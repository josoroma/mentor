import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionRecord } from '@/app/_types'
import type { PersistenceResult } from '@/lib/learning/persistence'
import { createSessionAutosave } from '@/lib/learning/session-autosave'

const snapshot = (
  second: number,
  status: SessionRecord['status'] = 'in-progress',
): SessionRecord => ({
  id: 'session-live',
  scenarioId: 'daily-standup',
  roleId: 'deployed-ai-developer',
  level: 'B2',
  startedAt: '2026-10-15T12:00:00.000Z',
  updatedAt: new Date(Date.UTC(2026, 9, 15, 12, 0, second)).toISOString(),
  durationSeconds: second,
  messages: [],
  status,
})

const success = (session: SessionRecord): PersistenceResult<SessionRecord> => ({
  data: session,
  mode: 'local',
  syncStatus: 'local',
})

describe('live session autosave', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces rapid transcript updates without waiting for a quiet interval', async () => {
    const save = vi.fn(async (session: SessionRecord) => success(session))
    const cache = vi.fn()
    const onChange = vi.fn()
    const controller = createSessionAutosave({ save, cache, onChange, destination: 'device' })
    controller.update(snapshot(1))
    await vi.advanceTimersByTimeAsync(500)
    controller.update(snapshot(2))
    await vi.advanceTimersByTimeAsync(250)
    expect(save).toHaveBeenCalledOnce()
    expect(save).toHaveBeenLastCalledWith(snapshot(2))
    expect(cache).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith({
      status: 'saved',
      destination: 'device',
      error: null,
    })
    controller.dispose()
  })

  it('serializes a completed flush behind an in-flight partial write', async () => {
    let release!: (value: PersistenceResult<SessionRecord>) => void
    const save = vi
      .fn<(value: SessionRecord) => Promise<PersistenceResult<SessionRecord>>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      )
      .mockImplementation(async (session) => success(session))
    const controller = createSessionAutosave({
      save,
      cache: vi.fn(),
      onChange: vi.fn(),
      destination: 'device',
    })
    controller.update(snapshot(1))
    await vi.advanceTimersByTimeAsync(750)
    const flushing = controller.flush(snapshot(3, 'completed'))
    expect(save).toHaveBeenCalledTimes(1)
    release(success(snapshot(1)))
    expect(await flushing).toBe(true)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith(snapshot(3, 'completed'))
    controller.dispose()
  })

  it('reports a failed database save and retries the latest snapshot automatically', async () => {
    const save = vi
      .fn<(value: SessionRecord) => Promise<PersistenceResult<SessionRecord>>>()
      .mockResolvedValueOnce({
        data: snapshot(1),
        mode: 'local',
        syncStatus: 'error',
        error: 'Database offline',
      })
      .mockImplementation(async (session) => success(session))
    const onChange = vi.fn()
    const controller = createSessionAutosave({
      save,
      cache: vi.fn(),
      onChange,
      destination: 'device',
    })
    expect(await controller.flush(snapshot(1))).toBe(false)
    expect(onChange).toHaveBeenLastCalledWith({
      status: 'error',
      destination: 'device',
      error: 'Database offline',
    })
    controller.update(snapshot(2))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(save).toHaveBeenLastCalledWith(snapshot(2))
    expect(onChange).toHaveBeenLastCalledWith({
      status: 'saved',
      destination: 'device',
      error: null,
    })
    controller.dispose()
  })

  it('continues to the database when writing the recovery cache fails', async () => {
    const save = vi.fn(async (session: SessionRecord) => success(session))
    const controller = createSessionAutosave({
      save,
      cache: () => {
        throw new Error('Quota exceeded')
      },
      onChange: vi.fn(),
      destination: 'device',
    })
    expect(await controller.flush(snapshot(1))).toBe(true)
    expect(save).toHaveBeenCalledOnce()
    controller.dispose()
  })
})
