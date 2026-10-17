import { createSpeechPlayer, type SpeechPlayer } from '@/lib/audio/microphone'
import { SPEECH_CHUNK_LIMIT, splitSpeechText } from '@/lib/audio/audio-utils'
import { readSpeechProvider, subscribeSpeechProviderChange } from '@/lib/audio/speech-preference'

export const CORRECTION_SPEECH_CHUNK_LIMIT = SPEECH_CHUNK_LIMIT

export type CorrectionPlaybackSnapshot = {
  status: 'idle' | 'loading' | 'playing' | 'error'
  error: string | null
}

export type CorrectionPlaybackController = {
  getSnapshot: () => CorrectionPlaybackSnapshot
  subscribe: (listener: () => void) => () => void
  play: (text: string, onBeforePlay?: () => void | Promise<void>) => Promise<void>
  stop: () => void
}

let activeController: CorrectionPlaybackController | null = null

export const stopCorrectionPlayback = () => activeController?.stop()

export const splitCorrectionSpeech = splitSpeechText

const boundedOperation = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutMessage: string,
) => {
  const controller = new AbortController()
  const cancel = () => controller.abort(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const timeout = setTimeout(() => controller.abort(new Error(timeoutMessage)), timeoutMs)
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason ?? new DOMException('Cancelled', 'AbortError'))
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    controller.signal.throwIfAborted()
    return await Promise.race([operation(controller.signal), aborted])
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', cancel)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
  }
}

type PlaybackRun = {
  abort: AbortController
  context: AudioContext
  player: SpeechPlayer
  detach: () => void
  cleaned: boolean
}

export const createCorrectionPlaybackController = (): CorrectionPlaybackController => {
  let snapshot: CorrectionPlaybackSnapshot = { status: 'idle', error: null }
  let current: PlaybackRun | null = null
  const listeners = new Set<() => void>()
  const update = (status: CorrectionPlaybackSnapshot['status'], error: string | null = null) => {
    if (snapshot.status === status && snapshot.error === error) return
    snapshot = { status, error }
    listeners.forEach((listener) => listener())
  }
  const cleanup = (run: PlaybackRun) => {
    if (run.cleaned) return
    run.cleaned = true
    run.abort.abort()
    run.player.stop()
    run.detach()
    if (run.context.state !== 'closed') void run.context.close().catch(() => {})
  }
  const finish = (run: PlaybackRun, error: string | null = null) => {
    cleanup(run)
    if (current !== run) return
    current = null
    if (activeController === controller) activeController = null
    update(error ? 'error' : 'idle', error)
  }
  const stop = () => {
    const run = current
    current = null
    if (activeController === controller) activeController = null
    if (run) cleanup(run)
    update('idle')
  }
  const controller: CorrectionPlaybackController = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stop,
    play: (text, onBeforePlay) => {
      stopCorrectionPlayback()
      stop()
      const chunks = splitCorrectionSpeech(text)
      const provider = readSpeechProvider()
      if (!chunks.length) return Promise.resolve()
      if (typeof window === 'undefined' || !window.AudioContext) {
        update('error', 'Audio playback is unavailable in this browser.')
        return Promise.resolve()
      }
      let context: AudioContext
      try {
        context = new window.AudioContext({ latencyHint: 'interactive' })
      } catch {
        update('error', 'Audio playback could not start. Try again.')
        return Promise.resolve()
      }
      const run: PlaybackRun = {
        abort: new AbortController(),
        context,
        player: createSpeechPlayer(
          context,
          () => {},
          () => {
            if (current === run && !run.abort.signal.aborted) update('playing')
          },
        ),
        detach: () => {},
        cleaned: false,
      }
      current = run
      activeController = controller
      update('loading')
      const stopWhenHidden = () => {
        if (document.visibilityState === 'hidden') stop()
      }
      window.addEventListener('pagehide', stop)
      window.addEventListener('hashchange', stop)
      document.addEventListener('visibilitychange', stopWhenHidden)
      const unsubscribePreference = subscribeSpeechProviderChange(stop)
      run.detach = () => {
        unsubscribePreference()
        window.removeEventListener('pagehide', stop)
        window.removeEventListener('hashchange', stop)
        document.removeEventListener('visibilitychange', stopWhenHidden)
      }
      // Call resume synchronously during the click, before any network or
      // optional application preparation, without requesting a microphone.
      const resumed = boundedOperation(
        () => context.resume(),
        run.abort.signal,
        4000,
        'Your browser paused playback. Press Retry to enable audio.',
      )
      return (async () => {
        try {
          await resumed
          if (onBeforePlay)
            await boundedOperation(
              async () => {
                await onBeforePlay()
              },
              run.abort.signal,
              10_000,
              'Playback preparation took too long. Try again.',
            )
          for (const chunk of chunks) {
            run.abort.signal.throwIfAborted()
            if (current !== run) return
            if (!chunk.trim()) continue
            update('loading')
            const audio = await boundedOperation(
              async (signal) => {
                const response = await fetch('/api/speech', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ text: chunk, voice: 'coach', provider }),
                  signal,
                })
                if (response.status === 429)
                  throw new Error('Local speech is busy. Wait a moment and try again.')
                if (response.status === 504)
                  throw new Error('Local speech took too long. Try again.')
                if (!response.ok || !response.headers.get('content-type')?.includes('audio/wav'))
                  throw new Error('Local speech is unavailable. Try again.')
                const bytes = await response.arrayBuffer()
                if (!bytes.byteLength) throw new Error('Local speech returned no audio. Try again.')
                return bytes
              },
              run.abort.signal,
              55_000,
              'Local speech took too long. Try again.',
            )
            run.abort.signal.throwIfAborted()
            await boundedOperation(
              (signal) => run.player.play(audio, signal),
              run.abort.signal,
              600_000,
              'Audio playback took too long. Try again.',
            )
          }
          finish(run)
        } catch (error) {
          if (run.abort.signal.aborted || current !== run) {
            cleanup(run)
            return
          }
          finish(run, error instanceof Error ? error.message : 'Audio playback failed. Try again.')
        }
      })()
    },
  }
  return controller
}
