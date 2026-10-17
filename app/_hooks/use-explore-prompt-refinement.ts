'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExplorePromptRefinementRequest } from '@/lib/explore/prompt-refinement'
import {
  createExplorePromptRefinementContext,
  createExplorePromptRefinementSnapshot,
  ExplorePromptRefinementController,
} from '@/lib/explore/prompt-refinement-controller'

export const useExplorePromptRefinement = ({
  prompt,
  learningContext,
  lesson,
  conversation,
  contextKey,
  enabled,
}: ExplorePromptRefinementRequest & { contextKey: string; enabled: boolean }) => {
  const context = createExplorePromptRefinementContext(
    { prompt, learningContext, lesson, conversation },
    contextKey,
  )
  const [snapshot, setSnapshot] = useState(createExplorePromptRefinementSnapshot)
  const controller = useRef<ExplorePromptRefinementController | null>(null)
  const current = useRef({ context, enabled })
  current.current = { context, enabled }

  useEffect(() => {
    const active = new ExplorePromptRefinementController({ onChange: setSnapshot })
    controller.current = active
    active.update(current.current.context, current.current.enabled)
    return () => {
      active.dispose()
      if (controller.current === active) controller.current = null
    }
  }, [])

  useEffect(() => {
    controller.current?.update(current.current.context, current.current.enabled)
  }, [context?.key, enabled])

  const refine = useCallback(async () => {
    const active = controller.current
    if (!active) return
    active.update(current.current.context, current.current.enabled)
    await active.refine()
  }, [])

  const clear = useCallback(() => controller.current?.clear(), [])
  const choose = useCallback(
    (id: string) =>
      controller.current?.choose(id, current.current.context, current.current.enabled, snapshot) ??
      null,
    [snapshot],
  )

  // Hide stale choices during rendering, before cancellation effects run.
  const visible =
    enabled && context && snapshot.key === context.key
      ? snapshot
      : createExplorePromptRefinementSnapshot()

  return {
    options: visible.options,
    status: visible.status,
    error: visible.error,
    refine,
    choose,
    cancel: clear,
    clear,
  }
}
