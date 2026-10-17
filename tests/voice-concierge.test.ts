import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVoiceConcierge, type ConciergeSpeaker } from '@/lib/audio/voice-concierge'
import type { Microphone, openMicrophone } from '@/lib/audio/microphone'
import { SPEECH_CHUNK_LIMIT, splitSpeechText } from '@/lib/audio/audio-utils'
import type { SpeechProvider } from '@/lib/audio/speech-provider'
import type { SpeechPersonaId } from '@/lib/audio/personas'
import { notifySpeechProviderChange } from '@/lib/audio/speech-preference'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const disposables: Array<() => void> = []
const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}
const setup = (microphoneMode: 'automatic' | 'manual' = 'automatic') => {
  let capture!: Parameters<typeof openMicrophone>[0]
  let speakerCallbacks!: { onStart: () => void; onLevel: (level: number) => void }
  const playback = deferred<void>()
  const microphone: Microphone = {
    sampleRate: 16000,
    context: {} as AudioContext,
    close: vi.fn(async () => undefined),
    setMuted: vi.fn(),
  }
  const open = vi.fn(async (options: Parameters<typeof openMicrophone>[0]) => {
    capture = options
    return microphone
  })
  const speaker: ConciergeSpeaker = {
    unlock: vi.fn(async () => true),
    play: vi.fn(async () => {
      speakerCallbacks.onStart()
      speakerCallbacks.onLevel(0.2)
      await playback.promise
    }),
    stop: vi.fn(() => playback.resolve()),
    close: vi.fn(async () => undefined),
  }
  const openOutput = vi.fn((callbacks: typeof speakerCallbacks) => {
    speakerCallbacks = callbacks
    return speaker
  })
  const callbacks = {
    onState: vi.fn(),
    onCoachLevel: vi.fn(),
    onUserLevel: vi.fn(),
    onInterimTranscript: vi.fn(),
    onError: vi.fn(),
    onTranscript: vi.fn(),
    onPlayback: vi.fn(),
    onMicrophoneEnabled: vi.fn(),
    onConversationComplete: vi.fn(),
    onListeningQuiet: vi.fn(),
    onSpeechStart: vi.fn(),
  }
  const synthesize = vi.fn(
    async (
      _text: string,
      _signal: AbortSignal,
      _voice?: 'coach' | 'partner',
      _provider?: SpeechProvider,
      _persona?: SpeechPersonaId,
    ) => new ArrayBuffer(8),
  )
  const transcribe = vi.fn(
    async (_audio: Blob, _signal: AbortSignal) => 'I want to talk about design reviews.',
  )
  const concierge = createVoiceConcierge(callbacks, {
    openMicrophone: open,
    openSpeaker: openOutput,
    synthesize,
    transcribe,
    microphoneMode,
  })
  disposables.push(concierge.dispose)
  return {
    concierge,
    callbacks,
    microphone,
    speaker,
    open,
    synthesize,
    transcribe,
    playback,
    output: () => speakerCallbacks,
    samples: (value: number, ms = 100) =>
      capture.onSamples(new Float32Array((16000 * ms) / 1000).fill(value)),
  }
}

afterEach(() => {
  disposables.splice(0).forEach((dispose) => dispose())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('spoken concierge', () => {
  it('keeps assigned persona identities across chunks, prefetch and replay', async () => {
    const fixture = setup()
    fixture.playback.resolve()
    const turns = [
      {
        speaker: 'alex' as const,
        persona: 'riley' as const,
        text: 'A specific example helps colleagues understand an unfamiliar tradeoff. '.repeat(8),
      },
      {
        speaker: 'sam' as const,
        persona: 'jordan' as const,
        text: 'That gives me useful context for the review.',
      },
    ]
    await fixture.concierge.beginConversation(turns, 'kokoro')
    fixture.concierge.pause()
    await fixture.concierge.enable()
    expect(fixture.synthesize.mock.calls.length).toBeGreaterThan(4)
    for (const [, , channel, provider, persona] of fixture.synthesize.mock.calls) {
      expect(provider).toBe('kokoro')
      expect(persona).toBe(channel === 'coach' ? 'riley' : 'jordan')
    }
    expect(fixture.callbacks.onPlayback).toHaveBeenCalledWith(
      expect.objectContaining({ activeSpeaker: 'sam' }),
    )
  })

  it('requires a new exchange instead of replaying assigned voices on a different engine', async () => {
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), {
        localStorage: { getItem: () => JSON.stringify({ speechProvider: 'chatterbox' }) },
      }),
    )
    const fixture = setup()
    await fixture.concierge.beginConversation(
      [
        { speaker: 'alex', persona: 'riley', text: 'A useful example.' },
        { speaker: 'sam', persona: 'jordan', text: 'I understand.' },
      ],
      'kokoro',
    )
    expect(fixture.synthesize).not.toHaveBeenCalled()
    expect(fixture.callbacks.onError).toHaveBeenLastCalledWith(
      expect.stringContaining('Start a new exchange'),
    )
  })
  it('keeps one saved engine across both personas and all prefetched chunks', async () => {
    let provider = 'kokoro'
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), {
        localStorage: { getItem: () => JSON.stringify({ speechProvider: provider }) },
      }),
    )
    const fixture = setup()
    vi.mocked(fixture.speaker.play).mockImplementation(async () => {
      provider = 'macos'
    })
    await fixture.concierge.beginConversation([
      { speaker: 'alex', text: 'A useful thought about communicating with teammates. '.repeat(10) },
      { speaker: 'sam', text: 'I would try that approach during a design review.' },
    ])
    expect(fixture.synthesize.mock.calls.length).toBeGreaterThan(2)
    expect(fixture.synthesize.mock.calls.every(([, , , engine]) => engine === 'kokoro')).toBe(true)
    expect(fixture.synthesize.mock.calls.at(-1)?.[2]).toBe('partner')
  })

  it('stops both playback and prefetched synthesis when the saved engine changes', async () => {
    let provider = 'chatterbox'
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), {
        localStorage: { getItem: () => JSON.stringify({ speechProvider: provider }) },
      }),
    )
    const fixture = setup()
    const beginning = fixture.concierge.beginConversation([
      { speaker: 'alex', text: 'How is your implementation going?' },
      { speaker: 'sam', text: 'The review is ready.' },
    ])
    await flush()
    provider = 'macos'
    notifySpeechProviderChange()
    await beginning
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('paused')
    expect(fixture.synthesize.mock.calls.every(([, signal]) => signal.aborted)).toBe(true)
    expect(fixture.speaker.stop).toHaveBeenCalled()
    expect(fixture.microphone.close).toHaveBeenCalled()
  })

  it('preserves final topic transcription when the saved engine changes', async () => {
    let provider = 'chatterbox'
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), {
        localStorage: { getItem: () => JSON.stringify({ speechProvider: provider }) },
      }),
    )
    const fixture = setup()
    const transcript = deferred<string>()
    fixture.transcribe.mockImplementationOnce(() => transcript.promise)
    await fixture.concierge.listen()
    fixture.samples(0.1, 700)
    const finishing = fixture.concierge.finishTurn()
    await flush()
    const signal = fixture.transcribe.mock.calls[0][1]
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('transcribing')
    provider = 'kokoro'
    notifySpeechProviderChange()
    expect(signal.aborted).toBe(false)
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('transcribing')
    transcript.resolve('I want to practice explaining tradeoffs.')
    await finishing
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledExactlyOnceWith(
      'I want to practice explaining tradeoffs.',
    )
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('idle')
  })

  it('keeps the microphone and complete captured topic while listening across an engine change', async () => {
    let provider = 'macos'
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), {
        localStorage: { getItem: () => JSON.stringify({ speechProvider: provider }) },
      }),
    )
    const fixture = setup()
    await fixture.concierge.listen()
    fixture.samples(0.1, 400)
    provider = 'kokoro'
    notifySpeechProviderChange()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('listening')
    expect(fixture.microphone.close).not.toHaveBeenCalled()
    fixture.samples(0.1, 350)
    await fixture.concierge.finishTurn()
    expect(fixture.transcribe.mock.calls[0][0].size).toBe(44 + 750 * 16 * 2)
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledOnce()
  })

  it('stops only demonstration audio when a learner has already started their topic', async () => {
    let provider = 'chatterbox'
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), {
        localStorage: { getItem: () => JSON.stringify({ speechProvider: provider }) },
      }),
    )
    const fixture = setup()
    const beginning = fixture.concierge.begin('A topic suggestion from your colleague.')
    await flush()
    // Enough accumulated speech for a topic, below the continuous barge-in threshold.
    fixture.samples(0.1, 180)
    fixture.samples(0, 50)
    fixture.samples(0.1, 180)
    expect(fixture.speaker.stop).not.toHaveBeenCalled()
    provider = 'kokoro'
    notifySpeechProviderChange()
    expect(fixture.speaker.stop).toHaveBeenCalledOnce()
    expect(fixture.synthesize.mock.calls[0][1].aborted).toBe(true)
    expect(fixture.microphone.close).not.toHaveBeenCalled()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('listening')
    fixture.samples(0.1, 300)
    fixture.samples(0, 1200)
    await beginning
    await flush()
    expect(fixture.transcribe.mock.calls[0][0].size).toBe(44 + 1910 * 16 * 2)
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledOnce()
  })

  it('plays its prompt and automatically recognizes one utterance after a pause', async () => {
    const fixture = setup()
    const beginning = fixture.concierge.begin('What would you like to talk about?')
    await flush()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('speaking')
    expect(fixture.synthesize).toHaveBeenCalledWith(
      'What would you like to talk about?',
      expect.any(AbortSignal),
      'coach',
      'kokoro',
      undefined,
    )
    fixture.playback.resolve()
    await beginning
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('listening')
    fixture.samples(0.1, 800)
    fixture.samples(0, 1200)
    await flush()
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledExactlyOnceWith(
      'I want to talk about design reviews.',
    )
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('idle')
    expect(fixture.microphone.close).toHaveBeenCalledOnce()
    expect(fixture.speaker.close).toHaveBeenCalledOnce()
    const audio = fixture.transcribe.mock.calls[0][0]
    expect(audio.type).toBe('audio/wav')
    expect(new DataView(await audio.arrayBuffer()).getUint32(24, true)).toBe(16000)
  })

  it('interrupts only after sustained speech and preserves the beginning of that utterance', async () => {
    const fixture = setup()
    const beginning = fixture.concierge.begin('A storytelling tip.')
    await flush()
    fixture.samples(0.1, 100)
    expect(fixture.speaker.stop).not.toHaveBeenCalled()
    fixture.samples(0, 1200)
    expect(fixture.speaker.stop).not.toHaveBeenCalled()
    fixture.samples(0.1, 100)
    fixture.samples(0.1, 150)
    expect(fixture.speaker.stop).toHaveBeenCalledOnce()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('listening')
    fixture.samples(0.1, 400)
    fixture.samples(0, 1200)
    await beginning
    await flush()
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledOnce()
    expect(fixture.transcribe.mock.calls[0][0].size).toBe(44 + 1850 * 16 * 2)
  })

  it('offers an explicit audio gesture when autoplay is blocked and replays the pending prompt', async () => {
    const fixture = setup()
    vi.mocked(fixture.speaker.unlock).mockResolvedValueOnce(false)
    await fixture.concierge.begin('Tell me your topic.')
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('needs-gesture')
    expect(fixture.open).not.toHaveBeenCalled()
    expect(fixture.synthesize).not.toHaveBeenCalled()
    expect(fixture.speaker.close).toHaveBeenCalledOnce()
    const enabling = fixture.concierge.enable()
    await flush()
    expect(fixture.synthesize.mock.calls[0][0]).toBe('Tell me your topic.')
    fixture.playback.resolve()
    await enabling
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('listening')
  })

  it('lets the tip finish when microphone permission is denied, then exposes the actual error', async () => {
    const fixture = setup()
    fixture.open.mockRejectedValueOnce(new Error('Microphone permission was denied.'))
    const beginning = fixture.concierge.begin('Lead with the result.')
    await flush()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('speaking')
    fixture.playback.resolve()
    await beginning
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('error')
    expect(fixture.callbacks.onError).toHaveBeenLastCalledWith('Microphone permission was denied.')
    expect(fixture.speaker.close).toHaveBeenCalledOnce()
  })

  it('handles a request to listen during playback after microphone permission was denied', async () => {
    const fixture = setup()
    fixture.open.mockRejectedValueOnce(new Error('Microphone permission was denied.'))
    const beginning = fixture.concierge.begin('Tell me your topic when you are ready.')
    await flush()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('speaking')
    await expect(fixture.concierge.listen()).resolves.toBeUndefined()
    await beginning
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('error')
    expect(fixture.callbacks.onError).toHaveBeenLastCalledWith('Microphone permission was denied.')
    expect(fixture.open).toHaveBeenCalledOnce()
    expect(fixture.speaker.close).toHaveBeenCalledOnce()
    expect(fixture.transcribe).not.toHaveBeenCalled()
  })

  it('closes a late microphone permission grant after pause without stale callbacks', async () => {
    const fixture = setup()
    const permission = deferred<Microphone>()
    fixture.open.mockReturnValueOnce(permission.promise)
    const listening = fixture.concierge.listen()
    fixture.concierge.pause()
    Object.values(fixture.callbacks).forEach((callback) => callback.mockClear())
    permission.resolve(fixture.microphone)
    await listening
    expect(fixture.microphone.close).toHaveBeenCalledOnce()
    Object.values(fixture.callbacks).forEach((callback) => expect(callback).not.toHaveBeenCalled())
  })

  it('aborts an in-flight transcript and ignores its late result after disposal', async () => {
    const fixture = setup()
    const recognition = deferred<string>()
    fixture.transcribe.mockReturnValueOnce(recognition.promise)
    await fixture.concierge.listen()
    fixture.samples(0.1, 700)
    const finishing = fixture.concierge.finishTurn()
    await flush()
    fixture.concierge.dispose()
    expect(fixture.transcribe.mock.calls[0][1].aborted).toBe(true)
    Object.values(fixture.callbacks).forEach((callback) => callback.mockClear())
    recognition.resolve('A stale topic')
    await finishing
    Object.values(fixture.callbacks).forEach((callback) => expect(callback).not.toHaveBeenCalled())
  })

  it('hands off microphone ownership to a dialog and ignores late homepage synthesis', async () => {
    const homepage = setup()
    const synthesis = deferred<ArrayBuffer>()
    homepage.synthesize.mockReturnValueOnce(synthesis.promise)
    const greeting = homepage.concierge.begin('A storytelling tip.')
    await flush()
    const modal = setup()
    await modal.concierge.listen()
    expect(homepage.microphone.close).toHaveBeenCalledOnce()
    expect(homepage.synthesize.mock.calls[0][1].aborted).toBe(true)
    synthesis.resolve(new ArrayBuffer(8))
    await greeting
    expect(homepage.speaker.play).not.toHaveBeenCalled()
    expect(modal.microphone.close).not.toHaveBeenCalled()
    modal.samples(0.1, 700)
    await modal.concierge.finishTurn()
    expect(modal.callbacks.onTranscript).toHaveBeenCalledOnce()
  })

  it('releases the microphone after 30 seconds of silence without inventing a transcript', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    await fixture.concierge.listen()
    fixture.samples(0, 1000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fixture.microphone.close).toHaveBeenCalledOnce()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('idle')
    expect(fixture.transcribe).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a long utterance by samples even when browser timers are throttled', async () => {
    const fixture = setup()
    await fixture.concierge.listen()
    fixture.samples(0.1, 60_000)
    await flush()
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledOnce()
    expect(fixture.transcribe.mock.calls[0][0].size).toBe(44 + 45 * 16000 * 2)
  })

  it('allows a full learner turn after a long spoken tip and silent microphone capture', async () => {
    const fixture = setup()
    const beginning = fixture.concierge.begin('A longer storytelling tip.')
    await flush()
    for (let index = 0; index < 600; index++) fixture.samples(0, 100)
    expect(fixture.microphone.close).not.toHaveBeenCalled()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('speaking')
    fixture.playback.resolve()
    await beginning
    fixture.samples(0.1, 2000)
    fixture.samples(0, 1200)
    await flush()
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledOnce()
    const audio = fixture.transcribe.mock.calls[0][0]
    expect(audio.size).toBeGreaterThan(44 + 2000 * 16 * 2)
  })

  it('does not speak a delayed tip after the learner interrupts during synthesis', async () => {
    const fixture = setup()
    const synthesis = deferred<ArrayBuffer>()
    fixture.synthesize.mockReturnValueOnce(synthesis.promise)
    const beginning = fixture.concierge.begin('A storytelling tip.')
    await flush()
    fixture.samples(0.1, 300)
    expect(fixture.synthesize.mock.calls[0][1].aborted).toBe(true)
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('listening')
    synthesis.resolve(new ArrayBuffer(8))
    await beginning
    expect(fixture.speaker.play).not.toHaveBeenCalled()
    fixture.samples(0.1, 300)
    fixture.samples(0, 1200)
    await flush()
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledOnce()
  })

  it('previews local recognition and aborts that request before recognizing the final full utterance', async () => {
    const fixture = setup()
    const preview = deferred<string>()
    fixture.transcribe.mockReturnValueOnce(preview.promise)
    await fixture.concierge.listen()
    fixture.samples(0.1, 3000)
    await flush()
    expect(fixture.transcribe).toHaveBeenCalledOnce()
    const finishing = fixture.concierge.finishTurn()
    await flush()
    expect(fixture.transcribe.mock.calls[0][1].aborted).toBe(true)
    preview.resolve('Stale preview')
    await finishing
    await flush()
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledOnce()
    expect(fixture.callbacks.onInterimTranscript).not.toHaveBeenCalledWith('Stale preview')
  })

  it('ignores a short noise and continues waiting for a meaningful voice turn', async () => {
    const fixture = setup()
    await fixture.concierge.listen()
    fixture.samples(0.1, 50)
    fixture.samples(0, 1200)
    await flush()
    expect(fixture.transcribe).not.toHaveBeenCalled()
    expect(fixture.microphone.close).not.toHaveBeenCalled()
    fixture.samples(0.1, 600)
    fixture.samples(0, 1200)
    await flush()
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledOnce()
  })

  it('surfaces invalid speech and transcription responses instead of treating them as successful speech', async () => {
    const fixture = setup()
    const callbacks = fixture.callbacks
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ text: 42 })),
    )
    const concierge = createVoiceConcierge(callbacks, { openMicrophone: fixture.open })
    disposables.push(concierge.dispose)
    await concierge.listen()
    fixture.samples(0.1, 700)
    await concierge.finishTurn()
    expect(callbacks.onTranscript).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenLastCalledWith(
      'The speech service returned an invalid transcript.',
    )
  })
})

describe('spoken conversation sequence', () => {
  const turns = [
    { speaker: 'alex' as const, text: 'How did your prototype go?' },
    { speaker: 'sam' as const, text: 'We learned that a smaller first step helped.' },
    { speaker: 'alex' as const, text: 'What will you try next?' },
  ]

  it('synthesizes every part of a long turn while preserving its persona and transcript index', async () => {
    const fixture = setup()
    const longTurn = 'We should discuss the implementation tradeoffs with the customer '
      .repeat(12)
      .trim()
    const conversation = fixture.concierge.beginConversation([
      { speaker: 'sam', text: longTurn },
      { speaker: 'alex', text: 'Which tradeoff matters most?' },
    ])
    await flush()
    expect(fixture.synthesize).toHaveBeenCalledTimes(2)
    expect(fixture.callbacks.onPlayback).toHaveBeenLastCalledWith({
      activeSpeaker: 'sam',
      activeTurnIndex: 0,
      startedTurnCount: 1,
    })
    expect(fixture.callbacks.onState).not.toHaveBeenCalledWith('listening')
    fixture.playback.resolve()
    await conversation
    const requests = fixture.synthesize.mock.calls
    expect(requests.every(([text]) => text.length <= SPEECH_CHUNK_LIMIT)).toBe(true)
    expect(
      requests
        .filter(([, , voice]) => voice === 'partner')
        .map(([text]) => text)
        .join(''),
    ).toBe(longTurn)
    expect(requests.at(-1)?.[2]).toBe('coach')
    expect(fixture.speaker.play).toHaveBeenCalledTimes(splitSpeechText(longTurn).length + 1)
    const playing = fixture.callbacks.onPlayback.mock.calls
      .map(([state]) => state)
      .filter((state) => state.activeSpeaker)
    expect(
      playing
        .filter((state) => state.activeSpeaker === 'sam')
        .every((state) => state.activeTurnIndex === 0 && state.startedTurnCount === 1),
    ).toBe(true)
    expect(playing.at(-1)).toEqual({
      activeSpeaker: 'alex',
      activeTurnIndex: 1,
      startedTurnCount: 2,
    })
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('listening')
  })

  it('cancels prefetched chunks and all remaining words of a long turn on interruption', async () => {
    const fixture = setup()
    const prefetched = deferred<ArrayBuffer>()
    fixture.synthesize
      .mockResolvedValueOnce(new ArrayBuffer(8))
      .mockReturnValueOnce(prefetched.promise)
    const conversation = fixture.concierge.beginConversation([
      { speaker: 'sam', text: 'This is a longer explanation of the delivery plan. '.repeat(20) },
      { speaker: 'alex', text: 'What happens next?' },
    ])
    await flush()
    expect(fixture.synthesize).toHaveBeenCalledTimes(2)
    fixture.samples(0.1, 300)
    expect(fixture.synthesize.mock.calls[1][1].aborted).toBe(true)
    expect(vi.mocked(fixture.speaker.play).mock.calls[0][1].aborted).toBe(true)
    prefetched.resolve(new ArrayBuffer(8))
    await conversation
    expect(fixture.synthesize).toHaveBeenCalledTimes(2)
    expect(fixture.speaker.play).toHaveBeenCalledOnce()
    expect(fixture.callbacks.onPlayback).toHaveBeenLastCalledWith({
      activeSpeaker: null,
      activeTurnIndex: null,
      startedTurnCount: 1,
    })
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('listening')
  })

  it('alternates voices only when playback starts and prefetches one turn ahead', async () => {
    const fixture = setup()
    const first = deferred<void>()
    const second = deferred<void>()
    const third = deferred<void>()
    vi.mocked(fixture.speaker.play)
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => {
        fixture.output().onStart()
        await second.promise
      })
      .mockImplementationOnce(async () => {
        fixture.output().onStart()
        await third.promise
      })
    const conversation = fixture.concierge.beginConversation(turns)
    await flush()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('preparing')
    expect(fixture.callbacks.onPlayback).toHaveBeenLastCalledWith({
      activeSpeaker: null,
      activeTurnIndex: null,
      startedTurnCount: 0,
    })
    expect(fixture.synthesize.mock.calls.map(([text, , voice]) => [text, voice])).toEqual([
      [turns[0].text, 'coach'],
      [turns[1].text, 'partner'],
    ])
    fixture.output().onStart()
    expect(fixture.callbacks.onPlayback).toHaveBeenLastCalledWith({
      activeSpeaker: 'alex',
      activeTurnIndex: 0,
      startedTurnCount: 1,
    })
    first.resolve()
    await flush()
    expect(fixture.callbacks.onPlayback).toHaveBeenLastCalledWith({
      activeSpeaker: 'sam',
      activeTurnIndex: 1,
      startedTurnCount: 2,
    })
    expect(fixture.synthesize.mock.calls[2][2]).toBe('coach')
    expect(fixture.callbacks.onState).not.toHaveBeenCalledWith('listening')
    second.resolve()
    await flush()
    expect(fixture.callbacks.onPlayback).toHaveBeenLastCalledWith({
      activeSpeaker: 'alex',
      activeTurnIndex: 2,
      startedTurnCount: 3,
    })
    third.resolve()
    await conversation
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('listening')
    expect(fixture.callbacks.onPlayback).toHaveBeenLastCalledWith({
      activeSpeaker: null,
      activeTurnIndex: null,
      startedTurnCount: 3,
    })
    expect(fixture.open).toHaveBeenCalledOnce()
    expect(fixture.speaker.play).toHaveBeenCalledTimes(3)
    fixture.concierge.pause()
    expect(fixture.callbacks.onPlayback).toHaveBeenLastCalledWith({
      activeSpeaker: null,
      activeTurnIndex: null,
      startedTurnCount: 3,
    })
    await fixture.concierge.listen()
    expect(fixture.callbacks.onPlayback).toHaveBeenLastCalledWith({
      activeSpeaker: null,
      activeTurnIndex: null,
      startedTurnCount: 3,
    })
    fixture.concierge.cancel()
    expect(fixture.callbacks.onPlayback).toHaveBeenLastCalledWith({
      activeSpeaker: null,
      activeTurnIndex: null,
      startedTurnCount: 0,
    })
  })

  it('aborts prefetched speech and every future turn when the learner interrupts', async () => {
    const fixture = setup()
    const prefetched = deferred<ArrayBuffer>()
    fixture.synthesize
      .mockResolvedValueOnce(new ArrayBuffer(8))
      .mockReturnValueOnce(prefetched.promise)
    const conversation = fixture.concierge.beginConversation(turns)
    await flush()
    fixture.samples(0.1, 300)
    expect(fixture.speaker.stop).toHaveBeenCalledOnce()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('listening')
    expect(fixture.synthesize.mock.calls[1][1].aborted).toBe(true)
    expect(vi.mocked(fixture.speaker.play).mock.calls[0][1].aborted).toBe(true)
    expect(fixture.callbacks.onPlayback).toHaveBeenLastCalledWith({
      activeSpeaker: null,
      activeTurnIndex: null,
      startedTurnCount: 1,
    })
    prefetched.resolve(new ArrayBuffer(8))
    await conversation
    fixture.samples(0.1, 400)
    fixture.samples(0, 1200)
    await flush()
    expect(fixture.synthesize).toHaveBeenCalledTimes(2)
    expect(fixture.speaker.play).toHaveBeenCalledOnce()
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledOnce()
  })

  it('pauses all playback and prefetch work without allowing late audio or callbacks', async () => {
    const fixture = setup()
    const prefetched = deferred<ArrayBuffer>()
    fixture.synthesize
      .mockResolvedValueOnce(new ArrayBuffer(8))
      .mockReturnValueOnce(prefetched.promise)
    const conversation = fixture.concierge.beginConversation(turns)
    await flush()
    fixture.concierge.pause()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('paused')
    expect(fixture.synthesize.mock.calls[1][1].aborted).toBe(true)
    expect(fixture.microphone.close).toHaveBeenCalledOnce()
    expect(fixture.speaker.close).toHaveBeenCalledOnce()
    Object.values(fixture.callbacks).forEach((callback) => callback.mockClear())
    prefetched.resolve(new ArrayBuffer(8))
    fixture.output().onStart()
    fixture.output().onLevel(0.5)
    await conversation
    await flush()
    expect(fixture.speaker.play).toHaveBeenCalledOnce()
    Object.values(fixture.callbacks).forEach((callback) => expect(callback).not.toHaveBeenCalled())
  })

  it('replays the complete pending conversation after an autoplay gesture', async () => {
    const fixture = setup()
    vi.mocked(fixture.speaker.unlock).mockResolvedValueOnce(false)
    await fixture.concierge.beginConversation(turns)
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('needs-gesture')
    expect(fixture.synthesize).not.toHaveBeenCalled()
    const enabling = fixture.concierge.enable()
    await flush()
    fixture.playback.resolve()
    await enabling
    expect(fixture.synthesize.mock.calls.map(([text]) => text)).toEqual(
      turns.map(({ text }) => text),
    )
    expect(fixture.speaker.play).toHaveBeenCalledTimes(3)
    expect(fixture.callbacks.onPlayback).toHaveBeenLastCalledWith({
      activeSpeaker: null,
      activeTurnIndex: null,
      startedTurnCount: 3,
    })
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('listening')
  })

  it('gives each synthesized turn its own deadline across a longer conversation', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    const first = deferred<void>()
    const second = deferred<void>()
    const thirdAudio = deferred<ArrayBuffer>()
    fixture.synthesize
      .mockResolvedValueOnce(new ArrayBuffer(8))
      .mockResolvedValueOnce(new ArrayBuffer(8))
      .mockReturnValueOnce(thirdAudio.promise)
    vi.mocked(fixture.speaker.play)
      .mockImplementationOnce(async () => {
        fixture.output().onStart()
        await first.promise
      })
      .mockImplementationOnce(async () => {
        fixture.output().onStart()
        await second.promise
      })
      .mockImplementationOnce(async () => fixture.output().onStart())
    const conversation = fixture.concierge.beginConversation(turns)
    await flush()
    await vi.advanceTimersByTimeAsync(40_000)
    first.resolve()
    await flush()
    expect(fixture.synthesize).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(fixture.synthesize.mock.calls[2][1].aborted).toBe(false)
    expect(vi.mocked(fixture.speaker.play).mock.calls[1][1].aborted).toBe(false)
    thirdAudio.resolve(new ArrayBuffer(8))
    second.resolve()
    await conversation
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('listening')
    expect(fixture.callbacks.onError).not.toHaveBeenCalledWith(expect.any(String))
  })
})

describe('homepage microphone consent and continuous batches', () => {
  const turns = [
    { speaker: 'alex' as const, text: 'How would you explain the handover?' },
    { speaker: 'sam' as const, text: 'I would start with the customer workflow.' },
  ]

  it('plays successive complete batches and replay without opening the microphone', async () => {
    const fixture = setup('manual')
    fixture.playback.resolve()
    await fixture.concierge.beginConversation(turns)
    expect(fixture.callbacks.onConversationComplete).toHaveBeenCalledOnce()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('idle')
    await fixture.concierge.beginConversation(turns.slice().reverse())
    fixture.concierge.pause()
    await fixture.concierge.enable()
    expect(fixture.open).not.toHaveBeenCalled()
    expect(fixture.callbacks.onMicrophoneEnabled).not.toHaveBeenCalledWith(true)
    expect(fixture.callbacks.onConversationComplete).toHaveBeenCalledTimes(3)
    expect(fixture.speaker.play).toHaveBeenCalledTimes(6)
    expect(fixture.callbacks.onPlayback).toHaveBeenLastCalledWith({
      activeSpeaker: null,
      activeTurnIndex: null,
      startedTurnCount: 2,
    })
  })

  it('does not complete an autoplay-blocked batch or enable capture with Enable audio', async () => {
    const fixture = setup('manual')
    vi.mocked(fixture.speaker.unlock).mockResolvedValueOnce(false)
    await fixture.concierge.beginConversation(turns)
    expect(fixture.callbacks.onConversationComplete).not.toHaveBeenCalled()
    expect(fixture.open).not.toHaveBeenCalled()
    fixture.playback.resolve()
    await fixture.concierge.enable()
    expect(fixture.callbacks.onConversationComplete).toHaveBeenCalledOnce()
    expect(fixture.open).not.toHaveBeenCalled()
    fixture.concierge.cancel()
    await fixture.concierge.enable()
    expect(fixture.open).not.toHaveBeenCalled()
  })

  it('opens only on explicit opt-in, interrupts AI immediately, and suppresses completion', async () => {
    const fixture = setup('manual')
    const conversation = fixture.concierge.beginConversation(turns)
    await flush()
    expect(fixture.open).not.toHaveBeenCalled()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('speaking')
    await fixture.concierge.setMicrophoneEnabled(true)
    await conversation
    expect(fixture.open).toHaveBeenCalledOnce()
    expect(fixture.speaker.stop).toHaveBeenCalled()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('listening')
    expect(fixture.callbacks.onMicrophoneEnabled).toHaveBeenLastCalledWith(true)
    expect(fixture.callbacks.onConversationComplete).not.toHaveBeenCalled()
    fixture.samples(0.1, 700)
    fixture.samples(0, 1200)
    await flush()
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledOnce()
    expect(fixture.callbacks.onMicrophoneEnabled).toHaveBeenLastCalledWith(true)
    await fixture.concierge.beginConversation(turns)
    expect(fixture.open).toHaveBeenCalledTimes(2)
    expect(fixture.callbacks.onConversationComplete).toHaveBeenCalledOnce()
  })

  it('closes an armed mic during AI playback without stopping the AI batch', async () => {
    const fixture = setup('manual')
    await fixture.concierge.setMicrophoneEnabled(true)
    const conversation = fixture.concierge.beginConversation(turns)
    await flush()
    const stoppedBeforeToggle = vi.mocked(fixture.speaker.stop).mock.calls.length
    await fixture.concierge.setMicrophoneEnabled(false)
    expect(fixture.callbacks.onMicrophoneEnabled).toHaveBeenLastCalledWith(false)
    expect(fixture.microphone.close).toHaveBeenCalledTimes(2)
    expect(fixture.speaker.stop).toHaveBeenCalledTimes(stoppedBeforeToggle)
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('speaking')
    fixture.playback.resolve()
    await conversation
    expect(fixture.callbacks.onConversationComplete).toHaveBeenCalledOnce()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('idle')
    await fixture.concierge.beginConversation(turns)
    expect(fixture.open).toHaveBeenCalledTimes(2)
  })

  it('closes a permission grant arriving after mic off and ignores its stale samples', async () => {
    const fixture = setup('manual')
    const permission = deferred<Microphone>()
    fixture.open.mockReturnValueOnce(permission.promise)
    const enabling = fixture.concierge.setMicrophoneEnabled(true)
    await fixture.concierge.setMicrophoneEnabled(false)
    permission.resolve(fixture.microphone)
    await enabling
    const pendingCapture = fixture.open.mock.calls[0][0]
    pendingCapture.onSamples(new Float32Array(16000).fill(0.1))
    pendingCapture.onSamples(new Float32Array(24000))
    await flush()
    expect(fixture.microphone.close).toHaveBeenCalledOnce()
    expect(fixture.callbacks.onMicrophoneEnabled).toHaveBeenLastCalledWith(false)
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('idle')
    expect(fixture.transcribe).not.toHaveBeenCalled()
  })

  it('keeps a final transcript request intact when the learner switches their mic off', async () => {
    const fixture = setup('manual')
    const recognition = deferred<string>()
    fixture.transcribe.mockReturnValueOnce(recognition.promise)
    await fixture.concierge.setMicrophoneEnabled(true)
    fixture.samples(0.1, 700)
    const finishing = fixture.concierge.finishTurn()
    await flush()
    await fixture.concierge.setMicrophoneEnabled(false)
    expect(fixture.transcribe.mock.calls[0][1].aborted).toBe(false)
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('transcribing')
    recognition.resolve('Could we include a short tutorial?')
    await finishing
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledExactlyOnceWith(
      'Could we include a short tutorial?',
    )
    expect(fixture.callbacks.onMicrophoneEnabled).toHaveBeenLastCalledWith(false)
    expect(fixture.callbacks.onConversationComplete).not.toHaveBeenCalled()
  })

  it('notifies quiet listening without ending the conversation or losing microphone consent', async () => {
    vi.useFakeTimers()
    const fixture = setup('manual')
    await fixture.concierge.setMicrophoneEnabled(true)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(fixture.callbacks.onListeningQuiet).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fixture.callbacks.onListeningQuiet).toHaveBeenCalledOnce()
    expect(fixture.microphone.close).not.toHaveBeenCalled()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('listening')
    expect(fixture.callbacks.onMicrophoneEnabled).toHaveBeenLastCalledWith(true)
    fixture.samples(0.1, 700)
    fixture.samples(0, 1200)
    await flush()
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledOnce()
  })

  it('notifies meaningful speech while already listening so pending generation can stop', async () => {
    const fixture = setup('manual')
    await fixture.concierge.setMicrophoneEnabled(true)
    fixture.samples(0.001, 1000)
    fixture.samples(0.1, 50)
    fixture.samples(0, 1200)
    expect(fixture.callbacks.onSpeechStart).not.toHaveBeenCalled()
    fixture.samples(0.1, 100)
    expect(fixture.callbacks.onSpeechStart).not.toHaveBeenCalled()
    fixture.samples(0.1, 150)
    expect(fixture.callbacks.onSpeechStart).toHaveBeenCalledOnce()
    fixture.samples(0.1, 400)
    expect(fixture.callbacks.onSpeechStart).toHaveBeenCalledOnce()
    fixture.samples(0, 1200)
    await flush()
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledOnce()
  })

  it('interrupts a manual-mode batch for meaningful speech with brief pauses', async () => {
    const fixture = setup('manual')
    await fixture.concierge.setMicrophoneEnabled(true)
    const conversation = fixture.concierge.beginConversation(turns)
    await flush()
    fixture.samples(0.1, 180)
    fixture.samples(0, 50)
    expect(fixture.callbacks.onSpeechStart).not.toHaveBeenCalled()
    fixture.samples(0.1, 180)
    expect(fixture.callbacks.onSpeechStart).toHaveBeenCalledOnce()
    expect(fixture.callbacks.onState).toHaveBeenLastCalledWith('listening')
    await conversation
    expect(fixture.callbacks.onConversationComplete).not.toHaveBeenCalled()
    fixture.samples(0.1, 400)
    fixture.samples(0, 1200)
    await flush()
    expect(fixture.callbacks.onTranscript).toHaveBeenCalledOnce()
    expect(fixture.transcribe.mock.calls[0][0].size).toBe(44 + 2010 * 16 * 2)
  })

  it('turns consent off on pause and does not reopen capture when audio resumes', async () => {
    const fixture = setup('manual')
    await fixture.concierge.setMicrophoneEnabled(true)
    const conversation = fixture.concierge.beginConversation(turns)
    await flush()
    fixture.concierge.pause()
    await conversation
    expect(fixture.callbacks.onMicrophoneEnabled).toHaveBeenLastCalledWith(false)
    expect(fixture.callbacks.onConversationComplete).not.toHaveBeenCalled()
    const openedBeforeResume = fixture.open.mock.calls.length
    fixture.playback.resolve()
    await fixture.concierge.enable()
    expect(fixture.open).toHaveBeenCalledTimes(openedBeforeResume)
    expect(fixture.callbacks.onConversationComplete).toHaveBeenCalledOnce()
  })

  it('reports permission denial with the microphone off and never completes interrupted audio', async () => {
    const fixture = setup('manual')
    fixture.open.mockRejectedValueOnce(new Error('Microphone permission was denied.'))
    const conversation = fixture.concierge.beginConversation(turns)
    await flush()
    await fixture.concierge.setMicrophoneEnabled(true)
    await conversation
    expect(fixture.callbacks.onMicrophoneEnabled).toHaveBeenLastCalledWith(false)
    expect(fixture.callbacks.onError).toHaveBeenLastCalledWith('Microphone permission was denied.')
    expect(fixture.callbacks.onConversationComplete).not.toHaveBeenCalled()
  })

  it('never calls complete on failed synthesis or a cancelled batch', async () => {
    const fixture = setup('manual')
    fixture.synthesize.mockRejectedValueOnce(new Error('Voice service is unavailable.'))
    await fixture.concierge.beginConversation(turns)
    expect(fixture.callbacks.onConversationComplete).not.toHaveBeenCalled()
    const playing = deferred<void>()
    vi.mocked(fixture.speaker.play).mockImplementationOnce(async () => playing.promise)
    const next = fixture.concierge.beginConversation(turns)
    await flush()
    fixture.concierge.cancel()
    playing.resolve()
    await next
    expect(fixture.callbacks.onConversationComplete).not.toHaveBeenCalled()
    expect(fixture.open).not.toHaveBeenCalled()
  })
})
