import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { readExploreDetail, readExploreLibrary } from '@/lib/explore/server'
import type { ExploreLearningContext, ExploreSession } from '@/lib/explore/schema'

const professional: ExploreLearningContext = {
  selection: { path: 'professional', roleId: 'scrum-master' },
  level: 'B1',
}
const lifeSkills: ExploreLearningContext = {
  selection: { path: 'life-skills', categoryId: 'public-speaking', topicId: 'storytelling' },
  level: 'B2',
}
const session = (): ExploreSession => ({
  id: randomUUID(),
  title: 'A saved exploration',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  version: 2,
  artifactKind: 'walkthrough',
})
const query = { page: 0, pageSize: 12, q: '' }
const identity = (rpcData: unknown, rows: unknown[] = [], failure = false) => {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.includes('/rpc/')) return Response.json(rpcData)
    return failure
      ? Response.json({ code: '42501', message: 'Not authorized' }, { status: 403 })
      : Response.json(rows)
  })
  return {
    fetch,
    userId: randomUUID(),
    client: createClient('http://127.0.0.1:54321', 'test-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch },
    }),
  }
}
const library = (sessions: ExploreSession[]) => ({
  sessions,
  total: sessions.length,
  page: 0,
  pageSize: 12,
})

describe('saved exploration learning paths', () => {
  it('labels each lesson from its saved artifact rather than an earlier prompt or current profile', async () => {
    const sessions = [session(), session()]
    const owner = identity(library(sessions), [
      {
        id: sessions[0].id,
        prompts: [{ context: lifeSkills }],
        artifacts: [{ revision: { context: professional } }],
      },
      {
        id: sessions[1].id,
        prompts: [{ context: professional }],
        artifacts: [{ revision: { context: lifeSkills } }],
      },
    ])
    const result = await readExploreLibrary(owner, query)
    expect(result.sessions.map((item) => item.learningContext)).toEqual([professional, lifeSkills])
    const url = new URL(String(owner.fetch.mock.calls[1][0]))
    expect(url.searchParams.get('user_id')).toBe(`eq.${owner.userId}`)
    expect(url.searchParams.get('id')).toBe(`in.(${sessions.map((item) => item.id).join(',')})`)
    expect(url.searchParams.get('prompts.role')).toBe('eq.user')
    expect(url.searchParams.get('prompts.order')).toBe('sequence.asc')
    expect(url.searchParams.get('prompts.limit')).toBe('1')
    expect(url.searchParams.get('artifacts.order')).toBe('created_at.desc,id.desc')
    expect(url.searchParams.get('artifacts.limit')).toBe('1')
  })

  it('uses the original prompt context for conversations that have no generated artifact yet', async () => {
    const saved = session()
    const owner = identity(library([saved]), [
      { id: saved.id, prompts: [{ context: lifeSkills }], artifacts: [] },
    ])
    expect((await readExploreLibrary(owner, query)).sessions[0].learningContext).toEqual(lifeSkills)
  })

  it('keeps a legacy artifact with missing context unknown even if another prompt has a role', async () => {
    const saved = session()
    const owner = identity(library([saved]), [
      {
        id: saved.id,
        prompts: [{ context: professional }],
        artifacts: [{ revision: { context: null } }],
      },
    ])
    expect((await readExploreLibrary(owner, query)).sessions[0].learningContext).toBeUndefined()
  })

  it('retains legacy and empty conversations without inventing a learning path', async () => {
    const sessions = [session(), session()]
    const owner = identity(library(sessions), [
      { id: sessions[0].id, prompts: [{ context: null }], artifacts: [] },
      { id: sessions[1].id, prompts: [], artifacts: [] },
    ])
    expect(
      (await readExploreLibrary(owner, query)).sessions.map((item) => item.learningContext),
    ).toEqual([undefined, undefined])
  })

  it('can recover the original focus for a detail whose paged conversation omits its first prompt', async () => {
    const saved = session()
    const owner = identity({ session: saved, messages: [], artifacts: [], nextCursor: 24 }, [
      { id: saved.id, prompts: [{ context: professional }], artifacts: [] },
    ])
    expect((await readExploreDetail(owner, saved.id)).session.learningContext).toEqual(professional)
  })

  it.each([professional, undefined])(
    'uses a fully loaded original prompt without another read, including legacy missing context',
    async (learningContext) => {
      const saved = session()
      const prompt = {
        id: randomUUID(),
        sessionId: saved.id,
        role: 'user',
        content: 'Explain this topic.',
        createdAt: saved.createdAt,
        sequence: 1,
        status: 'pending',
        requestId: randomUUID(),
        metadata: { learningContext },
      }
      const owner = identity({
        session: saved,
        messages: [
          prompt,
          { ...prompt, id: randomUUID(), sequence: 3, metadata: { learningContext: lifeSkills } },
        ],
        artifacts: [],
        nextCursor: null,
      })
      expect((await readExploreDetail(owner, saved.id)).session.learningContext).toEqual(
        learningContext,
      )
      expect(owner.fetch).toHaveBeenCalledTimes(1)
    },
  )

  it('does not query context for an empty library', async () => {
    const owner = identity(library([]))
    expect(await readExploreLibrary(owner, query)).toEqual(library([]))
    expect(owner.fetch).toHaveBeenCalledTimes(1)
  })

  it('validates saved metadata before using it as a label', async () => {
    const saved = session()
    const owner = identity(library([saved]), [
      {
        id: saved.id,
        prompts: [{ context: { ...professional, level: 'invented' } }],
        artifacts: [],
      },
    ])
    await expect(readExploreLibrary(owner, query)).rejects.toThrow()
  })

  it('reports an ownership failure instead of silently presenting missing metadata', async () => {
    const owner = identity(library([session()]), [], true)
    await expect(readExploreLibrary(owner, query)).rejects.toMatchObject({ status: 403 })
  })
})
