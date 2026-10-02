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

/** Keys that would mutate an object's prototype if used as an answer map key. */
const DANGEROUS_ANSWER_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

type QuestionEntry = {
  question: string
  header?: unknown
  options?: unknown
  multiSelect?: unknown
}

/** Validate `input.questions` and return the entries, or null when malformed.
 *  Every entry needs a non-empty, unique `question` string. */
function parseQuestions(input: unknown): QuestionEntry[] | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const questions = (input as Record<string, unknown>).questions
  if (!Array.isArray(questions) || questions.length === 0) return null

  const parsed: QuestionEntry[] = []
  const seen = new Set<string>()
  for (const item of questions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const question = (item as Record<string, unknown>).question
    if (typeof question !== 'string' || question.trim() === '') return null
    if (DANGEROUS_ANSWER_KEYS.has(question) || seen.has(question)) return null
    seen.add(question)
    parsed.push(item as QuestionEntry)
  }
  return parsed
}

/**
 * Parse a user's answer payload for an AskUserQuestion permission request.
 *
 * The caller (the platform controller) is responsible for stripping any
 * `/answer <id>` command prefix and passing only the answer payload here, so
 * this function never inspects the command itself.
 *
 * - Single question and the text does not start with `{`: the trimmed text is
 *   forwarded verbatim as the answer (no positional/number mapping).
 * - Multiple questions, or any text starting with `{`: parsed as a JSON object
 *   keyed by the full question text. Keys must exactly cover every question and
 *   each value must be a non-empty string.
 *
 * Returns null whenever the input is malformed, the payload cannot be
 * unambiguously mapped, or a prototype-dangerous key is present.
 */
export function parseQuestionAnswer(text: string, input: unknown): Record<string, string> | null {
  const questions = parseQuestions(input)
  if (!questions) return null

  const trimmed = text.trim()
  if (trimmed === '') return null

  if (questions.length === 1 && !trimmed.startsWith('{')) {
    return { [questions[0]!.question]: trimmed }
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null

  const record = decoded as Record<string, unknown>
  const keys = Object.getOwnPropertyNames(record)
  for (const key of keys) {
    if (DANGEROUS_ANSWER_KEYS.has(key)) return null
  }
  if (keys.length !== questions.length) return null

  const answers: Record<string, string> = {}
  for (const entry of questions) {
    if (DANGEROUS_ANSWER_KEYS.has(entry.question)) return null
    if (!Object.prototype.hasOwnProperty.call(record, entry.question)) return null
    const value = record[entry.question]
    if (typeof value !== 'string') return null
    const answer = value.trim()
    if (answer === '') return null
    answers[entry.question] = answer
  }
  return answers
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
    const header = typeof entry.header === 'string' && entry.header.trim() ? `（${entry.header.trim()}）` : ''
    const multi = entry.multiSelect === true ? '（可多选，用逗号分隔）' : ''
    lines.push(`${index + 1}. ${entry.question}${header}${multi}`)

    const options = Array.isArray(entry.options) ? entry.options : []
    for (const option of options) {
      if (!option || typeof option !== 'object') continue
      const label = (option as Record<string, unknown>).label
      const description = (option as Record<string, unknown>).description
      if (typeof label !== 'string' || label.trim() === '') continue
      const suffix = typeof description === 'string' && description.trim() ? `：${description.trim()}` : ''
      lines.push(`   - ${label.trim()}${suffix}`)
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
