import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scenarios } from '@/app/_constants'
import { useVoiceSession } from '@/app/_hooks/use-voice-session'
import type { openMicrophone } from '@/lib/audio/microphone'
import type { SpeechProvider } from '@/lib/audio/speech-provider'
import type { SpeechPersona } from '@/lib/audio/personas'

type Effect = () => void | (() => void)

// This hook's asynchronous controller lives in refs. A small hook harness lets
// us drive real microphone buffers, ASR, finalization and fetch cancellation
// without a DOM or synthetic React rendering timers.
const hooks = vi.hoisted(() => ({
  effects: [] as Effect[],
  cleanups: [] as Array<() => void>,
  states: [] as unknown[],
  preferenceListener: undefined as (() => void) | undefined,
  provider: 'chatterbox' as SpeechProvider,
  capture: undefined as Parameters<typeof openMicrophone>[0] | undefined,
  onPlaybackStart: undefined as (() => void) | undefined,
  playback: undefined as Promise<void> | undefined,
  close: vi.fn(async () => {}),
  stop: vi.fn(),
}))

vi.mock('react', () => ({
  useCallback: <T>(callback: T) => callback,
  useRef: <T>(current: T) => ({ current }),
  useEffect: (effect: Effect) => hooks.effects.push(effect),
  useState: <T>(initial: T) => {
    const index = hooks.states.push(initial) - 1
    return [
      initial,
      (next: T) => {
        hooks.states[index] = next
      },
    ]
  },
}))
vi.mock('@/lib/audio/correction-playback', () => ({ stopCorrectionPlayback: vi.fn() }))
vi.mock('@/lib/audio/speech-preference', () => ({
  readSpeechProvider: () => hooks.provider,
  subscribeSpeechProviderChange: (listener: () => void) => {
    hooks.preferenceListener = listener
    return () => {
      hooks.preferenceListener = undefined
    }
  },
}))
vi.mock('@/lib/audio/microphone', () => ({
  openMicrophone: async (options: Parameters<typeof openMicrophone>[0]) => {
    hooks.capture = options
    return { sampleRate: 16000, context: {}, close: hooks.close, setMuted: vi.fn() }
  },
  createSpeechPlayer: (_context: unknown, _onLevel: unknown, onStart: () => void) => {
    hooks.onPlaybackStart = onStart
    return {
      play: async () => {
        onStart()
        await hooks.playback
      },
      stop: hooks.stop,
    }
  },
}))

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const flush = async () => {
  for (let index = 0; index < 30; index++) await Promise.resolve()
}

beforeEach(() => {
  hooks.effects = []
  hooks.cleanups = []
  hooks.states = []
  hooks.provider = 'chatterbox'
  hooks.capture = undefined
  hooks.playback = undefined
  hooks.close.mockClear()
  hooks.stop.mockClear()
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval })
})
afterEach(() => {
  hooks.cleanups.reverse().forEach((cleanup) => cleanup())
  vi.unstubAllGlobals()
})

const setup = (personas: Partial<Record<SpeechProvider, SpeechPersona[]>> = {}) => {
  const recognized = deferred<Response>()
  let recognitionSignal: AbortSignal | undefined
  let speechSignal: AbortSignal | undefined
  let holdSpeech = false
  let coachResponse: Response | undefined
  const onComplete = vi.fn()
  const fetchMock = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    if (input === '/api/health')
      return Response.json({
        coach: { available: true },
        speech: {
          recognition: true,
          providers: {
            chatterbox: { synthesis: true, personas: personas.chatterbox },
            kokoro: { synthesis: true, personas: personas.kokoro },
          },
        },
      })
    if (input === '/api/transcribe') {
      recognitionSignal = options?.signal as AbortSignal
      return (await recognized.promise).clone()
    }
    if (input === '/api/coach')
      return (
        coachResponse ?? new Response('A clear first sentence. A second idea. A final question?')
      )
    if (input === '/api/speech') {
      speechSignal = options?.signal as AbortSignal
      if (holdSpeech)
        return new Promise<Response>((_resolve, reject) => {
          speechSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            { once: true },
          )
        })
      return new Response('local WAV')
    }
    throw new Error(`Unexpected endpoint: ${input}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const session = useVoiceSession({
    scenario: { ...scenarios[0], openingLine: 'Hello. Tell me your update.' },
    roleId: 'ai-developer',
    level: 'B2',
    onComplete,
  })
  hooks.effects.forEach((effect) => {
    const cleanup = effect()
    if (cleanup) hooks.cleanups.push(cleanup)
  })
  return {
    session,
    onComplete,
    fetchMock,
    recognized,
    isGeneratingCoach: () => hooks.states[11],
    setCoachResponse: (response: Response) => {
      coachResponse = response
    },
    recognitionSignal: () => recognitionSignal,
    speechSignal: () => speechSignal,
    holdSpeech: () => {
      holdSpeech = true
    },
    releaseSpeech: () => {
      holdSpeech = false
    },
    capture: () => hooks.capture?.onSamples(new Float32Array(8000).fill(0.1)),
    changeProvider: (provider: SpeechProvider = 'kokoro') => {
      hooks.provider = provider
      hooks.preferenceListener?.()
    },
    speechRequests: () => fetchMock.mock.calls.filter(([url]) => url === '/api/speech'),
  }
}

const streamingCoach = () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start: (value) => {
        controller = value
      },
    }),
  )
  return {
    response,
    write: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    close: () => controller.close(),
  }
}

describe('coach inference gives inline refinements time during playback', () => {
  it('keeps inference busy during streamed speech and releases it before playback ends', async () => {
    const fixture = setup()
    await fixture.session.start()
    const coach = streamingCoach()
    const playback = deferred<void>()
    hooks.playback = playback.promise
    fixture.setCoachResponse(coach.response)
    fixture.capture()
    fixture.recognized.resolve(Response.json({ text: 'I finish the test.' }))
    const finishing = fixture.session.finishTurn()
    await flush()
    expect(fixture.isGeneratingCoach()).toBe(true)
    coach.write('That gives the team a clear update. ')
    await flush()
    expect(hooks.states[0]).toBe('speaking')
    expect(fixture.isGeneratingCoach()).toBe(true)
    coach.close()
    await flush()
    expect(hooks.states[0]).toBe('speaking')
    expect(fixture.isGeneratingCoach()).toBe(false)
    playback.resolve()
    await finishing
    expect(hooks.states[0]).toBe('listening')
  })

  it('clears interrupted inference immediately without a stale stream clearing the next turn', async () => {
    const fixture = setup()
    await fixture.session.start()
    const first = streamingCoach()
    fixture.setCoachResponse(first.response)
    fixture.capture()
    fixture.recognized.resolve(Response.json({ text: 'I finish the test.' }))
    const firstTurn = fixture.session.finishTurn()
    await flush()
    expect(fixture.isGeneratingCoach()).toBe(true)
    fixture.session.interrupt()
    expect(fixture.isGeneratingCoach()).toBe(false)
    const second = streamingCoach()
    fixture.setCoachResponse(second.response)
    fixture.capture()
    const secondTurn = fixture.session.finishTurn()
    await flush()
    expect(fixture.isGeneratingCoach()).toBe(true)
    first.close()
    await firstTurn
    expect(fixture.isGeneratingCoach()).toBe(true)
    second.write('Let us review the next step.')
    second.close()
    await secondTurn
    expect(fixture.isGeneratingCoach()).toBe(false)
  })

  it('releases inference after a failed coach response so saved words can still be refined', async () => {
    const fixture = setup()
    await fixture.session.start()
    fixture.setCoachResponse(
      Response.json({ error: 'Local coach is unavailable.' }, { status: 503 }),
    )
    fixture.capture()
    fixture.recognized.resolve(Response.json({ text: 'I finish the test.' }))
    await fixture.session.finishTurn()
    expect(hooks.states[0]).toBe('error')
    expect(fixture.isGeneratingCoach()).toBe(false)
  })
})

describe('voice preference changes preserve authoritative learner audio', () => {
  it('keeps the selected practice voice, prompt identity and saved scenario consistent', async () => {
    hooks.provider = 'kokoro'
    const fixture = setup({ kokoro: [{ id: 'riley', name: 'Riley', languages: ['en'] }] })
    await fixture.session.start()
    fixture.capture()
    fixture.recognized.resolve(Response.json({ text: 'My update is ready.' }))
    await fixture.session.finishTurn()
    const coach = fixture.fetchMock.mock.calls.find(([url]) => url === '/api/coach')
    const context = JSON.parse(String(coach?.[1]?.body))
    expect(context.scenario.persona).toMatchObject({ id: 'riley', name: 'Riley' })
    for (const [, options] of fixture.speechRequests())
      expect(JSON.parse(String(options?.body))).toMatchObject({
        provider: 'kokoro',
        persona: 'riley',
      })
    const result = await fixture.session.stop()
    expect(result.scenario.persona).toMatchObject({ id: 'riley', name: 'Riley' })
    expect(fixture.onComplete).toHaveBeenCalledWith(result)
  })

  it('preserves learner text and sends no unsupported persona after switching engines', async () => {
    hooks.provider = 'kokoro'
    const fixture = setup({
      kokoro: [{ id: 'riley', name: 'Riley', languages: ['en'] }],
      chatterbox: [
        { id: 'alex', name: 'Alex', languages: ['en'] },
        { id: 'sam', name: 'Sam', languages: ['en'] },
      ],
    })
    await fixture.session.start()
    fixture.capture()
    const finishing = fixture.session.finishTurn()
    await flush()
    fixture.changeProvider('chatterbox')
    expect(fixture.recognitionSignal()?.aborted).toBe(false)
    fixture.recognized.resolve(Response.json({ text: 'Keep this authoritative final turn.' }))
    await finishing
    expect(fixture.speechRequests()).toHaveLength(1)
    expect(fixture.fetchMock.mock.calls.some(([url]) => url === '/api/coach')).toBe(false)
    expect(hooks.states[0]).toBe('error')
    const result = await fixture.session.stop()
    expect(result.messages.at(-1)?.content).toBe('Keep this authoritative final turn.')
    expect(result.scenario.persona.name).toBe('Riley')
  })
  it('retains captured audio while listening and saves it on End & reflect', async () => {
    const fixture = setup()
    await fixture.session.start()
    fixture.capture()
    fixture.changeProvider()
    expect(hooks.close).not.toHaveBeenCalled()
    const ending = fixture.session.stop()
    await flush()
    expect(fixture.recognitionSignal()).toBeDefined()
    fixture.recognized.resolve(Response.json({ text: 'Today I fixed the login bug.' }))
    const result = await ending
    expect(result.messages.at(-1)?.content).toBe('Today I fixed the login bug.')
    expect(fixture.onComplete).toHaveBeenCalledWith(result)
  })

  it('does not abort final turn recognition when the provider changes', async () => {
    const fixture = setup()
    await fixture.session.start()
    fixture.capture()
    const finishing = fixture.session.finishTurn()
    await flush()
    fixture.changeProvider()
    expect(fixture.recognitionSignal()?.aborted).toBe(false)
    fixture.recognized.resolve(Response.json({ text: 'Could you review my pull request?' }))
    await finishing
    const result = await fixture.session.stop()
    expect(
      result.messages.some(({ content }) => content === 'Could you review my pull request?'),
    ).toBe(true)
    expect(fixture.onComplete).toHaveBeenCalledWith(result)
    expect(
      fixture
        .speechRequests()
        .slice(1)
        .every(([, init]) => JSON.parse(String(init?.body)).provider === 'kokoro'),
    ).toBe(true)
  })

  it('keeps End & reflect transcription and completion intact during a provider change', async () => {
    const fixture = setup()
    await fixture.session.start()
    fixture.capture()
    const ending = fixture.session.stop()
    await flush()
    fixture.changeProvider()
    expect(fixture.recognitionSignal()?.aborted).toBe(false)
    fixture.recognized.resolve(Response.json({ text: 'My final update must be saved.' }))
    const result = await ending
    expect(result.messages.at(-1)?.content).toBe('My final update must be saved.')
    expect(result.transcriptionError).toBeUndefined()
    expect(fixture.onComplete).toHaveBeenCalledExactlyOnceWith(result)
  })

  it('cancels old speech and queued chunks while preserving the completed conversation', async () => {
    const fixture = setup()
    await fixture.session.start()
    fixture.capture()
    fixture.holdSpeech()
    fixture.recognized.resolve(Response.json({ text: 'Here is my update.' }))
    const finishing = fixture.session.finishTurn()
    await flush()
    expect(fixture.speechRequests()).toHaveLength(2)
    fixture.changeProvider()
    expect(fixture.speechSignal()?.aborted).toBe(true)
    await finishing
    expect(fixture.speechRequests()).toHaveLength(2)
    expect(hooks.states[0]).toBe('listening')
    const result = await fixture.session.stop()
    expect(result.messages.map(({ content }) => content)).toContain('Here is my update.')
    expect(result.messages.at(-1)?.content).toBe(
      'A clear first sentence. A second idea. A final question?',
    )
    expect(fixture.onComplete).toHaveBeenCalledWith(result)
  })

  it('cancels an opening voice without leaving the session stuck or paused', async () => {
    const fixture = setup()
    fixture.holdSpeech()
    const starting = fixture.session.start()
    await flush()
    expect(fixture.speechRequests()).toHaveLength(1)
    fixture.changeProvider()
    await starting
    expect(fixture.speechSignal()?.aborted).toBe(true)
    expect(hooks.states[0]).toBe('listening')
  })
})
