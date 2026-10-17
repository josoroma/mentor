import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { scenarios } from '@/app/_constants'
import { readRemoteScenarioBookmarks, writeRemoteScenarioBookmarks } from '@/lib/supabase/bookmarks'

const row = (index: number) => ({
  scenario_id: `scenario-${String(index).padStart(4, '0')}`,
  scenario: { ...scenarios[0], id: `scenario-${String(index).padStart(4, '0')}` },
  level: 'B2',
  saved_at: '2026-10-15T12:00:00+00:00',
  updated_at: '2026-10-15T12:00:00+00:00',
  saved: index % 2 === 0,
})

const createClient = (
  options: {
    rows?: unknown[]
    cap?: number
    repeated?: boolean
    error?: string
  } = {},
) => {
  const calls: { owner?: string; cursor?: string; rows?: unknown[] }[] = []
  const client = {
    from: vi.fn((table: string) => {
      expect(table).toBe('scenario_bookmarks')
      const call: (typeof calls)[number] = {}
      calls.push(call)
      const query = {
        select: () => query,
        eq: (_key: string, owner: string) => {
          call.owner = owner
          return query
        },
        order: () => query,
        limit: () => query,
        gt: (_key: string, cursor: string) => {
          call.cursor = cursor
          return query
        },
        upsert: (rows: unknown[], conflict: unknown) => {
          expect(conflict).toEqual({ onConflict: 'user_id,scenario_id' })
          call.rows = rows
          return query
        },
        then: (resolve: (value: unknown) => unknown) => {
          const rows = (call.rows ?? options.rows ?? []).filter(
            (item) =>
              options.repeated ||
              !call.cursor ||
              (item as { scenario_id: string }).scenario_id > call.cursor,
          )
          return Promise.resolve(
            resolve({
              data: rows.slice(0, options.cap ?? 500),
              error: options.error ? { message: options.error } : null,
            }),
          )
        },
      }
      return query
    }),
  } as unknown as SupabaseClient
  return { client, calls }
}

describe('Supabase saved scenarios', () => {
  it('pages all owned snapshots and tombstones even with a smaller server cap', async () => {
    const { client, calls } = createClient({
      rows: Array.from({ length: 1_201 }, (_, index) => row(index)),
      cap: 250,
    })
    const records = await readRemoteScenarioBookmarks(client, 'learner-1')
    expect(records).toHaveLength(1_201)
    expect(records[1].saved).toBe(false)
    expect(records[0].savedAt).toBe('2026-10-15T12:00:00.000Z')
    expect(calls).toHaveLength(6)
    expect(calls.every((call) => call.owner === 'learner-1')).toBe(true)
  })

  it('rejects overlapping pages rather than looping or omitting saved records', async () => {
    const { client } = createClient({ rows: [row(1)], repeated: true })
    await expect(readRemoteScenarioBookmarks(client, 'learner-1')).rejects.toThrow('overlapping')
  })

  it.each([
    { ...row(1), scenario_id: 'mismatch' },
    { ...row(1), level: 'unknown' },
    { ...row(1), updated_at: '2025-01-01T00:00:00Z' },
    { ...row(1), scenario: {} },
  ])('rejects malformed database snapshots', async (invalid) => {
    const { client } = createClient({ rows: [invalid] })
    await expect(readRemoteScenarioBookmarks(client, 'learner-1')).rejects.toThrow('invalid')
  })

  it('writes validated snapshots in bounded batches owned by the current learner', async () => {
    const { client, calls } = createClient()
    const records = Array.from({ length: 501 }, (_, index) => ({
      scenario: row(index).scenario,
      level: 'B2' as const,
      savedAt: '2026-10-15T12:00:00.000Z',
      updatedAt: '2026-10-15T12:00:00.000Z',
      saved: index % 2 === 0,
    }))
    expect(await writeRemoteScenarioBookmarks(client, 'learner-1', records)).toEqual(records)
    expect(calls.map((call) => call.rows?.length)).toEqual([500, 1])
    expect(
      calls
        .flatMap((call) => call.rows)
        .every((item) => (item as { user_id: string }).user_id === 'learner-1'),
    ).toBe(true)
  })

  it('rejects partial write acknowledgements instead of reporting false success', async () => {
    const { client } = createClient({ cap: 0 })
    await expect(
      writeRemoteScenarioBookmarks(client, 'learner-1', [
        {
          scenario: scenarios[0],
          level: 'B2',
          saved: true,
          savedAt: '2026-10-15T12:00:00.000Z',
          updatedAt: '2026-10-15T12:00:00.000Z',
        },
      ]),
    ).rejects.toThrow('did not confirm')
  })

  it('reports database errors for retry', async () => {
    const { client } = createClient({ error: 'Offline' })
    await expect(readRemoteScenarioBookmarks(client, 'learner-1')).rejects.toThrow('Offline')
  })
})
