import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildExploreDiscussionInstructions,
  buildExploreDiscussionPrompt,
  selectExploreDiscussionArtifact,
} from '@/lib/explore/discussion'
import { generateExploreTurn } from '@/lib/explore/generation'
import {
  ExploreArtifactContentSchema,
  type ExploreArtifact,
  type ExploreDetail,
  type ExploreTurnRequest,
} from '@/lib/explore/schema'

const sessionId = randomUUID()
const now = new Date().toISOString()
const artifact = (title = 'Clear review requests'): ExploreArtifact => ({
  id: randomUUID(),
  sessionId,
  sourceMessageId: randomUUID(),
  createdAt: now,
  updatedAt: now,
  revision: 1,
  revisionId: randomUUID(),
  state: { exampleFormality: 'neutral', examplePractice0: 'Can you review it?' },
  content: ExploreArtifactContentSchema.parse({
    kind: 'examples',
    title,
    summary: 'Ask a colleague for focused feedback.',
    objectives: ['State what feedback is needed.'],
    sections: [],
    steps: [],
    examples: [
      {
        phrase: 'Could you review this change?',
        context: 'A pull request is ready.',
        formality: 'neutral',
        urgency: 'normal',
        channel: 'Pull request',
        note: 'Name the feedback you need.',
      },
    ],
    nodes: [],
    edges: [],
    questions: [],
    config: { size: 5, values: [], simulation: 'pendulum', pseudocode: '', complexity: '' },
    assumptions: [],
  }),
})
const detail = (): ExploreDetail => ({
  session: {
    id: sessionId,
    title: 'Review practice',
    createdAt: now,
    updatedAt: now,
    version: 2,
    artifactKind: 'examples',
  },
  messages: [],
  nextCursor: null,
  artifacts: [artifact()],
})
const input = (prompt = 'Why is this request polite?'): ExploreTurnRequest => ({
  sessionId,
  requestId: randomUUID(),
  prompt,
  artifactId: null,
  expectedVersion: 2,
})
const completion = (text: string, reason = 'stop') =>
  Response.json({
    id: 'chatcmpl-discussion',
    model: 'mtplx',
    created: 1,
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: reason }],
    usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
  })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('selected artifact discussion context', () => {
  it('retains the lesson focus after global settings change', () => {
    const state = detail()
    const learningContext = {
      selection: {
        path: 'life-skills' as const,
        categoryId: 'public-speaking',
        topicId: 'storytelling',
      },
      level: 'B1' as const,
    }
    state.artifacts[0].content.learningContext = learningContext
    const request = {
      ...input(),
      learningContext: {
        selection: { path: 'professional' as const, roleId: 'frontend-engineer' },
        level: 'C1' as const,
      },
    }
    const prompt = JSON.parse(buildExploreDiscussionPrompt(request, state))
    expect(prompt.selectedArtifact.content.learningContext).toEqual(learningContext)
    expect(JSON.stringify(prompt)).not.toContain('frontend-engineer')
  })

  it('uses the selected legacy artifact instead of another saved lesson and retains its state', () => {
    const state = detail()
    state.artifacts.push(artifact('An unrelated legacy lesson'))
    const request = { ...input(), artifactId: state.artifacts[0].id }
    const prompt = JSON.parse(buildExploreDiscussionPrompt(request, state))
    expect(prompt.selectedArtifact.id).toBe(state.artifacts[0].id)
    expect(prompt.selectedArtifact.content).toEqual(state.artifacts[0].content)
    expect(prompt.selectedArtifact.learningState).toEqual(state.artifacts[0].state)
    expect(JSON.stringify(prompt)).not.toContain('An unrelated legacy lesson')
  })

  it('resolves null to the last artifact in canonical database order, matching the UI', () => {
    const state = detail()
    state.artifacts[0].updatedAt = '2099-01-01T00:00:00Z'
    state.artifacts.push(artifact('Latest created lesson'))
    expect(selectExploreDiscussionArtifact(input(), state).id).toBe(state.artifacts[1].id)
  })

  it.each(['foreign', 'malformed', 'session'] as const)(
    'rejects a %s target before inference',
    async (kind) => {
      const state = detail()
      const request = { ...input(), artifactId: kind === 'malformed' ? 'invalid' : randomUUID() }
      if (kind === 'session') {
        request.artifactId = state.artifacts[0].id
        state.artifacts[0].sessionId = randomUUID()
      }
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      await expect(generateExploreTurn(request, state, AbortSignal.timeout(1000))).rejects.toThrow()
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('includes recent saved discussion while excluding other-artifact turns and unsaved/restore messages', () => {
    const state = detail()
    const otherArtifact = artifact()
    state.artifacts.push(otherArtifact)
    const selected = state.artifacts[0]
    const otherRequest = randomUUID()
    state.messages = [
      {
        id: randomUUID(),
        sessionId,
        role: 'user',
        content: 'What about the unrelated lesson?',
        createdAt: now,
        sequence: 0,
        status: 'complete',
        requestId: otherRequest,
        metadata: {},
      },
      {
        id: randomUUID(),
        sessionId,
        role: 'assistant',
        content: 'UNRELATED fact.',
        createdAt: now,
        sequence: 1,
        status: 'complete',
        requestId: otherRequest,
        metadata: { artifactId: otherArtifact.id },
      },
      {
        id: randomUUID(),
        sessionId,
        role: 'assistant',
        content: 'The request gives the reviewer useful context.',
        createdAt: now,
        sequence: 2,
        status: 'complete',
        requestId: randomUUID(),
        metadata: { artifactId: selected.id },
      },
      {
        id: randomUUID(),
        sessionId,
        role: 'user',
        content: 'FAILED message.',
        createdAt: now,
        sequence: 3,
        status: 'failed',
        requestId: randomUUID(),
        metadata: {},
      },
      {
        id: randomUUID(),
        sessionId,
        role: 'user',
        content: 'RESTORE message.',
        createdAt: now,
        sequence: 4,
        status: 'complete',
        requestId: randomUUID(),
        metadata: { action: 'restore' },
      },
    ]
    const prompt = JSON.parse(
      buildExploreDiscussionPrompt({ ...input(), artifactId: selected.id }, state),
    )
    expect(prompt.recentConversation).toEqual([
      { role: 'assistant', content: 'The request gives the reviewer useful context.' },
    ])
  })

  it('packs a large artifact around the requested item and marks omissions without rejecting the question', () => {
    const state = detail()
    state.artifacts[0].content.examples = Array.from({ length: 40 }, (_, index) => ({
      ...state.artifacts[0].content.examples[0],
      phrase: `Example ${index + 1}: ${'Please consider this review request. '.repeat(18)}`,
      context: 'A detailed context. '.repeat(24),
      note:
        index === 39
          ? 'UNIQUE: Escalate the release blocker to the incident lead.'
          : 'Consider tone carefully. '.repeat(20),
    }))
    const prompt = buildExploreDiscussionPrompt(
      input('Explain example 40 and its release blocker.'),
      state,
    )
    expect(prompt.length).toBeLessThanOrEqual(18000)
    const parsed = JSON.parse(prompt)
    expect(parsed.contextScope).toContain('Excerpt:')
    expect(parsed.selectedArtifact.itemCounts.examples).toBe(40)
    expect(parsed.selectedArtifact.excerpts[0].itemNumber).toBe(40)
    expect(parsed.selectedArtifact.excerpts[0].text).toContain('UNIQUE: Escalate')
    expect(parsed.selectedArtifact.learningState.exampleFormality).toBe('neutral')
    expect(parsed.selectedArtifact.excerpts.length).toBeLessThan(40)
  })

  it('preserves the active tutorial step in a small local context, including a long question', () => {
    vi.stubEnv('MENTOR_COACH_CONTEXT', '4096')
    const state = detail()
    state.artifacts[0].content.kind = 'walkthrough'
    state.artifacts[0].content.steps = Array.from({ length: 20 }, (_, index) => ({
      title: `Step ${index + 1}`,
      body: `Key lesson ${index + 1}. ${'Useful detail. '.repeat(75)}`,
    }))
    state.artifacts[0].state = { walkthroughStep: 19 }
    const prompt = buildExploreDiscussionPrompt(
      input(`Why does this step matter? ${'Explain clearly. '.repeat(180)}`),
      state,
    )
    expect(prompt.length).toBeLessThanOrEqual(6000)
    const parsed = JSON.parse(prompt)
    expect(parsed.selectedArtifact.excerpts[0].field).toBe('steps')
    expect(parsed.selectedArtifact.excerpts[0].itemNumber).toBe(20)
    expect(parsed.contextScope).toContain('Excerpt:')
  })
})

describe('reply-only local follow-ups', () => {
  it.each([
    [
      'Can you translate page to Spanish, yes or no?',
      'Yes, I can translate the phrases into Spanish.',
    ],
    ['Translate the first phrase into Spanish.', '¿Podrías revisar este cambio?'],
    [
      'Create another artifact about gravity.',
      'Use New exploration to create a lesson about gravity.',
    ],
    [
      'Replace this artifact with a simpler explanation.',
      'I can explain it more simply here; the saved lesson stays as it is.',
    ],
    [
      'Add 100 more examples.',
      'We can discuss examples here. Use New exploration for another generated lesson.',
    ],
  ])('discusses %s without generating or revising an artifact', async (question, answer) => {
    const state = detail()
    const original = structuredClone(state.artifacts)
    const fetchMock = vi.fn(async () => completion(answer))
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateExploreTurn(input(question), state, AbortSignal.timeout(1000))
    expect(result).toEqual({ reply: answer, action: 'explain', artifact: null })
    expect(state.artifacts).toEqual(original)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('http://127.0.0.1:8000/v1/chat/completions')
    const body = JSON.parse(String(init.body))
    expect(body.response_format).toBeUndefined()
    expect(body.messages[0].content).toBe(buildExploreDiscussionInstructions())
    const prompt = body.messages[1].content as string
    expect(prompt).toContain('Saved reference context')
    expect(prompt).toContain('Latest learner request — answer this now')
    expect(prompt.endsWith(question)).toBe(true)
    expect(prompt.split(question)).toHaveLength(2)
    expect(prompt).not.toContain('requestedExampleCount')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('cannot turn model-produced action text into an artifact mutation', async () => {
    const text = JSON.stringify({
      reply: 'Replaced.',
      action: 'create',
      artifact: { title: 'A replacement' },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => completion(text)),
    )
    const result = await generateExploreTurn(
      input('Create another artifact'),
      detail(),
      AbortSignal.timeout(1000),
    )
    expect(result.action).toBe('explain')
    expect(result.artifact).toBeNull()
  })

  it('puts a new explanatory question after prior yes/no history', async () => {
    const state = detail()
    state.messages = [
      {
        id: randomUUID(),
        sessionId,
        role: 'user',
        content: 'Can you translate this, yes or no?',
        createdAt: now,
        sequence: 0,
        status: 'complete',
        requestId: randomUUID(),
        metadata: { artifactId: state.artifacts[0].id },
      },
    ]
    const fetchMock = vi.fn(async () =>
      completion('It asks politely without pressuring the reviewer.'),
    )
    vi.stubGlobal('fetch', fetchMock)
    await generateExploreTurn(
      input('Why is the first phrase polite?'),
      state,
      AbortSignal.timeout(1000),
    )
    const prompt = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ).messages[1].content
    expect(prompt).toContain('Can you translate this, yes or no?')
    expect(prompt.indexOf('Can you translate this, yes or no?')).toBeLessThan(
      prompt.indexOf('Latest learner request'),
    )
    expect(prompt.endsWith('Why is the first phrase polite?')).toBe(true)
    expect(buildExploreDiscussionInstructions()).toContain('give the translation')
  })

  it.each([
    ['', 'stop'],
    ['unfinished', 'length'],
  ] as const)(
    'rejects unusable discussion output without an artifact fallback',
    async (text, reason) => {
      const fetchMock = vi.fn(async () => completion(text, reason))
      vi.stubGlobal('fetch', fetchMock)
      await expect(
        generateExploreTurn(input(), detail(), AbortSignal.timeout(1000)),
      ).rejects.toThrow()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it('honors cancellation before starting the model', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateExploreTurn(input(), detail(), AbortSignal.abort())).rejects.toMatchObject(
      { name: 'AbortError' },
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
