import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TranscriptMessage } from '@/app/_types'
import { LiveImprovementQueue, type ImprovementSnapshot } from '@/lib/ai/live-improvements'

const message = (
  content: string,
  id = 'turn-1',
  role: TranscriptMessage['role'] = 'user',
): TranscriptMessage => ({
  id,
  content,
  role,
  timestamp: 1_792_065_600_000,
})

type RequestCall = {
  message: TranscriptMessage
  context: TranscriptMessage[]
  signal: AbortSignal
  stream: (text: string) => void
  resolve: (text: string) => void
  reject: (error: Error) => void
}

const createHarness = (respectAbort = true) => {
  const calls: RequestCall[] = []
  const changes: ImprovementSnapshot[] = []
  const request = vi.fn(
    (
      source: TranscriptMessage,
      context: TranscriptMessage[],
      signal: AbortSignal,
      stream: (text: string) => void,
    ) =>
      new Promise<string>((resolve, reject) => {
        calls.push({ message: source, context, signal, stream, resolve, reject })
        if (respectAbort)
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            { once: true },
          )
      }),
  )
  const queue = new LiveImprovementQueue({
    request,
    onChange: (snapshot) => changes.push(snapshot),
  })
  return { queue, calls, changes, request, latest: () => changes.at(-1) }
}

describe('live improved transcript queue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('discards a slow obsolete draft and serializes the latest recognition result', async () => {
    const { queue, calls, latest } = createHarness()
    queue.update([], message('Yesterday I fix'), false)
    await vi.advanceTimersByTimeAsync(450)
    queue.update([], message('Yesterday I fix the bug'), false)
    queue.update([], message('Yesterday I fix the login bug'), false)
    expect(calls).toHaveLength(1)
    calls[0].resolve('Yesterday, I fixed it.')
    await vi.advanceTimersByTimeAsync(450)
    expect(latest()?.improvements).toEqual([])
    expect(calls).toHaveLength(2)
    expect(calls[1].message.content).toBe('Yesterday I fix the login bug')
    calls[1].resolve('Yesterday, I fixed the login bug.')
    await vi.advanceTimersByTimeAsync(0)
    expect(latest()?.improvements).toEqual([
      expect.objectContaining({
        messageId: 'turn-1',
        original: 'Yesterday I fix the login bug',
        improved: 'Yesterday, I fixed the login bug.',
        isFinal: false,
      }),
    ])
    queue.dispose()
  })

  it('does not display streamed wording for an obsolete draft after recognition changes', async () => {
    const { queue, calls, latest } = createHarness()
    queue.update([], message('Yesterday I fix'), false)
    await vi.advanceTimersByTimeAsync(450)
    calls[0].stream('Yesterday, I fixed')
    queue.update([], message('Today I test the change'), false)
    calls[0].stream('Yesterday, I fixed the bug.')
    expect(latest()?.pending).toBeNull()
    calls[0].resolve('Yesterday, I fixed the bug.')
    await vi.advanceTimersByTimeAsync(0)
    expect(latest()?.improvements).toEqual([])
    queue.dispose()
  })

  it('promotes a matching draft to a final correction without another request', async () => {
    const { queue, calls, latest } = createHarness()
    const source = message('I finish the test')
    queue.update([], source, false)
    await vi.advanceTimersByTimeAsync(450)
    calls[0].resolve('I finished the test.')
    await vi.advanceTimersByTimeAsync(0)
    queue.update([source], null, false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toHaveLength(1)
    expect(latest()?.improvements[0].isFinal).toBe(true)
    queue.dispose()
  })

  it('promotes a matching draft when finishing immediately without issuing a duplicate request', async () => {
    const { queue, calls } = createHarness()
    const source = message('I finish the test')
    queue.update([], source, false)
    await vi.advanceTimersByTimeAsync(450)
    calls[0].resolve('I finished the test.')
    await vi.advanceTimersByTimeAsync(0)
    const finished = queue.finish([source])
    await vi.advanceTimersByTimeAsync(0)
    // Resolve an unexpected request so a failing assertion never leaves the test hanging.
    calls[1]?.resolve('I finished the test.')
    const results = await finished
    expect(calls).toHaveLength(1)
    expect(results).toEqual([
      expect.objectContaining({ improved: 'I finished the test.', isFinal: true }),
    ])
    queue.dispose()
  })

  it('aborts corrections and cancels pending scheduling while the coach is busy', async () => {
    const { queue, calls, latest } = createHarness(false)
    const source = message('I finish the test')
    queue.update([], source, false)
    await vi.advanceTimersByTimeAsync(450)
    calls[0].stream('I finished')
    queue.update([], source, true)
    expect(calls[0].signal.aborted).toBe(true)
    calls[0].resolve('I finished the test.')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls).toHaveLength(1)
    expect(latest()?.pending).toBeNull()
    expect(latest()?.improvements).toEqual([])
    queue.update([], source, false)
    await vi.advanceTimersByTimeAsync(450)
    expect(calls).toHaveLength(2)
    queue.dispose()
  })

  it('does not start a queued correction if the coach becomes busy during the debounce', async () => {
    const { queue, calls } = createHarness()
    const source = message('I finish the test')
    queue.update([], source, false)
    queue.update([], source, true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toHaveLength(0)
    queue.dispose()
  })

  it('retains an explicit error and allows retry without an automatic request loop', async () => {
    const { queue, calls, latest } = createHarness()
    queue.update([message('I finish the test')], null, false)
    await vi.advanceTimersByTimeAsync(450)
    calls[0].reject(new Error('Local model unavailable'))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(latest()?.pending).toEqual(
      expect.objectContaining({ status: 'error', error: 'Local model unavailable' }),
    )
    expect(calls).toHaveLength(1)
    queue.retry()
    await vi.advanceTimersByTimeAsync(450)
    expect(calls).toHaveLength(2)
    calls[1].resolve('I finished the test.')
    await vi.advanceTimersByTimeAsync(0)
    expect(latest()?.pending).toBeNull()
    expect(latest()?.improvements[0].isFinal).toBe(true)
    queue.dispose()
  })

  it('keeps an earlier turn failure visible while a later turn succeeds and retries it explicitly', async () => {
    const { queue, calls, latest } = createHarness()
    const first = message('I finish tests', 'first')
    const second = message('Today I deploy', 'second')
    queue.update([first, second], null, false)
    await vi.advanceTimersByTimeAsync(450)
    calls[0].reject(new Error('Local model unavailable'))
    await vi.advanceTimersByTimeAsync(450)
    expect(calls).toHaveLength(2)
    expect(latest()?.pending).toMatchObject({ messageId: 'second', status: 'waiting' })
    expect(latest()?.failures).toEqual([
      expect.objectContaining({
        messageId: 'first',
        original: first.content,
        status: 'error',
        error: 'Local model unavailable',
      }),
    ])
    calls[1].resolve('Today, I will deploy the change.')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(calls).toHaveLength(2)
    expect(latest()?.pending).toBeNull()
    expect(latest()?.failures).toHaveLength(1)
    expect(latest()?.improvements.map(({ messageId }) => messageId)).toEqual(['second'])
    queue.retry()
    expect(latest()?.failures).toEqual([])
    await vi.advanceTimersByTimeAsync(450)
    expect(calls[2].message).toEqual(first)
    calls[2].resolve('I finished the tests.')
    await vi.advanceTimersByTimeAsync(0)
    expect(latest()?.failures).toEqual([])
    expect(
      latest()
        ?.improvements.map(({ messageId }) => messageId)
        .sort(),
    ).toEqual(['first', 'second'])
    queue.dispose()
  })

  it('discards retained failures when their source is revised or removed', async () => {
    const { queue, calls, latest } = createHarness()
    queue.update([], message('Yesterday I fix'), false)
    await vi.advanceTimersByTimeAsync(450)
    calls[0].reject(new Error('Local model unavailable'))
    await vi.advanceTimersByTimeAsync(0)
    expect(latest()?.failures).toHaveLength(1)
    queue.update([], message('Today I test the change'), true)
    expect(latest()?.failures).toEqual([])
    expect(latest()?.pending).toBeNull()
    queue.update([], message('Today I test the change'), false)
    await vi.advanceTimersByTimeAsync(450)
    expect(calls).toHaveLength(2)
    calls[1].reject(new Error('Still unavailable'))
    await vi.advanceTimersByTimeAsync(0)
    expect(latest()?.failures).toHaveLength(1)
    queue.update([], null, false)
    expect(latest()?.failures).toEqual([])
    expect(latest()?.pending).toBeNull()
    queue.dispose()
  })

  it('does not reintroduce a failed obsolete draft after recognition changes', async () => {
    const { queue, calls, latest } = createHarness()
    queue.update([], message('Yesterday I fix'), false)
    await vi.advanceTimersByTimeAsync(450)
    queue.update([], message('Today I test the change'), false)
    calls[0].reject(new Error('An obsolete request failed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(latest()?.failures).toEqual([])
    expect(latest()?.pending).toBeNull()
    await vi.advanceTimersByTimeAsync(450)
    expect(calls[1].message.content).toBe('Today I test the change')
    queue.dispose()
  })

  it('replaces a failed interim draft with a fresh attempt when the same words become final', async () => {
    const { queue, calls, latest } = createHarness()
    const source = message('I finish the test')
    queue.update([], source, false)
    await vi.advanceTimersByTimeAsync(450)
    calls[0].reject(new Error('Draft request failed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(latest()?.failures).toHaveLength(1)
    queue.update([source], null, false)
    await vi.advanceTimersByTimeAsync(450)
    expect(calls).toHaveLength(2)
    expect(latest()?.failures).toEqual([])
    expect(latest()?.pending).toMatchObject({ messageId: source.id, status: 'waiting' })
    calls[1].resolve('I finished the test.')
    await vi.advanceTimersByTimeAsync(0)
    expect(latest()?.failures).toEqual([])
    expect(latest()?.improvements).toEqual([
      expect.objectContaining({
        messageId: source.id,
        improved: 'I finished the test.',
        isFinal: true,
      }),
    ])
    queue.dispose()
  })

  it('does not emit late stream chunks or results after disposal', async () => {
    const { queue, calls, changes } = createHarness(false)
    queue.update([], message('I finish the test'), false)
    await vi.advanceTimersByTimeAsync(450)
    queue.dispose()
    const count = changes.length
    expect(calls[0].signal.aborted).toBe(true)
    calls[0].stream('I finished')
    calls[0].resolve('I finished the test.')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(changes).toHaveLength(count)
    expect(calls).toHaveLength(1)
  })

  it('uses the last six preceding messages as context and never corrects the coach', async () => {
    const { queue, calls } = createHarness()
    const context = Array.from({ length: 8 }, (_, index) =>
      message(`Coach context ${index}`, `coach-${index}`, 'assistant'),
    )
    const source = message('I finish the test')
    queue.update([...context, source], null, false)
    await vi.advanceTimersByTimeAsync(450)
    expect(calls).toHaveLength(1)
    expect(calls[0].message).toEqual(source)
    expect(calls[0].context).toEqual(context.slice(-6))
    queue.dispose()
  })

  it('finishes the final user messages in order and excludes abandoned interim speech', async () => {
    const { queue, calls } = createHarness()
    const first = message('I finish tests', 'first')
    const second = message('Today I deploy', 'second')
    queue.update([], message('Abandoned partial', 'abandoned'), true)
    const finishing = queue.finish([first, message('What is next?', 'coach', 'assistant'), second])
    await vi.advanceTimersByTimeAsync(0)
    expect(calls[0].message).toEqual(first)
    calls[0].resolve('I finished the tests.')
    await vi.advanceTimersByTimeAsync(0)
    expect(calls[1].message).toEqual(second)
    calls[1].resolve('Today, I will deploy the change.')
    const result = await finishing
    expect(result.map(({ messageId }) => messageId)).toEqual(['first', 'second'])
    expect(result.every(({ isFinal }) => isFinal)).toBe(true)
    queue.dispose()
  })

  it('bounds the entire finish operation even when an active request does not honor cancellation', async () => {
    const { queue, calls } = createHarness(false)
    queue.update([], message('I finish tests'), false)
    await vi.advanceTimersByTimeAsync(450)
    let settled = false
    const finishing = queue.finish([message('I finish tests')]).then((result) => {
      settled = true
      return result
    })
    await vi.advanceTimersByTimeAsync(25_001)
    const settledWithinDeadline = settled
    // Release the transport after the deadline so the test does not leak an unresolved task.
    calls.forEach((call) => call.resolve('I finished the tests.'))
    await vi.advanceTimersByTimeAsync(0)
    calls.forEach((call) => call.resolve('I finished the tests.'))
    await finishing
    expect(settledWithinDeadline).toBe(true)
    queue.dispose()
  })
})
