import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createExplorePromptRefinementContext,
  createExplorePromptRefinementSnapshot,
  ExplorePromptRefinementController,
  type ExplorePromptRefinementSnapshot,
} from '@/lib/explore/prompt-refinement-controller'
import type { ExplorePromptRefinementRequest } from '@/lib/explore/prompt-refinement'

const original = 'Explain how git rebase works.'
const context = (
  prompt = original,
  contextKey = 'new:professional:scrum-master',
  extra: Partial<ExplorePromptRefinementRequest> = {},
) => createExplorePromptRefinementContext({ prompt, ...extra }, contextKey)

const response = (prompt = original) => ({
  prompt,
  options: [
    {
      id: 'option-1',
      title: 'Inspect the commit graph',
      description: 'Follow the commits and inspect how their relationships change.',
      prompt:
        'Explain git rebase with a selectable commit graph, zoom, pan, and labeled connections.',
    },
    {
      id: 'option-2',
      title: 'Follow a replay',
      description: 'Step through an animated branch replay and inspect each commit.',
      prompt:
        'Animate git rebase one commit at a time with play, pause, and a timeline I can scrub.',
    },
    {
      id: 'option-3',
      title: 'Try a comparison',
      description: 'Compare rebase and merge with a small interactive example.',
      prompt:
        'Create an interactive diagram comparing git rebase and merge with a guided practice question.',
    },
  ],
})

const deferred = () => {
  let resolve!: (value: unknown) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<unknown>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const setup = () => {
  let snapshot = createExplorePromptRefinementSnapshot()
  const pending: Array<ReturnType<typeof deferred> & { signal: AbortSignal }> = []
  const request = vi.fn((_request: ExplorePromptRefinementRequest, signal: AbortSignal) => {
    const next = deferred()
    pending.push({ ...next, signal })
    return next.promise
  })
  const changes = vi.fn((next: ExplorePromptRefinementSnapshot) => {
    snapshot = next
  })
  const controller = new ExplorePromptRefinementController({ request, onChange: changes })
  return { controller, request, pending, changes, snapshot: () => snapshot }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('explicit exploration prompt refinement', () => {
  it('waits for the explicit refine action and never generates from a context update', async () => {
    const fixture = setup()
    fixture.controller.update(context(), true)
    fixture.controller.update(context('Show me a useful workflow.'), true)
    await vi.advanceTimersByTimeAsync(100_000)
    expect(fixture.request).not.toHaveBeenCalled()
    expect(fixture.snapshot().status).toBe('idle')
    fixture.controller.dispose()
  })

  it('validates input, trims the request, and invalidates choices on any draft edit', () => {
    expect(context('   ')).toBeNull()
    expect(context('x'.repeat(4001))).toBeNull()
    expect(context(`  ${original}  `)?.request.prompt).toBe(original)
    expect(context(` ${original}`)?.key).not.toBe(context(original)?.key)
    expect(context(original, 'different-session')?.key).not.toBe(context()?.key)
    expect(
      context(original, undefined, {
        lesson: { title: 'Git branches', kind: 'diagram', summary: 'A small branch graph.' },
      })?.key,
    ).not.toBe(context()?.key)
    expect(
      context(original, undefined, {
        conversation: [{ role: 'assistant', content: 'Let us inspect the current branch.' }],
      })?.key,
    ).not.toBe(context()?.key)
  })

  it('makes three validated choices available and consumes exactly the selected prompt once', async () => {
    const fixture = setup()
    const current = context(`  ${original}  `)
    fixture.controller.update(current, true)
    const work = fixture.controller.refine()
    expect(fixture.snapshot().status).toBe('loading')
    expect(fixture.request.mock.calls[0][0].prompt).toBe(original)
    fixture.pending[0].resolve(response())
    await work
    const rendered = fixture.snapshot()
    expect(rendered.status).toBe('ready')
    expect(rendered.options).toHaveLength(3)
    expect(fixture.controller.choose('unknown', current, true, rendered)).toBeNull()
    expect(fixture.controller.choose('option-2', current, true, rendered)).toBe(
      response().options[1].prompt,
    )
    expect(fixture.snapshot().status).toBe('idle')
    expect(fixture.snapshot().options).toEqual([])
    expect(fixture.controller.choose('option-2', current, true, rendered)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    fixture.controller.dispose()
  })

  it('rejects a choice synchronously after a draft changes, before update effects run', async () => {
    const fixture = setup()
    fixture.controller.update(context(), true)
    const work = fixture.controller.refine()
    fixture.pending[0].resolve(response())
    await work
    expect(
      fixture.controller.choose(
        'option-1',
        context('Explain git merge.'),
        true,
        fixture.snapshot(),
      ),
    ).toBeNull()
    expect(fixture.snapshot().options).toEqual([])
    fixture.controller.dispose()
  })

  it('rejects a choice synchronously when navigation or dictation disables the form', async () => {
    const fixture = setup()
    fixture.controller.update(context(), true)
    const work = fixture.controller.refine()
    fixture.pending[0].resolve(response())
    await work
    expect(fixture.controller.choose('option-1', context(), false, fixture.snapshot())).toBeNull()
    fixture.controller.update(context(), true)
    expect(fixture.snapshot().options).toEqual([])
    expect(fixture.request).toHaveBeenCalledTimes(1)
    fixture.controller.dispose()
  })

  it.each([
    ['draft edit', () => context('Explain git merge.'), true],
    ['session change', () => context(original, 'another-session'), true],
    ['learning path change', () => context(original, 'new:life-skills'), true],
    ['disabled form', () => context(), false],
  ] as const)('aborts on %s and ignores a late response', async (_label, nextContext, enabled) => {
    const fixture = setup()
    fixture.controller.update(context(), true)
    const work = fixture.controller.refine()
    fixture.controller.update(nextContext(), enabled)
    expect(fixture.pending[0].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    fixture.pending[0].resolve(response())
    await work
    expect(fixture.snapshot().options).toEqual([])
    expect(fixture.snapshot().status).toBe('idle')
    fixture.controller.dispose()
  })

  it('cancels a previous request when refining again and rejects an old rendered choice', async () => {
    const fixture = setup()
    fixture.controller.update(context(), true)
    const first = fixture.controller.refine()
    const second = fixture.controller.refine()
    expect(fixture.pending[0].signal.aborted).toBe(true)
    fixture.pending[0].resolve(response())
    await first
    expect(fixture.snapshot().status).toBe('loading')
    fixture.pending[1].resolve(response())
    await second
    const oldSnapshot = fixture.snapshot()
    const third = fixture.controller.refine()
    fixture.pending[2].resolve(response())
    await third
    expect(fixture.controller.choose('option-1', context(), true, oldSnapshot)).toBeNull()
    expect(fixture.controller.choose('option-1', context(), true, fixture.snapshot())).toBe(
      response().options[0].prompt,
    )
    fixture.controller.dispose()
  })

  it.each([
    ['incomplete options', { ...response(), options: response().options.slice(0, 2) }],
    ['duplicate identities', { ...response(), options: Array(3).fill(response().options[0]) }],
    ['different prompt', response('Explain a different topic.')],
  ])('does not offer %s and allows an explicit retry', async (_label, invalid) => {
    const fixture = setup()
    fixture.controller.update(context(), true)
    const first = fixture.controller.refine()
    fixture.pending[0].resolve(invalid)
    await first
    expect(fixture.snapshot().status).toBe('error')
    expect(fixture.snapshot().error).toMatch(/try again/i)
    expect(fixture.snapshot().options).toEqual([])
    const retry = fixture.controller.refine()
    fixture.pending[1].resolve(response())
    await retry
    expect(fixture.snapshot().status).toBe('ready')
    fixture.controller.dispose()
  })

  it('times out, aborts the request, and keeps late results unselectable', async () => {
    const fixture = setup()
    fixture.controller.update(context(), true)
    const work = fixture.controller.refine()
    await vi.advanceTimersByTimeAsync(95_000)
    expect(fixture.pending[0].signal.aborted).toBe(true)
    expect(fixture.snapshot().status).toBe('error')
    expect(fixture.snapshot().error).toMatch(/too long/)
    fixture.pending[0].resolve(response())
    await work
    expect(fixture.snapshot().options).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    fixture.controller.dispose()
  })

  it('cleans up cancellation and disposal without replacing the learner draft', async () => {
    const fixture = setup()
    fixture.controller.update(context(), true)
    const first = fixture.controller.refine()
    fixture.controller.clear()
    expect(fixture.pending[0].signal.aborted).toBe(true)
    fixture.pending[0].reject(new DOMException('Aborted', 'AbortError'))
    await first
    expect(fixture.snapshot().status).toBe('idle')
    const second = fixture.controller.refine()
    fixture.controller.dispose()
    const calls = fixture.changes.mock.calls.length
    fixture.pending[1].resolve(response())
    await second
    expect(fixture.changes).toHaveBeenCalledTimes(calls)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports service failures without producing fallback options', async () => {
    const fixture = setup()
    fixture.controller.update(context(), true)
    const work = fixture.controller.refine()
    fixture.pending[0].reject(new Error('Your local coach is unavailable.'))
    await work
    expect(fixture.snapshot()).toMatchObject({
      status: 'error',
      options: [],
      error: 'Your local coach is unavailable.',
    })
    fixture.controller.dispose()
  })

  it('posts only to the refinement endpoint without creating or saving a lesson', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response())))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new ExplorePromptRefinementController({ onChange: vi.fn() })
    controller.update(context(), true)
    await controller.refine()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/explore/refine-prompt',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ prompt: original }),
        signal: expect.any(AbortSignal),
      }),
    )
    controller.dispose()
  })
})
