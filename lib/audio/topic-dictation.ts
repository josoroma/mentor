import { z } from 'zod'
import { TranscriptionSchema } from '@/lib/ai/contracts'
import { encodeWav, VoiceActivityBuffer } from '@/lib/audio/audio-utils'
import { openMicrophone, type Microphone } from '@/lib/audio/microphone'

export type TopicDictationState = 'idle' | 'recording' | 'transcribing'

type DictationCallbacks = {
  onState: (state: TopicDictationState) => void
  onLevel: (level: number) => void
  onError: (error: string | null) => void
  onTranscript: (text: string) => void
}

type Recording = {
  microphone: Microphone | null
  buffer: VoiceActivityBuffer | null
  timer: ReturnType<typeof setTimeout> | null
  request: AbortController | null
  samples: number
  transcribing: boolean
}

const recordingLimitMs = 30_000
const recognitionLimitMs = 45_000
const ResponseErrorSchema = z.object({ error: z.string().max(1000) })

const transcribeTopic = async (audio: Blob, signal: AbortSignal) => {
  const form = new FormData()
  form.append('audio', audio, 'conversation-topic.wav')
  const response = await fetch('/api/transcribe', {
    method: 'POST',
    body: form,
    signal,
  })
  if (!response.ok) {
    const result = ResponseErrorSchema.safeParse(await response.json().catch(() => null))
    throw new Error(
      result.success
        ? result.data.error
        : 'Local speech recognition is unavailable. Please try again.',
    )
  }
  const result = TranscriptionSchema.safeParse(await response.json())
  if (!result.success) throw new Error('The speech service returned an invalid transcript.')
  const text = result.data.text.trim()
  if (!text) throw new Error('I could not hear your topic. Please try speaking again.')
  return text
}

/** Owns one bounded recording, including microphone permission and request races. */
export const createTopicDictation = (
  callbacks: DictationCallbacks,
  dependencies: {
    openMicrophone?: typeof openMicrophone
    transcribe?: typeof transcribeTopic
  } = {},
) => {
  const open = dependencies.openMicrophone ?? openMicrophone
  const transcribe = dependencies.transcribe ?? transcribeTopic
  let current: Recording | null = null
  let disposed = false

  const clearTimer = (recording: Recording) => {
    if (recording.timer !== null) clearTimeout(recording.timer)
    recording.timer = null
  }

  const closeMicrophone = async (recording: Recording) => {
    const microphone = recording.microphone
    recording.microphone = null
    await microphone?.close().catch(() => undefined)
  }

  const finish = (recording: Recording, error: string | null = null) => {
    if (current !== recording || disposed) return false
    clearTimer(recording)
    current = null
    callbacks.onLevel(0)
    callbacks.onState('idle')
    callbacks.onError(error)
    return true
  }

  const cancel = () => {
    const recording = current
    current = null
    if (recording) {
      clearTimer(recording)
      recording.request?.abort()
      void closeMicrophone(recording)
    }
    if (!disposed) {
      callbacks.onLevel(0)
      callbacks.onState('idle')
      callbacks.onError(null)
    }
  }

  const stop = async () => {
    const recording = current
    if (!recording || recording.transcribing || disposed) return
    if (!recording.microphone || !recording.buffer) {
      // A pending browser permission request cannot be aborted. Its late result is closed.
      cancel()
      return
    }
    clearTimer(recording)
    recording.transcribing = true
    const sampleRate = recording.microphone.sampleRate
    const samples = recording.buffer.snapshot()
    const hasSpeech = recording.buffer.hasSpeech()
    recording.buffer.reset()
    callbacks.onLevel(0)
    callbacks.onState('transcribing')
    await closeMicrophone(recording)
    if (current !== recording || disposed) return
    if (!hasSpeech) {
      finish(recording, 'I could not hear your topic. Speak for a moment, then try again.')
      return
    }

    const request = new AbortController()
    recording.request = request
    let timedOut = false
    recording.timer = setTimeout(() => {
      timedOut = true
      request.abort()
    }, recognitionLimitMs)
    try {
      const text = await transcribe(encodeWav(samples, sampleRate), request.signal)
      if (timedOut) throw new Error('Speech recognition took too long. Please try again.')
      if (finish(recording)) callbacks.onTranscript(text)
    } catch (reason) {
      finish(
        recording,
        timedOut
          ? 'Speech recognition took too long. Please try again.'
          : reason instanceof Error
            ? reason.message
            : 'Local speech recognition failed. Please try again.',
      )
    }
  }

  const start = async () => {
    if (current || disposed) return
    const recording: Recording = {
      microphone: null,
      buffer: null,
      timer: null,
      request: null,
      samples: 0,
      transcribing: false,
    }
    current = recording
    callbacks.onError(null)
    callbacks.onState('recording')
    let lastMeterAt = 0
    try {
      const microphone = await open({
        onSamples: (samples) => {
          if (
            current !== recording ||
            disposed ||
            recording.transcribing ||
            !recording.buffer ||
            !recording.microphone
          )
            return
          const maxSamples = recording.microphone.sampleRate * (recordingLimitMs / 1000)
          const remaining = maxSamples - recording.samples
          const chunk = samples.length > remaining ? samples.slice(0, remaining) : samples
          recording.samples += chunk.length
          const activity = recording.buffer.push(chunk)
          if (Date.now() - lastMeterAt >= 65) {
            callbacks.onLevel(activity.level)
            lastMeterAt = Date.now()
          }
          if (recording.samples >= maxSamples) void stop()
        },
        onEnded: () => {
          if (current === recording && !disposed) void stop()
        },
      })
      if (current !== recording || disposed) {
        await microphone.close().catch(() => undefined)
        return
      }
      recording.microphone = microphone
      recording.buffer = new VoiceActivityBuffer({
        sampleRate: microphone.sampleRate,
        maxDurationMs: recordingLimitMs,
        silenceMs: recordingLimitMs,
      })
      recording.timer = setTimeout(() => void stop(), recordingLimitMs)
    } catch (reason) {
      await closeMicrophone(recording)
      finish(
        recording,
        reason instanceof Error
          ? reason.message
          : 'Could not open the microphone. Please try again.',
      )
    }
  }

  const dispose = () => {
    disposed = true
    cancel()
  }

  return { start, stop, cancel, dispose }
}
