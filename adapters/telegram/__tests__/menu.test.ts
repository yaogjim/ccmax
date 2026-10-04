import { describe, it, expect, mock } from 'bun:test'
import {
  TELEGRAM_BOT_COMMANDS,
  buildTelegramHistoryView,
  buildTelegramSelectionPage,
  parseTelegramHistoryCallback,
  parseTelegramSelectionCallback,
  syncTelegramBotCommands,
} from '../menu.js'

describe('Telegram menu helpers', () => {
  it('keeps bot commands valid for Telegram setMyCommands', () => {
    expect(TELEGRAM_BOT_COMMANDS.length).toBeGreaterThan(0)
    for (const command of TELEGRAM_BOT_COMMANDS) {
      expect(command.command).toMatch(/^[a-z0-9_]{1,32}$/)
      expect(command.description.trim().length).toBeGreaterThan(0)
      expect(command.description.length).toBeLessThanOrEqual(256)
    }
  })

  it('publishes an /answer command for AskUserQuestion replies', () => {
    expect(TELEGRAM_BOT_COMMANDS.some((command) => command.command === 'answer')).toBe(true)
  })

  it('deletes stale bot commands before setting the current menu', async () => {
    const calls: string[] = []
    const api = {
      deleteMyCommands: mock(async () => {
        calls.push('delete')
      }),
      setMyCommands: mock(async () => {
        calls.push('set')
      }),
    }

    await syncTelegramBotCommands(api)

    expect(calls).toEqual(['delete', 'set'])
    expect(api.setMyCommands).toHaveBeenCalledWith(TELEGRAM_BOT_COMMANDS)
  })

  it('builds paginated selection callbacks after eight options', () => {
    const page = buildTelegramSelectionPage({
      kind: 'model',
      token: 'aabbccdd',
      items: Array.from({ length: 9 }, (_, index) => ({
        label: `Model ${index + 1}`,
        value: `model-${index + 1}`,
      })),
      page: 0,
    })

    expect(page.totalPages).toBe(2)
    expect(page.visibleItems).toHaveLength(8)
    expect(page.rows.at(-1)).toEqual([
      { text: '1/2', callbackData: 'tgsel:model:aabbccdd:noop:0' },
      { text: 'Next', callbackData: 'tgsel:model:aabbccdd:page:1' },
    ])
    expect(page.rows[0]?.[0]?.callbackData).toBe('tgsel:model:aabbccdd:pick:0')
    for (const row of page.rows) {
      for (const button of row) {
        expect(button.callbackData.length).toBeLessThanOrEqual(64)
      }
    }
  })

  it('parses tokenized selection callbacks and expires tokenless upgrades', () => {
    expect(parseTelegramSelectionCallback('tgsel:resume_session:aabbccdd:pick:7')).toEqual({
      kind: 'resume_session',
      token: 'aabbccdd',
      action: 'pick',
      index: 7,
    })
    expect(parseTelegramSelectionCallback('tgsel:new_project:deadbeef:pick:0')).toEqual({
      kind: 'new_project',
      token: 'deadbeef',
      action: 'pick',
      index: 0,
    })
    expect(parseTelegramSelectionCallback('tgsel:resume_session:pick:7')).toEqual({
      kind: 'resume_session',
      token: '',
      action: 'pick',
      index: 7,
    })
    expect(parseTelegramSelectionCallback('permit:req:yes')).toBeNull()
    expect(parseTelegramSelectionCallback('tgsel:model:page:-1')).toBeNull()
  })

  it('adds cancel and refresh callbacks for new_project menus', () => {
    const page = buildTelegramSelectionPage({
      kind: 'new_project',
      token: 'aabbccdd',
      items: [{ label: 'repo', value: '/work/repo' }],
      page: 0,
    })
    const callbacks = page.rows.flat().map((button) => button.callbackData)
    expect(callbacks).toContain('tgsel:new_project:aabbccdd:refresh:0')
    expect(callbacks).toContain('tgsel:new_project:aabbccdd:cancel:0')
    expect(parseTelegramSelectionCallback('tgsel:new_project:aabbccdd:cancel:0')).toEqual({
      kind: 'new_project',
      token: 'aabbccdd',
      action: 'cancel',
      index: 0,
    })
    for (const data of callbacks) expect(data.length).toBeLessThanOrEqual(64)
  })

  it('builds history buttons with isolated tgh callbacks at or under 64 bytes', () => {
    const view = buildTelegramHistoryView({
      token: 'aabbccdd',
      kind: 'sessions',
      title: '历史会话：/work/repo',
      page: 1,
      totalPages: 2,
      currentSessionId: 'sess-2',
      items: [
        {
          index: 8,
          label: 'Fix IM',
          value: 'sess-2',
          description: '2026-08-31 12:00 · 3 条消息 · sess-2xx',
        },
      ],
    })

    expect(view.text).toContain('Fix IM（当前）')
    expect(view.text).toContain('3 条消息')
    expect(view.text).toContain('第 2/2 页')
    const callbacks = view.reply_markup.inline_keyboard.flat().map((button) => button.callback_data)
    expect(callbacks).toContain('tgh:aabbccdd:pick:8')
    expect(callbacks).toContain('tgh:aabbccdd:page:0')
    expect(callbacks).toContain('tgh:aabbccdd:projects')
    expect(callbacks).toContain('tgh:aabbccdd:refresh')
    expect(callbacks).toContain('tgh:aabbccdd:cancel')
    for (const data of callbacks) expect(data.length).toBeLessThanOrEqual(64)
  })

  it('parses history callbacks and ignores tgsel data', () => {
    expect(parseTelegramHistoryCallback('tgh:aabbccdd:pick:8')).toEqual({
      token: 'aabbccdd',
      action: 'pick',
      index: 8,
    })
    expect(parseTelegramHistoryCallback('tgh:aabbccdd:projects')).toEqual({
      token: 'aabbccdd',
      action: 'projects',
    })
    expect(parseTelegramHistoryCallback('tgsel:model:aabbccdd:pick:0')).toBeNull()
    expect(parseTelegramHistoryCallback('tgh:aabbccdd:pick')).toBeNull()
  })
})
