import { parseQuestions, parseQuestionAnswer } from './ask-user-question.js'

export { parseQuestions, parseQuestionAnswer }

export type PermissionDecision = {
  requestId: string
  allowed: boolean
  rule?: 'always'
}

function getSinglePendingRequestId(requestIds?: Iterable<string> | null): string | null {
  if (!requestIds) return null
  const ids = Array.from(requestIds)
  return ids.length === 1 ? ids[0]! : null
}

export function parsePermissionCommand(
  text: string,
  pendingRequestIds?: Iterable<string> | null,
): PermissionDecision | null {
  const trimmed = text.trim()
  const match = text.trim().match(/^\/(allow|always|allow-always|deny)\s+(\S+)/i)
  if (match) {
    const action = match[1]!.toLowerCase()
    const requestId = match[2]!
    if (action === 'deny') return { requestId, allowed: false }
    if (action === 'always' || action === 'allow-always') return { requestId, allowed: true, rule: 'always' }
    return { requestId, allowed: true }
  }

  const requestId = getSinglePendingRequestId(pendingRequestIds)
  if (!requestId) return null

  const shortcut = trimmed.toLowerCase()
  if (['1', '/1', 'allow', '/allow', 'y', 'yes', '允许', '允许一次', '同意', '批准'].includes(shortcut)) {
    return { requestId, allowed: true }
  }
  if (['2', '/2', 'always', '/always', 'allow-always', '/allow-always', '永久允许', '一直允许'].includes(shortcut)) {
    return { requestId, allowed: true, rule: 'always' }
  }
  if (['3', '/3', 'deny', '/deny', 'n', 'no', '拒绝', '不允许', '否'].includes(shortcut)) {
    return { requestId, allowed: false }
  }

  return null
}

export function parsePermitCallbackData(data: string): PermissionDecision | null {
  const parts = data.split(':')
  if (parts.length !== 3 || parts[0] !== 'permit' || !parts[1]) return null

  switch (parts[2]) {
    case 'yes':
      return { requestId: parts[1], allowed: true }
    case 'always':
      return { requestId: parts[1], allowed: true, rule: 'always' }
    case 'no':
      return { requestId: parts[1], allowed: false }
    default:
      return null
  }
}

export function formatPermissionInstructions(requestId: string): string {
  return [
    '回复 1 允许一次，2 永久允许，3 拒绝。',
    `也可回复 /allow ${requestId}、/always ${requestId}、/deny ${requestId}。`,
  ].join('\n')
}

export function formatPermissionDecisionStatus(decision: Pick<PermissionDecision, 'allowed' | 'rule'>): string {
  if (!decision.allowed) return '❌ 已拒绝'
  return decision.rule === 'always' ? '♾️ 已永久允许' : '✅ 已允许'
}

/**
 * Build the Chinese prompt shown when an AskUserQuestion tool is waiting for an
 * answer: the full question/option list plus how to reply with `/answer`.
 *
 * The returned string is intentionally unsplit — platform limits vary, so the
 * platform controller runs it through `splitMessage` with its own maximum.
 */
export function formatQuestionInstructions(requestId: string, input: unknown): string {
  const questions = parseQuestions(input)
  if (!questions) {
    return `请回复答案：/answer ${requestId} <答案>`
  }

  const lines: string[] = [`📝 需要回答以下问题 [${requestId}]`, '']
  questions.forEach((entry, index) => {
    const header = entry.header ? `（${entry.header}）` : ''
    const multi = entry.multiSelect ? '（可多选，用逗号分隔）' : ''
    lines.push(`${index + 1}. ${entry.question}${header}${multi}`)
    for (const option of entry.options) {
      const suffix = option.description ? `：${option.description}` : ''
      lines.push(`   - ${option.label}${suffix}`)
    }
  })

  lines.push('')
  if (questions.length === 1) {
    lines.push('回复 /answer <id> <答案> 作答，例如：')
    lines.push(`/answer ${requestId} <你的答案>`)
    lines.push('请使用上面的 /answer 命令，普通聊天消息不会提交为问题答案。')
  } else {
    lines.push('请一次性回复全部答案，使用 JSON（键为完整问题文本）：')
    const template = Object.fromEntries(questions.map((entry) => [entry.question, '<答案>']))
    lines.push(`/answer ${requestId} ${JSON.stringify(template)}`)
  }

  return lines.join('\n')
}
