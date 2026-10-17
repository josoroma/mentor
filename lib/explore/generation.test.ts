import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildExploreInstructions,
  buildExplorePrompt,
  generateExploreTurn,
  getRequestedExampleCount,
} from '@/lib/explore/generation'
import {
  ExploreArtifactContentSchema,
  type ExploreDetail,
  type ExploreEdgeEvidence,
  type ExploreTurnRequest,
} from '@/lib/explore/schema'

const sessionId = randomUUID()
const artifactId = randomUUID()
const now = new Date().toISOString()
const content = ExploreArtifactContentSchema.parse({
  kind: 'walkthrough',
  title: 'A focused retrospective',
  summary: 'Improve one team process together.',
  objectives: ['Agree on a useful improvement'],
  sections: [],
  steps: [{ title: 'Set the stage', body: 'Invite observations without assigning blame.' }],
  examples: [],
  nodes: [],
  edges: [],
  questions: [],
  config: { size: 5, values: [], simulation: 'pendulum', pseudocode: '', complexity: '' },
  assumptions: [],
})
const detail = (saved = false): ExploreDetail => ({
  session: {
    id: sessionId,
    title: 'Team learning',
    createdAt: now,
    updatedAt: now,
    version: 0,
    artifactKind: null,
  },
  messages: [],
  nextCursor: null,
  artifacts: saved
    ? [
        {
          id: artifactId,
          sessionId,
          sourceMessageId: randomUUID(),
          createdAt: now,
          updatedAt: now,
          revision: 2,
          revisionId: randomUUID(),
          content,
          state: { step: 0 },
        },
      ]
    : [],
})
const input = (prompt = 'Explain an effective Sprint Retrospective'): ExploreTurnRequest => ({
  sessionId,
  requestId: randomUUID(),
  prompt,
  artifactId: null,
  expectedVersion: 0,
})
const draft = {
  reply: 'Start with observations, then agree on one improvement to try.',
  action: 'create',
  artifact: content,
}
const completion = (value: unknown = draft, reason = 'stop') =>
  Response.json({
    id: 'chatcmpl-explore',
    model: 'mtplx',
    created: 1,
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify(value) },
        finish_reason: reason,
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 600, total_tokens: 700 },
  })
const exampleContent = (count: number) => ({
  ...content,
  kind: 'examples',
  examples: Array.from({ length: count }, (_, index) => ({
    phrase: `Could you review change ${index + 1} when you have time?`,
    context: `A teammate has context on change ${index + 1}.`,
    formality: 'neutral',
    urgency: 'normal',
    channel: 'Pull request',
    note: 'State what feedback you need.',
  })),
})
const diagramContent = (evidence?: ExploreEdgeEvidence) =>
  ExploreArtifactContentSchema.parse({
    ...content,
    kind: 'diagram',
    title: 'Request flow',
    nodes: [
      { id: 'client', label: 'Client', detail: 'Starts the request.' },
      { id: 'api', label: 'API', detail: 'Handles the request.' },
      { id: 'database', label: 'Database', detail: 'Stores records.' },
    ],
    edges: [{ from: 'client', to: 'api', label: 'requests', evidence }],
    steps: [
      { title: 'Request', body: 'The client sends a request.', focus: ['client', 'api'] },
      { title: 'Processing', body: 'The API processes the request.', focus: ['api'] },
      { title: 'Persistence', body: 'The database stores a record.', focus: ['database'] },
    ],
    config: { ...content.config, diagram: { view: 'flow', layout: 'horizontal' } },
  })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('Explore prompt context', () => {
  it('uses the complete saved focus and level for a manually entered exploration', () => {
    const request = {
      ...input('Help me tell a clear story'),
      learningContext: {
        selection: {
          path: 'life-skills' as const,
          categoryId: 'public-speaking',
          topicId: 'storytelling',
        },
        level: 'B1' as const,
      },
    }
    const prompt = JSON.parse(buildExplorePrompt(request, detail()))
    expect(prompt.learningFocus.label).toBe('Public Speaking · Storytelling')
    expect(prompt.englishLevel).toBe('B1')
    expect(JSON.stringify(prompt)).not.toContain('Forward-Deployed')
  })

  it('persists the requested focus with the artifact without accepting model-invented settings', async () => {
    const learningContext = {
      selection: { path: 'professional' as const, roleId: 'deployed-ai-developer' },
      level: 'C1' as const,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        completion({
          ...draft,
          artifact: {
            ...content,
            learningContext: {
              selection: { path: 'professional', roleId: 'product-engineer' },
              level: 'A2',
            },
          },
        }),
      ),
    )
    const result = await generateExploreTurn(
      { ...input(), learningContext },
      detail(),
      AbortSignal.timeout(1000),
    )
    expect(result.artifact?.learningContext).toEqual(learningContext)
  })

  it.each([
    ['Teach me 20 different ways to ask for a code review in English', 20],
    ['Show twenty examples of professional disagreement', 20],
    ['Show twenty-one examples of professional disagreement', 21],
    ['Give me 5 realistic examples', 5],
    ['Explain 20 disks in Hanoi', null],
  ])('honors example counts in %s', (prompt, expected) => {
    expect(getRequestedExampleCount(prompt)).toBe(expected)
  })
  it('limits initial example requests without silently truncating them', () => {
    expect(getRequestedExampleCount('Give 3 examples')).toBe(3)
    expect(() => getRequestedExampleCount('Give 41 examples')).toThrow('1 to 40')
  })
  it('keeps the selected full revision and only complete persisted conversational context', () => {
    const state = detail(true)
    state.messages = Array.from({ length: 30 }, (_, index) => ({
      id: randomUUID(),
      sessionId,
      role: index % 2 ? 'assistant' : 'user',
      content: `Message ${index}: ${'a'.repeat(1200)}`,
      createdAt: now,
      sequence: index,
      status: index === 29 ? 'failed' : 'complete',
      requestId: randomUUID(),
      metadata: {},
    }))
    const prompt = JSON.parse(
      buildExplorePrompt({ ...input('Explain this more simply'), artifactId }, state),
    )
    expect(prompt.selectedArtifact.content).toEqual(content)
    expect(prompt.selectedArtifact.revision).toBe(2)
    expect(prompt.selectedArtifact.learningState).toEqual({ step: 0 })
    expect(prompt.recentConversation.length).toBeLessThanOrEqual(12)
    expect(prompt.recentConversation.at(-1).content).toContain('Message 28:')
    expect(JSON.stringify(prompt.recentConversation)).not.toContain('Message 29:')
    expect(JSON.stringify(prompt).length).toBeLessThan(10_000)
  })
  it('rejects a target outside the persisted exploration', () => {
    expect(() =>
      buildExplorePrompt({ ...input(), artifactId: randomUUID() }, detail(true)),
    ).toThrow('does not belong')
  })
  it('keeps trusted rendering boundaries and factual caveats explicit', () => {
    const instructions = buildExploreInstructions()
    expect(instructions).toContain('ONLY a stable ascending bubble-sort')
    expect(instructions).toContain('story points are not hours')
    expect(instructions).toContain('not a Scrum requirement')
    expect(instructions).toContain('No remote resources or invented citations')
    expect(instructions).toContain('untrusted learning context')
    expect(instructions).toContain('Always use action=create')
    expect(instructions).not.toContain(
      'If a new subject or additional artifact is requested, create',
    )
  })
  it.each([
    'Explain git rebase using svg or threejs or wasm interactive',
    'Show a data-flow diagram for a request',
    'Explain this architecture',
    'Create a sequence diagram of a checkout',
    'Let me inspect the parts of a motor',
    'Create an interactive diagram of the water cycle',
    'Show a reversible disassembly of a camera',
    'Show a workflow diagram for release approval',
    'Draw lifecycle diagrams for a browser request',
  ])('chooses visual data for %s', (prompt) => {
    expect(
      JSON.parse(buildExplorePrompt(input(prompt), detail())).presentationRequirements,
    ).toContain('Use kind=diagram')
  })
  it('keeps plain tutorials and requested example counts out of forced diagram selection', () => {
    expect(JSON.parse(buildExplorePrompt(input(), detail())).presentationRequirements).toContain(
      'guided walkthrough',
    )
    expect(
      JSON.parse(buildExplorePrompt(input('Give three examples of clear writing'), detail()))
        .presentationRequirements,
    ).toBeNull()
    const instructions = buildExploreInstructions()
    expect(instructions).toContain('Structural checks validate references, not factual truth')
    expect(instructions).toContain('ONLY ideal small-angle pendulum')
    expect(instructions).toContain('Repository URLs are not fetched')
  })
  it('teaches rebase with clearly illustrative original and replayed commit graphs', () => {
    const prompt = JSON.parse(buildExplorePrompt(input('Explain git rebase with SVG'), detail()))
    expect(prompt.presentationRequirements).toContain('BEFORE/AFTER commit graphs')
    expect(prompt.presentationRequirements).toContain(
      'Without supplied history, use an illustrative example',
    )
    expect(prompt.presentationRequirements).toContain('Edges point child to parent')
    expect(prompt.presentationRequirements).toContain('Rebase creates new commit IDs')
    expect(prompt.presentationRequirements).toContain('leaves main at B')
  })
})

describe('local Explore generation', () => {
  it('uses structured local output and validated database context', async () => {
    const fetchMock = vi.fn(async () => completion())
    vi.stubGlobal('fetch', fetchMock)
    const request = input()
    const result = await generateExploreTurn(request, detail(), AbortSignal.timeout(1000))
    expect(result).toEqual(draft)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('http://127.0.0.1:8000/v1/chat/completions')
    const body = JSON.parse(String(init.body))
    expect(body.response_format.type).toBe('json_schema')
    const inspectLimits = (value: unknown) => {
      if (!value || typeof value !== 'object') return
      const object = value as Record<string, unknown>
      if (typeof object.maxLength === 'number') expect(object.maxLength).toBeLessThanOrEqual(1000)
      Object.values(object).forEach(inspectLimits)
    }
    inspectLimits(body.response_format.json_schema.schema)
    expect(JSON.parse(body.messages[1].content).learnerRequest).toBe(request.prompt)
    expect(body.max_tokens ?? body.max_completion_tokens).toBeGreaterThanOrEqual(1600)
    expect(body.max_tokens ?? body.max_completion_tokens).toBeLessThanOrEqual(6000)
  })
  it('forces all 20 requested examples at the model boundary and preserves every nuance field', async () => {
    const artifact = exampleContent(20)
    const fetchMock = vi.fn(async () => completion({ ...draft, artifact }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateExploreTurn(
      input('Teach me 20 different ways to ask for a code review in English'),
      detail(),
      AbortSignal.timeout(1000),
    )
    expect(result.artifact?.examples).toHaveLength(20)
    expect(result.artifact?.examples[0]).toMatchObject({
      formality: 'neutral',
      urgency: 'normal',
      channel: 'Pull request',
    })
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    )
    expect(JSON.stringify(body.response_format)).toContain('"minItems":20')
    expect(JSON.stringify(body.response_format)).toContain('"maxItems":20')
  })
  it('requires a diagram for an explicit visual request and repairs a prose-only artifact once', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(completion())
      .mockResolvedValueOnce(completion({ ...draft, artifact: diagramContent() }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateExploreTurn(
      input('Explain git rebase using SVG'),
      detail(),
      AbortSignal.timeout(1000),
    )
    expect(result.artifact?.kind).toBe('diagram')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('repairs a spatial artifact without an assembly view or focused steps', async () => {
    const artifact = diagramContent()
    const assembly = {
      ...artifact,
      config: { ...artifact.config, diagram: { view: 'assembly', layout: 'vertical' } },
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        completion({
          ...draft,
          artifact: {
            ...artifact,
            config: { ...artifact.config, diagram: undefined },
            steps: artifact.steps.map(({ title, body }) => ({ title, body })),
          },
        }),
      )
      .mockResolvedValueOnce(completion({ ...draft, artifact: assembly }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateExploreTurn(
      input('Show the parts of a sensor assembly in 3D'),
      detail(),
      AbortSignal.timeout(1000),
    )
    expect(result.artifact?.config.diagram?.view).toBe('assembly')
    expect(result.artifact?.steps.every((step) => step.focus?.length)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it.each([
    { name: 'stationary parts', separation: [0, 0, 0] },
    { name: 'uniform translation', separation: [1, 2, 3] },
  ])('repairs authored disassembly with $name using automatic geometry', async ({ separation }) => {
    const artifact = diagramContent()
    const assembly = {
      ...artifact,
      config: { ...artifact.config, diagram: { view: 'assembly', layout: 'vertical' } },
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        completion({
          ...draft,
          artifact: {
            ...assembly,
            nodes: artifact.nodes.map((node) => ({
              ...node,
              visual: { shape: 'box', position: [0, 0, 0], size: [1, 1, 1], separation },
            })),
          },
        }),
      )
      .mockResolvedValueOnce(completion({ ...draft, artifact: assembly }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateExploreTurn(
      input('Show a sensor assembly with reversible separation'),
      detail(),
      AbortSignal.timeout(1000),
    )
    expect(result.artifact?.nodes.every((node) => node.visual == null)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('accepts authored separation that changes the relative positions of the parts', async () => {
    const artifact = diagramContent()
    const assembly = {
      ...artifact,
      config: { ...artifact.config, diagram: { view: 'assembly', layout: 'vertical' } },
      nodes: artifact.nodes.map((node, index) => ({
        ...node,
        visual: {
          shape: 'box',
          position: [0, index, 0],
          size: [1, 1, 1],
          separation: [0, index * 2, 0],
        },
      })),
    }
    const fetchMock = vi.fn(async () => completion({ ...draft, artifact: assembly }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateExploreTurn(
      input('Show a sensor assembly with reversible separation'),
      detail(),
      AbortSignal.timeout(1000),
    )
    expect(result.artifact?.nodes.map((node) => node.visual?.separation)).toEqual([
      [0, 0, 0],
      [0, 2, 0],
      [0, 4, 0],
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('accepts an exact learner-supplied quotation without treating it as factual verification', async () => {
    const artifact = diagramContent({ kind: 'provided', quote: 'The client requests the API.' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => completion({ ...draft, artifact })),
    )
    const result = await generateExploreTurn(
      input('Diagram this description: The client requests the API.'),
      detail(),
      AbortSignal.timeout(1000),
    )
    expect(result.artifact?.edges[0].evidence).toEqual(artifact.edges[0].evidence)
  })
  it.each([
    ['user', 'complete', true],
    ['assistant', 'complete', false],
    ['user', 'failed', false],
  ] as const)(
    'only accepts quotes from included learner history: %s %s',
    async (role, status, accepted) => {
      const quote = 'The client requests the API.'
      const state = detail()
      state.messages = [
        {
          id: randomUUID(),
          sessionId,
          role,
          content: quote,
          createdAt: now,
          sequence: 0,
          status,
          requestId: randomUUID(),
          metadata: {},
        },
      ]
      const artifact = diagramContent({ kind: 'provided', quote })
      const fetchMock = vi.fn(async () => completion({ ...draft, artifact }))
      vi.stubGlobal('fetch', fetchMock)
      const generation = generateExploreTurn(
        input('Show the request flow diagram'),
        state,
        AbortSignal.timeout(1000),
      )
      if (accepted) {
        expect((await generation).artifact?.edges[0].evidence?.quote).toBe(quote)
        expect(fetchMock).toHaveBeenCalledTimes(1)
      } else {
        await expect(generation).rejects.toThrow('did not pass validation')
        expect(fetchMock).toHaveBeenCalledTimes(2)
      }
    },
  )
  it('repairs invented source quotations without copying them into the instructions', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        completion({
          ...draft,
          artifact: diagramContent({ kind: 'provided', quote: 'UNTRUSTED INVENTED SOURCE' }),
        }),
      )
      .mockResolvedValueOnce(
        completion({
          ...draft,
          artifact: diagramContent({ kind: 'illustrative', quote: '' }),
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    expect(
      (
        await generateExploreTurn(
          input('Explain an API architecture'),
          detail(),
          AbortSignal.timeout(1000),
        )
      ).artifact?.edges[0].evidence?.kind,
    ).toBe('illustrative')
    const repair = JSON.parse(String(fetchMock.mock.calls[1][1].body)).messages[0].content
    expect(repair).toContain('must exactly match learner-supplied text')
    expect(repair).not.toContain('UNTRUSTED INVENTED SOURCE')
  })
  it('leaves output space for a small diagram in a 4096-token local context', async () => {
    vi.stubEnv('MENTOR_COACH_CONTEXT', '4096')
    const fetchMock = vi.fn(async () => completion({ ...draft, artifact: diagramContent() }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateExploreTurn(
      input('Explain git rebase with SVG'),
      detail(),
      AbortSignal.timeout(1000),
    )
    expect(result.artifact?.kind).toBe('diagram')
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    )
    expect(body.max_tokens ?? body.max_completion_tokens).toBeGreaterThanOrEqual(1600)
    expect(body.max_tokens ?? body.max_completion_tokens).toBeLessThan(4096)
  })
  it('repairs an incomplete count once without inventing replacement examples', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(completion({ ...draft, artifact: exampleContent(2) }))
      .mockResolvedValueOnce(completion({ ...draft, artifact: exampleContent(20) }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateExploreTurn(
      input('Give 20 examples'),
      detail(),
      AbortSignal.timeout(1000),
    )
    expect(result.artifact?.examples).toHaveLength(20)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('rejects duplicate examples after one bounded local retry', async () => {
    const artifact = exampleContent(2)
    artifact.examples[1] = artifact.examples[0]
    const fetchMock = vi.fn(async () => completion({ ...draft, artifact }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      generateExploreTurn(input('Give 2 examples'), detail(), AbortSignal.timeout(1000)),
    ).rejects.toThrow('did not pass validation')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('passes the specific graph validation constraint into one repair without copying model output', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        completion({
          ...draft,
          artifact: {
            ...exampleContent(2),
            nodes: [
              {
                id: 'request',
                label: 'Review request',
                detail: 'UNTRUSTED OUTPUT THAT MUST NOT ENTER REPAIR',
              },
            ],
            edges: [{ from: 'request', to: 'missing-context-node', label: 'context' }],
          },
        }),
      )
      .mockResolvedValueOnce(completion({ ...draft, artifact: exampleContent(2) }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateExploreTurn(
      input('Give 2 examples'),
      detail(),
      AbortSignal.timeout(1000),
    )
    expect(result.action).toBe('create')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const repair = JSON.parse(
      String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body),
    ).messages[0].content
    expect(repair).toContain(
      'Diagram nodes must be unique and edges must reference existing nodes.',
    )
    expect(repair).not.toContain('UNTRUSTED OUTPUT THAT MUST NOT ENTER REPAIR')
    expect(repair.length - buildExploreInstructions().length).toBeLessThan(750)
  })
  it('does not allow a model revision without a selected target', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(completion({ ...draft, action: 'revise' }))
      .mockResolvedValueOnce(completion())
    vi.stubGlobal('fetch', fetchMock)
    expect((await generateExploreTurn(input(), detail(), AbortSignal.timeout(1000))).action).toBe(
      'create',
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('requires playable stories and correct Fibonacci values for Planning Poker', async () => {
    const artifact = {
      ...content,
      kind: 'fibonacci',
      steps: Array.from({ length: 3 }, (_, index) => ({
        title: `Search feature ${index + 1}`,
        body: 'Acceptance criteria: Search respects the selected filters. Uncertainty: Existing indexing behavior. What needs investigating?',
      })),
      sections: [
        {
          heading: 'Relative estimation',
          body: 'Fibonacci values 1, 2, 3, 5, 8, 13, 21 are a convention for relative estimation.',
        },
      ],
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        completion({
          ...draft,
          artifact: {
            ...artifact,
            sections: [
              { heading: 'Relative estimation', body: 'Fibonacci values 1, 2, 3, 5, 8, 13, 20.' },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(completion({ ...draft, artifact }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateExploreTurn(
      input('Explain Fibonacci and Agile story points'),
      detail(),
      AbortSignal.timeout(1000),
    )
    expect(result.artifact?.steps).toHaveLength(3)
    expect(result.artifact?.sections[0].body).toContain('13, 21')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('propagates cancellation without starting another inference request', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      controller.abort()
      init.signal?.throwIfAborted()
      return completion()
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateExploreTurn(input(), detail(), controller.signal)).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('refuses remote model configuration before sending saved learning data', async () => {
    vi.stubEnv('LOCAL_AI_BASE_URL', 'https://example.org/v1')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateExploreTurn(input(), detail(), AbortSignal.timeout(1000))).rejects.toThrow(
      'loopback',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
