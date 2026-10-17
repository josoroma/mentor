import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { createExploreBackupFixture } from '@/tests/fixtures/explore'
import {
  beginExploreTurn,
  completeExploreTurn,
  parseExploreId,
  readExploreArtifactForPractice,
  requireExploreIdentity,
  throwExploreDatabaseError,
} from '@/lib/explore/server'

describe('Explore initial question learning context', () => {
  const learningContext = {
    selection: { path: 'professional' as const, roleId: 'frontend-engineer' },
    level: 'B2' as const,
  }
  const setup = () => {
    const backup = createExploreBackupFixture()
    backup.messages[0].status = 'pending'
    backup.messages[0].metadata.learningContext = learningContext
    const detail = {
      session: backup.sessions[0],
      messages: backup.messages,
      artifacts: [],
      nextCursor: null,
    }
    const rpc = vi.fn(async (name: string, _args?: unknown) => ({
      data: name === 'explore_read_detail' ? detail : { completed: false },
      error: null,
    }))
    return {
      rpc,
      detail,
      identity: { client: { rpc } as unknown as SupabaseClient, userId: crypto.randomUUID() },
      request: {
        sessionId: backup.sessions[0].id,
        requestId: backup.messages[0].requestId,
        prompt: backup.messages[0].content,
        artifactId: null,
        expectedVersion: 0,
      },
    }
  }

  it('persists context atomically with the original question before inference', async () => {
    const { identity, request, rpc } = setup()
    const result = await beginExploreTurn(identity, { ...request, learningContext })
    expect(rpc).toHaveBeenNthCalledWith(1, 'explore_begin_turn', {
      p_session_id: request.sessionId,
      p_request_id: request.requestId,
      p_prompt: request.prompt,
      p_artifact_id: null,
      p_expected_version: 0,
      p_learning_context: learningContext,
    })
    expect(result.learningContext).toEqual(learningContext)
  })

  it('recovers saved context when a legacy retry omits it', async () => {
    const { identity, request, rpc } = setup()
    const result = await beginExploreTurn(identity, request)
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_learning_context: null })
    expect(result.learningContext).toEqual(learningContext)
  })

  it('still permits legacy prompts without any saved context', async () => {
    const { identity, request, detail } = setup()
    delete detail.messages[0].metadata.learningContext
    expect((await beginExploreTurn(identity, request)).learningContext).toBeUndefined()
  })

  it('rejects invalid saved context before exposing it to inference', async () => {
    const { identity, request, detail } = setup()
    Object.assign(detail.messages[0].metadata, {
      learningContext: { selection: { path: 'professional', roleId: 'invented-role' }, level: 'B2' },
    })
    await expect(beginExploreTurn(identity, request)).rejects.toThrow()
  })
})

describe('Explore authorization and database error boundaries', () => {
  it('requires bearer authentication before touching the database', async () => {
    await expect(
      requireExploreIdentity(new Request('http://127.0.0.1:3000/api/explore/sessions')),
    ).rejects.toMatchObject({ status: 401 })
  })

  it('rejects cross-origin requests even when they present a bearer token', async () => {
    await expect(
      requireExploreIdentity(
        new Request('http://127.0.0.1:3000/api/explore/sessions', {
          headers: { origin: 'https://another-site.example', authorization: 'Bearer example' },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('rejects malformed identifiers before making a query', () => {
    expect(() => parseExploreId('arbitrary-filter,or(user_id.not.is.null)')).toThrow(
      'identifier is invalid',
    )
    const id = crypto.randomUUID()
    expect(parseExploreId(id)).toBe(id)
  })

  it.each([
    ['P0002', 404],
    ['PT409', 409],
    ['40001', 409],
    ['23505', 409],
    ['28000', 401],
    ['PGRST301', 401],
    ['42501', 403],
    ['22023', 400],
  ])('maps %s to HTTP %i', (code, status) => {
    try {
      throwExploreDatabaseError({ code, message: 'Safe database validation message.' })
      expect.fail('Expected a database error')
    } catch (error) {
      expect(error).toMatchObject({ status })
    }
  })

  it('does not expose unexpected internal database failures', () => {
    expect(() =>
      throwExploreDatabaseError({ code: 'XX000', message: 'secret SQL details' }),
    ).toThrow('The exploration database could not complete this operation.')
    expect(() => throwExploreDatabaseError(null)).not.toThrow()
  })
})

describe('Explore practice artifact read boundary', () => {
  it('returns only a validated owned artifact without mutating state or revisions', async () => {
    const artifact = createExploreBackupFixture().artifacts[0]
    const rpc = vi.fn(async () => ({ data: artifact, error: null }))
    const identity = { client: { rpc } as unknown as SupabaseClient, userId: crypto.randomUUID() }
    expect(await readExploreArtifactForPractice(identity, artifact.id)).toEqual(artifact)
    expect(rpc).toHaveBeenCalledExactlyOnceWith('explore_read_artifact', {
      p_artifact_id: artifact.id,
    })
  })

  it('returns 404 for an unavailable artifact without exposing another learner’s data', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }))
    const identity = { client: { rpc } as unknown as SupabaseClient, userId: crypto.randomUUID() }
    await expect(
      readExploreArtifactForPractice(identity, crypto.randomUUID()),
    ).rejects.toMatchObject({ status: 404 })
    expect(rpc).toHaveBeenCalledOnce()
  })

  it('rejects malformed identifiers before querying and invalid stored content before returning it', async () => {
    const rpc = vi.fn(async () => ({ data: { state: {} }, error: null }))
    const identity = { client: { rpc } as unknown as SupabaseClient, userId: crypto.randomUUID() }
    await expect(readExploreArtifactForPractice(identity, 'invalid')).rejects.toMatchObject({
      status: 400,
    })
    expect(rpc).not.toHaveBeenCalled()
    await expect(readExploreArtifactForPractice(identity, crypto.randomUUID())).rejects.toThrow()
  })
})

describe('Explore discussion-only commit boundary', () => {
  const discussionOnly =
    'Chat questions discuss the current artifact. Start a new exploration to create another lesson.'

  it.each(['create', 'revise'] as const)(
    'surfaces the atomic database guard for a %s follow-up without reading or reporting changed artifacts',
    async (action) => {
      const backup = createExploreBackupFixture()
      const rpc = vi.fn(async (_name: string, _args?: unknown) => ({
        data: null,
        error: { code: 'PT409', message: discussionOnly },
      }))
      const identity = { client: { rpc } as unknown as SupabaseClient, userId: crypto.randomUUID() }
      await expect(
        completeExploreTurn(
          identity,
          {
            sessionId: backup.sessions[0].id,
            requestId: crypto.randomUUID(),
            prompt: 'Change the lesson.',
            artifactId: backup.artifacts[0].id,
            expectedVersion: 2,
          },
          { reply: 'Attempted change.', action, artifact: backup.artifacts[0].content },
        ),
      ).rejects.toMatchObject({ status: 409, message: discussionOnly })
      expect(rpc).toHaveBeenCalledTimes(1)
      expect(rpc.mock.calls[0][0]).toBe('explore_complete_turn')
    },
  )

  it('preserves idempotent completed creation replays by leaving the ordered guard inside the RPC', async () => {
    const backup = createExploreBackupFixture()
    const detail = {
      session: backup.sessions[0],
      messages: backup.messages,
      artifacts: backup.artifacts,
      nextCursor: null,
    }
    const rpc = vi.fn(async (name: string) => ({
      data: name === 'explore_read_detail' ? detail : null,
      error: null,
    }))
    const identity = { client: { rpc } as unknown as SupabaseClient, userId: crypto.randomUUID() }
    const request = {
      sessionId: backup.sessions[0].id,
      requestId: backup.messages[0].requestId,
      prompt: backup.messages[0].content,
      artifactId: null,
      expectedVersion: 0,
    }
    expect(
      await completeExploreTurn(identity, request, {
        reply: 'The original completed creation.',
        action: 'create',
        artifact: backup.artifacts[0].content,
      }),
    ).toEqual(detail)
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'explore_complete_turn',
      'explore_read_detail',
    ])
  })
})
