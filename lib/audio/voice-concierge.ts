import { z } from 'zod'
import { TranscriptionSchema } from '@/lib/ai/contracts'
import {
  encodeWav,
  mergeTranscript,
  splitSpeechText,
  VoiceActivityBuffer,
} from '@/lib/audio/audio-utils'
import { createSpeechPlayer, openMicrophone, type Microphone } from '@/lib/audio/microphone'
import { readSpeechProvider, subscribeSpeechProviderChange } from '@/lib/audio/speech-preference'
import type { SpeechProvider } from '@/lib/audio/speech-provider'
import { SpeechPersonaIdSchema, type SpeechPersonaId } from '@/lib/audio/personas'

export type VoiceConciergeState =
  | 'idle'
  | 'preparing'
  | 'speaking'
  | 'listening'
  | 'transcribing'
  | 'needs-gesture'
  | 'paused'
  | 'error'

type ConciergeCallbacks = {
  onState: (state: VoiceConciergeState) => void
  onCoachLevel: (level: number) => void
  onUserLevel: (level: number) => void
  onInterimTranscript: (text: string) => void
  onError: (error: string | null) => void
  onTranscript: (text: string) => void
  onPlayback?: (playback: ConciergePlayback) => void
  onMicrophoneEnabled?: (enabled: boolean) => void
  onConversationComplete?: () => void
  onListeningQuiet?: () => void
  onSpeechStart?: () => void
}

export type ConciergePlayback = {
  activeSpeaker: 'alex' | 'sam' | null
  activeTurnIndex: number | null
  startedTurnCount: number
}

type SpeakerCallbacks = {
  onLevel: (level: number) => void
  onStart: () => void
}

export type ConciergeSpeaker = {
  unlock: (signal: AbortSignal) => Promise<boolean>
  play: (audio: ArrayBuffer, signal: AbortSignal) => Promise<void>
  stop: () => void
  close: () => Promise<void>
}

const ResponseErrorSchema = z.object({ error: z.string().max(1000) })
const PromptSchema = z.string().trim().min(1).max(2400)
const ConversationTurnSchema = z.object({
  speaker: z.enum(['alex', 'sam']),
  text: PromptSchema,
  persona: SpeechPersonaIdSchema.optional(),
})
const ConversationSchema = z.array(ConversationTurnSchema).min(1).max(12)
export type ConciergeConversationTurn = z.infer<typeof ConversationTurnSchema>
const silenceLimitMs = 30_000
const manualQuietMs = 8_000
const turnLimitMs = 45_000
const requestLimitMs = 55_000

const responseError = async (response: Response, fallback: string) => {
  const result = ResponseErrorSchema.safeParse(await response.json().catch(() => null))
  return new Error(result.success ? result.data.error : fallback)
}

const synthesizeSpeech = async (
  text: string,
  signal: AbortSignal,
  voice: 'coach' | 'partner' = 'coach',
  provider?: SpeechProvider,
  persona?: SpeechPersonaId,
) => {
  const response = await fetch('/api/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, provider, persona }),
    signal,
  })
  if (!response.ok)
    throw await responseError(response, 'The local coach voice is unavailable. Please try again.')
  if (!response.headers.get('content-type')?.includes('audio/'))
    throw new Error('The speech service returned invalid audio.')
  return response.arrayBuffer()
}

const recognizeSpeech = async (audio: Blob, signal: AbortSignal) => {
  const form = new FormData()
  form.append('audio', audio, 'voice-topic.wav')
  const response = await fetch('/api/transcribe', { method: 'POST', body: form, signal })
  if (!response.ok)
    throw await responseError(
      response,
      'Local speech recognition is unavailable. Please try again.',
    )
  const result = TranscriptionSchema.safeParse(await response.json())
  if (!result.success) throw new Error('The speech service returned an invalid transcript.')
  return result.data.text.trim()
}

/** Keeps coach playback independent from microphone permission. */
const openSpeaker = ({ onLevel, onStart }: SpeakerCallbacks): ConciergeSpeaker => {
  if (typeof window === 'undefined' || !window.AudioContext)
    throw new Error('This browser does not support audio playback. Try a recent browser.')
  const context = new AudioContext({ latencyHint: 'interactive' })
  const player = createSpeechPlayer(context, onLevel, onStart)
  return {
    unlock: (signal) => {
      if (signal.aborted || context.state === 'closed') return Promise.resolve(false)
      // resume() must happen synchronously inside the Enable audio click.
      const resumed = context.resume()
      return new Promise<boolean>((resolve) => {
        let finished = false
        const finish = (ready: boolean) => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          signal.removeEventListener('abort', aborted)
          resolve(ready)
        }
        const aborted = () => finish(false)
        const timer = setTimeout(() => finish(context.state === 'running'), 900)
        signal.addEventListener('abort', aborted, { once: true })
        resumed.then(
          () => finish(context.state === 'running'),
          () => finish(false),
        )
      })
    },
    play: player.play,
    stop: player.stop,
    close: async () => {
      player.stop()
      if (context.state !== 'closed') await context.close()
    },
  }
}

type Operation = {
  provider?: SpeechProvider
  request: AbortController
  microphone: Microphone | null
  microphonePromise: Promise<void> | null
  microphoneError: string | null
  microphoneVersion: number
  speaker: ConciergeSpeaker | null
  synthesis: AbortController
  interimRequest: AbortController | null
  buffer: VoiceActivityBuffer | null
  timer: ReturnType<typeof setTimeout> | null
  requestTimers: Set<ReturnType<typeof setTimeout>>
  stage: VoiceConciergeState
  interrupted: boolean
  speakingSamples: number
  speechReported: boolean
  totalSamples: number
  lastInterimAt: number
  interim: string
  finalizing: boolean
}

// A homepage greeting and an open dialog must never own the microphone together.
let activeOwner: { cancel: () => void } | null = null

/** Cancellable spoken turns with automatic or explicitly enabled learner capture. */
export const createVoiceConcierge = (
  callbacks: ConciergeCallbacks,
  dependencies: {
    openMicrophone?: typeof openMicrophone
    openSpeaker?: (callbacks: SpeakerCallbacks) => ConciergeSpeaker
    synthesize?: typeof synthesizeSpeech
    transcribe?: typeof recognizeSpeech
    microphoneMode?: 'automatic' | 'manual'
  } = {},
) => {
  const open = dependencies.openMicrophone ?? openMicrophone
  const speakerFactory = dependencies.openSpeaker ?? openSpeaker
  const synthesize = dependencies.synthesize ?? synthesizeSpeech
  const transcribe = dependencies.transcribe ?? recognizeSpeech
  const manualMicrophone = dependencies.microphoneMode === 'manual'
  let current: Operation | null = null
  let pendingConversation: ConciergeConversationTurn[] | null = null
  let pendingProvider: SpeechProvider | undefined
  let startedTurnCount = 0
  let disposed = false
  let microphoneEnabled = false

  const updateMicrophoneEnabled = (enabled: boolean) => {
    if (microphoneEnabled === enabled) return
    microphoneEnabled = enabled
    if (!disposed) callbacks.onMicrophoneEnabled?.(enabled)
  }

  const valid = (operation: Operation) => current === operation && !disposed
  const setState = (operation: Operation, state: VoiceConciergeState) => {
    if (!valid(operation)) return
    operation.stage = state
    callbacks.onState(state)
  }
  const clearTimer = (operation: Operation) => {
    if (operation.timer !== null) clearTimeout(operation.timer)
    operation.timer = null
  }
  const closeMicrophone = (operation: Operation) => {
    operation.microphoneVersion++
    operation.microphonePromise = null
    const microphone = operation.microphone
    operation.microphone = null
    operation.buffer = null
    return microphone?.close().catch(() => undefined) ?? Promise.resolve()
  }
  const cleanup = (operation: Operation) => {
    clearTimer(operation)
    operation.requestTimers.forEach(clearTimeout)
    operation.requestTimers.clear()
    operation.request.abort()
    operation.synthesis.abort()
    operation.interimRequest?.abort()
    operation.speaker?.stop()
    void operation.speaker?.close().catch(() => undefined)
    void closeMicrophone(operation)
  }
  const release = () => {
    if (activeOwner === owner) activeOwner = null
  }
  const clearActiveSpeaker = () => {
    callbacks.onPlayback?.({
      activeSpeaker: null,
      activeTurnIndex: null,
      startedTurnCount,
    })
    callbacks.onCoachLevel(0)
  }
  const reset = (
    state: VoiceConciergeState,
    clearConversation = true,
    clearProgress = false,
    preserveMicrophone = false,
  ) => {
    const operation = current
    current = null
    if (clearConversation) pendingConversation = null
    if (clearProgress) startedTurnCount = 0
    if (operation) cleanup(operation)
    if (!preserveMicrophone) updateMicrophoneEnabled(false)
    release()
    if (!disposed) {
      clearActiveSpeaker()
      callbacks.onUserLevel(0)
      callbacks.onInterimTranscript('')
      callbacks.onError(null)
      callbacks.onState(state)
    }
  }
  const cancel = () => reset('idle', true, true)
  const pause = () => reset('paused', false)
  const owner = { cancel }
  const fail = (operation: Operation, message: string) => {
    if (!valid(operation)) return
    reset('error', false)
    callbacks.onError(message)
  }
  const requestSignal = (operation: Operation, extra?: AbortSignal) => {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), requestLimitMs)
    operation.requestTimers.add(timer)
    const signal = AbortSignal.any([
      operation.request.signal,
      timeout.signal,
      ...(extra ? [extra] : []),
    ])
    return {
      signal,
      close: () => {
        clearTimeout(timer)
        operation.requestTimers.delete(timer)
      },
    }
  }

  const finishTurn = async () => {
    const operation = current
    if (!operation || !valid(operation) || operation.finalizing) return
    if (!operation.microphone || !operation.buffer) {
      fail(operation, 'The microphone is not ready yet. Please try listening again.')
      return
    }
    operation.finalizing = true
    operation.interrupted = true
    operation.synthesis.abort()
    operation.speaker?.stop()
    operation.interimRequest?.abort()
    clearTimer(operation)
    const sampleRate = operation.microphone.sampleRate
    const audio = operation.buffer.snapshot()
    const hasSpeech = operation.buffer.hasSpeech()
    operation.buffer.reset()
    clearActiveSpeaker()
    callbacks.onUserLevel(0)
    setState(operation, 'transcribing')
    await closeMicrophone(operation)
    if (!valid(operation)) return
    if (!hasSpeech) {
      fail(operation, 'I could not hear your topic. Please try speaking again.')
      return
    }
    const request = requestSignal(operation)
    try {
      const { signal } = request
      const text = await transcribe(encodeWav(audio, sampleRate), signal)
      if (!valid(operation)) return
      if (signal.aborted) throw new Error('Speech recognition took too long. Please try again.')
      if (!text.trim()) throw new Error('I could not hear your topic. Please try speaking again.')
      reset('idle', true, false, manualMicrophone)
      callbacks.onTranscript(text.trim())
    } catch (reason) {
      fail(
        operation,
        reason instanceof Error && reason.name !== 'AbortError' && reason.name !== 'TimeoutError'
          ? reason.message
          : 'Speech recognition took too long. Please try again.',
      )
    } finally {
      request.close()
    }
  }

  const armIdleTimer = (operation: Operation) => {
    clearTimer(operation)
    operation.timer = setTimeout(
      () => {
        if (!valid(operation) || operation.finalizing) return
        if (manualMicrophone) {
          operation.timer = null
          // Stay armed while the controller resumes the two AI voices.
          callbacks.onListeningQuiet?.()
        } else reset('idle')
      },
      manualMicrophone ? manualQuietMs : silenceLimitMs,
    )
  }
  const enterListening = (operation: Operation) => {
    if (!valid(operation) || operation.finalizing) return
    if (manualMicrophone && !microphoneEnabled) {
      setState(operation, 'idle')
      return
    }
    if (operation.microphoneError) {
      fail(operation, operation.microphoneError)
      return
    }
    if (!operation.microphone) {
      setState(operation, 'preparing')
      return
    }
    setState(operation, 'listening')
    if (operation.buffer?.hasSpeech()) {
      clearTimer(operation)
      operation.timer = setTimeout(() => void finishTurn(), turnLimitMs)
    } else armIdleTimer(operation)
  }
  const interrupt = (operation: Operation) => {
    if (!valid(operation) || operation.finalizing) return
    operation.interrupted = true
    operation.synthesis.abort()
    operation.speaker?.stop()
    clearActiveSpeaker()
    enterListening(operation)
  }
  const updateInterim = async (operation: Operation) => {
    if (!valid(operation) || !operation.buffer || !operation.microphone || operation.interimRequest)
      return
    const request = new AbortController()
    operation.interimRequest = request
    const audio = encodeWav(operation.buffer.snapshot(8), operation.microphone.sampleRate)
    const bounded = requestSignal(operation, request.signal)
    try {
      const { signal } = bounded
      const text = await transcribe(audio, signal)
      if (!valid(operation) || operation.finalizing || signal.aborted || !text) return
      operation.interim = mergeTranscript(operation.interim, text)
      callbacks.onInterimTranscript(operation.interim)
    } catch {
      // A missed preview never prevents the complete utterance being recognized.
    } finally {
      bounded.close()
      if (operation.interimRequest === request) operation.interimRequest = null
    }
  }

  const ensureMicrophone = (operation: Operation) => {
    if (manualMicrophone && !microphoneEnabled) return Promise.resolve()
    if (operation.microphonePromise) return operation.microphonePromise
    const version = ++operation.microphoneVersion
    const microphoneValid = () => valid(operation) && operation.microphoneVersion === version
    operation.microphonePromise = (async () => {
      let lastMeterAt = 0
      try {
        const microphone = await open({
          onSamples: (samples) => {
            if (
              !microphoneValid() ||
              operation.finalizing ||
              !operation.buffer ||
              !operation.microphone
            )
              return
            const sampleRate = operation.microphone.sampleRate
            const remaining = sampleRate * (turnLimitMs / 1000) - operation.totalSamples
            const chunk = samples.length > remaining ? samples.slice(0, remaining) : samples
            const activity = operation.buffer.push(chunk)
            if (activity.started) operation.totalSamples = 0
            if (activity.active) operation.totalSamples += chunk.length
            if (Date.now() - lastMeterAt >= 65) {
              callbacks.onUserLevel(activity.level)
              lastMeterAt = Date.now()
            }
            operation.speakingSamples =
              activity.level >= 0.012 ? operation.speakingSamples + chunk.length : 0
            if (!operation.speechReported && operation.buffer.hasSpeech()) {
              operation.speechReported = true
              callbacks.onSpeechStart?.()
              if (!microphoneValid()) return
            }
            if (
              !operation.interrupted &&
              (operation.stage === 'speaking' || operation.stage === 'preparing') &&
              (operation.speakingSamples >= sampleRate * 0.22 ||
                (manualMicrophone && operation.buffer.hasSpeech()))
            )
              interrupt(operation)
            if (operation.stage !== 'listening') {
              if (activity.complete) {
                operation.buffer.reset()
                operation.speechReported = false
                operation.totalSamples = 0
              }
              return
            }
            if (activity.started || operation.speakingSamples === chunk.length) {
              clearTimer(operation)
              operation.timer = setTimeout(() => void finishTurn(), turnLimitMs)
            }
            if (activity.complete || operation.totalSamples >= sampleRate * (turnLimitMs / 1000)) {
              if (operation.buffer.hasSpeech()) void finishTurn()
              else {
                operation.buffer.reset()
                operation.speechReported = false
                operation.totalSamples = 0
                armIdleTimer(operation)
              }
              return
            }
            const elapsedMs = (operation.totalSamples / sampleRate) * 1000
            if (operation.buffer.hasSpeech() && elapsedMs - operation.lastInterimAt >= 2800) {
              operation.lastInterimAt = elapsedMs
              void updateInterim(operation)
            }
          },
          onEnded: () => {
            if (!microphoneValid() || operation.finalizing) return
            if (operation.buffer?.hasSpeech()) void finishTurn()
            else fail(operation, 'Your microphone disconnected. Reconnect it and try again.')
          },
        })
        if (!microphoneValid()) {
          await microphone.close().catch(() => undefined)
          return
        }
        operation.microphone = microphone
        updateMicrophoneEnabled(true)
        operation.buffer = new VoiceActivityBuffer({ sampleRate: microphone.sampleRate })
        if (operation.interrupted) enterListening(operation)
      } catch (reason) {
        if (!microphoneValid()) return
        updateMicrophoneEnabled(false)
        operation.microphoneError =
          reason instanceof Error
            ? reason.message
            : 'Could not open the microphone. Please try again.'
        callbacks.onError(operation.microphoneError)
        // A denied microphone must not silence a tip already being played.
        if (operation.interrupted) fail(operation, operation.microphoneError)
      }
    })()
    return operation.microphonePromise
  }

  const createOperation = (clearProgress = true) => {
    reset('idle', true, clearProgress, manualMicrophone)
    if (activeOwner && activeOwner !== owner) activeOwner.cancel()
    activeOwner = owner
    const operation: Operation = {
      provider: readSpeechProvider(),
      request: new AbortController(),
      microphone: null,
      microphonePromise: null,
      microphoneError: null,
      microphoneVersion: 0,
      speaker: null,
      synthesis: new AbortController(),
      interimRequest: null,
      buffer: null,
      timer: null,
      requestTimers: new Set(),
      stage: 'preparing',
      interrupted: false,
      speakingSamples: 0,
      speechReported: false,
      totalSamples: 0,
      lastInterimAt: 0,
      interim: '',
      finalizing: false,
    }
    current = operation
    callbacks.onState('preparing')
    return operation
  }

  const beginConversation = async (
    turns: ConciergeConversationTurn[],
    expectedProvider?: SpeechProvider,
  ) => {
    if (disposed) return
    const operation = createOperation()
    if (expectedProvider && operation.provider && expectedProvider !== operation.provider) {
      fail(
        operation,
        'The voice model changed. Start a new exchange to choose matching conversation partners.',
      )
      return
    }
    operation.provider ??= expectedProvider
    const conversation = ConversationSchema.safeParse(turns)
    if (!conversation.success) {
      fail(operation, 'The spoken conversation is empty or too long. Please try again.')
      return
    }
    pendingConversation = conversation.data
    pendingProvider = operation.provider
    // Chunk synthesis without changing the transcript's logical turn or persona.
    const parts = conversation.data.flatMap((turn, turnIndex) =>
      splitSpeechText(turn.text)
        .filter((text) => text.trim())
        .map((text) => ({ ...turn, text, turnIndex })),
    )
    let playingTurnIndex: number | null = null
    try {
      const speaker = speakerFactory({
        onLevel: (level) => {
          if (valid(operation) && !operation.interrupted) callbacks.onCoachLevel(level)
        },
        onStart: () => {
          if (!valid(operation) || operation.interrupted || playingTurnIndex === null) return
          startedTurnCount = playingTurnIndex + 1
          callbacks.onPlayback?.({
            activeSpeaker: conversation.data[playingTurnIndex].speaker,
            activeTurnIndex: playingTurnIndex,
            startedTurnCount,
          })
          setState(operation, 'speaking')
        },
      })
      operation.speaker = speaker
      const unlocked = await speaker.unlock(operation.request.signal)
      if (!valid(operation) || operation.interrupted) return
      if (!unlocked) {
        reset('needs-gesture', false)
        return
      }
      void ensureMicrophone(operation)
      const prepareTurn = async (turn: ConciergeConversationTurn) => {
        const request = requestSignal(operation, operation.synthesis.signal)
        try {
          const audio = await synthesize(
            turn.text,
            request.signal,
            turn.speaker === 'sam' ? 'partner' : 'coach',
            operation.provider,
            turn.persona,
          )
          if (request.signal.aborted)
            throw new Error('The coach voice took too long. Please try again.')
          return { ok: true as const, audio }
        } catch (error) {
          // A prefetched turn may fail while the current turn is still playing.
          // Keep its rejection handled until it becomes the next turn.
          return { ok: false as const, error }
        } finally {
          request.close()
        }
      }
      const playbackSignal = AbortSignal.any([operation.request.signal, operation.synthesis.signal])
      let upcoming = prepareTurn(parts[0])
      for (let index = 0; index < parts.length; index++) {
        const prepared = await upcoming
        if (!valid(operation) || operation.interrupted) return
        if (!prepared.ok) throw prepared.error
        const nextTurn = parts[index + 1]
        if (nextTurn) upcoming = prepareTurn(nextTurn)
        playingTurnIndex = parts[index].turnIndex
        await speaker.play(prepared.audio, playbackSignal)
        if (!valid(operation) || operation.interrupted) return
        playingTurnIndex = null
        clearActiveSpeaker()
        if (nextTurn) setState(operation, 'preparing')
      }
      if (!valid(operation) || operation.interrupted) return
      operation.interrupted = true
      if (manualMicrophone && !microphoneEnabled) {
        reset('idle', false, false, true)
      } else {
        await ensureMicrophone(operation)
        if (!valid(operation)) return
        enterListening(operation)
        if (!valid(operation)) return
      }
      callbacks.onConversationComplete?.()
    } catch (reason) {
      if (!valid(operation) || operation.interrupted) return
      fail(operation, reason instanceof Error ? reason.message : 'The coach voice could not play.')
    }
  }

  const begin = (text: string) => beginConversation([{ speaker: 'alex', text }])

  const listen = async () => {
    if (disposed) return
    if (manualMicrophone) {
      updateMicrophoneEnabled(true)
      // An explicit mic click must not lose an utterance already being recognized.
      if (current?.finalizing) return
    }
    if (current && !current.finalizing) {
      const operation = current
      interrupt(operation)
      if (valid(operation)) await ensureMicrophone(operation)
      return
    }
    const operation = createOperation(false)
    operation.interrupted = true
    await ensureMicrophone(operation)
    enterListening(operation)
  }
  const enable = async () => {
    if (pendingConversation) await beginConversation(pendingConversation, pendingProvider)
    else if (!manualMicrophone) await listen()
  }
  const setMicrophoneEnabled = async (enabled: boolean) => {
    if (disposed) return
    if (enabled) {
      await listen()
      return
    }
    updateMicrophoneEnabled(false)
    const operation = current
    if (!operation) return
    clearTimer(operation)
    operation.interimRequest?.abort()
    operation.interimRequest = null
    callbacks.onUserLevel(0)
    if (!operation.finalizing && operation.buffer?.hasSpeech()) {
      // A completed phrase is still useful when the learner clicks mic off.
      await finishTurn()
      return
    }
    await closeMicrophone(operation)
    if (!valid(operation) || operation.finalizing) return
    operation.microphoneError = null
    operation.totalSamples = 0
    operation.speakingSamples = 0
    operation.speechReported = false
    operation.lastInterimAt = 0
    operation.interim = ''
    callbacks.onInterimTranscript('')
    if (operation.interrupted) setState(operation, 'idle')
  }
  const dispose = () => {
    unsubscribePreference()
    disposed = true
    cancel()
  }
  const unsubscribePreference = subscribeSpeechProviderChange(() => {
    const operation = current
    if (
      operation?.finalizing ||
      operation?.stage === 'transcribing' ||
      operation?.stage === 'listening'
    )
      return
    if (operation?.buffer?.hasSpeech()) {
      // Switching a voice may stop the demonstration, never a learner's topic.
      interrupt(operation)
      return
    }
    pause()
  })

  return {
    begin,
    beginConversation,
    enable,
    listen,
    setMicrophoneEnabled,
    finishTurn,
    pause,
    cancel,
    dispose,
  }
}
