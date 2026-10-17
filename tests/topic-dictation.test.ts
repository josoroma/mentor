import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTopicDictation } from '@/lib/audio/topic-dictation'
import type { Microphone, openMicrophone } from '@/lib/audio/microphone'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const setup = () => {
  let capture!: Parameters<typeof openMicrophone>[0]
  const microphone: Microphone = {
    sampleRate: 16_000,
    context: {} as AudioContext,
    close: vi.fn(async () => undefined),
    setMuted: vi.fn(),
  }
  const open = vi.fn(async (options: Parameters<typeof openMicrophone>[0]) => {
    capture = options
    return microphone
  })
  const transcribe = vi.fn(async (_audio: Blob, _signal: AbortSignal) => 'My next project')
  const callbacks = {
    onState: vi.fn(),
    onLevel: vi.fn(),
    onError: vi.fn(),
    onTranscript: vi.fn(),
  }
  const dictation = createTopicDictation(callbacks, { openMicrophone: open, transcribe })
  return {
    dictation,
    microphone,
    open,
    transcribe,
    callbacks,
    samples: (value = 0.1, count = 8000) => capture.onSamples(new Float32Array(count).fill(value)),
    end: () => capture.onEnded(),
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('topic dictation lifecycle', () => {
  it('closes capture before requesting a self-contained WAV and delivering a topic', async () => {
    const fixture = setup()
    await fixture.dictation.start()
    fixture.samples()
    await fixture.dictation.stop()
    expect(fixture.microphone.close).toHaveBeenCalledOnce()
    expect(fixture.transcribe).toHaveBeenCalledOnce()
    expect(vi.mocked(fixture.microphone.close).mock.invocationCallOrder[0]).toBeLessThan(
      fixture.transcribe.mock.invocationCallOrder[0],
    )
    const [audio, signal] = fixture.transcribe.mock.calls[0]
    expect(audio.type).toBe('audio/wav')
    const header = new DataView(await audio.arrayBuffer())
    expect(header.getUint32(24, true)).toBe(16_000)
    expect(header.getUint32(40, true)).toBe(8000 * 2)
    expect(signal.aborted).toBe(false)
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledWith('My next project')
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('idle')
    expect(fixture.callbacks.onLevel).toHaveBeenLastCalledWith(0)
    fixture.dictation.dispose()
  })

  it('rejects silence and short clicks without sending audio to speech recognition', async () => {
    const fixture = setup()
    await fixture.dictation.start()
    fixture.samples(0, 8000)
    fixture.samples(0.1, 500)
    await fixture.dictation.stop()
    expect(fixture.microphone.close).toHaveBeenCalledOnce()
    expect(fixture.transcribe).not.toHaveBeenCalled()
    expect(fixture.callbacks.onError).toHaveBeenLastCalledWith(
      expect.stringContaining('could not hear your topic'),
    )
    fixture.dictation.dispose()
  })

  it('closes a late microphone permission result after cancellation without affecting a new recording', async () => {
    const fixture = setup()
    const permission = deferred<Microphone>()
    fixture.open.mockImplementationOnce(() => permission.promise)
    const firstStart = fixture.dictation.start()
    fixture.dictation.cancel()
    await fixture.dictation.start()
    const abandoned = { ...fixture.microphone, close: vi.fn(async () => undefined) }
    permission.resolve(abandoned)
    await firstStart
    expect(abandoned.close).toHaveBeenCalledOnce()
    expect(fixture.microphone.close).not.toHaveBeenCalled()
    fixture.samples()
    await fixture.dictation.stop()
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledOnce()
    fixture.dictation.dispose()
  })

  it('cancels permission waiting when Stop is pressed before capture opens', async () => {
    const fixture = setup()
    const permission = deferred<Microphone>()
    fixture.open.mockImplementationOnce(() => permission.promise)
    const starting = fixture.dictation.start()
    await fixture.dictation.stop()
    permission.resolve(fixture.microphone)
    await starting
    expect(fixture.microphone.close).toHaveBeenCalledOnce()
    expect(fixture.transcribe).not.toHaveBeenCalled()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('idle')
    fixture.dictation.dispose()
  })

  it('aborts recognition and discards late results after cancellation', async () => {
    const fixture = setup()
    const recognition = deferred<string>()
    fixture.transcribe.mockImplementationOnce(() => recognition.promise)
    await fixture.dictation.start()
    fixture.samples()
    const stopping = fixture.dictation.stop()
    await vi.waitFor(() => expect(fixture.transcribe).toHaveBeenCalledOnce())
    fixture.dictation.cancel()
    expect(fixture.transcribe.mock.calls[0][1].aborted).toBe(true)
    recognition.resolve('This should not replace a newer topic')
    await stopping
    expect(fixture.callbacks.onTranscript).not.toHaveBeenCalled()
    fixture.dictation.dispose()
  })

  it('stops automatically at 30 seconds even if audio callbacks stop arriving', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    await fixture.dictation.start()
    fixture.samples()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fixture.microphone.close).toHaveBeenCalledOnce()
    expect(fixture.transcribe).toHaveBeenCalledOnce()
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    fixture.dictation.dispose()
  })

  it('bounds recording by audio samples when wall-clock timers are throttled', async () => {
    const fixture = setup()
    await fixture.dictation.start()
    fixture.samples(0.1, 16_000 * 35)
    await vi.waitFor(() => expect(fixture.callbacks.onTranscript).toHaveBeenCalledOnce())
    const audio = fixture.transcribe.mock.calls[0][0]
    expect(audio.size).toBe(44 + 16_000 * 30 * 2)
    fixture.dictation.dispose()
  })

  it('aborts timed-out recognition and exposes a retryable error', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    fixture.transcribe.mockImplementationOnce(
      (_audio, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }),
    )
    await fixture.dictation.start()
    fixture.samples()
    const stopping = fixture.dictation.stop()
    await vi.advanceTimersByTimeAsync(45_000)
    await stopping
    expect(fixture.transcribe.mock.calls[0][1].aborted).toBe(true)
    expect(fixture.callbacks.onError).toHaveBeenLastCalledWith(
      'Speech recognition took too long. Please try again.',
    )
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('idle')
    expect(vi.getTimerCount()).toBe(0)
    fixture.dictation.dispose()
  })

  it('cleans up on disposal and never notifies an unmounted consumer', async () => {
    const fixture = setup()
    const permission = deferred<Microphone>()
    fixture.open.mockImplementationOnce(() => permission.promise)
    const starting = fixture.dictation.start()
    fixture.dictation.dispose()
    Object.values(fixture.callbacks).forEach((callback) => callback.mockClear())
    permission.resolve(fixture.microphone)
    await starting
    expect(fixture.microphone.close).toHaveBeenCalledOnce()
    Object.values(fixture.callbacks).forEach((callback) => expect(callback).not.toHaveBeenCalled())
    await fixture.dictation.start()
    expect(fixture.open).toHaveBeenCalledOnce()
  })

  it('reports microphone errors and allows retry', async () => {
    const fixture = setup()
    fixture.open.mockRejectedValueOnce(new Error('Microphone permission was denied.'))
    await fixture.dictation.start()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('idle')
    expect(fixture.callbacks.onError).toHaveBeenLastCalledWith('Microphone permission was denied.')
    await fixture.dictation.start()
    fixture.samples()
    await fixture.dictation.stop()
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledOnce()
    fixture.dictation.dispose()
  })

  it('ends a recording when the microphone is disconnected', async () => {
    const fixture = setup()
    await fixture.dictation.start()
    fixture.samples()
    fixture.end()
    await vi.waitFor(() => expect(fixture.callbacks.onTranscript).toHaveBeenCalledOnce())
    expect(fixture.microphone.close).toHaveBeenCalledOnce()
    fixture.dictation.dispose()
  })
})

describe('topic transcription boundary', () => {
  it.each([
    [{ text: '' }, 'could not hear your topic'],
    [{ text: 42 }, 'invalid transcript'],
  ])('rejects unsupported or empty recognition responses', async (payload, message) => {
    const fixture = setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(payload)),
    )
    const dictation = createTopicDictation(fixture.callbacks, {
      openMicrophone: fixture.open,
    })
    await dictation.start()
    fixture.samples()
    await dictation.stop()
    expect(fixture.callbacks.onTranscript).not.toHaveBeenCalled()
    expect(fixture.callbacks.onError).toHaveBeenLastCalledWith(expect.stringContaining(message))
    dictation.dispose()
    fixture.dictation.dispose()
  })
})
