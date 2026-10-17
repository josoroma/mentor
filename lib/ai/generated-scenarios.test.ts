import { afterEach, describe, expect, it, vi } from 'vitest'
import { roles } from '@/app/_constants'
import { POST } from '@/app/api/scenarios/route'
import {
  buildGeneratedScenarios,
  buildScenarioGenerationInstructions,
  buildScenarioGenerationPrompt,
  GeneratedScenariosSchema,
  ScenarioDraftBatchSchema,
  ScenarioGenerationRequestSchema,
} from '@/lib/ai/generated-scenarios'
import {
  buildCoachPrompt,
  buildCompactCoachPrompt,
  buildCompactFeedbackPrompt,
  buildFeedbackPrompt,
} from '@/lib/ai/prompts'
import { resolveLearningSelection } from '@/lib/learning/paths'

const input = {
  selection: { path: 'professional', roleId: 'product-engineer' },
  roleId: roles[0].id,
  level: 'B2',
}

const draft = {
  scenarios: [
    {
      title: 'Clarify a confusing onboarding step',
      description: 'Explain a usability concern and agree on a small product improvement.',
      category: 'Collaboration',
      minutes: 5,
      personaRole: 'A product designer reviewing an onboarding flow',
      brief:
        'Imagine you and a designer are reviewing a sign-up flow. Discuss where someone might be confused and agree on one improvement to try.',
      objectives: [
        'Describe the confusing step clearly',
        'Explain why a proposed change could help',
        'Agree on a way to check the improvement',
      ],
      openingLine:
        'Let’s imagine we’re reviewing this sign-up flow together. Which step would you simplify first?',
    },
    {
      title: 'Explain a feature trade-off',
      description: 'Discuss the scope of a feature and explain a practical compromise.',
      category: 'Technical discussions',
      minutes: 8,
      personaRole: 'A product manager exploring feature scope',
      brief:
        'Imagine a feature could ship with a simple first version or take longer with more options. Compare both approaches with your product manager.',
      objectives: [
        'Explain the benefit of each approach',
        'Describe the cost of added complexity',
        'Recommend a concrete next step',
      ],
      openingLine:
        'Imagine we’re deciding the scope of a new feature. What would you include in the first version?',
    },
    {
      title: 'Present a small product experiment',
      description: 'Present an experiment and explain what the team could learn from it.',
      category: 'Presentations',
      minutes: 10,
      personaRole: 'A teammate reviewing an experiment proposal',
      brief:
        'Imagine you are proposing a small product experiment. Present its goal, explain how it might work, and agree on what evidence would be useful.',
      objectives: [
        'Introduce the experiment with a clear goal',
        'Explain how you would evaluate the idea',
        'Invite a question and respond concisely',
      ],
      openingLine:
        'Let’s imagine you have a product experiment to share. What would you like the team to learn?',
    },
  ],
}

const draftWithCount = (count: number) => ({
  scenarios: Array.from({ length: count }, (_, index) => {
    const scenario = draft.scenarios[index % draft.scenarios.length]
    return { ...scenario, title: `${scenario.title} ${index + 1}` }
  }),
})

const request = (body: unknown = input, options: { signal?: AbortSignal; origin?: string } = {}) =>
  new Request('http://localhost:3000/api/scenarios', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.origin && { origin: options.origin }),
    },
    body: JSON.stringify(body),
    signal: options.signal,
  })

const completion = (content = JSON.stringify(draft), finishReason = 'stop') =>
  Response.json({
    id: 'chatcmpl-scenarios',
    model: 'mtplx',
    created: 1,
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 600, total_tokens: 700 },
  })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('generated scenario contracts', () => {
  it('gives generated scenarios authoritative selection metadata and fresh server-owned identities', () => {
    const body = ScenarioGenerationRequestSchema.parse(input)
    const poisoned = ScenarioDraftBatchSchema.parse({
      ...draft,
      roleId: 'unknown',
      scenarios: draft.scenarios.map((scenario) => ({
        ...scenario,
        id: 'daily-standup',
        roleIds: [roles[0].id],
        learningSelection: { path: 'professional', roleId: roles[0].id },
        difficulty: 'Beginner',
        icon: 'injected',
      })),
    })
    const first = buildGeneratedScenarios(body, poisoned)
    const second = buildGeneratedScenarios(body, poisoned)
    expect(first.roleId).toBe('product-engineer')
    expect(first.level).toBe('B2')
    expect(first.scenarios).toHaveLength(3)
    expect(new Set([...first.scenarios, ...second.scenarios].map(({ id }) => id)).size).toBe(6)
    first.scenarios.forEach((scenario, index) => {
      expect(scenario.id).toMatch(/^learning-[\da-f-]{36}$/)
      expect(scenario.learningSelection).toEqual(input.selection)
      expect(scenario.roleIds).toEqual(['product-engineer'])
      expect(scenario.difficulty).toBe('Intermediate')
      expect(scenario.title).toBe(draft.scenarios[index].title)
      expect(scenario.brief).toBe(draft.scenarios[index].brief)
      expect(scenario.openingLine).toBe(draft.scenarios[index].openingLine)
      expect(scenario.icon).not.toBe('injected')
    })
    expect(GeneratedScenariosSchema.safeParse({ ...first, roleId: roles[0].id }).success).toBe(
      false,
    )
    expect(
      GeneratedScenariosSchema.safeParse({
        ...first,
        scenarios: [
          { ...first.scenarios[0], learningSelection: undefined },
          ...first.scenarios.slice(1),
        ],
      }).success,
    ).toBe(false)
  })

  it.each([1, 2, 9])(
    'accepts %s distinct complete scenarios without padding the batch',
    (count) => {
      const batchDraft = draftWithCount(count)
      const generated = buildGeneratedScenarios(
        ScenarioGenerationRequestSchema.parse(input),
        ScenarioDraftBatchSchema.parse(batchDraft),
      )
      expect(generated.scenarios).toHaveLength(count)
      expect(generated.scenarios.map(({ title }) => title)).toEqual(
        batchDraft.scenarios.map(({ title }) => title),
      )
      expect(new Set(generated.scenarios.map(({ id }) => id)).size).toBe(count)
    },
  )

  it.each([0, 10])('rejects %s scenarios at both the model and response boundaries', (count) => {
    expect(ScenarioDraftBatchSchema.safeParse(draftWithCount(count)).success).toBe(false)
    const generated = buildGeneratedScenarios(
      ScenarioGenerationRequestSchema.parse(input),
      ScenarioDraftBatchSchema.parse(draft),
    )
    expect(
      GeneratedScenariosSchema.safeParse({
        ...generated,
        scenarios: Array.from({ length: count }, (_, index) => ({
          ...generated.scenarios[0],
          id: `learning-${index}`,
          title: `A distinct fictional scenario ${index}`,
        })),
      }).success,
    ).toBe(false)
  })

  it.each([
    ['A2', 'Beginner'],
    ['B1', 'Intermediate'],
    ['B2', 'Intermediate'],
    ['C1', 'Advanced'],
    ['C2', 'Advanced'],
  ])('maps %s practice to %s difficulty', (level, difficulty) => {
    const result = buildGeneratedScenarios(
      ScenarioGenerationRequestSchema.parse({ ...input, level }),
      ScenarioDraftBatchSchema.parse(draft),
    )
    expect(result.scenarios.every((scenario) => scenario.difficulty === difficulty)).toBe(true)
  })

  it('rejects incomplete scenarios or duplicate titles instead of replacing them with static scenarios', () => {
    for (const scenarios of [
      [...draft.scenarios, draft.scenarios[0]],
      [
        draft.scenarios[0],
        { ...draft.scenarios[1], title: 'CLARIFY: A CONFUSING ONBOARDING STEP!' },
        draft.scenarios[2],
      ],
      [{ ...draft.scenarios[0], objectives: ['One objective only'] }, ...draft.scenarios.slice(1)],
      [{ ...draft.scenarios[0], minutes: 20 }, ...draft.scenarios.slice(1)],
      [
        { ...draft.scenarios[0], openingLine: 'I have completed the work myself.' },
        ...draft.scenarios.slice(1),
      ],
      [{ ...draft.scenarios[0], category: 'Some other category' }, ...draft.scenarios.slice(1)],
      [{ ...draft.scenarios[0], brief: 'x'.repeat(651) }, ...draft.scenarios.slice(1)],
    ]) {
      expect(ScenarioDraftBatchSchema.safeParse({ scenarios }).success).toBe(false)
    }
  })

  it('uses the exact life-skills topic without unrelated saved profession context', () => {
    const body = ScenarioGenerationRequestSchema.parse({
      ...input,
      selection: { path: 'life-skills', categoryId: 'public-speaking', topicId: 'storytelling' },
    })
    const prompt = JSON.parse(buildScenarioGenerationPrompt(body, 'fresh-seed'))
    expect(prompt.learningPath).toBe('life-skills')
    expect(prompt.selectedFocus).toContain('Public Speaking')
    expect(prompt.selectedFocus).toContain('Storytelling')
    expect(prompt.subject).toContain('Storytelling')
    expect(prompt.variationSeed).toBe('fresh-seed')
    expect(JSON.stringify(prompt)).not.toContain(roles[0].name)
    const batch = buildGeneratedScenarios(body, ScenarioDraftBatchSchema.parse(draft))
    expect(batch.scenarios.every((scenario) => scenario.id.startsWith('free-learning-'))).toBe(true)
    const focus = resolveLearningSelection(body.selection)
    for (const [index, scenario] of batch.scenarios.entries()) {
      expect(scenario.brief).toBe(draft.scenarios[index].brief)
      expect(scenario.learningSelection).toEqual(body.selection)
      for (const instructions of [
        buildCoachPrompt(scenario, roles[0], 'B2'),
        buildCompactCoachPrompt(scenario, roles[0], 'B2'),
        buildFeedbackPrompt(scenario, roles[0], 'B2'),
        buildCompactFeedbackPrompt(scenario, 'B2'),
      ]) {
        expect(instructions).toContain(focus.label)
        expect(instructions).toContain(focus.subject)
        expect(instructions).not.toContain(roles[0].name)
      }
    }
    expect(buildScenarioGenerationInstructions()).toContain('exact selected category AND topic')
  })

  it('enforces a nonclinical wellness persona and keeps educational boundaries in every scenario', () => {
    const body = ScenarioGenerationRequestSchema.parse({
      ...input,
      selection: {
        path: 'life-skills',
        categoryId: 'nutrition-metabolic-health',
        topicId: 'understanding-insulin-resistance',
      },
    })
    const prompt = JSON.parse(buildScenarioGenerationPrompt(body, 'seed'))
    expect(prompt.wellness).toBe(true)
    expect(prompt.conversationBoundary).toContain('Do not diagnose conditions')
    const batch = buildGeneratedScenarios(
      body,
      ScenarioDraftBatchSchema.parse({
        scenarios: draft.scenarios.map((scenario) => ({ ...scenario, personaRole: 'A clinician' })),
      }),
    )
    for (const [index, scenario] of batch.scenarios.entries()) {
      expect(scenario.persona.role).toBe('A fellow learner practicing clear health questions')
      expect(scenario.brief).toBe(draft.scenarios[index].brief)
      expect(scenario.learningSelection).toEqual(body.selection)
      for (const instructions of [
        buildCoachPrompt(scenario, roles[0], 'B2'),
        buildCompactCoachPrompt(scenario, roles[0], 'B2'),
        buildFeedbackPrompt(scenario, roles[0], 'B2'),
        buildCompactFeedbackPrompt(scenario, 'B2'),
      ]) {
        expect(instructions).toContain('Do not diagnose conditions')
        expect(instructions).toContain('or promise health outcomes')
      }
    }
  })
})

describe('local scenario generation route', () => {
  it('returns a complete seven-scenario response without rejecting it or padding to nine', async () => {
    const sevenScenarios = draftWithCount(7)
    const fetchMock = vi.fn(async () => completion(JSON.stringify(sevenScenarios)))
    vi.stubGlobal('fetch', fetchMock)
    const response = await POST(request())
    expect(response.status).toBe(200)
    const batch = GeneratedScenariosSchema.parse(await response.json())
    expect(batch.scenarios).toHaveLength(7)
    expect(batch.scenarios.map(({ title }) => title)).toEqual(
      sevenScenarios.scenarios.map(({ title }) => title),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('requests nine scenarios through local structured inference using the selected role', async () => {
    const nineScenarios = draftWithCount(9)
    const fetchMock = vi.fn(async () => completion(JSON.stringify(nineScenarios)))
    vi.stubGlobal('fetch', fetchMock)
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const batch = GeneratedScenariosSchema.parse(await response.json())
    expect(batch.roleId).toBe('product-engineer')
    expect(batch.scenarios).toHaveLength(9)
    expect(batch.scenarios.map(({ title }) => title)).toEqual(
      nineScenarios.scenarios.map(({ title }) => title),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('http://127.0.0.1:8000/v1/chat/completions')
    const upstream = JSON.parse(String(init.body))
    expect(upstream.response_format.type).toBe('json_schema')
    expect(upstream.response_format.json_schema.schema.properties.scenarios).toMatchObject({
      minItems: 1,
      maxItems: 9,
    })
    const prompt = JSON.parse(upstream.messages[1].content)
    expect(prompt.selectedFocus).toBe('Product Engineer')
    expect(prompt.context).toBe(roles.find(({ id }) => id === 'product-engineer')?.description)
    expect(prompt.englishLevel).toBe('B2')
    expect(prompt.scenarioCount).toBe(9)
    expect(prompt.variationSeed).toMatch(/^[\da-f-]{36}$/)
    expect(JSON.stringify(prompt)).not.toContain(roles[0].name)
    expect(upstream.messages[0].content).toContain('Generate the actual scenarios now')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([
    { ...input, selection: undefined },
    { ...input, selection: { path: 'professional', roleId: 'unknown' } },
    {
      ...input,
      selection: { path: 'life-skills', categoryId: 'public-speaking', topicId: 'job-interviews' },
    },
    {
      ...input,
      selection: { path: 'life-skills', categoryId: 'public-speaking', topicId: 'storytelling' },
      roleId: 'unknown',
    },
    { ...input, level: 'A1' },
  ])('rejects an invalid request before running local inference', async (body) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const response = await POST(request(body))
    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects cross-origin generation requests', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect((await POST(request(input, { origin: 'https://example.org' }))).status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['{}', 'stop'],
    [JSON.stringify({ scenarios: [] }), 'stop'],
    [JSON.stringify(draftWithCount(10)), 'stop'],
    [
      JSON.stringify({ scenarios: [draft.scenarios[0], draft.scenarios[0], draft.scenarios[2]] }),
      'stop',
    ],
    [JSON.stringify(draft), 'length'],
  ])(
    'returns a clear error for invalid or truncated model output without a fallback',
    async (content, finishReason) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const fetchMock = vi.fn(async () => completion(content, finishReason))
      vi.stubGlobal('fetch', fetchMock)
      const response = await POST(request())
      expect(response.status).toBe(503)
      expect(await response.json()).not.toHaveProperty('scenarios')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it('cancels local inference when the learner changes the focus', async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        controller.abort()
        init.signal?.throwIfAborted()
        return completion()
      }),
    )
    expect((await POST(request(input, { signal: controller.signal }))).status).toBe(499)
  })

  it('reports timeout without returning stale or canned scenarios', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort())
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const response = await POST(request())
    expect(response.status).toBe(504)
    expect((await response.json()).error).toContain('took too long')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports local memory pressure without a hosted retry', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: { message: 'insufficient memory' } }, { status: 507 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect((await response.json()).error).toContain('more free memory')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses nonlocal inference configuration instead of sending learning context elsewhere', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('LOCAL_AI_BASE_URL', 'https://example.org/v1')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect((await POST(request())).status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
