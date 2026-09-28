import { LOCAL_SCHEDULED_TASKS_API_PATH } from './client.js'

export const LOCAL_SCHEDULED_TASK_TOOL_NAME = 'LocalScheduledTask'

export const LOCAL_SCHEDULED_TASK_DESCRIPTION =
  'Create, list, update, enable, disable, delete, or immediately run a scheduled task on this machine. Tasks are persisted by the local desktop app and run locally, so they survive restarts and do not need a cloud schedule. Only available when the desktop app is running.'

/**
 * Tool guidance. Written for the model, so it must never include the internal
 * bearer token or any hint about how to construct a raw HTTP request: the
 * credential stays inside the tool implementation.
 */
export function buildLocalScheduledTaskPrompt(): string {
  return `Manage scheduled tasks that live on the user's own machine, through the running desktop app's authenticated local API (${LOCAL_SCHEDULED_TASKS_API_PATH}).

Call this tool (\`${LOCAL_SCHEDULED_TASK_TOOL_NAME}\`) — not a Bash command and not any cloud scheduling feature — whenever the user asks, in conversation, to:
- schedule something to happen later or repeatedly ("every weekday at 8", "in an hour")
- list, inspect, or change their scheduled tasks
- turn an existing task on or off, or run it now
- cancel a scheduled task

## Actions

- \`create\` — needs \`cron\` and \`prompt\`. Provide \`name\` and \`description\` when the user gave them.
- \`list\` — returns every task with its id, schedule, enabled state, and next run time.
- \`get\` — one task by \`id\`.
- \`update\` — one task by \`id\` plus the fields to change. Only the fields you pass are changed.
- \`enable\` / \`disable\` — one task by \`id\`.
- \`delete\` — one task by \`id\`. Irreversible.
- \`run\` — one task by \`id\`. Starts an immediate one-off execution; the schedule is untouched.

## Scheduling

Use a standard 5-field cron expression in the machine's local time: minute hour day-of-month month day-of-week. "0 9 * * 1-5" is 9am on weekdays, local time.

For "remind me once at <time>" requests pin the minute, hour, day, and month so the expression matches a single moment, and pass \`recurring: false\`.

Recurring tasks keep firing until they are deleted or disabled.

For tasks about the current project, pass its absolute path as \`folderPath\` explicitly. Omitting \`folderPath\` runs the task in the user's home directory, not the current project.

## Notifications

By default a task only reports back in the app. Add \`notification\` when the user explicitly asks to be told somewhere else:
- \`channels\`: which destinations, from \`desktop\`, \`telegram\`, \`feishu\`.
- \`recipients\`: optional. Each entry is a platform user id (or, for Telegram, a numeric chat/user id), or an object with \`userId\` and an optional \`displayName\`. Only use identifiers the user gave you or that appear in \`list\` output.

The server re-checks every recipient against the accounts actually paired with this app. A recipient that is unknown, ambiguous, or unpaired is rejected — it is never expanded into a broadcast to everyone. If the user has not named a target, leave \`notification\` out rather than guessing.

## Important

- Never invent a task id. Call \`list\` first if you do not already have one.
- Report the real task id and the next run time back to the user.
- If the tool reports that it is unavailable, the desktop app is not running. Say so instead of falling back to a shell command.`
}