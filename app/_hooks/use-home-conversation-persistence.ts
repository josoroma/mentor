'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createHomeConversationAutosave } from '@/app/_home-conversation-autosave'
import {
  createHomeConversationMessages,
  createHomeConversationRecords,
  createHomeConversationScenario,
  type HomeConversationTurn,
} from '@/app/_home-conversation-records'
import { useLiveImprovements } from '@/app/_hooks/use-live-improvements'
import type { Profile } from '@/app/_types'
import type { SpeechPersonaPair } from '@/lib/audio/persona-selection'
import type { LearningSelection } from '@/lib/learning/paths'
import { getStorageMode, saveLearningSession } from '@/lib/learning/persistence'
import type { AutosaveState } from '@/lib/learning/session-autosave'
import { cacheLearningSession } from '@/lib/learning/storage'

export const useHomeConversationPersistence = ({
  id,
  topic,
  turns,
  profile,
  selection,
  personas,
  enabled,
  coachBusy,
}: {
  id: string | null
  topic: string
  turns: HomeConversationTurn[]
  profile: Pick<Profile, 'roleId' | 'level'>
  selection: LearningSelection | null
  personas: SpeechPersonaPair
  enabled: boolean
  coachBusy: boolean
}) => {
  const [state, setState] = useState<AutosaveState>({
    status: 'idle',
    destination: 'device',
    error: null,
  })
  const controller = useRef<ReturnType<typeof createHomeConversationAutosave> | null>(null)
  const scenario = useMemo(
    () =>
      createHomeConversationScenario({
        id: id ?? 'waiting',
        topic,
        profile,
        selection,
        personas,
        openingLine: turns[0]?.text,
      }),
    [id, topic, profile.roleId, profile.level, selection, personas, turns[0]?.text],
  )
  const messages = useMemo(() => createHomeConversationMessages(turns, personas), [turns, personas])
  const corrections = useLiveImprovements({
    sessionId: enabled && messages.some((message) => message.role === 'user') ? id : null,
    scenario,
    roleId: profile.roleId,
    level: profile.level,
    messages,
    pendingMessage: null,
    coachBusy,
  })
  const records = useMemo(
    () =>
      id && enabled
        ? createHomeConversationRecords({
            id,
            scenario,
            profile,
            messages,
            improvements: corrections.improvements,
          })
        : [],
    [id, enabled, scenario, profile.roleId, profile.level, messages, corrections.improvements],
  )
  const latest = useRef(records)
  latest.current = records

  useEffect(() => {
    const autosave = createHomeConversationAutosave({
      save: saveLearningSession,
      cache: cacheLearningSession,
      onChange: setState,
      destination: getStorageMode() === 'supabase' ? 'supabase' : 'device',
    })
    controller.current = autosave
    autosave.update(latest.current)
    const flush = () => {
      autosave.update(latest.current)
      void autosave.flush()
    }
    const visibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('online', autosave.retry)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('online', autosave.retry)
      autosave.dispose()
      controller.current = null
    }
  }, [])

  useEffect(() => {
    controller.current?.update(records)
  }, [records])

  useEffect(() => {
    // Keep the previous conversation's writer alive until navigation cleanup,
    // allowing its failed syncs to retry while the new exchange is running.
    const autosave = controller.current
    return () => {
      void autosave?.flush()
    }
  }, [id, enabled])

  const flush = useCallback(async () => {
    controller.current?.update(latest.current)
    return (await controller.current?.flush()) ?? false
  }, [])
  const retry = useCallback(() => controller.current?.retry(), [])

  return {
    ...state,
    improvements: corrections.improvements,
    pending: corrections.pending,
    retryImprovements: corrections.retry,
    flush,
    retry,
  }
}
