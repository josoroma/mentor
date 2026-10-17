import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/explore/artifacts/[id]/improve-practice/route'
import { RequestError } from '@/lib/ai/http'
import {
  buildExplorePracticeImprovementContext,
  ExplorePracticeImprovementRequestSchema,
  ExplorePracticeImprovementResponseSchema,
} from '@/lib/explore/practice-improvement'
import type { ExploreArtifact } from '@/lib/explore/schema'

const mocks = vi.hoisted(() => ({ identity: vi.fn(), read: vi.fn(), generate: vi.fn() }))
vi.mock('@/lib/explore/server', () => ({
  requireExploreIdentity: mocks.identity,
  readExploreArtifactForPractice: mocks.read,
  parseExploreId: (id: string) => {
    if (!z.uuid().safeParse(id).success) throw new RequestError('Invalid artifact.')
    return id
  },
}))
vi.mock('@/lib/explore/improvement', () => ({ generateExploreImprovement: mocks.generate }))

const now = new Date().toISOString()
const artifact: ExploreArtifact = {
  id: randomUUID(),
  sessionId: randomUUID(),
  sourceMessageId: randomUUID(),
  createdAt: now,
  updatedAt: now,
  revision: 2,
  revisionId: randomUUID(),
  state: { examplePractice0: 'My saved original draft' },
  content: {
    kind: 'examples',
    title: 'Ask for a code review',
    summary: 'Practice clear requests.',
    objectives: [],
    sections: [],
    steps: [],
    examples: [
      {
        phrase: 'Please review the completed deployment today.',
        context: 'A teammate has a pull request ready for review.',
        formality: 'neutral',
        urgency: 'normal',
        channel: 'Pull request',
        note: 'Explain the scope of feedback.',
      },
    ],
    nodes: [],
    edges: [],
    questions: [],
    config: { size: 5, values: [], simulation: 'pendulum', pseudocode: '', complexity: '' },
    assumptions: [],
  },
}
const identity = { userId: randomUUID(), client: {} }
const input = {
  exampleIndex: 0,
  expectedRevision: 2,
  text: 'I has not finished yet. Can Ana review two services on Friday?',
}
const improved = 'I have not finished yet. Can Ana review two services on Friday?'
const params = { params: Promise.resolve({ id: artifact.id }) }
const request = (body: unknown = input, options: { signal?: AbortSignal; origin?: string } = {}) =>
  new Request(`http://localhost:3000/api/explore/artifacts/${artifact.id}/improve-practice`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
      ...(options.origin && { origin: options.origin }),
    },
    body: JSON.stringify(body),
    signal: options.signal,
  })

beforeEach(() => {
  mocks.identity.mockResolvedValue(identity)
  mocks.read.mockResolvedValue(structuredClone(artifact))
  mocks.generate.mockResolvedValue(improved)
})
afterEach(() => {
  vi.resetAllMocks()
  vi.restoreAllMocks()
})

describe('practice improvement contract and context', () => {
  it('normalizes only outer whitespace and keeps source distinct from the correction', () => {
    expect(
      ExplorePracticeImprovementRequestSchema.parse({ ...input, text: `  ${input.text}\n` }).text,
    ).toBe(input.text)
    expect(
      ExplorePracticeImprovementResponseSchema.parse({
        text: input.text,
        improvedText: ` ${improved} `,
      }),
    ).toEqual({ text: input.text, improvedText: improved })
  })

  it('uses bounded canonical exercise background without offering the example phrase to copy', () => {
    const context = buildExplorePracticeImprovementContext(input, artifact)
    expect(context).toHaveLength(1)
    expect(context[0].content.length).toBeLessThan(600)
    expect(context[0].content).not.toContain(artifact.content.examples[0].phrase)
    expect(JSON.parse(context[0].content)).toEqual({
      referenceOnly: true,
      exerciseTopic: artifact.content.title,
      situation: artifact.content.examples[0].context,
      exampleFormality: 'neutral',
      exampleUrgency: 'normal',
      channel: 'Pull request',
    })
  })

  it('cannot turn an earlier revision or a non-example lesson into current practice context', () => {
    expect(() =>
      buildExplorePracticeImprovementContext({ ...input, expectedRevision: 1 }, artifact),
    ).toThrow('lesson has changed')
    expect(() =>
      buildExplorePracticeImprovementContext(input, {
        ...artifact,
        content: { ...artifact.content, kind: 'walkthrough' },
      }),
    ).toThrow('example lessons only')
    expect(() =>
      buildExplorePracticeImprovementContext({ ...input, exampleIndex: 1 }, artifact),
    ).toThrow('not part')
  })
})

describe('authenticated practice improvement endpoint', () => {
  it('returns source and correction separately without changing original content, state or revision', async () => {
    const original = structuredClone(artifact)
    mocks.read.mockResolvedValue(original)
    const response = await POST(request({ ...input, text: `  ${input.text}\n` }), params)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ text: input.text, improvedText: improved })
    expect(mocks.read).toHaveBeenCalledWith(identity, artifact.id)
    expect(mocks.generate).toHaveBeenCalledWith(
      input.text,
      buildExplorePracticeImprovementContext(input, artifact),
      expect.any(AbortSignal),
    )
    expect(original).toEqual(artifact)
    expect(mocks.identity.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.read.mock.invocationCallOrder[0],
    )
    expect(mocks.read.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.generate.mock.invocationCallOrder[0],
    )
  })

  it.each([
    { ...input, text: '' },
    { ...input, text: '  ' },
    { ...input, text: 'x'.repeat(2001) },
    { ...input, exampleIndex: -1 },
    { ...input, exampleIndex: 40 },
    { ...input, exampleIndex: 1.5 },
    { ...input, expectedRevision: 0 },
    { ...input, example: 'Client-selected replacement example' },
  ])('rejects invalid or injected client input before reading context', async (body) => {
    expect((await POST(request(body), params)).status).toBe(400)
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('requires authentication before reading the artifact', async () => {
    mocks.identity.mockRejectedValue(new RequestError('Sign in.', 401))
    expect((await POST(request(), params)).status).toBe(401)
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('rejects cross-origin requests before authentication', async () => {
    expect((await POST(request(input, { origin: 'https://example.org' }), params)).status).toBe(403)
    expect(mocks.identity).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('preserves ownership 404 without inference', async () => {
    mocks.read.mockRejectedValue(new RequestError('Artifact not found.', 404))
    expect((await POST(request(), params)).status).toBe(404)
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('validates the artifact identifier before querying', async () => {
    expect((await POST(request(), { params: Promise.resolve({ id: 'invalid' }) })).status).toBe(400)
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('rejects stale revisions before local inference', async () => {
    expect((await POST(request({ ...input, expectedRevision: 1 }), params)).status).toBe(409)
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('rejects a valid numeric index absent from the selected canonical lesson', async () => {
    expect((await POST(request({ ...input, exampleIndex: 39 }), params)).status).toBe(400)
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('rejects non-example lessons before local inference', async () => {
    mocks.read.mockResolvedValue({
      ...artifact,
      content: { ...artifact.content, kind: 'walkthrough' },
    })
    expect((await POST(request(), params)).status).toBe(400)
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it.each(['', 'x'.repeat(2001)])(
    'rejects unusable corrected text instead of truncating or returning the original as a fallback',
    async (text) => {
      mocks.generate.mockResolvedValue(text)
      expect((await POST(request(), params)).status).toBe(503)
    },
  )

  it('reports inference failure explicitly', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.generate.mockRejectedValue(new Error('Local model unavailable'))
    const response = await POST(request(), params)
    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('does not return a late correction after cancellation', async () => {
    const controller = new AbortController()
    mocks.generate.mockImplementation(async () => {
      controller.abort()
      return improved
    })
    expect((await POST(request(input, { signal: controller.signal }), params)).status).toBe(499)
  })

  it('reports timeout before reading or generating', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort())
    expect((await POST(request(), params)).status).toBe(504)
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })
})
