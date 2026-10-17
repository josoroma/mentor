'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { stopCorrectionPlayback } from '@/lib/audio/correction-playback'
import type { SpeechProvider } from '@/lib/audio/speech-provider'
import {
  createVoiceConcierge,
  type ConciergeConversationTurn,
  type ConciergePlayback,
  type VoiceConciergeState,
} from '@/lib/audio/voice-concierge'

export const useVoiceConcierge = ({
  onTranscript,
  enabled = true,
  microphoneMode = 'automatic',
  onConversationComplete,
  onListeningQuiet,
  onSpeechStart,
  onPlayback,
  onState,
}: {
  onTranscript: (text: string) => void
  enabled?: boolean
  microphoneMode?: 'automatic' | 'manual'
  onConversationComplete?: () => void
  onListeningQuiet?: () => void
  onSpeechStart?: () => void
  onPlayback?: (playback: ConciergePlayback) => void
  onState?: (state: VoiceConciergeState) => void
}) => {
  const [state, setState] = useState<VoiceConciergeState>('idle')
  const [coachLevel, setCoachLevel] = useState(0)
  const [userLevel, setUserLevel] = useState(0)
  const [interimTranscript, setInterimTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [microphoneEnabled, setMicrophoneEnabledState] = useState(false)
  const [playback, setPlayback] = useState<ConciergePlayback>({
    activeSpeaker: null,
    activeTurnIndex: null,
    startedTurnCount: 0,
  })
  const callbackRef = useRef(onTranscript)
  const eventRef = useRef({
    onConversationComplete,
    onListeningQuiet,
    onSpeechStart,
    onPlayback,
    onState,
  })
  const enabledRef = useRef(enabled)
  const conciergeRef = useRef<ReturnType<typeof createVoiceConcierge> | null>(null)
  callbackRef.current = onTranscript
  eventRef.current = {
    onConversationComplete,
    onListeningQuiet,
    onSpeechStart,
    onPlayback,
    onState,
  }
  enabledRef.current = enabled

  useEffect(() => {
    const concierge = createVoiceConcierge(
      {
        onState: (nextState) => {
          setState(nextState)
          if (enabledRef.current) eventRef.current.onState?.(nextState)
        },
        onCoachLevel: setCoachLevel,
        onUserLevel: setUserLevel,
        onInterimTranscript: setInterimTranscript,
        onError: setError,
        onMicrophoneEnabled: setMicrophoneEnabledState,
        onPlayback: (nextPlayback) => {
          setPlayback(nextPlayback)
          if (enabledRef.current) eventRef.current.onPlayback?.(nextPlayback)
        },
        onTranscript: (text) => {
          if (enabledRef.current) callbackRef.current(text)
        },
        onConversationComplete: () => {
          if (enabledRef.current) eventRef.current.onConversationComplete?.()
        },
        onListeningQuiet: () => {
          if (enabledRef.current) eventRef.current.onListeningQuiet?.()
        },
        onSpeechStart: () => {
          if (enabledRef.current) eventRef.current.onSpeechStart?.()
        },
      },
      { microphoneMode },
    )
    conciergeRef.current = concierge
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') concierge.pause()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      conciergeRef.current = null
      concierge.dispose()
    }
  }, [microphoneMode])

  useEffect(() => {
    if (!enabled) conciergeRef.current?.cancel()
  }, [enabled])

  const begin = useCallback(async (text: string) => {
    if (enabledRef.current && document.visibilityState !== 'hidden') {
      stopCorrectionPlayback()
      await conciergeRef.current?.begin(text)
    }
  }, [])
  const enable = useCallback(async () => {
    if (enabledRef.current && document.visibilityState !== 'hidden') {
      stopCorrectionPlayback()
      await conciergeRef.current?.enable()
    }
  }, [])
  const beginConversation = useCallback(
    async (turns: ConciergeConversationTurn[], provider?: SpeechProvider) => {
      if (enabledRef.current && document.visibilityState !== 'hidden') {
        stopCorrectionPlayback()
        await conciergeRef.current?.beginConversation(turns, provider)
      }
    },
    [],
  )
  const listen = useCallback(async () => {
    if (enabledRef.current && document.visibilityState !== 'hidden') {
      stopCorrectionPlayback()
      await conciergeRef.current?.listen()
    }
  }, [])
  const finishTurn = useCallback(async () => {
    if (enabledRef.current) await conciergeRef.current?.finishTurn()
  }, [])
  const setMicrophoneEnabled = useCallback(async (nextEnabled: boolean) => {
    if (!nextEnabled || (enabledRef.current && document.visibilityState !== 'hidden')) {
      if (nextEnabled) stopCorrectionPlayback()
      await conciergeRef.current?.setMicrophoneEnabled(nextEnabled)
    }
  }, [])
  const pause = useCallback(() => conciergeRef.current?.pause(), [])
  const cancel = useCallback(() => conciergeRef.current?.cancel(), [])

  return {
    state,
    coachLevel,
    userLevel,
    interimTranscript,
    error,
    microphoneEnabled,
    ...playback,
    begin,
    beginConversation,
    enable,
    listen,
    setMicrophoneEnabled,
    finishTurn,
    pause,
    cancel,
  }
}
