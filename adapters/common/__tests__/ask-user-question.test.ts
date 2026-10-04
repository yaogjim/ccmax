import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createQuestionFlow,
  parseQuestionAnswer,
  parseQuestions,
} from '../ask-user-question.js'

const ENV_KEYS = ['HOME', 'CLAUDE_CONFIG_DIR'] as const

const previousEnv = new Map<string, string | undefined>()
let directory: string

beforeEach(() => {
  for (const key of ENV_KEYS) previousEnv.set(key, process.env[key])
  directory = mkdtempSync(join(tmpdir(), 'ask-user-question-'))
  process.env.HOME = directory
  process.env.CLAUDE_CONFIG_DIR = directory
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = previousEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(directory, { recursive: true, force: true })
})

const singleQuestionInput = {
  questions: [
    {
      question: '选哪个库？',
      header: 'Library',
      options: [
        { label: 'Axios', description: '成熟稳定' },
        { label: 'Fetch', description: '浏览器内置' },
      ],
      multiSelect: false,
    },
  ],
}

const multiQuestionInput = {
  questions: [
    {
      question: '前端框架？',
      header: 'Framework',
      options: [
        { label: 'React', description: '生态丰富' },
        { label: 'Vue', description: '上手简单' },
      ],
      multiSelect: false,
    },
    {
      question: '数据库？',
      header: 'Database',
      options: [
        { label: 'Postgres', description: '功能完整' },
        { label: 'SQLite', description: '零运维' },
      ],
      multiSelect: false,
    },
  ],
}

const multiSelectInput = {
  questions: [
    {
      question: '启用哪些能力？',
      header: 'Features',
      options: [
        { label: '缓存', description: '加速读取' },
        { label: '日志', description: '排查问题' },
        { label: '监控', description: '观察运行' },
      ],
      multiSelect: true,
    },
  ],
}

const commaLabelInput = {
  questions: [
    {
      question: 'Continue?',
      options: [
        { label: 'Yes, please' },
        { label: 'No, thanks' },
        { label: 'Maybe' },
      ],
      multiSelect: true,
    },
  ],
}

const commaLabelWithSubstringInput = {
  questions: [
    {
      question: 'Continue?',
      options: [
        { label: 'Yes, please' },
        { label: 'please' },
        { label: 'Maybe' },
      ],
      multiSelect: true,
    },
  ],
}

describe('parseQuestions', () => {
  it('keeps valid option labels and descriptions without requiring 2-4 options', () => {
    const parsed = parseQuestions({
      questions: [
        {
          question: '自由文本？',
          header: '  备注  ',
          options: [
            { label: '  仅一项  ', description: '  仍可用  ' },
            { label: '   ' },
            { label: 1 },
            'skip',
            null,
          ],
          multiSelect: 'yes',
        },
      ],
    })
    expect(parsed).toEqual([
      {
        question: '自由文本？',
        header: '备注',
        options: [{ label: '仅一项', description: '仍可用' }],
        multiSelect: false,
      },
    ])
  })

  it('filters broken options down to a free-text question instead of rejecting the payload', () => {
    expect(parseQuestions({
      questions: [{ question: '没有按钮？', options: [{ foo: 'bar' }, 12] }],
    })).toEqual([
      { question: '没有按钮？', options: [], multiSelect: false },
    ])
  })

  it('rejects empty, duplicate, or prototype-dangerous question keys', () => {
    expect(parseQuestions(null)).toBeNull()
    expect(parseQuestions({ questions: [] })).toBeNull()
    expect(parseQuestions({ questions: [{ question: '   ' }] })).toBeNull()
    expect(parseQuestions({ questions: [{ question: 'x' }, { question: 'x' }] })).toBeNull()
    expect(parseQuestions({ questions: [{ question: '__proto__' }] })).toBeNull()
    expect(parseQuestions({ questions: [{ question: 'constructor' }] })).toBeNull()
    expect(parseQuestions({ questions: [{ question: 'prototype' }] })).toBeNull()
  })
})

describe('parseQuestionAnswer', () => {
  it('keeps a single-question plain reply verbatim and does not map digits onto options', () => {
    expect(parseQuestionAnswer('1', singleQuestionInput)).toEqual({ '选哪个库？': '1' })
    expect(parseQuestionAnswer('/answer req-1 Axios', singleQuestionInput)).toEqual({
      '选哪个库？': '/answer req-1 Axios',
    })
  })

  it('accepts full-question JSON and strict 1-based numeric JSON that exactly cover every question', () => {
    expect(
      parseQuestionAnswer('{"前端框架？":"React","数据库？":"SQLite"}', multiQuestionInput),
    ).toEqual({ '前端框架？': 'React', '数据库？': 'SQLite' })
    expect(
      parseQuestionAnswer('{"1":"React","2":"SQLite"}', multiQuestionInput),
    ).toEqual({ '前端框架？': 'React', '数据库？': 'SQLite' })
    expect(parseQuestionAnswer('{"1":"Fetch"}', singleQuestionInput)).toEqual({ '选哪个库？': 'Fetch' })
  })

  it('rejects mixed, extra, or missing JSON keys', () => {
    expect(parseQuestionAnswer('{"1":"React","数据库？":"SQLite"}', multiQuestionInput)).toBeNull()
    expect(
      parseQuestionAnswer(
        '{"1":"React","2":"SQLite","前端框架？":"Vue"}',
        multiQuestionInput,
      ),
    ).toBeNull()
    expect(parseQuestionAnswer('{"1":"React"}', multiQuestionInput)).toBeNull()
    expect(
      parseQuestionAnswer('{"1":"React","2":"SQLite","3":"x"}', multiQuestionInput),
    ).toBeNull()
    expect(parseQuestionAnswer('{"2":"SQLite","3":"x"}', multiQuestionInput)).toBeNull()
    expect(
      parseQuestionAnswer('{"前端框架？":"React","数据库？":"SQLite","多余":"x"}', multiQuestionInput),
    ).toBeNull()
  })

  it('rejects prototype-dangerous keys, empty values, non-strings, and illegal payloads', () => {
    expect(parseQuestionAnswer('{"__proto__":"drop"}', { questions: [{ question: 'Q?' }] })).toBeNull()
    expect(parseQuestionAnswer('{"constructor":"drop"}', { questions: [{ question: 'Q?' }] })).toBeNull()
    expect(parseQuestionAnswer('{"1":"  "}', singleQuestionInput)).toBeNull()
    expect(parseQuestionAnswer('{"1":1}', singleQuestionInput)).toBeNull()
    expect(parseQuestionAnswer('{not json}', singleQuestionInput)).toBeNull()
    expect(parseQuestionAnswer('[1,2]', multiQuestionInput)).toBeNull()
    expect(parseQuestionAnswer('React', multiQuestionInput)).toBeNull()
  })
})

describe('ImQuestionFlow', () => {
  it('advances a single-select choice and lands on the summary after the last question', () => {
    const flow = createQuestionFlow(singleQuestionInput)
    expect(flow).not.toBeNull()
    expect(flow!.choose(1)).toBe(true)
    expect(flow!.answers).toEqual({ '选哪个库？': 'Fetch' })
    expect(flow!.isSummary).toBe(true)
    expect(flow!.index).toBe(1)
    expect(flow!.choose(0)).toBe(false)
    expect(flow!.answers).toEqual({ '选哪个库？': 'Fetch' })
  })

  it('toggles multi-select options and writes joined labels only on next', () => {
    const flow = createQuestionFlow(multiSelectInput)!
    expect(flow.choose(0)).toBe(true)
    expect(flow.choose(2)).toBe(true)
    expect(flow.choose(0)).toBe(true)
    expect(flow.index).toBe(0)
    expect(flow.answers).toEqual({})
    expect(flow.next()).toBe(true)
    expect(flow.answers).toEqual({ '启用哪些能力？': '监控' })
    expect(flow.isSummary).toBe(true)
  })

  it('submits custom text, merging already-selected multi-select labels', () => {
    const single = createQuestionFlow(singleQuestionInput)!
    expect(single.answer('  自己写  ')).toBe(true)
    expect(single.answers).toEqual({ '选哪个库？': '自己写' })
    expect(single.isSummary).toBe(true)

    const multi = createQuestionFlow(multiSelectInput)!
    expect(multi.choose(0)).toBe(true)
    expect(multi.choose(1)).toBe(true)
    expect(multi.answer('自定义')).toBe(true)
    expect(multi.answers).toEqual({ '启用哪些能力？': '缓存, 日志, 自定义' })
  })

  it('does not complete until every question has a non-empty answer', () => {
    const flow = createQuestionFlow(multiQuestionInput)!
    expect(flow.complete()).toBeNull()
    expect(flow.choose(0)).toBe(true)
    expect(flow.complete()).toBeNull()
    expect(flow.next()).toBe(false)
    expect(flow.answer('SQLite')).toBe(true)
    expect(flow.isSummary).toBe(true)
    expect(flow.complete()).toEqual({ '前端框架？': 'React', '数据库？': 'SQLite' })
  })

  it('lets back and edit restore a previous question and its selected option', () => {
    const flow = createQuestionFlow(multiQuestionInput)!
    expect(flow.choose(0)).toBe(true)
    expect(flow.choose(1)).toBe(true)
    expect(flow.isSummary).toBe(true)
    expect(flow.back()).toBe(true)
    expect(flow.index).toBe(1)
    expect([...flow.selectedIndices]).toEqual([1])
    expect(flow.edit(0)).toBe(true)
    expect(flow.index).toBe(0)
    expect([...flow.selectedIndices]).toEqual([0])
    expect(flow.choose(1)).toBe(true)
    expect(flow.index).toBe(1)
    expect(flow.answer('改过的库')).toBe(true)
    expect(flow.complete()).toEqual({ '前端框架？': 'Vue', '数据库？': '改过的库' })
  })

  it('returns a snapshot from complete that does not alias the live answers map', () => {
    const flow = createQuestionFlow(singleQuestionInput)!
    expect(flow.choose(0)).toBe(true)
    const snapshot = flow.complete()
    expect(snapshot).toEqual({ '选哪个库？': 'Axios' })
    snapshot!['选哪个库？'] = 'mutated'
    expect(flow.answers).toEqual({ '选哪个库？': 'Axios' })
    expect(flow.complete()).toEqual({ '选哪个库？': 'Axios' })
  })

  it('does not write on summary or illegal indices', () => {
    const flow = createQuestionFlow(singleQuestionInput)!
    expect(flow.choose(9)).toBe(false)
    expect(flow.answer('   ')).toBe(false)
    expect(flow.next()).toBe(false)
    expect(flow.back()).toBe(false)
    expect(flow.edit(-1)).toBe(false)
    expect(flow.edit(1)).toBe(false)
    expect(flow.choose(0)).toBe(true)
    expect(flow.answer('nope')).toBe(false)
    expect(flow.next()).toBe(false)
    expect(flow.edit(2)).toBe(false)
    expect(flow.answers).toEqual({ '选哪个库？': 'Axios' })
  })

  it('keeps comma-containing labels across next, back/edit, and next', () => {
    const flow = createQuestionFlow(commaLabelInput)!
    expect(flow.choose(0)).toBe(true)
    expect(flow.choose(1)).toBe(true)
    expect(flow.next()).toBe(true)
    expect(flow.answers).toEqual({ 'Continue?': 'Yes, please, No, thanks' })
    expect(flow.isSummary).toBe(true)

    expect(flow.back()).toBe(true)
    expect([...flow.selectedIndices].sort((left, right) => left - right)).toEqual([0, 1])
    expect(flow.next()).toBe(true)
    expect(flow.answers).toEqual({ 'Continue?': 'Yes, please, No, thanks' })
    expect(flow.complete()).toEqual({ 'Continue?': 'Yes, please, No, thanks' })

    expect(flow.edit(0)).toBe(true)
    expect([...flow.selectedIndices].sort((left, right) => left - right)).toEqual([0, 1])
    expect(flow.next()).toBe(true)
    expect(flow.answers).toEqual({ 'Continue?': 'Yes, please, No, thanks' })
    expect(flow.complete()).toEqual({ 'Continue?': 'Yes, please, No, thanks' })
  })

  it('keeps comma-containing custom text plus checked options across back and edit', () => {
    const flow = createQuestionFlow(commaLabelInput)!
    expect(flow.choose(0)).toBe(true)
    expect(flow.choose(2)).toBe(true)
    expect(flow.answer('Other, with comma')).toBe(true)
    expect(flow.answers).toEqual({ 'Continue?': 'Yes, please, Maybe, Other, with comma' })

    expect(flow.back()).toBe(true)
    expect([...flow.selectedIndices].sort((left, right) => left - right)).toEqual([0, 2])
    expect(flow.next()).toBe(true)
    expect(flow.answers).toEqual({ 'Continue?': 'Yes, please, Maybe, Other, with comma' })

    expect(flow.edit(0)).toBe(true)
    expect([...flow.selectedIndices].sort((left, right) => left - right)).toEqual([0, 2])
    expect(flow.choose(1)).toBe(true)
    expect(flow.next()).toBe(true)
    expect(flow.answers).toEqual({
      'Continue?': 'Yes, please, No, thanks, Maybe, Other, with comma',
    })
    expect(flow.complete()).toEqual({
      'Continue?': 'Yes, please, No, thanks, Maybe, Other, with comma',
    })
  })

  it('does not restore an unchecked option from a comma-split answer', () => {
    const flow = createQuestionFlow(commaLabelWithSubstringInput)!
    expect(flow.choose(0)).toBe(true)
    expect(flow.choose(2)).toBe(true)
    expect(flow.next()).toBe(true)
    expect(flow.answers).toEqual({ 'Continue?': 'Yes, please, Maybe' })

    expect(flow.back()).toBe(true)
    expect([...flow.selectedIndices].sort((left, right) => left - right)).toEqual([0, 2])
    expect(flow.choose(2)).toBe(true)
    expect([...flow.selectedIndices].sort((left, right) => left - right)).toEqual([0])
    expect(flow.selectedIndices.has(1)).toBe(false)

    expect(flow.next()).toBe(true)
    expect(flow.answers).toEqual({ 'Continue?': 'Yes, please' })
    expect(flow.back()).toBe(true)
    expect([...flow.selectedIndices]).toEqual([0])
    expect(flow.selectedIndices.has(1)).toBe(false)
    expect(flow.selectedIndices.has(2)).toBe(false)
    expect(flow.next()).toBe(true)
    expect(flow.complete()).toEqual({ 'Continue?': 'Yes, please' })
  })
})