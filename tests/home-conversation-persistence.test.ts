import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createHomeConversationAutosave } from '@/app/_home-conversation-autosave'
import {
  createHomeConversationMessages,
  createHomeConversationRecords,
  createHomeConversationScenario,
  type HomeConversationTurn,
} from '@/app/_home-conversation-records'
import type { SessionRecord, TranscriptImprovement } from '@/app/_types'
import type { PersistenceResult } from '@/lib/learning/persistence'

const profile = { roleId: 'deployed-ai-developer', level: 'B1' as const }
const personas = { alex: 'jordan', sam: 'riley' } as const
const scenario = createHomeConversationScenario({
  id: 'conversation-1',
  topic: 'Planning a customer handover',
  profile,
  selection: { path: 'professional', roleId: profile.roleId },
  personas,
  openingLine: 'We can prepare a visual guide.',
})
const started = Date.parse('2026-10-17T10:00:00.000Z')
const turn = (
  index: number,
  speaker: HomeConversationTurn['speaker'] = 'user',
): HomeConversationTurn => ({
  id: `turn-${index}`,
  speaker,
  text: speaker === 'user' ? '  We needs a visual guide.  ' : 'Which part should we explain?',
  timestamp: started + index * 1_000,
})
const records = (turns: HomeConversationTurn[], improvements: TranscriptImprovement[] = []) =>
  createHomeConversationRecords({
    id: 'conversation-1',
    scenario,
    profile,
    messages: createHomeConversationMessages(turns, personas),
    improvements,
  })
const improved = (index: number): TranscriptImprovement => ({
  messageId: `turn-${index}`,
  original: turn(index).text,
  improved: 'We need a visual guide.',
  isFinal: true,
  updatedAt: '2026-10-17T11:00:00.000Z',
})

describe('homepage conversation records', () => {
  it('creates no learner history for an AI-only conversation', () => {
    expect(records([turn(0, 'alex'), turn(1, 'sam')])).toEqual([])
  })

  it('preserves actual learner words and the named AI context after joining', () => {
    const [record] = records(
      [turn(0, 'alex'), turn(1, 'sam'), turn(2), turn(8, 'alex')],
      [improved(2)],
    )
    expect(record.messages.map((message) => [message.role, message.content])).toEqual([
      ['assistant', 'Jordan: Which part should we explain?'],
      ['assistant', 'Riley: Which part should we explain?'],
      ['user', '  We needs a visual guide.  '],
      ['assistant', 'Jordan: Which part should we explain?'],
    ])
    expect(record.durationSeconds).toBe(6)
    expect(record.status).toBe('in-progress')
    expect(record.feedback).toBeUndefined()
    expect(record.improvements).toEqual([improved(2)])
  })

  it('rejects invalid and duplicate source turns at the transcript boundary', () => {
    expect(() => records([turn(0), turn(0)])).toThrow(/unique/)
    expect(() => records([{ ...turn(0), timestamp: Infinity }])).toThrow()
    expect(() => records([{ ...turn(0), text: '' }])).toThrow()
  })

  it('does not silently truncate a long named AI turn', () => {
    const text = 'a'.repeat(20_000)
    const [record] = records([{ ...turn(0, 'alex'), text }, turn(1)])
    const aiText = record.messages.filter((message) => message.role === 'assistant')
    expect(aiText.map((message) => message.content).join('')).toBe(`Jordan: ${text}`)
    expect(aiText.every((message) => message.content.length <= 20_000)).toBe(true)
  })

  it('keeps every turn and its correction across the 1,000-message storage boundary', () => {
    const turns = Array.from({ length: 1_003 }, (_, index) => turn(index))
    const parts = records(turns, [improved(999), improved(1_000)])
    expect(parts.map((part) => part.messages.length)).toEqual([1_000, 3])
    expect(parts.flatMap((part) => part.messages.map((message) => message.id))).toEqual(
      turns.map((item) => item.id),
    )
    expect(parts[0].improvements).toEqual([improved(999)])
    expect(parts[1].improvements).toEqual([improved(1_000)])
    expect(records(turns.slice(0, 1_001))[0].id).toBe(parts[0].id)
    expect(parts[1].id).not.toBe(parts[0].id)
  })

  it('rolls over long conversations without truncating time or dropping messages', () => {
    const turns = [turn(0), turn(86_400), turn(86_401), turn(172_802)]
    const parts = records(turns)
    expect(parts.map((part) => part.messages.length)).toEqual([2, 1, 1])
    expect(parts[0].durationSeconds).toBe(86_400)
    expect(parts.flatMap((part) => part.messages)).toHaveLength(4)
  })

  it('does not attach stale corrections or AI quotations as learner improvements', () => {
    const stale = { ...improved(1), original: 'Something the learner never said.' }
    const [record] = records([turn(0, 'alex'), turn(1)], [improved(0), stale, improved(2)])
    expect(record.improvements).toEqual([])
  })
})

const saved = (session: SessionRecord): PersistenceResult<SessionRecord> => ({
  data: session,
  mode: 'local',
  syncStatus: 'local',
})

describe('homepage conversation autosave', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('flushes an earlier exchange without replacing it when a new exchange starts', async () => {
    const oldRecord = records([turn(0)])[0]
    const newRecord = { ...oldRecord, id: 'home-conversation-2-part-1' }
    let release!: (result: PersistenceResult<SessionRecord>) => void
    const save = vi
      .fn<(session: SessionRecord) => Promise<PersistenceResult<SessionRecord>>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      )
      .mockImplementation(async (session) => saved(session))
    const cache = vi.fn()
    const controller = createHomeConversationAutosave({
      save,
      cache,
      onChange: vi.fn(),
      destination: 'device',
    })
    controller.update([oldRecord])
    await vi.advanceTimersByTimeAsync(750)
    controller.update([newRecord])
    const flushing = controller.flush()
    release(saved(oldRecord))
    expect(await flushing).toBe(true)
    expect(save.mock.calls.map(([session]) => session.id)).toEqual([oldRecord.id, newRecord.id])
    expect(cache).toHaveBeenCalledWith(oldRecord)
    expect(cache).toHaveBeenCalledWith(newRecord)
    controller.dispose()
  })

  it('updates only changed parts and preserves corrections in later writes', async () => {
    const turns = Array.from({ length: 1_001 }, (_, index) => turn(index))
    const first = records(turns)
    const save = vi.fn(async (session: SessionRecord) => saved(session))
    const controller = createHomeConversationAutosave({
      save,
      cache: vi.fn(),
      onChange: vi.fn(),
      destination: 'device',
    })
    controller.update(first)
    expect(await controller.flush()).toBe(true)
    controller.update(records(turns, [improved(1_000)]))
    expect(await controller.flush()).toBe(true)
    expect(save.mock.calls.map(([session]) => session.id)).toEqual([
      first[0].id,
      first[1].id,
      first[1].id,
    ])
    expect(save.mock.calls.at(-1)?.[0].improvements).toEqual([improved(1_000)])
    controller.dispose()
  })

  it('retains failed previous-part saves and retries them with all local copies intact', async () => {
    const [record] = records([turn(0)])
    const onChange = vi.fn()
    const cache = vi.fn()
    const save = vi
      .fn<(session: SessionRecord) => Promise<PersistenceResult<SessionRecord>>>()
      .mockResolvedValueOnce({
        ...saved(record),
        syncStatus: 'error',
        error: 'Loopback database unavailable',
      })
      .mockImplementation(async (session) => saved(session))
    const controller = createHomeConversationAutosave({
      save,
      cache,
      onChange,
      destination: 'supabase',
    })
    controller.update([record])
    expect(await controller.flush()).toBe(false)
    expect(onChange.mock.lastCall?.[0].status).toBe('error')
    controller.update([{ ...record, id: 'home-another-part-1' }])
    controller.retry()
    expect(await controller.flush()).toBe(true)
    expect(cache.mock.calls.map(([session]) => session.id)).toContain(record.id)
    expect(onChange.mock.lastCall?.[0]).toEqual({
      status: 'saved',
      destination: 'device',
      error: null,
    })
    controller.dispose()
  })

  it('flushes the most recent buffered originals when the homepage unmounts', async () => {
    const [record] = records([turn(0), turn(1, 'alex')])
    const save = vi.fn(async (session: SessionRecord) => saved(session))
    const controller = createHomeConversationAutosave({
      save,
      cache: vi.fn(),
      onChange: vi.fn(),
      destination: 'device',
    })
    controller.update([record])
    controller.dispose()
    await vi.runAllTimersAsync()
    expect(save).toHaveBeenCalledWith(record)
  })
})
