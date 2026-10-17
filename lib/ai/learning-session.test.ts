import { afterEach, describe, expect, it, vi } from 'vitest'
import { roles } from '@/app/_constants'
import { POST } from '@/app/api/learning-session/route'
import { ConversationPlanSchema } from '@/lib/ai/conversation-plan'
import {
  buildLearningSessionInstructions,
  buildLearningSessionPlan,
  buildLearningSessionPrompt,
  LearningSessionRequestSchema,
} from '@/lib/ai/learning-session'
import {
  buildCoachPrompt,
  buildCompactCoachPrompt,
  buildCompactFeedbackPrompt,
  buildFeedbackPrompt,
} from '@/lib/ai/prompts'

const input = {
  selection: {
    path: 'life-skills',
    categoryId: 'conflict-resolution',
    topicId: 'de-escalating-conflict',
  },
  roleId: roles[0].id,
  level: 'C2',
  minutes: 10,
}
const draft = {
  improvedTopic: 'Practice calming a disagreement and agreeing on a next step.',
  title: 'Finding common ground',
  description: 'De-escalate a fictional disagreement with a teammate.',
  personaRole: 'A teammate with a different perspective',
  openingLine:
    'Let’s imagine we disagree about a deadline. How could we find a next step that works for both of us?',
  stages: [
    { title: 'Hear the concern', focus: 'Acknowledge the concern in your own words.' },
    { title: 'Find common ground', focus: 'Clarify what each person needs.' },
    { title: 'Agree a step', focus: 'Summarize a practical next step respectfully.' },
  ],
  usefulPhrases: [
    'I understand your concern.',
    'Could we clarify what matters most?',
    'Let’s agree on a next step.',
  ],
}
const request = (body: unknown = input, options: { signal?: AbortSignal; origin?: string } = {}) =>
  new Request('http://localhost:3000/api/learning-session', {
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
    id: 'chatcmpl-learning',
    model: 'mtplx',
    created: 1,
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 300, total_tokens: 400 },
  })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('selected learning session planning', () => {
  it('keeps the selected life topic authoritative and removes unrelated professional context', () => {
    const parsed = LearningSessionRequestSchema.parse(input)
    const prompt = JSON.parse(
      buildLearningSessionPrompt(parsed, { subject: 'De-escalating conflict', seed: 'seed' }),
    )
    expect(prompt.learningPath).toBe('life-skills')
    expect(prompt.selectedFocus).toContain('De-escalating Conflict')
    expect(JSON.stringify(prompt)).not.toContain(roles[0].name)
    const plan = buildLearningSessionPlan(parsed, {
      ...draft,
      scenario: { id: 'injected' },
    } as typeof draft)
    expect(plan.scenario.id).toMatch(/^free-learning-[\da-f-]{36}$/)
    expect(plan.scenario.learningSelection).toEqual(input.selection)
    expect(plan.scenario.roleIds).toEqual([input.roleId])
    expect(plan.scenario.difficulty).toBe('Advanced')
    expect(plan.originalTopic).toContain('De-escalating Conflict')
    expect(buildLearningSessionInstructions()).toContain(
      'without asking them to choose or describe another topic',
    )
  })

  it('uses the selected professional position rather than an unrelated saved profile role', async () => {
    const fetchMock = vi.fn(async () => completion())
    vi.stubGlobal('fetch', fetchMock)
    const response = await POST(
      request({ ...input, selection: { path: 'professional', roleId: 'devops-engineer' } }),
    )
    expect(response.status).toBe(200)
    const plan = ConversationPlanSchema.parse(await response.json())
    expect(plan.scenario.roleIds).toEqual(['devops-engineer'])
    expect(plan.scenario.id).toMatch(/^learning-[\da-f-]{36}$/)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('127.0.0.1:8000/v1/chat/completions')
    const upstream = JSON.parse(String(init.body))
    expect(upstream.response_format.type).toBe('json_schema')
    expect(JSON.parse(upstream.messages[1].content).selectedFocus).toBe('DevOps Engineer')
    expect(upstream.max_tokens ?? upstream.max_completion_tokens).toBe(1400)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('keeps educational wellness boundaries in full and compact coaching and feedback', () => {
    const parsed = LearningSessionRequestSchema.parse({
      ...input,
      selection: {
        path: 'life-skills',
        categoryId: 'nutrition-metabolic-health',
        topicId: 'understanding-insulin-resistance',
      },
    })
    const prompt = JSON.parse(
      buildLearningSessionPrompt(parsed, { subject: 'Practice asking questions', seed: 'seed' }),
    )
    expect(prompt.wellness).toBe(true)
    const { scenario } = buildLearningSessionPlan(parsed, draft)
    expect(scenario.persona.role).toBe('A fellow learner practicing clear health questions')
    for (const instructions of [
      buildLearningSessionInstructions(),
      scenario.brief,
      buildCoachPrompt(scenario, roles[0], 'C2'),
      buildCompactCoachPrompt(scenario, roles[0], 'C2'),
      buildFeedbackPrompt(scenario, roles[0], 'C2'),
      buildCompactFeedbackPrompt(scenario, 'C2'),
    ]) {
      expect(instructions).toContain('Do not diagnose conditions')
      expect(instructions).toContain('or promise health outcomes')
    }
    expect(buildCoachPrompt(scenario, roles[0], 'C2')).not.toContain(roles[0].name)
    expect(buildFeedbackPrompt(scenario, roles[0], 'C2')).not.toContain(roles[0].name)
    expect(buildFeedbackPrompt(scenario, roles[0], 'C2')).toContain(
      'Never invent a quote or pretend to have heard the audio',
    )
  })

  it.each([
    { ...input, selection: { path: 'professional', roleId: 'unknown' } },
    {
      ...input,
      selection: { path: 'life-skills', categoryId: 'public-speaking', topicId: 'job-interviews' },
    },
    {
      ...input,
      selection: { path: 'life-skills', categoryId: 'conflict-resolution', topicId: '' },
    },
    { ...input, level: 'C3' },
    { ...input, roleId: 'unknown' },
  ])('rejects invalid choices before inference', async (body) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect((await POST(request(body))).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects cross-origin use', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect((await POST(request(input, { origin: 'https://example.org' }))).status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['{}', 'stop'],
    [JSON.stringify(draft), 'length'],
  ])('reports incomplete model output without a fabricated plan', async (content, finishReason) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn(async () => completion(content, finishReason))
    vi.stubGlobal('fetch', fetchMock)
    expect((await POST(request())).status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('cancels generation when the selected focus changes', async () => {
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

  it('reports local memory pressure without a cloud fallback', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: { message: 'insufficient memory' } }, { status: 507 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect((await response.json()).error).toContain('more free memory')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
