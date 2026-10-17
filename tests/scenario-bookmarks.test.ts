import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultProfile, scenarios } from '@/app/_constants'

const database = vi.hoisted(() => ({
  configured: false,
  local: false,
  authenticate: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
}))

vi.mock('@/lib/supabase/client', () => ({
  isSupabaseConfigured: () => database.configured,
  isLocalSupabaseConfigured: () => database.local,
  getAuthenticatedClient: database.authenticate,
}))
vi.mock('@/lib/supabase/bookmarks', () => ({
  readRemoteScenarioBookmarks: database.read,
  writeRemoteScenarioBookmarks: database.write,
}))

const record = (saved = true, updatedAt = '2026-10-15T12:00:00.000Z') => ({
  scenario: scenarios[0],
  level: 'B2' as const,
  savedAt: '2026-10-15T12:00:00.000Z',
  updatedAt,
  saved,
})

describe('saved scenario persistence', () => {
  let values: Map<string, string>
  let bookmarks: typeof import('@/lib/learning/bookmarks')

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'))
    database.configured = false
    database.local = false
    database.authenticate.mockReset().mockResolvedValue({ client: {}, userId: 'learner-1' })
    database.read.mockReset().mockResolvedValue([])
    database.write.mockReset().mockImplementation(async (_client, _user, records) => records)
    values = new Map([['mentor.profile.v1', JSON.stringify(defaultProfile)]])
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    })
    vi.stubGlobal('navigator', {})
    bookmarks = await import('@/lib/learning/bookmarks')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('saves the full scenario and proficiency on device without creating an identity', async () => {
    const result = await bookmarks.saveScenarioBookmark(scenarios[0], 'C2', true)
    expect(result.data[0]).toMatchObject({ scenario: scenarios[0], level: 'C2', saved: true })
    expect(bookmarks.readScenarioBookmarks()).toEqual(result.data)
    expect(database.authenticate).not.toHaveBeenCalled()
  })

  it('orders quick save/remove/resave actions even within one millisecond', async () => {
    const first = await bookmarks.saveScenarioBookmark(scenarios[0], 'B2', true)
    const removed = await bookmarks.saveScenarioBookmark(scenarios[0], 'B2', false)
    const resaved = await bookmarks.saveScenarioBookmark(scenarios[0], 'B2', true)
    expect(removed.data[0].saved).toBe(false)
    expect(removed.data[0].updatedAt).toBe('2026-10-15T12:00:00.001Z')
    expect(resaved.data[0].savedAt).toBe('2026-10-15T12:00:00.002Z')
    expect(bookmarks.mergeScenarioBookmarks(resaved.data, first.data, removed.data)).toEqual(
      resaved.data,
    )
  })

  it('never revives a tombstone from an older or equally dated saved state', () => {
    const saved = record()
    const removed = record(false)
    expect(bookmarks.mergeScenarioBookmarks([saved], [removed])[0].saved).toBe(false)
    expect(bookmarks.mergeScenarioBookmarks([removed], [saved])[0].saved).toBe(false)
    expect(
      bookmarks.mergeScenarioBookmarks([record(false, '2026-10-15T12:00:01.000Z')], [saved])[0]
        .saved,
    ).toBe(false)
  })

  it('sorts newest saved scenarios first with stable identifier tie-breaking', () => {
    const older = record()
    const newer = {
      ...record(),
      scenario: scenarios[1],
      savedAt: '2026-10-15T12:01:00.000Z',
      updatedAt: '2026-10-15T12:01:00.000Z',
    }
    expect(bookmarks.mergeScenarioBookmarks([older, newer])).toEqual([newer, older])
  })

  it('validates snapshot, level and chronology at the cache boundary', () => {
    expect(() =>
      bookmarks.writeScenarioBookmarks([{ ...record(), level: 'bad' as 'B2' }]),
    ).toThrow()
    expect(() =>
      bookmarks.writeScenarioBookmarks([{ ...record(), updatedAt: '2026-10-14T12:00:00.000Z' }]),
    ).toThrow()
    expect(values.has(bookmarks.SCENARIO_BOOKMARKS_KEY)).toBe(false)
  })

  it('recovers valid bookmarks without trusting malformed cache entries', () => {
    values.set(bookmarks.SCENARIO_BOOKMARKS_KEY, JSON.stringify([record(), { invalid: true }]))
    expect(bookmarks.readScenarioBookmarks()).toEqual([record()])
    values.set(bookmarks.SCENARIO_BOOKMARKS_KEY, '{broken')
    expect(bookmarks.readScenarioBookmarks()).toEqual([])
  })

  it('never contacts hosted Supabase when the saved profile is local-only', async () => {
    database.configured = true
    await bookmarks.saveScenarioBookmark(scenarios[0], 'B2', true, { sync: true })
    await bookmarks.loadScenarioBookmarks({ sync: true })
    expect(database.authenticate).not.toHaveBeenCalled()
  })

  it('allows configured loopback Supabase while preserving local-only privacy', async () => {
    database.configured = true
    database.local = true
    const result = await bookmarks.saveScenarioBookmark(scenarios[0], 'B2', true, { sync: true })
    expect(result.error).toBeUndefined()
    expect(database.write).toHaveBeenCalledWith({}, 'learner-1', result.data)
  })

  it('syncs hosted Supabase only after explicit profile and caller opt-in', async () => {
    database.configured = true
    values.set('mentor.profile.v1', JSON.stringify({ ...defaultProfile, localOnly: false }))
    await bookmarks.saveScenarioBookmark(scenarios[0], 'B2', true, { sync: false })
    expect(database.authenticate).not.toHaveBeenCalled()
    await bookmarks.loadScenarioBookmarks({ sync: true })
    expect(database.authenticate).toHaveBeenCalledOnce()
  })

  it('retains unsaves on device when the database fails', async () => {
    database.configured = true
    database.local = true
    database.read.mockRejectedValue(new Error('Database is unavailable'))
    const result = await bookmarks.saveScenarioBookmark(scenarios[0], 'B2', false, { sync: true })
    expect(result.error).toContain('Database is unavailable')
    expect(result.data[0].saved).toBe(false)
    expect(bookmarks.readScenarioBookmarks()).toEqual(result.data)
  })

  it('merges a fresh local removal after a delayed remote read and uploads the tombstone', async () => {
    database.configured = true
    database.local = true
    await bookmarks.saveScenarioBookmark(scenarios[0], 'B2', true)
    database.read.mockImplementationOnce(async () => {
      await bookmarks.saveScenarioBookmark(scenarios[0], 'B2', false)
      return [record()]
    })
    const result = await bookmarks.loadScenarioBookmarks({ sync: true })
    expect(result.data[0].saved).toBe(false)
    expect(database.write.mock.calls[0][2][0].saved).toBe(false)
  })

  it('retains a fresh local removal after a delayed remote write response', async () => {
    database.configured = true
    database.local = true
    database.write.mockImplementationOnce(async (_client, _user, records) => {
      await bookmarks.saveScenarioBookmark(scenarios[0], 'B2', false)
      return records
    })
    const result = await bookmarks.saveScenarioBookmark(scenarios[0], 'B2', true, { sync: true })
    expect(result.data[0].saved).toBe(false)
  })

  it('stops an upload when hosted sync permission is revoked during the read', async () => {
    database.configured = true
    values.set('mentor.profile.v1', JSON.stringify({ ...defaultProfile, localOnly: false }))
    database.read.mockImplementationOnce(async () => {
      values.set('mentor.profile.v1', JSON.stringify(defaultProfile))
      return []
    })
    await bookmarks.saveScenarioBookmark(scenarios[0], 'B2', true, { sync: true })
    expect(database.write).not.toHaveBeenCalled()
  })

  it('does not merge an upload response after hosted sync permission is revoked', async () => {
    database.configured = true
    values.set('mentor.profile.v1', JSON.stringify({ ...defaultProfile, localOnly: false }))
    database.write.mockImplementationOnce(async (_client, _user, records) => {
      values.set('mentor.profile.v1', JSON.stringify(defaultProfile))
      return [...records, { ...record(), scenario: scenarios[1] }]
    })
    const result = await bookmarks.saveScenarioBookmark(scenarios[0], 'B2', true, { sync: true })
    expect(result.data.map((item) => item.scenario.id)).toEqual([scenarios[0].id])
    expect(bookmarks.readScenarioBookmarks()).toEqual(result.data)
  })

  it('reads the latest cross-tab cache only after acquiring its exclusive cache lock', async () => {
    let release!: () => void
    let started!: () => void
    const granted = new Promise<void>((resolve) => {
      release = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      started = resolve
    })
    const request = vi.fn(
      async (name: string, options: { mode: string }, action: () => unknown) => {
        if (name === 'mentor-scenario-bookmarks-cache') {
          expect(options.mode).toBe('exclusive')
          started()
          await granted
        }
        return action()
      },
    )
    vi.stubGlobal('navigator', { locks: { request } })
    const saving = bookmarks.saveScenarioBookmark(scenarios[0], 'B2', true)
    await waiting
    // A different tab finishes its own cache write before this tab receives the lock.
    values.set(
      bookmarks.SCENARIO_BOOKMARKS_KEY,
      JSON.stringify([{ ...record(), scenario: scenarios[1] }]),
    )
    release()
    const result = await saving
    expect(result.data.map((item) => item.scenario.id).sort()).toEqual(
      [scenarios[0].id, scenarios[1].id].sort(),
    )
    expect(request).toHaveBeenCalledWith(
      'mentor-learning-data',
      { mode: 'shared' },
      expect.any(Function),
    )
  })

  it('locks every sync cache merge without keeping the cache locked during network calls', async () => {
    database.configured = true
    database.local = true
    let cacheLocked = false
    const request = vi.fn(async (name: string, _options: unknown, action: () => unknown) => {
      if (name !== 'mentor-scenario-bookmarks-cache') return action()
      cacheLocked = true
      try {
        const result = action()
        expect(result).not.toBeInstanceOf(Promise)
        return result
      } finally {
        cacheLocked = false
      }
    })
    vi.stubGlobal('navigator', { locks: { request } })
    database.read.mockImplementationOnce(async () => {
      expect(cacheLocked).toBe(false)
      return []
    })
    database.write.mockImplementationOnce(async (_client, _user, records) => {
      expect(cacheLocked).toBe(false)
      return records
    })
    await bookmarks.saveScenarioBookmark(scenarios[0], 'B2', true, { sync: true })
    expect(
      request.mock.calls.filter(([name]) => name === 'mentor-scenario-bookmarks-cache'),
    ).toHaveLength(3)
  })

  it('blocks saves during maintenance and after an external reset', async () => {
    values.set(
      'mentor.learning-maintenance.v1',
      JSON.stringify({ id: 'backup', expiresAt: Date.now() + 60_000, changesData: true }),
    )
    await expect(bookmarks.saveScenarioBookmark(scenarios[0], 'B2', true)).rejects.toThrow(
      'maintenance is in progress',
    )
    values.delete('mentor.learning-maintenance.v1')
    values.set('mentor.learning-revision.v1', 'reset-elsewhere')
    await expect(bookmarks.loadScenarioBookmarks()).rejects.toThrow('changed in another tab')
  })
})
