'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import type { Profile } from '@/app/_types'
import {
  HomeConversationController,
  createHomeConversationSnapshot,
} from '@/app/_home-conversation-controller'
import { useVoiceConcierge } from '@/app/_hooks/use-voice-concierge'
import { readSpeechProvider } from '@/lib/audio/speech-preference'
import {
  resolveAvailableSpeechPersonas,
  selectSpeechPersonaPair,
  type SpeechPersonaPair,
} from '@/lib/audio/persona-selection'
import { LearningSelectionSchema, type LearningSelection } from '@/lib/learning/paths'

const recentTopicsKey = 'mentor.demo-topics.v1'
const RecentTopicsSchema = z.array(z.string().trim().min(1).max(100)).max(8)
const readRecentTopics = (): string[] => {
  try {
    const value = RecentTopicsSchema.safeParse(
      JSON.parse(localStorage.getItem(recentTopicsKey) ?? '[]'),
    )
    return value.success ? value.data : []
  } catch {
    return []
  }
}

export const useHomeConversation = ({
  profile,
  selection,
  enabled,
}: {
  profile: Profile
  selection: LearningSelection | null
  enabled: boolean
}) => {
  const [snapshot, setSnapshot] = useState(createHomeConversationSnapshot)
  const controller = useRef<HomeConversationController | null>(null)
  const previousPair = useRef<SpeechPersonaPair | undefined>(undefined)
  const started = useRef(false)
  const voice = useVoiceConcierge({
    enabled,
    microphoneMode: 'manual',
    onTranscript: (text) => controller.current?.onTranscript(text),
    onPlayback: (playback) => controller.current?.onPlayback(playback),
    onState: (state) => controller.current?.onVoiceState(state),
    onSpeechStart: () => controller.current?.onVoiceState('listening'),
    onConversationComplete: () => controller.current?.onComplete(),
    onListeningQuiet: () => controller.current?.onListeningQuiet(),
  })
  const { beginConversation, pause, cancel, setMicrophoneEnabled } = voice
  const selectionKey = JSON.stringify(selection)
  useEffect(() => {
    const parsed = LearningSelectionSchema.safeParse(JSON.parse(selectionKey))
    if (!parsed.success) return
    started.current = false
    setSnapshot(createHomeConversationSnapshot())
    const current = new HomeConversationController({
      profile: { roleId: profile.roleId, level: profile.level },
      selection: parsed.data,
      prepare: async (signal) => {
        const provider = readSpeechProvider()
        const response = await fetch('/api/health', { cache: 'no-store', signal })
        if (!response.ok) throw new Error('The local voice models could not be checked. Try again.')
        const capabilities = resolveAvailableSpeechPersonas(await response.json(), provider)
        const personas = selectSpeechPersonaPair(
          capabilities.personas.map((item) => item.id),
          previousPair.current,
        )
        signal.throwIfAborted()
        previousPair.current = personas
        return { personas, provider: capabilities.provider }
      },
      play: beginConversation,
      pauseVoice: pause,
      cancelVoice: cancel,
      setMicrophone: setMicrophoneEnabled,
      onChange: setSnapshot,
      recentTopics: readRecentTopics,
      rememberTopic: (topic) => {
        try {
          localStorage.setItem(
            recentTopicsKey,
            JSON.stringify([topic, ...readRecentTopics()].slice(0, 8)),
          )
        } catch {
          /* An exchange still works without browser preference storage. */
        }
      },
    })
    controller.current = current
    const hide = () => {
      if (document.hidden) current.pause()
    }
    document.addEventListener('visibilitychange', hide)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      current.dispose()
      if (controller.current === current) controller.current = null
    }
  }, [
    profile.roleId,
    profile.level,
    profile.speechProvider,
    selectionKey,
    beginConversation,
    pause,
    cancel,
    setMicrophoneEnabled,
  ])

  useEffect(() => {
    if (!enabled) {
      controller.current?.pause()
      return
    }
    if (started.current) return
    const timer = setTimeout(() => {
      started.current = true
      void controller.current?.startNew()
    }, 0)
    return () => clearTimeout(timer)
  }, [enabled, profile.roleId, profile.level, profile.speechProvider, selectionKey])

  return {
    ...snapshot,
    voice,
    newExchange: useCallback(() => {
      void controller.current?.startNew()
    }, []),
    resume: useCallback(() => {
      void controller.current?.resume()
    }, []),
    pause: useCallback(() => controller.current?.pause(), []),
    setMicrophone: useCallback((value: boolean) => {
      void controller.current?.toggleMicrophone(value)
    }, []),
  }
}
