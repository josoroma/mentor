import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const revisionKey = 'mentor.learning-revision.v1'
const leaseKey = 'mentor.learning-maintenance.v1'
const createDeferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('learning maintenance across tabs and in-flight saves', () => {
  let values: Map<string, string>
  let surface: EventTarget & { localStorage: Storage }
  let maintenance: typeof import('@/lib/learning/maintenance')

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'))
    values = new Map()
    surface = Object.assign(new EventTarget(), {
      localStorage: {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
        removeItem: vi.fn((key: string) => values.delete(key)),
        clear: () => values.clear(),
        key: (index: number) => [...values.keys()][index] ?? null,
        get length() {
          return values.size
        },
      } as Storage,
    })
    vi.stubGlobal('window', surface)
    vi.stubGlobal('navigator', {})
    maintenance = await import('@/lib/learning/maintenance')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('recovers an expired lease from a closed tab instead of permanently blocking saves', () => {
    values.set(
      leaseKey,
      JSON.stringify({ id: 'closed-tab', expiresAt: Date.now() - 1, changesData: true }),
    )
    expect(() => maintenance.assertLearningWriteAllowed()).not.toThrow()
    expect(values.has(leaseKey)).toBe(false)
  })

  it('does not remove a newer owner that replaced the expired lease during inspection', () => {
    const expired = JSON.stringify({
      id: 'closed-tab',
      expiresAt: Date.now() - 1,
      changesData: true,
    })
    const renewed = JSON.stringify({
      id: 'other-tab',
      expiresAt: Date.now() + 60_000,
      changesData: true,
    })
    values.set(leaseKey, renewed)
    let inspected = false
    vi.mocked(surface.localStorage.getItem).mockImplementation((key) => {
      if (key === leaseKey && !inspected) {
        inspected = true
        return expired
      }
      return values.get(key) ?? null
    })
    expect(() => maintenance.assertLearningWriteAllowed()).toThrow('maintenance is in progress')
    expect(values.get(leaseKey)).toBe(renewed)
    expect(surface.localStorage.removeItem).not.toHaveBeenCalled()
  })

  it('blocks an old tab after another tab changed data until the new revision is acknowledged', () => {
    maintenance.assertLearningWriteAllowed()
    values.set(revisionKey, 'reset-in-other-tab')
    expect(() => maintenance.assertLearningWriteAllowed()).toThrow('changed in another tab')
    maintenance.acknowledgeLearningRevision()
    expect(() => maintenance.assertLearningWriteAllowed()).not.toThrow()
  })

  it('drains an already-running save before reset and rejects additional saves during maintenance', async () => {
    const save = createDeferred<string>()
    const sequence: string[] = []
    const saving = maintenance.runLearningOperation(async () => {
      const result = await save.promise
      sequence.push('save finished')
      return result
    })
    const resetting = maintenance.runLearningMaintenance(
      async () => {
        sequence.push('reset')
        return 'reset complete'
      },
      { changesData: true },
    )
    await expect(maintenance.runLearningOperation(async () => 'late save')).rejects.toThrow(
      'maintenance is in progress',
    )
    expect(sequence).toEqual([])
    save.resolve('saved')
    expect(await saving).toBe('saved')
    expect(await resetting).toBe('reset complete')
    expect(sequence).toEqual(['save finished', 'reset'])
    expect(values.has(leaseKey)).toBe(false)
    expect(values.has(revisionKey)).toBe(true)
    expect(() => maintenance.assertLearningWriteAllowed()).not.toThrow()
  })

  it('drains a failed save without leaving the maintenance queue or marker stuck', async () => {
    const save = createDeferred()
    const saving = maintenance.runLearningOperation(() => save.promise)
    const expectedFailure = expect(saving).rejects.toThrow('Save unavailable')
    const action = vi.fn(async () => 'backup ready')
    const exporting = maintenance.runLearningMaintenance(action, { changesData: false })
    save.reject(new Error('Save unavailable'))
    await expectedFailure
    expect(await exporting).toBe('backup ready')
    expect(action).toHaveBeenCalledOnce()
    expect(values.has(leaseKey)).toBe(false)
    expect(values.has(revisionKey)).toBe(false)
  })

  it('keeps the revision unchanged and releases maintenance after an action fails', async () => {
    values.set(revisionKey, 'before-reset')
    const events: unknown[] = []
    const unsubscribe = maintenance.subscribeLearningMaintenance((event) => events.push(event))
    await expect(
      maintenance.runLearningMaintenance(
        async () => {
          throw new Error('Database reset failed')
        },
        { changesData: true },
      ),
    ).rejects.toThrow('Database reset failed')
    expect(values.get(revisionKey)).toBe('before-reset')
    expect(values.has(leaseKey)).toBe(false)
    expect(events.at(-1)).toEqual({
      phase: 'complete',
      changed: false,
      external: false,
      changesData: true,
    })
    expect(() => maintenance.assertLearningWriteAllowed()).not.toThrow()
    unsubscribe()
  })

  it('renews its own lease but never overwrites or removes a newer competing lease', async () => {
    const held = createDeferred()
    const exporting = maintenance.runLearningMaintenance(() => held.promise, { changesData: false })
    const first = JSON.parse(values.get(leaseKey)!)
    await vi.advanceTimersByTimeAsync(5_000)
    const renewed = JSON.parse(values.get(leaseKey)!)
    expect(renewed.id).toBe(first.id)
    expect(renewed.expiresAt).toBe(first.expiresAt + 5_000)
    const competitor = JSON.stringify({
      id: 'new-owner',
      expiresAt: Date.now() + 60_000,
      changesData: true,
    })
    values.set(leaseKey, competitor)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(values.get(leaseKey)).toBe(competitor)
    held.resolve()
    await exporting
    expect(values.get(leaseKey)).toBe(competitor)
    expect(() => maintenance.assertLearningWriteAllowed()).toThrow('maintenance is in progress')
  })

  it('rejects a queued save if another tab resets before its shared lock is granted', async () => {
    const grant = createDeferred()
    const request = vi.fn(async (_name, _options, action: () => Promise<unknown>) => {
      await grant.promise
      return action()
    })
    vi.stubGlobal('navigator', { locks: { request } })
    const action = vi.fn(async () => 'saved')
    const operation = maintenance.runLearningOperation(action)
    values.set(revisionKey, 'changed-before-lock')
    grant.resolve()
    await expect(operation).rejects.toThrow('changed before this save started')
    expect(action).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith(
      'mentor-learning-data',
      { mode: 'shared' },
      expect.any(Function),
    )
  })

  it('rejects stale maintenance if the revision changes while waiting for its exclusive lock', async () => {
    const grant = createDeferred()
    const waiting = createDeferred()
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_name: string, _options: unknown, action: () => Promise<unknown>) => {
          waiting.resolve()
          await grant.promise
          return action()
        },
      },
    })
    const action = vi.fn(async () => 'reset')
    const operation = maintenance.runLearningMaintenance(action, { changesData: true })
    await waiting.promise
    values.set(revisionKey, 'newer-reset')
    grant.resolve()
    await expect(operation).rejects.toThrow()
    expect(action).not.toHaveBeenCalled()
    expect(values.get(revisionKey)).toBe('newer-reset')
    expect(values.has(leaseKey)).toBe(false)
  })

  it('rejects queued maintenance when a newer tab owns the lease without deleting that lease', async () => {
    const grant = createDeferred()
    const waiting = createDeferred()
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_name: string, _options: unknown, action: () => Promise<unknown>) => {
          waiting.resolve()
          await grant.promise
          return action()
        },
      },
    })
    const action = vi.fn(async () => 'reset')
    const operation = maintenance.runLearningMaintenance(action, { changesData: true })
    await waiting.promise
    const competitor = JSON.stringify({
      id: 'new-owner',
      expiresAt: Date.now() + 60_000,
      changesData: true,
    })
    values.set(leaseKey, competitor)
    grant.resolve()
    await expect(operation).rejects.toThrow()
    expect(action).not.toHaveBeenCalled()
    expect(values.get(leaseKey)).toBe(competitor)
  })

  it('reports external completion with its revision and operation scope and unsubscribes cleanly', () => {
    const listener = vi.fn()
    const unsubscribe = maintenance.subscribeLearningMaintenance(listener)
    const lease = JSON.stringify({
      id: 'other-tab',
      expiresAt: Date.now() + 60_000,
      changesData: true,
    })
    surface.dispatchEvent(
      Object.assign(new Event('storage'), { key: leaseKey, oldValue: null, newValue: lease }),
    )
    expect(listener).toHaveBeenLastCalledWith({
      phase: 'start',
      changed: false,
      external: true,
      changesData: true,
    })
    values.set(revisionKey, 'external-reset')
    surface.dispatchEvent(
      Object.assign(new Event('storage'), { key: leaseKey, oldValue: lease, newValue: null }),
    )
    expect(listener).toHaveBeenLastCalledWith({
      phase: 'complete',
      changed: true,
      external: true,
      changesData: true,
    })
    unsubscribe()
    listener.mockClear()
    surface.dispatchEvent(
      Object.assign(new Event('storage'), { key: leaseKey, oldValue: null, newValue: lease }),
    )
    expect(listener).not.toHaveBeenCalled()
  })
})
