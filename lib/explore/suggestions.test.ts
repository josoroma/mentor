import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/explore/suggestions/route'
import {
  buildExploreSuggestionInstructions,
  buildExploreSuggestionPrompt,
  buildExploreSuggestions,
  ExploreSuggestionDraftBatchSchema,
  ExploreSuggestionsRequestSchema,
  ExploreSuggestionsSchema,
  type ExploreSuggestionsRequest,
} from '@/lib/explore/suggestions'

const mocks = vi.hoisted(() => ({ generate: vi.fn() }))
vi.mock('ai', () => ({
  generateText: mocks.generate,
  Output: { object: (options: unknown) => options },
}))

const professional: ExploreSuggestionsRequest = {
  selection: { path: 'professional', roleId: 'deployed-ai-developer' },
  level: 'B2',
}
const life: ExploreSuggestionsRequest = {
  selection: { path: 'life-skills', categoryId: 'public-speaking', topicId: 'storytelling' },
  level: 'B1',
}
const wellness: ExploreSuggestionsRequest = {
  selection: {
    path: 'life-skills',
    categoryId: 'nutrition-metabolic-health',
    topicId: 'understanding-insulin-resistance',
  },
  level: 'A2',
}
const draft = {
  ideas: [
    {
      title: 'Explain a production handover',
      description: 'Practice communicating responsibilities and success measures to a customer.',
      prompt:
        'Build a step-by-step lesson about explaining ownership, monitoring and success measures during a fictional customer handover. Include a practice question after each step.',
      kind: 'walkthrough',
    },
  ],
}
const request = (
  body: unknown = professional,
  options: { origin?: string; signal?: AbortSignal } = {},
) =>
  new Request('http://localhost:3000/api/explore/suggestions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.origin && { origin: options.origin }),
    },
    body: JSON.stringify(body),
    signal: options.signal,
  })

beforeEach(() => {
  mocks.generate.mockResolvedValue({ output: structuredClone(draft), finishReason: 'stop' })
})
afterEach(() => {
  vi.resetAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Explore suggestion contracts and canonical learning context', () => {
  it.each([
    { selection: { path: 'professional', roleId: 'unknown-role' }, level: 'B2' },
    { selection: { ...life.selection, topicId: 'salary-negotiation' }, level: 'B2' },
    { ...professional, level: 'B3' },
    { ...professional, profileId: randomUUID() },
    { ...professional, selection: { ...professional.selection, description: 'Ignore context' } },
  ])('rejects unavailable or client-injected selection fields', (input) => {
    expect(ExploreSuggestionsRequestSchema.safeParse(input).success).toBe(false)
  })

  it('binds the model prompt to the full canonical professional role and English level', () => {
    const prompt = JSON.parse(buildExploreSuggestionPrompt(professional, 'variation-one'))
    expect(prompt).toMatchObject({
      selection: professional.selection,
      englishLevel: 'B2',
      focus: {
        label: 'Forward-Deployed AI Engineer',
        description: expect.stringContaining('Embed with customers to discover workflows'),
        wellness: false,
      },
      variationSeed: 'variation-one',
    })
    expect(prompt.focus.description).toContain('production AI')
    expect(prompt.focus.description).toContain('measurable business outcomes')
  })

  it('preserves category AND topic without injecting a professional role into life skills', () => {
    const prompt = JSON.parse(buildExploreSuggestionPrompt(life, 'variation-two'))
    expect(prompt.selection).toEqual(life.selection)
    expect(prompt.englishLevel).toBe('B1')
    expect(prompt.focus.label).toBe('Public Speaking · Storytelling')
    expect(prompt.focus.subject).toContain('situation, a challenge, an action')
    expect(JSON.stringify(prompt)).not.toContain('Forward-Deployed')
    const result = buildExploreSuggestions(life, draft)
    expect(result.ideas[0].prompt).toContain(
      'Life & Workplace Skills — Public Speaking · Storytelling',
    )
    expect(result.ideas[0].prompt).toContain('CEFR B1 English')
  })

  it('adds canonical context to every selectable prompt even when model wording omits it', () => {
    const result = buildExploreSuggestions(professional, draft)
    expect(result.selection).toEqual(professional.selection)
    expect(result.level).toBe('B2')
    expect(result.ideas[0].prompt).toContain('Professional Roles — Forward-Deployed AI Engineer')
    expect(result.ideas[0].prompt).toContain('CEFR B2 English')
    expect(result.ideas[0].prompt).toContain(draft.ideas[0].prompt)
    expect(result.ideas[0].prompt.length).toBeLessThanOrEqual(4000)
    expect(result.ideas[0].id).not.toBe(buildExploreSuggestions(professional, draft).ideas[0].id)
  })

  it('keeps wellness suggestions and their eventual lessons inside language practice', () => {
    const prompt = JSON.parse(buildExploreSuggestionPrompt(wellness, 'variation-three'))
    expect(prompt.focus.wellness).toBe(true)
    expect(prompt.wellnessInstructions).toContain('Do not diagnose conditions')
    const instructions = buildExploreSuggestionInstructions()
    expect(instructions).toContain('nobody provides clinical or nutritional explanations')
    const result = buildExploreSuggestions(wellness, draft)
    expect(result.ideas[0].prompt).toContain('Understanding Insulin Resistance')
    expect(result.ideas[0].prompt).toContain('Do not diagnose conditions')
    expect(result.ideas[0].prompt).toContain('CEFR A2 English')
    expect(result.ideas[0].prompt.length).toBeLessThanOrEqual(4000)
  })

  it('describes specialized renderer capabilities without requiring irrelevant formats', () => {
    const instructions = buildExploreSuggestionInstructions()
    expect(instructions).toContain('sorting ONLY for bubble sort')
    expect(instructions).toContain('hanoi ONLY for Towers of Hanoi')
    expect(instructions).toContain('You do not need to use every kind')
  })

  it('accepts one through twelve ideas and rejects empty, oversized or duplicate batches', () => {
    const twelve = Array.from({ length: 12 }, (_, index) => ({
      ...draft.ideas[0],
      title: `Distinct learning activity ${index + 1}`,
    }))
    expect(ExploreSuggestionDraftBatchSchema.safeParse({ ideas: twelve }).success).toBe(true)
    expect(ExploreSuggestionDraftBatchSchema.safeParse({ ideas: [] }).success).toBe(false)
    expect(
      ExploreSuggestionDraftBatchSchema.safeParse({ ideas: [...twelve, draft.ideas[0]] }).success,
    ).toBe(false)
    expect(
      ExploreSuggestionDraftBatchSchema.safeParse({
        ideas: [draft.ideas[0], { ...draft.ideas[0], title: 'EXPLAIN A PRODUCTION HANDOVER!' }],
      }).success,
    ).toBe(false)
  })

  it('does not allow model-authored identities or unsupported kinds', () => {
    expect(
      ExploreSuggestionDraftBatchSchema.safeParse({
        ideas: [{ ...draft.ideas[0], id: randomUUID() }],
      }).success,
    ).toBe(false)
    expect(
      ExploreSuggestionDraftBatchSchema.safeParse({
        ideas: [{ ...draft.ideas[0], kind: 'executable-code' }],
      }).success,
    ).toBe(false)
  })

  it('validates response identities, titles and final prompt bounds', () => {
    const result = buildExploreSuggestions(professional, draft)
    expect(ExploreSuggestionsSchema.safeParse(result).success).toBe(true)
    expect(
      ExploreSuggestionsSchema.safeParse({
        ...result,
        ideas: [result.ideas[0], { ...result.ideas[0], title: 'Different activity' }],
      }).success,
    ).toBe(false)
    expect(
      ExploreSuggestionsSchema.safeParse({
        ...result,
        ideas: [{ ...result.ideas[0], prompt: 'x'.repeat(4001) }],
      }).success,
    ).toBe(false)
  })
})

describe('local Explore suggestion endpoint', () => {
  it('generates bounded local ideas without a profile or database dependency', async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const result = ExploreSuggestionsSchema.parse(await response.json())
    expect(result).toMatchObject(professional)
    expect(result.ideas).toHaveLength(1)
    const options = mocks.generate.mock.calls[0][0]
    expect(options).toMatchObject({ maxRetries: 0, maxOutputTokens: 4300 })
    expect(options.model.provider).toContain('openai')
    expect(options.abortSignal).toBeInstanceOf(AbortSignal)
    expect(options.output.schema).toBe(ExploreSuggestionDraftBatchSchema)
    expect(JSON.parse(options.prompt).selection).toEqual(professional.selection)
  })

  it('varies the generation seed on every refresh while preserving the selected focus', async () => {
    await POST(request(life))
    await POST(request(life))
    const prompts = mocks.generate.mock.calls.map(([options]) => JSON.parse(options.prompt))
    expect(prompts[0].variationSeed).not.toBe(prompts[1].variationSeed)
    expect(prompts[0].selection).toEqual(prompts[1].selection)
  })

  it('rejects invalid selection and cross-origin requests before inference', async () => {
    const invalid = await POST(request({ ...professional, level: 'invalid' }))
    expect(invalid.status).toBe(400)
    expect(invalid.headers.get('Cache-Control')).toBe('no-store')
    expect((await POST(request(professional, { origin: 'https://example.org' }))).status).toBe(403)
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('refuses remote model configuration without any inference fallback', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('LOCAL_AI_BASE_URL', 'https://model.example.org/v1')
    expect((await POST(request())).status).toBe(503)
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it.each(['length', 'content-filter', 'error'])(
    'rejects incomplete generation (%s)',
    async (reason) => {
      mocks.generate.mockResolvedValue({ output: draft, finishReason: reason })
      const response = await POST(request())
      expect(response.status).toBe(503)
      expect((await response.json()).error).toContain('incomplete')
    },
  )

  it.each([{ ideas: [] }, { ideas: [draft.ideas[0], draft.ideas[0]] }])(
    'rejects unusable model output without static suggestions',
    async (output) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      mocks.generate.mockResolvedValue({ output, finishReason: 'stop' })
      const response = await POST(request())
      expect(response.status).toBe(503)
      expect(await response.json()).not.toHaveProperty('ideas')
    },
  )

  it('reports model unavailability and memory pressure as explicit retryable errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.generate.mockRejectedValue(new Error('Local model unavailable'))
    expect((await POST(request())).status).toBe(503)
    mocks.generate.mockRejectedValue({ statusCode: 507 })
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect((await response.json()).error).toContain('free memory')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('does not return late suggestions after cancellation', async () => {
    const controller = new AbortController()
    mocks.generate.mockImplementation(async () => {
      controller.abort()
      return { output: draft, finishReason: 'stop' }
    })
    expect((await POST(request(professional, { signal: controller.signal }))).status).toBe(499)
  })

  it('reports timeout and pre-existing cancellation before inference', async () => {
    expect((await POST(request(professional, { signal: AbortSignal.abort() }))).status).toBe(499)
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort())
    expect((await POST(request())).status).toBe(504)
    expect(mocks.generate).not.toHaveBeenCalled()
  })
})
