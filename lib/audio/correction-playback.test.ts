import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notifySpeechProviderChange } from '@/lib/audio/speech-preference'
import { STORAGE_KEYS } from '@/lib/learning/storage'
import {
  CORRECTION_SPEECH_CHUNK_LIMIT,
  createCorrectionPlaybackController,
  splitCorrectionSpeech,
  stopCorrectionPlayback,
} from '@/lib/audio/correction-playback'

const mocks = vi.hoisted(() => ({ createPlayer: vi.fn() }))
vi.mock('@/lib/audio/microphone', () => ({ createSpeechPlayer: mocks.createPlayer }))

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const audioResponse = () =>
  new Response(new Uint8Array([82, 73, 70, 70]), { headers: { 'Content-Type': 'audio/wav' } })
let contexts: FakeAudioContext[]
let players: Array<{ play: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>
let resumeBehavior: () => Promise<void>
let playBehavior: () => Promise<void>
let fakeWindow: EventTarget & { AudioContext?: typeof FakeAudioContext }
let fakeDocument: EventTarget & { visibilityState: string }
let preferences: Map<string, string>

class FakeAudioContext {
  state = 'suspended'
  resume = vi.fn(async () => {
    await resumeBehavior()
    this.state = 'running'
  })
  close = vi.fn(async () => {
    this.state = 'closed'
  })
  constructor() {
    contexts.push(this)
  }
}

beforeEach(() => {
  contexts = []
  players = []
  resumeBehavior = async () => {}
  playBehavior = async () => {}
  preferences = new Map()
  fakeWindow = Object.assign(new EventTarget(), {
    AudioContext: FakeAudioContext,
    localStorage: { getItem: (key: string) => preferences.get(key) ?? null },
  })
  fakeDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vi.stubGlobal('window', fakeWindow)
  vi.stubGlobal('document', fakeDocument)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => audioResponse()),
  )
  mocks.createPlayer.mockImplementation((_context, _onLevel, onStart: () => void) => {
    const player = {
      play: vi.fn(async () => {
        onStart()
        await playBehavior()
      }),
      stop: vi.fn(),
    }
    players.push(player)
    return player
  })
})
afterEach(() => {
  stopCorrectionPlayback()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
  vi.restoreAllMocks()
})

describe('complete correction speech chunks', () => {
  it('preserves every character while preferring complete sentences within the speech limit', () => {
    const text = 'This is an improved workplace explanation. '.repeat(145)
    const chunks = splitCorrectionSpeech(text)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.join('')).toBe(text.trim())
    expect(chunks.every((chunk) => chunk.length <= CORRECTION_SPEECH_CHUNK_LIMIT)).toBe(true)
    expect(chunks.slice(0, -1).every((chunk) => chunk.endsWith('. '))).toBe(true)
  })

  it('splits a long uninterrupted token without separating UTF-16 surrogate pairs', () => {
    const text = `${'x'.repeat(CORRECTION_SPEECH_CHUNK_LIMIT - 1)}🌍${'y'.repeat(3000)}🎯`
    const chunks = splitCorrectionSpeech(text)
    expect(chunks.join('')).toBe(text)
    expect(
      chunks.every(
        (chunk) => chunk.length <= CORRECTION_SPEECH_CHUNK_LIMIT && chunk.isWellFormed(),
      ),
    ).toBe(true)
  })

  it('handles whitespace and rejects impossible chunk limits', () => {
    expect(splitCorrectionSpeech('   ')).toEqual([])
    expect(splitCorrectionSpeech('  Clear question?\nA second sentence.  ', 20).join('')).toBe(
      'Clear question?\nA second sentence.',
    )
    expect(() => splitCorrectionSpeech('hello', 1)).toThrow(RangeError)
  })
})

describe('standalone corrected-text audio', () => {
  it.each(['macos', 'kokoro', 'chatterbox'] as const)(
    'routes every correction chunk to the saved %s engine',
    async (provider) => {
      preferences.set(STORAGE_KEYS.profile, JSON.stringify({ speechProvider: provider }))
      await createCorrectionPlaybackController().play('Here is a clearer explanation. '.repeat(30))
      expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(1)
      for (const [, init] of vi.mocked(fetch).mock.calls) {
        expect(JSON.parse(String(init?.body)).provider).toBe(provider)
      }
    },
  )

  it('snapshots the chosen engine before awaiting playback preparation', async () => {
    preferences.set(STORAGE_KEYS.profile, JSON.stringify({ speechProvider: 'kokoro' }))
    await createCorrectionPlaybackController().play('Please review my implementation.', () => {
      preferences.set(STORAGE_KEYS.profile, JSON.stringify({ speechProvider: 'macos' }))
    })
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).provider).toBe('kokoro')
  })

  it('cancels old synthesis on a Settings change and uses the new engine on retry', async () => {
    preferences.set(STORAGE_KEYS.profile, JSON.stringify({ speechProvider: 'chatterbox' }))
    const response = deferred<Response>()
    vi.mocked(fetch).mockImplementationOnce(() => response.promise)
    const controller = createCorrectionPlaybackController()
    const playback = controller.play('Could you review my change?')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal
    preferences.set(STORAGE_KEYS.profile, JSON.stringify({ speechProvider: 'macos' }))
    notifySpeechProviderChange()
    await playback
    expect(signal?.aborted).toBe(true)
    expect(controller.getSnapshot().status).toBe('idle')
    response.resolve(audioResponse())
    await controller.play('Could you review my change?')
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body)).provider).toBe('macos')
    expect(players[0].play).not.toHaveBeenCalled()
  })

  it('resumes audio synchronously in the click before fetch without asking for a microphone', async () => {
    const getUserMedia = vi.fn()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const controller = createCorrectionPlaybackController()
    const playback = controller.play('Could you review this change?')
    expect(contexts).toHaveLength(1)
    expect(contexts[0].resume).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
    expect(controller.getSnapshot().status).toBe('loading')
    await playback
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({
      text: 'Could you review this change?',
      voice: 'coach',
      provider: 'kokoro',
    })
    expect(players[0].play).toHaveBeenCalledTimes(1)
    expect(contexts[0].close).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot()).toEqual({ status: 'idle', error: null })
  })

  it('runs optional preparation after unlocking audio and before speech synthesis', async () => {
    const controller = createCorrectionPlaybackController()
    const before = vi.fn(() => {
      expect(contexts[0].resume).toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    })
    await controller.play('An improved sentence.', before)
    expect(before).toHaveBeenCalledTimes(1)
  })

  it('plays long corrections sequentially and waits for each audio chunk before requesting the next', async () => {
    const first = deferred<void>()
    playBehavior = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined)
    const text = 'A useful complete sentence. '.repeat(200)
    const controller = createCorrectionPlaybackController()
    const playback = controller.play(text)
    await vi.waitFor(() => expect(players[0].play).toHaveBeenCalledTimes(1))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().status).toBe('playing')
    first.resolve(undefined)
    await playback
    const chunks = vi
      .mocked(fetch)
      .mock.calls.map(([, init]) => JSON.parse(String(init?.body)).text)
    expect(chunks.join('')).toBe(text.trim())
    expect(chunks.every((chunk: string) => chunk.length <= CORRECTION_SPEECH_CHUNK_LIMIT)).toBe(
      true,
    )
    expect(players[0].play).toHaveBeenCalledTimes(chunks.length)
    expect(controller.getSnapshot().status).toBe('idle')
  })

  it('skips whitespace-only synthesis requests without losing words after a long blank run', async () => {
    const text = `Hello.${' '.repeat(5000)}The ending still matters.`
    const chunks = splitCorrectionSpeech(text)
    expect(chunks.join('')).toBe(text)
    await createCorrectionPlaybackController().play(text)
    const spoken = vi
      .mocked(fetch)
      .mock.calls.map(([, init]) => JSON.parse(String(init?.body)).text)
    expect(spoken.every((chunk: string) => chunk.trim().length > 0)).toBe(true)
    expect(spoken.join('')).toContain('The ending still matters.')
  })

  it('cancels pending synthesis and ignores a late response', async () => {
    const response = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => response.promise),
    )
    const controller = createCorrectionPlaybackController()
    const playback = controller.play('A corrected response.')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal
    controller.stop()
    expect(signal?.aborted).toBe(true)
    await playback
    response.resolve(audioResponse())
    await Promise.resolve()
    expect(players[0].play).not.toHaveBeenCalled()
    expect(contexts[0].close).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().status).toBe('idle')
  })

  it('globally stops the previous owner before another correction can speak', async () => {
    const held = deferred<void>()
    playBehavior = () => held.promise
    const first = createCorrectionPlaybackController()
    const second = createCorrectionPlaybackController()
    const oldPlayback = first.play('First correction.')
    await vi.waitFor(() => expect(first.getSnapshot().status).toBe('playing'))
    const nextPlayback = second.play('Second correction.')
    expect(players[0].stop).toHaveBeenCalledTimes(1)
    expect(first.getSnapshot().status).toBe('idle')
    expect(contexts[0].state).toBe('closed')
    await vi.waitFor(() => expect(second.getSnapshot().status).toBe('playing'))
    await oldPlayback
    expect(second.getSnapshot().status).toBe('playing')
    stopCorrectionPlayback()
    await nextPlayback
    expect(players[1].stop).toHaveBeenCalledTimes(1)
    expect(second.getSnapshot().status).toBe('idle')
  })

  it('allows a new run after cancellation without stale cleanup closing its context', async () => {
    const firstResponse = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => firstResponse.promise)
        .mockResolvedValue(audioResponse()),
    )
    const controller = createCorrectionPlaybackController()
    const first = controller.play('Old wording.')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    const next = controller.play('New wording.')
    await first
    firstResponse.resolve(audioResponse())
    await next
    expect(players[0].play).not.toHaveBeenCalled()
    expect(players[1].play).toHaveBeenCalledTimes(1)
    expect(contexts.every((context) => context.close.mock.calls.length === 1)).toBe(true)
  })

  it.each(['pagehide', 'hashchange', 'hidden'])(
    'stops and removes lifecycle listeners on %s',
    async (event) => {
      playBehavior = () => new Promise(() => {})
      const removeWindow = vi.spyOn(fakeWindow, 'removeEventListener')
      const removeDocument = vi.spyOn(fakeDocument, 'removeEventListener')
      const controller = createCorrectionPlaybackController()
      const playback = controller.play('Listen to this corrected wording.')
      await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('playing'))
      if (event === 'hidden') {
        fakeDocument.visibilityState = 'hidden'
        fakeDocument.dispatchEvent(new Event('visibilitychange'))
      } else fakeWindow.dispatchEvent(new Event(event))
      await playback
      expect(controller.getSnapshot().status).toBe('idle')
      expect(contexts[0].close).toHaveBeenCalledTimes(1)
      expect(removeWindow).toHaveBeenCalledWith('pagehide', expect.any(Function))
      expect(removeWindow).toHaveBeenCalledWith('hashchange', expect.any(Function))
      expect(removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    },
  )

  it('shows a retryable error for unavailable speech and succeeds on retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ error: 'Unavailable' }, { status: 503 }))
        .mockResolvedValueOnce(audioResponse()),
    )
    const controller = createCorrectionPlaybackController()
    await controller.play('Please review this change.')
    expect(controller.getSnapshot()).toEqual({
      status: 'error',
      error: 'Local speech is unavailable. Try again.',
    })
    expect(contexts[0].close).toHaveBeenCalledTimes(1)
    await controller.play('Please review this change.')
    expect(controller.getSnapshot().status).toBe('idle')
    expect(players[1].play).toHaveBeenCalledTimes(1)
  })

  it.each([
    [429, 'Local speech is busy. Wait a moment and try again.'],
    [504, 'Local speech took too long. Try again.'],
  ] as const)('shows a safe retryable message for speech status %s', async (status, error) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ error: 'Private model diagnostics must not appear' }, { status }),
        )
        .mockResolvedValueOnce(audioResponse()),
    )
    const controller = createCorrectionPlaybackController()
    await controller.play('Please review this change.')
    expect(controller.getSnapshot()).toEqual({ status: 'error', error })
    expect(players[0].play).not.toHaveBeenCalled()
    expect(contexts[0].close).toHaveBeenCalledTimes(1)
    await controller.play('Please review this change.')
    expect(controller.getSnapshot()).toEqual({ status: 'idle', error: null })
    expect(players[1].play).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([200, 500])(
    'keeps unknown or non-WAV responses generic for status %s',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ error: 'Private service details' }, { status })),
      )
      const controller = createCorrectionPlaybackController()
      await controller.play('Please review this change.')
      expect(controller.getSnapshot()).toEqual({
        status: 'error',
        error: 'Local speech is unavailable. Try again.',
      })
      expect(players[0].play).not.toHaveBeenCalled()
      expect(contexts[0].close).toHaveBeenCalledTimes(1)
    },
  )

  it('reports decoding failures and releases the audio context', async () => {
    playBehavior = async () => {
      throw new Error('Audio could not be decoded.')
    }
    const controller = createCorrectionPlaybackController()
    await controller.play('A useful correction.')
    expect(controller.getSnapshot()).toEqual({
      status: 'error',
      error: 'Audio could not be decoded.',
    })
    expect(contexts[0].close).toHaveBeenCalledTimes(1)
  })

  it('bounds suspended audio resume and clears the timer on failure', async () => {
    vi.useFakeTimers()
    resumeBehavior = () => new Promise(() => {})
    const controller = createCorrectionPlaybackController()
    const playback = controller.play('A useful correction.')
    await vi.advanceTimersByTimeAsync(4000)
    await playback
    expect(controller.getSnapshot().error).toContain('browser paused playback')
    expect(fetch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out synthesis, aborts the request, and clears all timers', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    )
    const controller = createCorrectionPlaybackController()
    const playback = controller.play('A useful correction.')
    await vi.advanceTimersByTimeAsync(0)
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal
    await vi.advanceTimersByTimeAsync(55_000)
    await playback
    expect(signal?.aborted).toBe(true)
    expect(controller.getSnapshot().error).toContain('speech took too long')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans timers when stopped during a suspended resume', async () => {
    vi.useFakeTimers()
    resumeBehavior = () => new Promise(() => {})
    const controller = createCorrectionPlaybackController()
    const playback = controller.play('A useful correction.')
    controller.stop()
    await playback
    expect(vi.getTimerCount()).toBe(0)
    expect(controller.getSnapshot().status).toBe('idle')
  })

  it('offers a useful error when Web Audio is unavailable', async () => {
    delete fakeWindow.AudioContext
    const controller = createCorrectionPlaybackController()
    await controller.play('A useful correction.')
    expect(controller.getSnapshot().error).toContain('unavailable in this browser')
    expect(fetch).not.toHaveBeenCalled()
  })
})
