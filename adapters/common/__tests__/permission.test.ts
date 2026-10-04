import { describe, expect, it } from 'bun:test'
import {
  formatPermissionDecisionStatus,
  formatPermissionInstructions,
  formatQuestionInstructions,
  parsePermissionCommand,
  parsePermitCallbackData,
  parseQuestionAnswer,
} from '../permission.js'

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

describe('permission helpers', () => {
  it('parses text permission commands', () => {
    expect(parsePermissionCommand('/allow req-1')).toEqual({ requestId: 'req-1', allowed: true })
    expect(parsePermissionCommand('/always req-2')).toEqual({ requestId: 'req-2', allowed: true, rule: 'always' })
    expect(parsePermissionCommand('/allow-always req-3')).toEqual({ requestId: 'req-3', allowed: true, rule: 'always' })
    expect(parsePermissionCommand('/deny req-4')).toEqual({ requestId: 'req-4', allowed: false })
  })

  it('parses short replies when one permission is pending', () => {
    const pending = new Set(['req-1'])
    expect(parsePermissionCommand('1', pending)).toEqual({ requestId: 'req-1', allowed: true })
    expect(parsePermissionCommand('2', pending)).toEqual({ requestId: 'req-1', allowed: true, rule: 'always' })
    expect(parsePermissionCommand('3', pending)).toEqual({ requestId: 'req-1', allowed: false })
    expect(parsePermissionCommand('/always', pending)).toEqual({ requestId: 'req-1', allowed: true, rule: 'always' })
    expect(parsePermissionCommand('永久允许', pending)).toEqual({ requestId: 'req-1', allowed: true, rule: 'always' })
  })

  it('does not parse short replies when multiple permissions are pending', () => {
    expect(parsePermissionCommand('1', new Set(['req-1', 'req-2']))).toBeNull()
  })

  it('parses callback permission actions', () => {
    expect(parsePermitCallbackData('permit:req-1:yes')).toEqual({ requestId: 'req-1', allowed: true })
    expect(parsePermitCallbackData('permit:req-2:always')).toEqual({ requestId: 'req-2', allowed: true, rule: 'always' })
    expect(parsePermitCallbackData('permit:req-3:no')).toEqual({ requestId: 'req-3', allowed: false })
    expect(parsePermitCallbackData('permit:req-4:unknown')).toBeNull()
  })

  it('formats text fallback and status labels', () => {
    expect(formatPermissionInstructions('req-1')).toContain('回复 1')
    expect(formatPermissionInstructions('req-1')).toContain('/always req-1')
    expect(formatPermissionDecisionStatus({ allowed: true, rule: 'always' })).toContain('永久允许')
    expect(formatPermissionDecisionStatus({ allowed: false })).toContain('拒绝')
  })
})

describe('parseQuestionAnswer', () => {
  it('maps plain text onto the single question, trimmed', () => {
    expect(parseQuestionAnswer('  Axios  ', singleQuestionInput)).toEqual({ '选哪个库？': 'Axios' })
  })

  it('returns null for empty text on a single question', () => {
    expect(parseQuestionAnswer('   ', singleQuestionInput)).toBeNull()
    expect(parseQuestionAnswer('', singleQuestionInput)).toBeNull()
  })

  it('parses a JSON answers map for a single question that starts with {', () => {
    expect(parseQuestionAnswer('{"选哪个库？":"Fetch"}', singleQuestionInput)).toEqual({ '选哪个库？': 'Fetch' })
  })

  it('parses a JSON answers map for multiple questions', () => {
    expect(
      parseQuestionAnswer('{"前端框架？":"React","数据库？":"Postgres"}', multiQuestionInput),
    ).toEqual({ '前端框架？': 'React', '数据库？': 'Postgres' })
  })

  it('parses strict 1-based numeric JSON keys that exactly cover every question', () => {
    expect(
      parseQuestionAnswer('{"1":"React","2":"Postgres"}', multiQuestionInput),
    ).toEqual({ '前端框架？': 'React', '数据库？': 'Postgres' })
    expect(parseQuestionAnswer('{"1":"Fetch"}', singleQuestionInput)).toEqual({ '选哪个库？': 'Fetch' })
  })

  it('does not map a single-question digit reply onto an option', () => {
    expect(parseQuestionAnswer('1', singleQuestionInput)).toEqual({ '选哪个库？': '1' })
  })

  it('does not map plain text onto multiple questions positionally', () => {
    expect(parseQuestionAnswer('React', multiQuestionInput)).toBeNull()
    expect(parseQuestionAnswer('1 React 2 Postgres', multiQuestionInput)).toBeNull()
    expect(parseQuestionAnswer('1. React\n2. Postgres', multiQuestionInput)).toBeNull()
  })

  it('requires the JSON keys to exactly cover every question', () => {
    expect(parseQuestionAnswer('{"前端框架？":"React"}', multiQuestionInput)).toBeNull()
    expect(
      parseQuestionAnswer('{"前端框架？":"React","数据库？":"Postgres","多余":"x"}', multiQuestionInput),
    ).toBeNull()
    expect(
      parseQuestionAnswer('{"前端框架？":"React","另一个？":"Postgres"}', multiQuestionInput),
    ).toBeNull()
    expect(parseQuestionAnswer('{"1":"React","数据库？":"Postgres"}', multiQuestionInput)).toBeNull()
    expect(parseQuestionAnswer('{"1":"React"}', multiQuestionInput)).toBeNull()
    expect(
      parseQuestionAnswer('{"1":"React","2":"Postgres","3":"x"}', multiQuestionInput),
    ).toBeNull()
  })

  it('rejects empty or non-string JSON answer values', () => {
    expect(parseQuestionAnswer('{"前端框架？":"  ","数据库？":"Postgres"}', multiQuestionInput)).toBeNull()
    expect(parseQuestionAnswer('{"前端框架？":1,"数据库？":"Postgres"}', multiQuestionInput)).toBeNull()
  })

  it('rejects malformed JSON', () => {
    expect(parseQuestionAnswer('{not json}', singleQuestionInput)).toBeNull()
    expect(parseQuestionAnswer('[1,2]', multiQuestionInput)).toBeNull()
    expect(parseQuestionAnswer('null', multiQuestionInput)).toBeNull()
  })

  it('rejects prototype-dangerous answer keys', () => {
    const proto = { questions: [{ question: '__proto__' }] }
    const ctor = { questions: [{ question: 'constructor' }] }
    const prototype = { questions: [{ question: 'prototype' }] }
    expect(parseQuestionAnswer('{"__proto__":"drop"}', proto)).toBeNull()
    expect(parseQuestionAnswer('{"constructor":"drop"}', ctor)).toBeNull()
    expect(parseQuestionAnswer('{"prototype":"drop"}', prototype)).toBeNull()
  })

  it('rejects malformed question input', () => {
    expect(parseQuestionAnswer('A', null)).toBeNull()
    expect(parseQuestionAnswer('A', undefined)).toBeNull()
    expect(parseQuestionAnswer('A', {})).toBeNull()
    expect(parseQuestionAnswer('A', { questions: 'nope' })).toBeNull()
    expect(parseQuestionAnswer('A', { questions: [] })).toBeNull()
    expect(parseQuestionAnswer('A', { questions: [{ question: '' }] })).toBeNull()
    expect(parseQuestionAnswer('A', { questions: [{ question: '   ' }] })).toBeNull()
    expect(parseQuestionAnswer('A', { questions: [{ question: 42 }] })).toBeNull()
    expect(parseQuestionAnswer('A', { questions: [{ question: 'x' }, { question: 'x' }] })).toBeNull()
  })

  it('does not strip a command prefix and forwards unambiguous text verbatim', () => {
    expect(parseQuestionAnswer('/answer req-1 Axios', singleQuestionInput)).toEqual({
      '选哪个库？': '/answer req-1 Axios',
    })
  })
})

describe('formatQuestionInstructions', () => {
  it('lists the single question and its options with the /answer command', () => {
    const text = formatQuestionInstructions('req-7', singleQuestionInput)
    expect(text).toContain('req-7')
    expect(text).toContain('选哪个库？')
    expect(text).toContain('Axios')
    expect(text).toContain('Fetch')
    expect(text).toContain('/answer req-7')
  })

  it('documents the JSON answers map for multiple questions', () => {
    const text = formatQuestionInstructions('req-9', multiQuestionInput)
    expect(text).toContain('前端框架？')
    expect(text).toContain('数据库？')
    expect(text).toContain('/answer req-9')
    expect(text).toContain('{')
  })

  it('falls back to a generic /answer hint for malformed input', () => {
    expect(formatQuestionInstructions('req-0', null)).toContain('/answer req-0')
    expect(formatQuestionInstructions('req-0', {})).toContain('/answer req-0')
  })
})
