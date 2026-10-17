'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { SessionRecord } from '@/app/_types'
import { getStorageMode, saveLearningSession } from '@/lib/learning/persistence'
import { createSessionAutosave, type AutosaveState } from '@/lib/learning/session-autosave'
import { cacheLearningSession } from '@/lib/learning/storage'

export const useSessionAutosave = (session: SessionRecord | null) => {
  const [state, setState] = useState<AutosaveState>({
    status: 'idle',
    destination: 'device',
    error: null,
  })
  const controller = useRef<ReturnType<typeof createSessionAutosave> | null>(null)
  const latest = useRef(session)
  latest.current = session

  useEffect(() => {
    const autosave = createSessionAutosave({
      save: saveLearningSession,
      cache: cacheLearningSession,
      onChange: setState,
      destination: getStorageMode() === 'supabase' ? 'supabase' : 'device',
    })
    controller.current = autosave
    if (latest.current) autosave.update(latest.current)
    const handlePageHide = () => {
      if (latest.current) {
        // IndexedDB and network writes may be interrupted when the browser exits.
        try {
          cacheLearningSession(latest.current)
        } catch {
          // The regular autosave status already reports failures and offers a retry.
        }
        void autosave.flush(latest.current)
      }
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') handlePageHide()
    }
    window.addEventListener('pagehide', handlePageHide)
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('online', autosave.retry)
    return () => {
      window.removeEventListener('pagehide', handlePageHide)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('online', autosave.retry)
      autosave.dispose()
      controller.current = null
    }
  }, [])

  useEffect(() => {
    if (session) controller.current?.update(session)
  }, [session])

  const flush = useCallback(async (value?: SessionRecord): Promise<boolean> => {
    if (!controller.current) return false
    return controller.current.flush(value ?? latest.current ?? undefined)
  }, [])
  const retry = useCallback(() => controller.current?.retry(), [])

  return { ...state, flush, retry }
}
