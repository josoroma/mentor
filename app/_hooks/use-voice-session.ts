'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProficiencyLevel, Scenario, TranscriptMessage } from '@/app/_types'
import { stopCorrectionPlayback } from '@/lib/audio/correction-playback'
import { readSpeechProvider, subscribeSpeechProviderChange } from '@/lib/audio/speech-preference'
import {
  assignScenarioPersona,
  resolveAvailableSpeechPersonas,
  selectSpeechPersona,
} from '@/lib/audio/persona-selection'
import { getSpeechPersonaName, type SpeechPersonaId } from '@/lib/audio/personas'
import {
  resolveSpeechProviderStatus,
  type SpeechProvider,
  type SpeechServiceStatus,
} from '@/lib/audio/speech-provider'
import {
  encodeWav,
  extractSpeechChunks,
  mergeTranscript,
  splitSpeechText,
  VoiceActivityBuffer,
} from '@/lib/audio/audio-utils'
import {
  createSpeechPlayer,
  openMicrophone,
  type Microphone,
  type SpeechPlayer,
} from '@/lib/audio/microphone'

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'paused' | 'error'

export type VoiceSessionResult = {
  id: string
  messages: TranscriptMessage[]
  elapsedSeconds: number
  scenarioId: string
  roleId: string
  level: ProficiencyLevel
  startedAt: string
  scenario: Scenario
  transcriptionError?: string
}

type VoiceSessionOptions = {
  scenario: Scenario
  roleId: string
  level: ProficiencyLevel
  onComplete?: (result: VoiceSessionResult) => void | Promise<void>
}

type LocalHealth = {
  coach?: { available: boolean; detail?: string }
  speech?: SpeechServiceStatus
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'The voice connection failed. Please try again.'
const isAborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
let previousPracticePersona: SpeechPersonaId | undefined

const responseError = async (response: Response, fallback: string) => {
  const body = (await response.json().catch(() => null)) as {
    error?: string | { message?: string }
    message?: string
  } | null
  return new Error(
    typeof body?.error === 'string'
      ? body.error
      : body?.error?.message || body?.message || fallback,
  )
}

const checkLocalServices = async (signal: AbortSignal, persona?: SpeechPersonaId) => {
  const response = await fetch('/api/health', { signal, cache: 'no-store' })
  if (!response.ok)
    throw await responseError(
      response,
      'Could not check the local voice services. Please try again.',
    )
  const health = (await response.json()) as LocalHealth
  const provider = readSpeechProvider()
  const synthesis = resolveSpeechProviderStatus(health.speech, provider)
  if (!health.speech?.recognition || !synthesis?.synthesis) {
    throw new Error(
      (!health.speech?.recognition ? health.speech?.detail : synthesis?.detail) ||
        (provider ? 'Your selected voice is unavailable. Check its status in Settings.' : '') ||
        'The local speech service is not running. Start it with npm run speech:start, then try again.',
    )
  }
  if (!health.coach?.available) {
    throw new Error(
      health.coach?.detail ||
        'The local AI coach is not running. Start the configured local model, then try again.',
    )
  }
  const capabilities = resolveAvailableSpeechPersonas(health, provider)
  if (persona && !capabilities.personas.some((item) => item.id === persona))
    throw new Error(
      `${getSpeechPersonaName(persona)} is not available with this voice model. Choose a model that supports this partner or start a new conversation.`,
    )
  return capabilities
}

const recognizeAudio = async (samples: Float32Array, sampleRate: number, signal: AbortSignal) => {
  const form = new FormData()
  form.append('audio', encodeWav(samples, sampleRate), 'voice-turn.wav')
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, 45000)
  try {
    const response = await fetch('/api/transcribe', {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
    if (!response.ok)
      throw await responseError(response, 'Local speech recognition failed. Please try again.')
    const result = (await response.json()) as { text?: string; transcript?: string }
    return (result.text ?? result.transcript ?? '').trim()
  } catch (reason) {
    if (timedOut)
      throw new Error(
        'Local speech recognition took too long. Check the speech service, then try again.',
      )
    throw reason
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', cancel)
  }
}

export const useVoiceSession = ({ scenario, roleId, level, onComplete }: VoiceSessionOptions) => {
  const [state, setState] = useState<VoiceState>('idle')
  const [messages, setMessages] = useState<TranscriptMessage[]>([])
  const [interimTranscript, setInterimTranscript] = useState('')
  const [pendingMessage, setPendingMessage] = useState<TranscriptMessage | null>(null)
  const [sessionIdentity, setSessionIdentity] = useState<{ id: string; startedAt: string } | null>(
    null,
  )
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [userLevel, setUserLevel] = useState(0)
  const [coachLevel, setCoachLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [isMuted, setIsMuted] = useState(false)
  const [activeScenario, setActiveScenario] = useState<Scenario | null>(null)
  const [isGeneratingCoach, setIsGeneratingCoach] = useState(false)
  const mountedRef = useRef(true)
  const stateRef = useRef<VoiceState>('idle')
  const messagesRef = useRef<TranscriptMessage[]>([])
  const optionsRef = useRef({ scenario, roleId, level, onComplete })
  const sessionOptionsRef = useRef({ scenario, roleId, level })
  const microphoneRef = useRef<Microphone | null>(null)
  const playerRef = useRef<SpeechPlayer | null>(null)
  const bufferRef = useRef<VoiceActivityBuffer | null>(null)
  const isMutedRef = useRef(false)
  const operationRef = useRef(0)
  const turnRef = useRef(0)
  const requestRef = useRef<AbortController | null>(null)
  const partialRequestRef = useRef<AbortController | null>(null)
  const speechRequestsRef = useRef(new Set<AbortController>())
  const speechGenerationRef = useRef(0)
  const partialTextRef = useRef('')
  const turnMessageRef = useRef<{ id: string; timestamp: number } | null>(null)
  const pendingFinalRef = useRef<{
    samples: Float32Array
    sampleRate: number
    message: { id: string; timestamp: number }
  } | null>(null)
  const lastPartialTimeRef = useRef(0)
  const lastMeterTimeRef = useRef(0)
  const startedAtRef = useRef('')
  const sessionIdRef = useRef('')
  const activeStartedRef = useRef<number | null>(null)
  const activeMsRef = useRef(0)
  const hasSessionRef = useRef(false)
  const failedActionRef = useRef<'start' | 'listen' | 'coach'>('start')
  const finishTurnRef = useRef<() => Promise<void>>(async () => {})
  const processFrameRef = useRef<(samples: Float32Array) => void>(() => {})
  const configKey = `${scenario.id}:${roleId}:${level}`
  optionsRef.current = { scenario, roleId, level, onComplete }

  const transition = useCallback((next: VoiceState) => {
    stateRef.current = next
    if (mountedRef.current) setState(next)
  }, [])

  const updateMessages = useCallback((next: TranscriptMessage[]) => {
    messagesRef.current = next
    if (mountedRef.current) setMessages(next)
  }, [])

  const currentElapsed = useCallback(
    () =>
      Math.floor(
        (activeMsRef.current +
          (activeStartedRef.current === null ? 0 : Date.now() - activeStartedRef.current)) /
          1000,
      ),
    [],
  )

  const pauseClock = useCallback(() => {
    if (activeStartedRef.current !== null) {
      activeMsRef.current += Date.now() - activeStartedRef.current
      activeStartedRef.current = null
    }
    if (mountedRef.current) setElapsedSeconds(currentElapsed())
  }, [currentElapsed])

  const clearTurn = useCallback(() => {
    bufferRef.current?.reset()
    partialTextRef.current = ''
    pendingFinalRef.current = null
    turnMessageRef.current = null
    lastPartialTimeRef.current = 0
    turnRef.current++
    partialRequestRef.current?.abort()
    partialRequestRef.current = null
    if (mountedRef.current) {
      setInterimTranscript('')
      setPendingMessage(null)
    }
  }, [])

  const abortOperations = useCallback(() => {
    operationRef.current++
    requestRef.current?.abort()
    requestRef.current = null
    speechRequestsRef.current.forEach((controller) => controller.abort())
    speechRequestsRef.current.clear()
    playerRef.current?.stop()
    clearTurn()
    if (mountedRef.current) {
      setUserLevel(0)
      setCoachLevel(0)
      setIsGeneratingCoach(false)
    }
  }, [clearTurn])

  const closeMicrophone = useCallback(async () => {
    const microphone = microphoneRef.current
    microphoneRef.current = null
    playerRef.current?.stop()
    playerRef.current = null
    bufferRef.current = null
    await microphone?.close()
  }, [])

  const fail = useCallback(
    (reason: unknown, action: 'start' | 'listen' | 'coach') => {
      if (!mountedRef.current || isAborted(reason)) return
      failedActionRef.current = action
      abortOperations()
      pauseClock()
      transition('error')
      setError(errorMessage(reason))
      void closeMicrophone()
    },
    [abortOperations, closeMicrophone, pauseClock, transition],
  )

  const acquireMicrophone = useCallback(
    async (operation: number) => {
      const microphone = await openMicrophone({
        onSamples: (samples) => processFrameRef.current(samples),
        onEnded: () =>
          fail(new Error('The microphone was disconnected. Reconnect it and try again.'), 'listen'),
      })
      if (!mountedRef.current || operation !== operationRef.current) {
        await microphone.close()
        return false
      }
      microphoneRef.current = microphone
      microphone.setMuted(isMutedRef.current)
      bufferRef.current = new VoiceActivityBuffer({ sampleRate: microphone.sampleRate })
      playerRef.current = createSpeechPlayer(
        microphone.context,
        (value) => {
          if (mountedRef.current) setCoachLevel(value)
        },
        () => transition('speaking'),
      )
      return true
    },
    [fail, transition],
  )

  const speakText = useCallback(
    async (
      text: string,
      operation: number,
      provider: SpeechProvider | undefined,
      speechGeneration: number,
    ) => {
      if (
        !text.trim() ||
        operation !== operationRef.current ||
        speechGeneration !== speechGenerationRef.current
      )
        return
      const controller = new AbortController()
      const persona = sessionOptionsRef.current.scenario.persona.id
      speechRequestsRef.current.add(controller)
      try {
        for (const chunk of splitSpeechText(text)) {
          if (
            operation !== operationRef.current ||
            speechGeneration !== speechGenerationRef.current ||
            controller.signal.aborted
          )
            return
          if (!chunk.trim()) continue
          const response = await fetch('/api/speech', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: chunk, provider, persona }),
            signal: controller.signal,
          })
          if (!response.ok)
            throw await responseError(
              response,
              'The coach voice could not be generated. Please try again.',
            )
          const audio = await response.arrayBuffer()
          if (operation !== operationRef.current || controller.signal.aborted) return
          await playerRef.current?.play(audio, controller.signal)
        }
      } catch (reason) {
        // Changing the voice cancels playback only. The learner's recognition
        // and the coach's transcript can finish under the same operation.
        if (speechGeneration !== speechGenerationRef.current && isAborted(reason)) return
        throw reason
      } finally {
        speechRequestsRef.current.delete(controller)
      }
    },
    [],
  )

  const requestCoach = useCallback(
    async (conversation: TranscriptMessage[], operation: number) => {
      const speechGeneration = speechGenerationRef.current
      const controller = new AbortController()
      requestRef.current = controller
      if (mountedRef.current) setIsGeneratingCoach(true)
      const options = sessionOptionsRef.current
      const capabilities = await checkLocalServices(controller.signal, options.scenario.persona.id)
      if (operation !== operationRef.current) return
      const provider = capabilities.provider
      const response = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenarioId: options.scenario.id,
          scenario: options.scenario,
          roleId: options.roleId,
          level: options.level,
          messages: conversation.map(({ role, content }) => ({ role, content })),
        }),
        signal: controller.signal,
      })
      if (!response.ok)
        throw await responseError(response, 'The AI coach could not respond. Please try again.')
      if (!response.body)
        throw new Error('The AI coach returned an empty response. Please try again.')
      const assistantId = crypto.randomUUID()
      const timestamp = Date.now()
      let text = ''
      let pendingSpeech = ''
      let speechQueue = Promise.resolve()
      let speechFailure: unknown
      const enqueueSpeech = (chunk: string) => {
        speechQueue = speechQueue
          .then(async () => {
            if (
              !speechFailure &&
              operation === operationRef.current &&
              speechGeneration === speechGenerationRef.current
            )
              await speakText(chunk, operation, provider, speechGeneration)
          })
          .catch((reason: unknown) => {
            speechFailure = reason
          })
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (operation !== operationRef.current) break
          const delta = decoder.decode(value, { stream: !done })
          text += delta
          pendingSpeech += delta
          if (text.trim()) {
            updateMessages([
              ...conversation,
              { id: assistantId, role: 'assistant', content: text, timestamp },
            ])
          }
          const extracted = extractSpeechChunks(pendingSpeech, done)
          pendingSpeech = extracted.remainder
          extracted.chunks.forEach(enqueueSpeech)
          if (done) break
        }
      } finally {
        if (operation !== operationRef.current) await reader.cancel().catch(() => {})
        reader.releaseLock()
        // Speech can start before the text stream finishes. Release editing
        // only once inference ends, while the remaining audio keeps playing.
        if (operation === operationRef.current && mountedRef.current) setIsGeneratingCoach(false)
      }
      await speechQueue
      if (operation !== operationRef.current) return
      if (speechFailure && speechGeneration === speechGenerationRef.current) throw speechFailure
      if (!text.trim()) throw new Error('The local AI coach returned no words. Please try again.')
      clearTurn()
      transition('listening')
    },
    [clearTurn, speakText, transition, updateMessages],
  )

  const finishTurn = useCallback(async () => {
    if (stateRef.current !== 'listening' || !bufferRef.current || !microphoneRef.current) return
    if (!bufferRef.current.hasSpeech()) {
      clearTurn()
      return
    }
    const samples = bufferRef.current.snapshot()
    const sampleRate = microphoneRef.current.sampleRate
    const message = turnMessageRef.current ?? { id: crypto.randomUUID(), timestamp: Date.now() }
    const operation = operationRef.current
    partialRequestRef.current?.abort()
    partialRequestRef.current = null
    turnRef.current++
    bufferRef.current.reset()
    pendingFinalRef.current = { samples, sampleRate, message }
    transition('thinking')
    setUserLevel(0)
    const controller = new AbortController()
    requestRef.current = controller
    let action: 'listen' | 'coach' = 'listen'
    try {
      const text = await recognizeAudio(samples, sampleRate, controller.signal)
      if (operation !== operationRef.current) return
      clearTurn()
      if (!text) {
        transition('listening')
        return
      }
      const next: TranscriptMessage[] = [
        ...messagesRef.current,
        {
          ...message,
          role: 'user',
          content: text,
        },
      ]
      updateMessages(next)
      action = 'coach'
      await requestCoach(next, operation)
    } catch (reason) {
      if (operation === operationRef.current) fail(reason, action)
    }
  }, [clearTurn, fail, requestCoach, transition, updateMessages])
  finishTurnRef.current = finishTurn

  processFrameRef.current = (samples) => {
    if (
      stateRef.current !== 'listening' ||
      isMutedRef.current ||
      !bufferRef.current ||
      !microphoneRef.current
    )
      return
    const activity = bufferRef.current.push(samples)
    const now = performance.now()
    if (now - lastMeterTimeRef.current >= 65) {
      lastMeterTimeRef.current = now
      setUserLevel(activity.level)
    }
    if (activity.started) {
      turnMessageRef.current = { id: crypto.randomUUID(), timestamp: Date.now() }
      partialTextRef.current = ''
      lastPartialTimeRef.current = 0
      turnRef.current++
      setInterimTranscript('')
      setPendingMessage(null)
    }
    if (activity.complete) {
      void finishTurnRef.current()
      return
    }
    if (
      !activity.active ||
      activity.durationMs < 1400 ||
      partialRequestRef.current ||
      (activity.durationMs - lastPartialTimeRef.current < 2200 && lastPartialTimeRef.current > 0)
    )
      return
    const controller = new AbortController()
    partialRequestRef.current = controller
    const turn = turnRef.current
    const operation = operationRef.current
    const isFullWindow = activity.durationMs <= 8000
    const snapshot = bufferRef.current.snapshot(8)
    const sampleRate = microphoneRef.current.sampleRate
    lastPartialTimeRef.current = activity.durationMs
    void recognizeAudio(snapshot, sampleRate, controller.signal)
      .then((text) => {
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          turn !== turnRef.current ||
          operation !== operationRef.current ||
          stateRef.current !== 'listening'
        )
          return
        partialTextRef.current = isFullWindow ? text : mergeTranscript(partialTextRef.current, text)
        setInterimTranscript(partialTextRef.current)
        if (partialTextRef.current && turnMessageRef.current) {
          setPendingMessage({
            ...turnMessageRef.current,
            role: 'user',
            content: partialTextRef.current,
          })
        }
      })
      .catch(() => {
        // Final recognition is authoritative and surfaces actionable errors.
      })
      .finally(() => {
        if (partialRequestRef.current === controller) partialRequestRef.current = null
      })
  }

  const start = useCallback(async () => {
    if (!['idle', 'error'].includes(stateRef.current)) return
    stopCorrectionPlayback()
    transition('thinking')
    abortOperations()
    const operation = operationRef.current
    await closeMicrophone()
    if (operation !== operationRef.current) return
    sessionOptionsRef.current = optionsRef.current
    hasSessionRef.current = false
    activeMsRef.current = 0
    activeStartedRef.current = null
    startedAtRef.current = new Date().toISOString()
    sessionIdRef.current = crypto.randomUUID()
    setSessionIdentity({ id: sessionIdRef.current, startedAt: startedAtRef.current })
    isMutedRef.current = false
    setIsMuted(false)
    setElapsedSeconds(0)
    setError(null)
    updateMessages([])
    transition('thinking')
    const controller = new AbortController()
    requestRef.current = controller
    try {
      const speechGeneration = speechGenerationRef.current
      const capabilities = await checkLocalServices(controller.signal)
      if (operation !== operationRef.current || !(await acquireMicrophone(operation))) return
      const personaId = capabilities.personas.length
        ? selectSpeechPersona(
            capabilities.personas.map((item) => item.id),
            previousPracticePersona,
          )
        : undefined
      const persona = capabilities.personas.find((item) => item.id === personaId)
      if (persona) {
        previousPracticePersona = persona.id
        sessionOptionsRef.current = {
          ...sessionOptionsRef.current,
          scenario: assignScenarioPersona(sessionOptionsRef.current.scenario, persona),
        }
      }
      setActiveScenario(sessionOptionsRef.current.scenario)
      hasSessionRef.current = true
      activeStartedRef.current = Date.now()
      const openingLine = sessionOptionsRef.current.scenario.openingLine
      if (openingLine) {
        updateMessages([
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: openingLine,
            timestamp: Date.now(),
          },
        ])
        await speakText(openingLine, operation, capabilities.provider, speechGeneration)
        if (operation === operationRef.current) transition('listening')
      } else {
        await requestCoach([], operation)
      }
    } catch (reason) {
      if (operation === operationRef.current) fail(reason, 'start')
    }
  }, [
    abortOperations,
    acquireMicrophone,
    closeMicrophone,
    fail,
    requestCoach,
    speakText,
    transition,
    updateMessages,
  ])

  const pause = useCallback(() => {
    if (!['listening', 'thinking', 'speaking'].includes(stateRef.current)) return
    abortOperations()
    pauseClock()
    transition('paused')
    void closeMicrophone()
  }, [abortOperations, closeMicrophone, pauseClock, transition])

  useEffect(
    () =>
      subscribeSpeechProviderChange(() => {
        speechGenerationRef.current++
        speechRequestsRef.current.forEach((controller) => controller.abort())
        speechRequestsRef.current.clear()
        playerRef.current?.stop()
        if (mountedRef.current) setCoachLevel(0)
        if (stateRef.current === 'speaking') transition('thinking')
        // Do not pause/clear the turn or invalidate the session operation:
        // final ASR (including End & reflect) must retain and save captured audio.
      }),
    [transition],
  )

  const resume = useCallback(async () => {
    if (!['paused', 'error'].includes(stateRef.current)) return
    stopCorrectionPlayback()
    abortOperations()
    const operation = operationRef.current
    setError(null)
    transition('thinking')
    const controller = new AbortController()
    requestRef.current = controller
    try {
      await checkLocalServices(controller.signal, sessionOptionsRef.current.scenario.persona.id)
      if (operation !== operationRef.current || !(await acquireMicrophone(operation))) return
      activeStartedRef.current = Date.now()
      transition('listening')
    } catch (reason) {
      if (operation === operationRef.current) fail(reason, 'listen')
    }
  }, [abortOperations, acquireMicrophone, fail, transition])

  const stop = useCallback(async (): Promise<VoiceSessionResult> => {
    const finalAudio =
      stateRef.current === 'listening' && bufferRef.current?.hasSpeech() && microphoneRef.current
        ? {
            samples: bufferRef.current.snapshot(),
            sampleRate: microphoneRef.current.sampleRate,
            message: turnMessageRef.current ?? { id: crypto.randomUUID(), timestamp: Date.now() },
          }
        : pendingFinalRef.current
    abortOperations()
    pauseClock()
    const operation = operationRef.current
    transition(finalAudio ? 'thinking' : 'idle')
    await closeMicrophone()
    let transcriptionError: string | undefined
    if (finalAudio) {
      const controller = new AbortController()
      requestRef.current = controller
      const timeout = window.setTimeout(() => controller.abort(), 30000)
      try {
        const text = await recognizeAudio(
          finalAudio.samples,
          finalAudio.sampleRate,
          controller.signal,
        )
        if (operation === operationRef.current && text) {
          updateMessages([
            ...messagesRef.current,
            {
              ...finalAudio.message,
              role: 'user',
              content: text,
            },
          ])
        }
      } catch (reason) {
        transcriptionError = `Your last turn could not be transcribed. ${isAborted(reason) ? 'Speech recognition timed out.' : errorMessage(reason)}`
        if (operation === operationRef.current) {
          pendingFinalRef.current = finalAudio
          if (mountedRef.current) setError(transcriptionError)
        }
      } finally {
        window.clearTimeout(timeout)
      }
    }
    if (operation === operationRef.current) transition(transcriptionError ? 'error' : 'idle')
    const options = sessionOptionsRef.current
    const result: VoiceSessionResult = {
      id: sessionIdRef.current || crypto.randomUUID(),
      messages: messagesRef.current,
      elapsedSeconds: currentElapsed(),
      scenarioId: options.scenario.id,
      roleId: options.roleId,
      level: options.level,
      startedAt: startedAtRef.current || new Date().toISOString(),
      scenario: options.scenario,
      ...(transcriptionError ? { transcriptionError } : {}),
    }
    const shouldComplete = hasSessionRef.current && !transcriptionError
    if (!transcriptionError) {
      hasSessionRef.current = false
      if (mountedRef.current) setError(null)
    }
    if (shouldComplete) await optionsRef.current.onComplete?.(result)
    return result
  }, [abortOperations, closeMicrophone, currentElapsed, pauseClock, transition, updateMessages])

  const toggleMute = useCallback(() => {
    isMutedRef.current = !isMutedRef.current
    microphoneRef.current?.setMuted(isMutedRef.current)
    setIsMuted(isMutedRef.current)
    clearTurn()
    setUserLevel(0)
  }, [clearTurn])

  const interrupt = useCallback(() => {
    if (!['speaking', 'thinking'].includes(stateRef.current) || !microphoneRef.current) return
    abortOperations()
    transition('listening')
  }, [abortOperations, transition])

  const retry = useCallback(async () => {
    if (stateRef.current !== 'error') return
    if (!hasSessionRef.current || failedActionRef.current === 'start') {
      await start()
      return
    }
    const retryCoach = failedActionRef.current === 'coach'
    await resume()
    if (retryCoach && (stateRef.current as VoiceState) === 'listening') {
      const operation = operationRef.current
      // A failed stream may have left an incomplete assistant response.
      let lastUser = messagesRef.current.length - 1
      while (lastUser >= 0 && messagesRef.current[lastUser].role !== 'user') lastUser--
      const conversation = messagesRef.current.slice(0, lastUser + 1)
      updateMessages(conversation)
      transition('thinking')
      try {
        await requestCoach(conversation, operation)
      } catch (reason) {
        if (operation === operationRef.current) fail(reason, 'coach')
      }
    }
  }, [fail, requestCoach, resume, start, transition, updateMessages])

  useEffect(() => {
    mountedRef.current = true
    const timer = window.setInterval(() => setElapsedSeconds(currentElapsed()), 500)
    return () => {
      mountedRef.current = false
      window.clearInterval(timer)
      abortOperations()
      void closeMicrophone()
    }
  }, [abortOperations, closeMicrophone, currentElapsed])

  useEffect(() => {
    abortOperations()
    pauseClock()
    void closeMicrophone()
    hasSessionRef.current = false
    activeMsRef.current = 0
    activeStartedRef.current = null
    startedAtRef.current = ''
    sessionIdRef.current = ''
    setSessionIdentity(null)
    setActiveScenario(null)
    setElapsedSeconds(0)
    setError(null)
    updateMessages([])
    transition('idle')
  }, [configKey, abortOperations, closeMicrophone, pauseClock, transition, updateMessages])

  return {
    scenario: activeScenario,
    state,
    messages,
    interimTranscript,
    pendingMessage,
    sessionIdentity,
    elapsedSeconds,
    userLevel,
    coachLevel,
    error,
    isMuted,
    isGeneratingCoach,
    start,
    pause,
    resume,
    stop,
    toggleMute,
    retry,
    finishTurn,
    interrupt,
  }
}
