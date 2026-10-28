import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { taskDeliveryActionSchema, TASK_DELIVERY_UNSUPPORTED_ERROR } from '../../shared/taskDelivery.js'
import { applyTaskDeliveryAction } from '../../utils/taskDelivery.js'
import { isTeamExecutionApproved, readTeamPlan } from '../../utils/swarm/teamPlanStore.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { errorMessage } from '../../utils/errors.js'
import {
  executeTaskCompletedHooks,
  getTaskCompletedHookMessage,
} from '../../utils/hooks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  deleteTaskWithCommit,
  findUnsatisfiedBlockers,
  formatTaskDependencyBlockedError,
  getTask,
  getTaskListId,
  isTodoV2Enabled,
  listTasks,
  type AtomicTaskUpdateResult,
  type Task,
  type TaskDeletionResult,
  TaskStatusSchema,
  TASK_DELIVERY_REASSIGN_ERROR,
  TASK_DELIVERY_STATUS_UPDATE_ERROR,
  updateTaskAtomically,
} from '../../utils/tasks.js'
import {
  getAgentId,
  getAgentName,
  getTeammateColor,
  getTeamName,
  isTeammate,
} from '../../utils/teammate.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import { VERIFICATION_AGENT_TYPE } from '../AgentTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

const inputSchema = lazySchema(() => {
  // Extended status schema that includes 'deleted' as a special action
  const TaskUpdateStatusSchema = TaskStatusSchema().or(z.literal('deleted'))

  return z.strictObject({
    taskId: z.string().describe('The ID of the task to update'),
    deliveryAction: taskDeliveryActionSchema.optional().describe('Versioned artifact protocol: owner submits artifact and acceptance criteria; a different reviewer accepts or returns it with a reason. Use the current delivery.revision from TaskGet. Do not combine with ordinary task edits.'),
    subject: z.string().optional().describe('New subject for the task'),
    description: z.string().optional().describe('New description for the task'),
    activeForm: z
      .string()
      .optional()
      .describe(
        'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
      ),
    status: TaskUpdateStatusSchema.optional().describe(
      'New status for the task',
    ),
    addBlocks: z
      .array(z.string())
      .optional()
      .describe('Task IDs that this task blocks'),
    addBlockedBy: z
      .array(z.string())
      .optional()
      .describe('Task IDs that block this task'),
    owner: z.string().optional().describe('New owner for the task'),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Metadata keys to merge into the task. Set a key to null to delete it.',
      ),
  })
})
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    taskId: z.string(),
    updatedFields: z.array(z.string()),
    error: z.string().optional(),
    statusChange: z
      .object({
        from: z.string(),
        to: z.string(),
      })
      .optional(),
    verificationNudgeNeeded: z.boolean().optional(),
    taskListMutationAt: z.string().optional(),
    taskListMutationRevision: z.number().int().nonnegative().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * Raised inside the atomic update when an abort landed after the completion
 * hooks returned. The resolver runs before any write, so throwing here leaves
 * the task exactly as it was instead of reporting a cancelled completion as a
 * success.
 */
class TaskCompletionCancelledError extends Error {}

const COMPLETION_CANCELLED_MESSAGE = 'Task completion was cancelled before it was committed; the task was not marked completed. If the work is finished, run TaskUpdate again once the turn is active.'

export const TaskUpdateTool = buildTool({
  name: TASK_UPDATE_TOOL_NAME,
  searchHint: 'update a task',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'TaskUpdate'
  },
  alwaysLoad: true,
  isEnabled() {
    return isTodoV2Enabled()
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    const parts = [input.taskId]
    if (input.status) parts.push(input.status)
    if (input.subject) parts.push(input.subject)
    return parts.join(' ')
  },
  renderToolUseMessage() {
    return null
  },
  async call(
    {
      taskId,
      deliveryAction,
      subject,
      description,
      activeForm,
      status,
      owner,
      addBlocks,
      addBlockedBy,
      metadata,
    },
    context,
  ) {
    const taskListId = getTaskListId(context?.agentId)

    // Auto-expand task list when updating tasks
    context.setAppState(prev => {
      if (prev.expandedView === 'tasks') return prev
      return { ...prev, expandedView: 'tasks' as const }
    })

    // Check if task exists
    const existingTask = await getTask(taskListId, taskId)
    const teamName = getTeamName() ?? context.getAppState().teamContext?.teamName
    if (deliveryAction) {
      try {
        if (!teamName) throw new Error('Artifact delivery requires a team')
        if (isTeammate() && getAgentName() === 'user') throw new Error('The user identity is reserved for human review')
        if ([subject, description, activeForm, status, owner, addBlocks, addBlockedBy, metadata].some(value => value !== undefined)) throw new Error('Keep delivery actions separate from ordinary task edits')
        const mutation = await applyTaskDeliveryAction(teamName, taskId, getAgentName() || 'team-lead', deliveryAction, undefined, { context })
        return { data: { success: true, taskId, updatedFields: mutation.updated ? ['delivery', 'status'] : [], taskListMutationAt: mutation.committedAt, taskListMutationRevision: mutation.revision } }
      } catch (error) {
        return { data: { success: false, taskId, updatedFields: [], error: error instanceof Error ? error.message : String(error) } }
      }
    }
    if (existingTask?.delivery?.submissions.length && (owner !== undefined || (status !== undefined && status !== 'deleted'))) {
      const latest = existingTask.delivery.submissions.at(-1)
      // A returned, still-open artifact may change hands so rework can be
      // scheduled with a fresh owner. Everything else stays with the delivery
      // protocol: a version under review keeps the owner whose work is being
      // judged, generic status edits cannot complete or reopen a task, and
      // deletion is refused by the storage guard instead.
      const returnedAndOpen = latest?.review?.decision === 'return' && existingTask.status !== 'completed'
      if (!(owner !== undefined && status === undefined && returnedAndOpen)) {
        const error = existingTask.status === 'completed'
          ? 'This task is completed; an accepted artifact cannot be reopened or reassigned.'
          : latest?.review === undefined
            ? 'This task is awaiting independent review; its owner cannot change until the artifact is returned.'
            : 'Use deliveryAction for independent review and rework; only a task whose artifact was returned and is still open can be reassigned.'
        return { data: { success: false, taskId, updatedFields: [], error } }
      }
    }
    if (teamName && (
      status === 'in_progress' ||
      status === 'completed' ||
      // Handing returned rework to a new owner is execution, so the same plan
      // approval the status paths require applies to that owner.
      (owner !== undefined && owner !== existingTask?.owner && existingTask?.delivery?.submissions.length)
    )) {
      const plan = await readTeamPlan(teamName)
      if (plan && !await isTeamExecutionApproved(teamName, owner ?? existingTask?.owner)) {
        return { data: { success: false, taskId, updatedFields: [], error: 'The team is awaiting human review. Submit the plan with TeamPlan and wait for approval before executing tasks.' } }
      }
    }
    if (!existingTask) {
      return {
        data: {
          success: false,
          taskId,
          updatedFields: [],
          error: 'Task not found',
        },
      }
    }

    // A teammate cannot start or finish a task ahead of the tasks it waits on;
    // without this the list's dependencies are only a suggestion, and a member
    // marks its blocked task in progress while the work it needs is unwritten.
    // The lead is not held to it: it coordinates, and may decide a dependency
    // no longer matters. Passing the same gate to the atomic update lets it be
    // rechecked after the completion hooks and the lock wait.
    const enforceDependencyOrder = isTeammate()
    if (
      enforceDependencyOrder &&
      (status === 'in_progress' || status === 'completed') &&
      status !== existingTask.status &&
      existingTask.blockedBy.length > 0
    ) {
      // A dependency that is not in the list is not evidence of finished work,
      // so a dangling edge counts as unfinished instead of vanishing from the
      // unresolved set.
      const tasksById = new Map(
        (await listTasks(taskListId)).map(task => [task.id, task]),
      )
      const waitingOn = findUnsatisfiedBlockers(existingTask, tasksById)
      if (waitingOn.length > 0) {
        return {
          data: {
            success: false,
            taskId,
            updatedFields: [],
            error: formatTaskDependencyBlockedError(taskId, waitingOn),
          },
        }
      }
    }

    const updatedFields: string[] = []
    const abortSignal = context?.abortController?.signal
    const completionCancelled = () => ({
      data: {
        success: false,
        taskId,
        updatedFields: [],
        error: COMPLETION_CANCELLED_MESSAGE,
      },
    })
    if (status !== undefined) {
      // Handle deletion - delete the task file and return early
      if (status === 'deleted') {
        let deletion: TaskDeletionResult
        try {
          deletion = await deleteTaskWithCommit(taskListId, taskId)
        } catch (error) {
          // The delete guard owns the refusal message, including for a damaged
          // or newer delivery schema.
          return { data: { success: false, taskId, updatedFields: [], error: errorMessage(error) } }
        }
        const deleted = deletion.deleted
        return {
          data: {
            success: deleted,
            taskId,
            updatedFields: deleted ? ['deleted'] : [],
            error: deleted ? undefined : 'Failed to delete task',
            statusChange: deleted
              ? { from: existingTask.status, to: 'deleted' }
              : undefined,
            taskListMutationAt: deletion.committedAt,
            taskListMutationRevision: deletion.revision,
          },
        }
      }

      // For regular status updates, run completion hooks before the atomic
      // commit. The commit re-reads the task so stale ownership decisions are
      // never carried across this asynchronous hook boundary.
      if (status !== existingTask.status) {
        // Run TaskCompleted hooks when marking a task as completed
        if (status === 'completed') {
          // A hook runner returns nothing once its signal is aborted, which
          // used to look like "no blocking error" and completed a turn the
          // user had already cancelled.
          if (abortSignal?.aborted) return completionCancelled()
          const blockingErrors: string[] = []

          const generator = executeTaskCompletedHooks(
            taskId,
            existingTask.subject,
            existingTask.description,
            getAgentName(),
            getTeamName(),
            undefined,
            abortSignal,
            undefined,
            context,
          )

          for await (const result of generator) {
            if (result.blockingError) {
              blockingErrors.push(
                getTaskCompletedHookMessage(result.blockingError),
              )
            }
          }

          if (abortSignal?.aborted) return completionCancelled()
          if (blockingErrors.length > 0) {
            return {
              data: {
                success: false,
                taskId,
                updatedFields: [],
                error: blockingErrors.join('\n'),
              },
            }
          }
        }

      }
    }

    // A teammate that batches several small tasks closed at once never passes
    // through `in_progress`, so those tasks used to finish with no owner at all
    // and the workbench could only report them as done by nobody. `getAgentName`
    // is undefined on the lead's main thread, so a lead closing out someone
    // else's task still cannot take credit for it.
    const automaticOwner = (
      isAgentSwarmsEnabled() &&
      (status === 'in_progress' || status === 'completed') &&
      owner === undefined
    ) ? getAgentName() : undefined
    let mutation: AtomicTaskUpdateResult | null
    try {
      mutation = await updateTaskAtomically(taskListId, taskId, (current) => {
        // The hooks and the lock wait both happen outside this transaction.
        // This check runs before the first write, so a cancellation that landed
        // in between cannot be committed and reported as a completed task.
        if (status === 'completed' && abortSignal?.aborted) throw new TaskCompletionCancelledError()
        const updates: Partial<Omit<Task, 'id'>> = {}
        if (subject !== undefined && subject !== current.subject) updates.subject = subject
        if (description !== undefined && description !== current.description) {
          updates.description = description
        }
        if (activeForm !== undefined && activeForm !== current.activeForm) {
          updates.activeForm = activeForm
        }
        if (owner !== undefined && owner !== current.owner) {
          updates.owner = owner
        } else if (owner === undefined && automaticOwner && !current.owner) {
          updates.owner = automaticOwner
        }
        if (metadata !== undefined) {
          const merged = { ...(current.metadata ?? {}) }
          for (const [key, value] of Object.entries(metadata)) {
            if (value === null) delete merged[key]
            else merged[key] = value
          }
          updates.metadata = merged
        }
        if (status !== undefined && status !== 'deleted' && status !== current.status) {
          updates.status = status
        }
        return updates
      }, {
        addBlocks,
        addBlockedBy,
        requireCompletedDependencies: enforceDependencyOrder,
      })
    } catch (error) {
      if (error instanceof TaskCompletionCancelledError) return completionCancelled()
      // A concurrent delivery submit/return can invalidate the decision this
      // call was made on. The storage guard owns that race; surface it as a
      // normal failure so the caller refreshes instead of retrying blindly.
      if (
        error instanceof Error &&
        (
          error.message === TASK_DELIVERY_STATUS_UPDATE_ERROR ||
          error.message === TASK_DELIVERY_REASSIGN_ERROR ||
          error.message === TASK_DELIVERY_UNSUPPORTED_ERROR
        )
      ) {
        return { data: { success: false, taskId, updatedFields: [], error: error.message } }
      }
      throw error
    }
    if (!mutation) {
      return {
        data: {
          success: false,
          taskId,
          updatedFields: [],
          error: 'Task not found',
        },
      }
    }
    if (mutation.refused) {
      // The transaction refused before writing, so report the dependency gate
      // as an ordinary failure; nothing was committed and no revision moved.
      return {
        data: {
          success: false,
          taskId,
          updatedFields: [],
          error: mutation.refused.error,
        },
      }
    }
    const committedTask = mutation.task
    const previousTask = mutation.previous
    if (previousTask.subject !== committedTask.subject) updatedFields.push('subject')
    if (previousTask.description !== committedTask.description) updatedFields.push('description')
    if (previousTask.activeForm !== committedTask.activeForm) updatedFields.push('activeForm')
    if (previousTask.owner !== committedTask.owner) updatedFields.push('owner')
    if (JSON.stringify(previousTask.metadata) !== JSON.stringify(committedTask.metadata)) {
      updatedFields.push('metadata')
    }
    if (previousTask.status !== committedTask.status) updatedFields.push('status')
    if (JSON.stringify(previousTask.blocks) !== JSON.stringify(committedTask.blocks)) {
      updatedFields.push('blocks')
    }
    if (
      JSON.stringify(previousTask.blockedBy) !==
      JSON.stringify(committedTask.blockedBy)
    ) updatedFields.push('blockedBy')
    const statusChange = previousTask.status !== committedTask.status
      ? { from: previousTask.status, to: committedTask.status }
      : undefined

    // Notify new owner via mailbox when ownership changes. Work that is already
    // finished is excluded: "this is now yours" is not true of a completed task,
    // and delivering it would wake an idle teammate for nothing.
    if (
      committedTask.owner &&
      committedTask.owner !== previousTask.owner &&
      committedTask.status !== 'completed' &&
      isAgentSwarmsEnabled()
    ) {
      const senderName = getAgentName() || 'team-lead'
      const senderColor = getTeammateColor()
      const assignmentMessage = JSON.stringify({
        type: 'task_assignment',
        taskId,
        subject: committedTask.subject,
        description: committedTask.description,
        assignedBy: senderName,
        timestamp: new Date().toISOString(),
      })
      await writeToMailbox(
        committedTask.owner,
        {
          from: senderName,
          text: assignmentMessage,
          timestamp: new Date().toISOString(),
          color: senderColor,
        },
        taskListId,
      )
    }

    // Structural verification nudge: if the main-thread agent just closed
    // out a 3+ task list and none of those tasks was a verification step,
    // append a reminder to the tool result. Fires at the loop-exit moment
    // where skips happen ("when the last task closed, the loop exited").
    // Mirrors the TodoWriteTool nudge for V1 sessions; this covers V2
    // (interactive CLI). TaskUpdateToolOutput is @internal so this field
    // does not touch the public SDK surface.
    let verificationNudgeNeeded = false
    if (
      feature('VERIFICATION_AGENT') &&
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false) &&
      !context.agentId &&
      statusChange?.to === 'completed'
    ) {
      const allTasks = await listTasks(taskListId)
      const allDone = allTasks.every(t => t.status === 'completed')
      if (
        allDone &&
        allTasks.length >= 3 &&
        !allTasks.some(t => /verif/i.test(t.subject))
      ) {
        verificationNudgeNeeded = true
      }
    }

    return {
      data: {
        success: true,
        taskId,
        updatedFields,
        statusChange,
        verificationNudgeNeeded,
        taskListMutationAt: mutation.committedAt,
        taskListMutationRevision: mutation.revision,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const {
      success,
      taskId,
      updatedFields,
      error,
      statusChange,
      verificationNudgeNeeded,
    } = content as Output
    if (!success) {
      // Return as non-error so it doesn't trigger sibling tool cancellation
      // in StreamingToolExecutor. "Task not found" is a benign condition
      // (e.g., task list already cleaned up) that the model can handle.
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: error || `Task #${taskId} not found`,
      }
    }

    let resultContent = `Updated task #${taskId} ${updatedFields.join(', ')}`

    // Add reminder for teammates when they complete a task (supports in-process teammates)
    if (
      statusChange?.to === 'completed' &&
      getAgentId() &&
      isAgentSwarmsEnabled()
    ) {
      resultContent +=
        '\n\nTask completed. Call TaskList now to find your next available task or see if your work unblocked others.'
    }

    if (verificationNudgeNeeded) {
      resultContent += `\n\nNOTE: You just closed out 3+ tasks and none of them was a verification step. Before writing your final summary, spawn the verification agent (subagent_type="${VERIFICATION_AGENT_TYPE}"). You cannot self-assign PARTIAL by listing caveats in your summary — only the verifier issues a verdict.`
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: resultContent,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
