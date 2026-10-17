import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import {
  ExploreMessageImprovementSchema,
  ExploreMessageSchema,
  type ExploreMessage,
} from '@/lib/explore/schema'
import {
  readExploreMessageForImprovement,
  saveExploreMessageImprovement,
} from '@/lib/explore/server'

const messageFixture = (): ExploreMessage => ({
  id: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  role: 'user',
  content: 'I want learn how recursion work',
  createdAt: '2026-10-16T12:00:00Z',
  sequence: 12,
  status: 'failed',
  requestId: crypto.randomUUID(),
  metadata: { expectedVersion: 3 },
})

const setupRead = (message: ExploreMessage | null, history: unknown[] = []) => {
  const row = message
    ? {
        id: message.id,
        session_id: message.sessionId,
        role: message.role,
        content: message.content,
        created_at: message.createdAt,
        sequence: message.sequence,
        status: message.status,
        request_id: message.requestId,
        metadata: message.metadata,
      }
    : null
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    lt: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(async () => ({ data: history, error: null })),
    maybeSingle: vi.fn(async () => ({ data: row, error: null })),
  }
  const from = vi.fn(() => query)
  return {
    identity: { client: { from } as unknown as SupabaseClient, userId: crypto.randomUUID() },
    query,
    from,
  }
}

describe('Explore message improvement contracts', () => {
  it('preserves original wording and arbitrary legacy metadata while typing a saved rewrite', () => {
    const message = messageFixture()
    const improvement = {
      text: 'I want to learn how recursion works.',
      createdAt: '2026-10-16T12:01:00Z',
    }
    expect(ExploreMessageSchema.parse(message)).toEqual(message)
    expect(
      ExploreMessageSchema.parse({ ...message, metadata: { ...message.metadata, improvement } }),
    ).toEqual({ ...message, metadata: { ...message.metadata, improvement } })
  })

  it.each([
    null,
    { text: '', createdAt: '2026-10-16T12:01:00Z' },
    { text: '   ', createdAt: '2026-10-16T12:01:00Z' },
    { text: 'x'.repeat(6001), createdAt: '2026-10-16T12:01:00Z' },
    { text: 'Improved', createdAt: 'yesterday' },
    { text: 'Improved' },
  ])('rejects malformed saved improvement %j', (improvement) => {
    expect(
      ExploreMessageSchema.safeParse({ ...messageFixture(), metadata: { improvement } }).success,
    ).toBe(false)
    expect(ExploreMessageImprovementSchema.safeParse(improvement).success).toBe(false)
  })
})

describe('Explore improvement persistence helpers', () => {
  it('reads a failed learner prompt with only bounded preceding owner-scoped context', async () => {
    const message = messageFixture()
    const { identity, query } = setupRead(message, [
      { role: 'assistant', content: 'The call returns here.', sequence: 11, metadata: {} },
      {
        role: 'user',
        content: 'Restore revision 1.',
        sequence: 10,
        metadata: { action: 'restore' },
      },
      { role: 'user', content: 'Explain the base case.', sequence: 9, metadata: {} },
    ])
    expect(await readExploreMessageForImprovement(identity, message.id)).toEqual({
      message,
      context: [
        { role: 'user', content: 'Explain the base case.' },
        { role: 'assistant', content: 'The call returns here.' },
      ],
    })
    expect(query.eq).toHaveBeenCalledWith('user_id', identity.userId)
    expect(query.eq).toHaveBeenCalledWith('session_id', message.sessionId)
    expect(query.eq).toHaveBeenCalledWith('status', 'complete')
    expect(query.lt).toHaveBeenCalledWith('sequence', message.sequence)
    expect(query.order).toHaveBeenCalledWith('sequence', { ascending: false })
    expect(query.limit).toHaveBeenCalledWith(8)
  })

  it('returns 404 for an inaccessible message before requesting context', async () => {
    const { identity, from } = setupRead(null)
    await expect(
      readExploreMessageForImprovement(identity, crypto.randomUUID()),
    ).rejects.toMatchObject({ status: 404 })
    expect(from).toHaveBeenCalledTimes(1)
  })

  it.each(['assistant', 'restore'] as const)(
    'rejects %s messages before generating context',
    async (kind) => {
      const message = messageFixture()
      if (kind === 'assistant') message.role = 'assistant'
      else message.metadata.action = 'restore'
      const { identity, from } = setupRead(message)
      await expect(readExploreMessageForImprovement(identity, message.id)).rejects.toMatchObject({
        status: 400,
      })
      expect(from).toHaveBeenCalledTimes(1)
    },
  )

  it('returns the canonical first rewrite from the guarded RPC and never sends a caller-selected owner', async () => {
    const message = messageFixture()
    message.metadata.improvement = {
      text: 'First saved rewrite.',
      createdAt: '2026-10-16T12:01:00Z',
    }
    const rpc = vi.fn(async () => ({ data: message, error: null }))
    const identity = { client: { rpc } as unknown as SupabaseClient, userId: crypto.randomUUID() }
    expect(
      await saveExploreMessageImprovement(identity, message.id, ' A different generated rewrite. '),
    ).toEqual(message)
    expect(rpc).toHaveBeenCalledWith('explore_save_message_improvement', {
      p_message_id: message.id,
      p_text: 'A different generated rewrite.',
    })
  })

  it('rejects empty or oversized rewrite text before database writes', async () => {
    const rpc = vi.fn()
    const identity = { client: { rpc } as unknown as SupabaseClient, userId: crypto.randomUUID() }
    for (const text of ['', '  ', 'x'.repeat(6001)])
      await expect(
        saveExploreMessageImprovement(identity, crypto.randomUUID(), text),
      ).rejects.toMatchObject({ status: 400 })
    expect(rpc).not.toHaveBeenCalled()
  })
})
