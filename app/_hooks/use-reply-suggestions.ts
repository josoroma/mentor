'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createReplySuggestionsContext,
  createReplySuggestionsSnapshot,
  ReplySuggestionsController,
  type ReplySuggestionsContext,
} from '@/app/_reply-suggestions-controller'
import type { ProficiencyLevel, Scenario, TranscriptMessage } from '@/app/_types'

export const useReplySuggestions = ({
  sessionId,
  scenario,
  roleId,
  level,
  messages,
  enabled,
  busy,
}: {
  sessionId: string | null
  scenario: Scenario
  roleId: string
  level: ProficiencyLevel
  messages: TranscriptMessage[]
  enabled: boolean
  busy: boolean
}) => {
  const context = useMemo(
    () => createReplySuggestionsContext({ sessionId, scenario, roleId, level, messages }),
    [sessionId, scenario, roleId, level, messages],
  )

  return useReplySuggestionsState({ context, enabled, busy })
}

export const useReplySuggestionsState = ({
  context,
  enabled,
  busy,
  mode = 'practice',
}: {
  context: ReplySuggestionsContext | null
  enabled: boolean
  busy: boolean
  mode?: 'practice' | 'join'
}) => {
  const [snapshot, setSnapshot] = useState(() => createReplySuggestionsSnapshot(null, mode))
  const [visible, setVisible] = useState(true)
  const controller = useRef<ReplySuggestionsController | null>(null)
  const active = enabled && visible

  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden')
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  useEffect(() => {
    const current = new ReplySuggestionsController({ onChange: setSnapshot })
    controller.current = current
    return () => {
      current.dispose()
      if (controller.current === current) controller.current = null
    }
  }, [])

  useEffect(() => {
    controller.current?.update(context, active, busy)
  }, [context, active, busy])

  const retry = useCallback(() => controller.current?.retry(), [])
  // Gate during rendering too: effects may not have cleared an old turn yet.
  const current =
    active && context && snapshot.key === context.key
      ? snapshot
      : createReplySuggestionsSnapshot(context, mode)

  return {
    replies: current.replies,
    isLoading: active && !busy && current.isLoading,
    error: current.error,
    isGenerated: current.isGenerated,
    retry,
    turnId: context?.turnId ?? null,
  }
}
