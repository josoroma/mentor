import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { defaultProfile, scenarios } from '@/app/_constants'
import type { SessionRecord } from '@/app/_types'
import { readRemoteLearningBackup, resetRemoteLearningData } from '@/lib/supabase/backup'

const session = (id: string): SessionRecord => ({
  id,
  scenarioId: 'daily-standup',
  roleId: 'deployed-ai-developer',
  level: 'B2',
  startedAt: '2026-10-15T12:00:00.000Z',
  durationSeconds: 120,
  messages: [],
})

const createClient = (
  options: {
    sessions?: unknown[]
    scenarios?: unknown[]
    profile?: unknown
    errorTable?: string
    serverCap?: number
    repeatPages?: boolean
  } = {},
) => {
  const calls: { table: string; cursor?: string; owner?: string }[] = []
  const from = vi.fn((table: string) => {
    const call: (typeof calls)[number] = { table }
    calls.push(call)
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((_column: string, owner: string) => {
        call.owner = owner
        return query
      }),
      order: vi.fn(() => query),
      limit: vi.fn(() => query),
      gt: vi.fn((_column: string, cursor: string) => {
        call.cursor = cursor
        return query
      }),
      maybeSingle: vi.fn(async () => ({
        data: Object.hasOwn(options, 'profile') ? options.profile : { profile: defaultProfile },
        error: options.errorTable === table ? { message: 'Database unavailable' } : null,
      })),
      then: (resolve: (value: unknown) => unknown) => {
        const rows =
          table === 'learning_sessions'
            ? (options.sessions ?? [])
            : (options.scenarios ?? [
                { id: scenarios[0].id, sort_order: 0, configuration: scenarios[0] },
              ])
        const filtered = rows.filter(
          (row) => options.repeatPages || !call.cursor || (row as { id: string }).id > call.cursor,
        )
        return Promise.resolve(
          resolve({
            data: filtered.slice(0, options.serverCap ?? 500),
            error: options.errorTable === table ? { message: 'Database unavailable' } : null,
          }),
        )
      },
    }
    return query
  })
  return { client: { from } as unknown as SupabaseClient, calls, from }
}

describe('read-only Supabase learning backup', () => {
  it('exports more than 1,000 owned sessions, even when the server caps each page below the request', async () => {
    const records = Array.from({ length: 1_201 }, (_, index) => {
      const id = `session-${String(index).padStart(4, '0')}`
      return { id, session: session(id) }
    })
    const { client, calls } = createClient({ sessions: records, serverCap: 250 })
    const backup = await readRemoteLearningBackup(client, 'learner-1')
    expect(backup.sessions).toHaveLength(1_201)
    expect(backup.sessions.at(-1)?.id).toBe('session-1200')
    expect(backup.profile).toEqual(defaultProfile)
    expect(backup.scenarios).toEqual([scenarios[0]])
    expect(calls.filter((call) => call.table === 'learning_sessions')).toHaveLength(6)
    expect(
      calls
        .filter((call) => call.table !== 'scenario_configs')
        .every((call) => call.owner === 'learner-1'),
    ).toBe(true)
  })

  it('returns an absent profile honestly and preserves scenario presentation ordering', async () => {
    const { client } = createClient({
      profile: null,
      scenarios: [
        { id: scenarios[0].id, sort_order: 5, configuration: scenarios[0] },
        { id: scenarios[1].id, sort_order: 1, configuration: scenarios[1] },
      ],
    })
    const backup = await readRemoteLearningBackup(client, 'learner-1')
    expect(backup.profile).toBeNull()
    expect(backup.sessions).toEqual([])
    expect(backup.scenarios).toEqual([scenarios[1], scenarios[0]])
  })

  it.each(['learning_profiles', 'learning_sessions', 'scenario_configs'])(
    'rejects database errors in %s without returning a partial backup',
    async (errorTable) => {
      const { client } = createClient({ errorTable })
      await expect(readRemoteLearningBackup(client, 'learner-1')).rejects.toThrow(
        'Database unavailable',
      )
    },
  )

  it.each([
    { profile: { profile: { name: 'Broken' } } },
    { sessions: [{ id: 'broken', session: { id: 'broken' } }] },
    { sessions: [{ id: 'mismatched', session: session('other') }] },
    { scenarios: [{ id: 'broken', sort_order: 0, configuration: {} }] },
  ])('rejects malformed stored records instead of silently dropping them', async (options) => {
    const { client } = createClient(options)
    await expect(readRemoteLearningBackup(client, 'learner-1')).rejects.toThrow('invalid')
  })

  it('rejects overlapping pages instead of looping or hiding a duplicate record', async () => {
    const { client } = createClient({
      sessions: [{ id: 'one', session: session('one') }],
      repeatPages: true,
    })
    await expect(readRemoteLearningBackup(client, 'learner-1')).rejects.toThrow('overlapping')
  })
})

describe('authenticated Supabase learning reset', () => {
  it('uses the single atomic RPC without a caller-supplied user identifier', async () => {
    const rpc = vi.fn(async () => ({
      data: { deletedSessions: 12, deletedProfiles: 1 },
      error: null,
    }))
    expect(await resetRemoteLearningData({ rpc } as unknown as SupabaseClient)).toEqual({
      deletedSessions: 12,
      deletedProfiles: 1,
    })
    expect(rpc).toHaveBeenCalledWith('reset_learning_data')
  })

  it('does not report success when the RPC fails', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'Database unavailable' } }))
    await expect(resetRemoteLearningData({ rpc } as unknown as SupabaseClient)).rejects.toThrow(
      'Database unavailable',
    )
  })

  it('requires a validated reset acknowledgement before clearing device data', async () => {
    const rpc = vi.fn(async () => ({ data: {}, error: null }))
    await expect(resetRemoteLearningData({ rpc } as unknown as SupabaseClient)).rejects.toThrow(
      'on-device records were retained',
    )
  })
})
