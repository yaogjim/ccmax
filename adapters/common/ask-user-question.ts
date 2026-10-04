/** Keys that would mutate an object's prototype if used as an answer map key. */
const DANGEROUS_ANSWER_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export type ImQuestion = {
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
}

function isDangerousKey(key: string): boolean {
  return DANGEROUS_ANSWER_KEYS.has(key)
}

function parseOptions(raw: unknown): Array<{ label: string; description?: string }> {
  if (!Array.isArray(raw)) return []
  const options: Array<{ label: string; description?: string }> = []
  for (const option of raw) {
    if (!option || typeof option !== 'object' || Array.isArray(option)) continue
    const record = option as Record<string, unknown>
    if (typeof record.label !== 'string' || record.label.trim() === '') continue
    const parsed: { label: string; description?: string } = { label: record.label.trim() }
    if (typeof record.description === 'string' && record.description.trim()) {
      parsed.description = record.description.trim()
    }
    options.push(parsed)
  }
  return options
}

/** Validate `input.questions` and return the entries, or null when malformed.
 *  Every entry needs a non-empty, unique `question` string. Invalid options are
 *  dropped so a question can degrade to free-text rather than failing closed. */
export function parseQuestions(input: unknown): ImQuestion[] | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const questions = (input as Record<string, unknown>).questions
  if (!Array.isArray(questions) || questions.length === 0) return null

  const parsed: ImQuestion[] = []
  const seen = new Set<string>()
  for (const item of questions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const record = item as Record<string, unknown>
    const question = record.question
    if (typeof question !== 'string' || question.trim() === '') return null
    if (isDangerousKey(question) || seen.has(question)) return null
    seen.add(question)
    const entry: ImQuestion = {
      question,
      options: parseOptions(record.options),
      multiSelect: record.multiSelect === true,
    }
    if (typeof record.header === 'string' && record.header.trim()) {
      entry.header = record.header.trim()
    }
    parsed.push(entry)
  }
  return parsed
}

function mapAnswersByQuestionKeys(
  questions: ImQuestion[],
  record: Record<string, unknown>,
): Record<string, string> | null {
  const answers: Record<string, string> = {}
  for (const entry of questions) {
    if (isDangerousKey(entry.question)) return null
    if (!Object.prototype.hasOwnProperty.call(record, entry.question)) return null
    const value = record[entry.question]
    if (typeof value !== 'string') return null
    const answer = value.trim()
    if (answer === '') return null
    answers[entry.question] = answer
  }
  return answers
}

function mapAnswersByNumericKeys(
  questions: ImQuestion[],
  record: Record<string, unknown>,
): Record<string, string> | null {
  const answers: Record<string, string> = {}
  for (let index = 0; index < questions.length; index++) {
    const key = String(index + 1)
    if (!Object.prototype.hasOwnProperty.call(record, key)) return null
    const value = record[key]
    if (typeof value !== 'string') return null
    const answer = value.trim()
    if (answer === '') return null
    answers[questions[index]!.question] = answer
  }
  return answers
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
 *   keyed either by the full question text or by strict 1-based question
 *   numbers (`{"1":"React","2":"SQLite"}`). The two encodings must not mix.
 *   Keys must exactly cover every question and each value must be a non-empty
 *   string.
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
    if (isDangerousKey(key)) return null
  }
  if (keys.length !== questions.length) return null

  return mapAnswersByQuestionKeys(questions, record) ?? mapAnswersByNumericKeys(questions, record)
}

function selectedLabels(question: ImQuestion, selectedIndices: Set<number>): string[] {
  return [...selectedIndices]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < question.options.length)
    .sort((left, right) => left - right)
    .map((index) => question.options[index]!.label)
}

export class ImQuestionFlow {
  questions: ImQuestion[]
  index: number
  answers: Record<string, string>
  selectedIndices: Set<number>
  private selectedByIndex: Map<number, Set<number>>
  private customByIndex: Map<number, string>

  constructor(questions: ImQuestion[]) {
    this.questions = questions
    this.index = 0
    this.answers = {}
    this.selectedIndices = new Set()
    this.selectedByIndex = new Map()
    this.customByIndex = new Map()
  }

  get isSummary(): boolean {
    return this.index >= this.questions.length
  }

  choose(optionIndex: number): boolean {
    const question = this.currentQuestion()
    if (!question) return false
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= question.options.length) {
      return false
    }
    if (question.multiSelect) {
      if (this.selectedIndices.has(optionIndex)) this.selectedIndices.delete(optionIndex)
      else this.selectedIndices.add(optionIndex)
      this.selectedByIndex.set(this.index, new Set(this.selectedIndices))
      return true
    }
    this.customByIndex.delete(this.index)
    this.selectedByIndex.set(this.index, new Set([optionIndex]))
    this.answers[question.question] = question.options[optionIndex]!.label
    this.advance()
    return true
  }

  answer(text: string): boolean {
    const question = this.currentQuestion()
    if (!question) return false
    const custom = text.trim()
    if (custom === '') return false
    this.customByIndex.set(this.index, custom)
    if (question.multiSelect) {
      this.selectedByIndex.set(this.index, new Set(this.selectedIndices))
      const labels = selectedLabels(question, this.selectedIndices)
      this.answers[question.question] = labels.length > 0 ? [...labels, custom].join(', ') : custom
    } else {
      this.answers[question.question] = custom
    }
    this.advance()
    return true
  }

  next(): boolean {
    const question = this.currentQuestion()
    if (!question) return false
    if (question.multiSelect) {
      const labels = selectedLabels(question, this.selectedIndices)
      const custom = this.customByIndex.get(this.index) ?? ''
      if (labels.length === 0 && custom === '') return false
      this.selectedByIndex.set(this.index, new Set(this.selectedIndices))
      this.answers[question.question] = custom === ''
        ? labels.join(', ')
        : [...labels, custom].join(', ')
      this.advance()
      return true
    }
    const existing = this.answers[question.question]
    if (typeof existing !== 'string' || existing.trim() === '') return false
    this.advance()
    return true
  }

  back(): boolean {
    if (this.index <= 0 || this.questions.length === 0) return false
    this.index = this.isSummary ? this.questions.length - 1 : this.index - 1
    this.restoreSelection()
    return true
  }

  edit(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.questions.length) return false
    this.index = index
    this.restoreSelection()
    return true
  }

  complete(): Record<string, string> | null {
    const snapshot: Record<string, string> = {}
    for (const question of this.questions) {
      const value = this.answers[question.question]
      if (typeof value !== 'string' || value.trim() === '') return null
      snapshot[question.question] = value
    }
    return snapshot
  }

  private currentQuestion(): ImQuestion | null {
    if (this.isSummary) return null
    return this.questions[this.index] ?? null
  }

  private advance(): void {
    this.index += 1
    this.restoreSelection()
  }

  private restoreSelection(): void {
    this.selectedIndices = new Set()
    if (!this.currentQuestion()) return
    const stored = this.selectedByIndex.get(this.index)
    if (stored) this.selectedIndices = new Set(stored)
  }
}

export function createQuestionFlow(input: unknown): ImQuestionFlow | null {
  const questions = parseQuestions(input)
  if (!questions) return null
  return new ImQuestionFlow(questions)
}