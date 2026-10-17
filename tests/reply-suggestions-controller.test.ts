import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scenarios } from '@/app/_constants'
import {
  createReplySuggestionsContext,
  createReplySuggestionsSnapshot,
  ReplySuggestionsController,
  type ReplySuggestionsSnapshot,
} from '@/app/_reply-suggestions-controller'
import type { ReplySuggestionsRequest } from '@/app/_reply-suggestions'
import type { TranscriptMessage } from '@/app/_types'

const coachTurn: TranscriptMessage = {
  id: 'coach-1',
  role: 'assistant',
  content: 'Which data sources should we consider?',
  timestamp: 1000,
}
const replies = {
  replies: [
    { label: 'Start simply', text: 'Could we start with one example data source?' },
    { label: 'Explore options', text: 'We could compare the options before choosing a source.' },
    { label: 'Clarify', text: 'What information does the service need?' },
  ],
}
const context = (messages = [coachTurn], sessionId: string | null = 'session-1') =>
  createReplySuggestionsContext({
    sessionId,
    scenario: scenarios[0],
    roleId: 'ai-developer',
    level: 'B2',
    messages,
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

const flush = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve()
}

const setup = () => {
  const pending: Array<ReturnType<typeof deferred> & { signal: AbortSignal }> = []
  let snapshot: ReplySuggestionsSnapshot = createReplySuggestionsSnapshot()
  const request = vi.fn((_request: ReplySuggestionsRequest, signal: AbortSignal) => {
    const next = deferred()
    pending.push({ ...next, signal })
    return next.promise
  })
  const controller = new ReplySuggestionsController({
    request,
    onChange: (next) => {
      snapshot = next
    },
  })
  return { controller, request, pending, snapshot: () => snapshot }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('suggested conversation replies', () => {
  it('offers three generic practice starters before a completed coach turn is available', () => {
    const fixture = setup()
    expect(fixture.snapshot().replies).toHaveLength(3)
    expect(fixture.snapshot().isGenerated).toBe(false)
    fixture.controller.update(context([]), true, false)
    fixture.controller.update(context([coachTurn], null), true, false)
    fixture.controller.update(context([{ ...coachTurn, role: 'user' }]), true, false)
    fixture.controller.update(context(), false, false)
    fixture.controller.update(context(), true, true)
    expect(fixture.request).not.toHaveBeenCalled()
    fixture.controller.dispose()
  })

  it('makes one request per coach turn and reuses completed replies through panel toggles', async () => {
    const fixture = setup()
    fixture.controller.update(context(), true, false)
    fixture.controller.update(context(), true, false)
    await vi.advanceTimersByTimeAsync(650)
    expect(fixture.request).toHaveBeenCalledTimes(1)
    expect(fixture.snapshot().isLoading).toBe(true)
    fixture.pending[0].resolve(replies)
    await flush()
    fixture.controller.update(context(), false, false)
    fixture.controller.update(context(), true, true)
    fixture.controller.update(context(), true, false)
    expect(fixture.request).toHaveBeenCalledTimes(1)
    expect(fixture.snapshot()).toMatchObject({
      replies: replies.replies,
      turnId: coachTurn.id,
      isGenerated: true,
      isLoading: false,
      error: null,
    })
    expect(vi.getTimerCount()).toBe(0)
    fixture.controller.dispose()
  })

  it('aborts when voice or correction work becomes busy and ignores delayed results', async () => {
    const fixture = setup()
    fixture.controller.update(context(), true, false)
    await vi.advanceTimersByTimeAsync(650)
    fixture.controller.update(context(), true, true)
    expect(fixture.pending[0].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(fixture.snapshot().isLoading).toBe(false)
    fixture.controller.update(context(), true, false)
    await vi.advanceTimersByTimeAsync(650)
    expect(fixture.request).toHaveBeenCalledTimes(2)
    fixture.pending[0].resolve(replies)
    await flush()
    expect(fixture.snapshot().isGenerated).toBe(false)
    expect(fixture.snapshot().isLoading).toBe(true)
    fixture.pending[1].resolve(replies)
    await flush()
    expect(fixture.snapshot().isGenerated).toBe(true)
    fixture.controller.dispose()
  })

  it('clears and cancels replies when the learner speaks, the session changes, or the panel closes', async () => {
    const fixture = setup()
    fixture.controller.update(context(), true, false)
    await vi.advanceTimersByTimeAsync(650)
    fixture.controller.update(context([{ ...coachTurn, role: 'user' }]), true, false)
    expect(fixture.pending[0].signal.aborted).toBe(true)
    expect(fixture.snapshot().turnId).toBeNull()
    fixture.controller.update(context(), true, false)
    await vi.advanceTimersByTimeAsync(650)
    fixture.controller.update(context([coachTurn], 'session-2'), true, false)
    await vi.advanceTimersByTimeAsync(650)
    expect(fixture.pending[1].signal.aborted).toBe(true)
    fixture.pending[1].resolve(replies)
    await flush()
    expect(fixture.snapshot().isGenerated).toBe(false)
    fixture.controller.update(context([coachTurn], 'session-2'), false, false)
    expect(fixture.pending[2].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    fixture.controller.update(context([coachTurn], null), false, false)
    expect(fixture.snapshot().turnId).toBeNull()
    fixture.controller.dispose()
  })

  it('requests new ideas for each new coach turn, even when the text repeats', async () => {
    const fixture = setup()
    fixture.controller.update(context(), true, false)
    await vi.advanceTimersByTimeAsync(650)
    fixture.pending[0].resolve(replies)
    await flush()
    fixture.controller.update(context([{ ...coachTurn, id: 'coach-2' }]), true, false)
    await vi.advanceTimersByTimeAsync(650)
    expect(fixture.request).toHaveBeenCalledTimes(2)
    expect(fixture.snapshot()).toMatchObject({ turnId: 'coach-2', isGenerated: false })
    fixture.controller.dispose()
    expect(fixture.pending[1].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('holds a known failure until the learner retries or a new coach turn arrives', async () => {
    const fixture = setup()
    fixture.controller.update(context(), true, false)
    await vi.advanceTimersByTimeAsync(650)
    fixture.pending[0].reject(new Error('The local coach is offline.'))
    await flush()
    fixture.controller.update(context(), true, false)
    fixture.controller.update(context(), false, false)
    fixture.controller.update(context(), true, true)
    fixture.controller.update(context(), true, false)
    expect(fixture.request).toHaveBeenCalledTimes(1)
    expect(fixture.snapshot().error).toBe('The local coach is offline.')
    expect(fixture.snapshot().replies).toHaveLength(3)
    fixture.controller.retry()
    await vi.advanceTimersByTimeAsync(650)
    expect(fixture.request).toHaveBeenCalledTimes(2)
    expect(fixture.snapshot().error).toBeNull()
    fixture.pending[1].reject(new Error('Still offline.'))
    await flush()
    fixture.controller.update(context([{ ...coachTurn, id: 'coach-2' }]), true, false)
    await vi.advanceTimersByTimeAsync(650)
    expect(fixture.request).toHaveBeenCalledTimes(3)
    fixture.controller.dispose()
  })

  it('rejects incomplete model responses without mislabeling generic practice starters', async () => {
    const fixture = setup()
    fixture.controller.update(context(), true, false)
    await vi.advanceTimersByTimeAsync(650)
    fixture.pending[0].resolve({ replies: replies.replies.slice(0, 2) })
    await flush()
    expect(fixture.snapshot()).toMatchObject({ isLoading: false, isGenerated: false })
    expect(fixture.snapshot().error).toMatch(/incomplete/)
    expect(fixture.snapshot().replies).toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)
    fixture.controller.dispose()
  })

  it('settles a timeout even if a transport ignores abort and ignores its eventual success', async () => {
    const fixture = setup()
    fixture.controller.update(context(), true, false)
    await vi.advanceTimersByTimeAsync(650)
    await vi.advanceTimersByTimeAsync(85_000)
    expect(fixture.pending[0].signal.aborted).toBe(true)
    expect(fixture.snapshot().error).toMatch(/too long/)
    expect(fixture.snapshot().isLoading).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    fixture.pending[0].resolve(replies)
    await flush()
    fixture.controller.update(context(), true, false)
    expect(fixture.request).toHaveBeenCalledTimes(1)
    expect(fixture.snapshot().isGenerated).toBe(false)
    fixture.controller.dispose()
  })

  it('waits for correction work and cancels scheduled requests when hidden or disposed', async () => {
    const fixture = setup()
    fixture.controller.update(context(), true, false)
    expect(fixture.snapshot().replies).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(450)
    fixture.controller.update(context(), true, true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fixture.request).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    fixture.controller.update(context(), true, false)
    await vi.advanceTimersByTimeAsync(300)
    fixture.controller.update(context(), false, false)
    expect(vi.getTimerCount()).toBe(0)
    fixture.controller.update(context(), true, false)
    await vi.advanceTimersByTimeAsync(649)
    expect(fixture.request).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fixture.request).toHaveBeenCalledTimes(1)
    fixture.controller.update(context([{ ...coachTurn, id: 'coach-2' }]), true, false)
    fixture.controller.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fixture.request).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds context to twelve messages and keeps the latest six thousand characters', () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      ...coachTurn,
      id: `message-${index}`,
      content: 'a'.repeat(6990) + 'last words',
    }))
    const prepared = context(messages)
    expect(prepared?.request.messages).toHaveLength(12)
    expect(prepared?.request.messages.every((message) => message.content.length === 6000)).toBe(
      true,
    )
    expect(prepared?.turnId).toBe('message-19')
    expect(
      prepared?.request.messages.every((message) => message.content.endsWith('last words')),
    ).toBe(true)
  })
})
