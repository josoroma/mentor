'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProficiencyLevel, Scenario } from '@/app/_types'
import {
  loadScenarioBookmarks,
  readScenarioBookmarks,
  saveScenarioBookmark,
  SCENARIO_BOOKMARKS_KEY,
  type ScenarioBookmark,
} from '@/lib/learning/bookmarks'

export const useScenarioBookmarks = ({
  enabled,
  sync,
  level,
}: {
  enabled: boolean
  sync: boolean
  level: ProficiencyLevel
}) => {
  const [records, setRecords] = useState<ScenarioBookmark[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pendingIds, setPendingIds] = useState<string[]>([])
  const pending = useRef(new Set<string>())
  const revision = useRef(0)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  const refresh = useCallback(async () => {
    if (!enabled) return
    const version = ++revision.current
    setLoading(true)
    setError(null)
    try {
      setRecords(readScenarioBookmarks())
      const result = await loadScenarioBookmarks({ sync })
      if (revision.current !== version || !enabledRef.current) return
      setRecords(result.data)
      setError(result.error ?? null)
    } catch (cause) {
      if (revision.current === version && enabledRef.current)
        setError(cause instanceof Error ? cause.message : 'Saved scenarios could not be loaded.')
    } finally {
      if (revision.current === version) setLoading(false)
    }
  }, [enabled, sync])

  useEffect(() => {
    void refresh()
    return () => {
      revision.current += 1
    }
  }, [refresh])

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (enabledRef.current && event.key === SCENARIO_BOOKMARKS_KEY) {
        try {
          setRecords(readScenarioBookmarks())
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'Saved scenarios could not be read.')
        }
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  const toggle = useCallback(
    async (scenario: Scenario) => {
      if (!enabled || loading || pending.current.has(scenario.id)) return
      const current = records.find((record) => record.scenario.id === scenario.id)
      const saved = !current?.saved
      const version = revision.current
      pending.current.add(scenario.id)
      setPendingIds([...pending.current])
      setError(null)
      const now = new Date().toISOString()
      setRecords((previous) => [
        ...previous.filter((record) => record.scenario.id !== scenario.id),
        {
          scenario,
          level: current?.level ?? level,
          saved,
          savedAt: saved ? now : (current?.savedAt ?? now),
          updatedAt: now,
        },
      ])
      try {
        const result = await saveScenarioBookmark(scenario, current?.level ?? level, saved, {
          sync,
        })
        if (revision.current === version && enabledRef.current) {
          setRecords(result.data)
          setError(result.error ?? null)
        }
      } catch (cause) {
        if (revision.current === version && enabledRef.current) {
          setRecords(readScenarioBookmarks())
          setError(
            cause instanceof Error ? cause.message : 'Your saved scenarios could not be updated.',
          )
        }
      } finally {
        pending.current.delete(scenario.id)
        setPendingIds([...pending.current])
      }
    },
    [enabled, loading, records, level, sync],
  )

  return {
    records,
    scenarios: records.filter((record) => record.saved).map((record) => record.scenario),
    ids: records.filter((record) => record.saved).map((record) => record.scenario.id),
    pendingIds,
    loading: enabled ? loading : true,
    error,
    refresh,
    toggle,
  }
}
