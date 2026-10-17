'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProficiencyLevel } from '@/app/_types'
import type { LearningSelection } from '@/lib/learning/paths'
import {
  ExploreSuggestionsRequestSchema,
  ExploreSuggestionsSchema,
  type ExploreSuggestion,
} from '@/lib/explore/suggestions'

type SuggestionsState = {
  key: string
  status: 'loading' | 'ready' | 'error'
  ideas: ExploreSuggestion[]
  error: string | null
}

export const useExploreSuggestions = ({
  selection,
  level,
  enabled,
}: {
  selection: LearningSelection | null
  level: ProficiencyLevel
  enabled: boolean
}) => {
  const request = ExploreSuggestionsRequestSchema.safeParse({ selection, level })
  const key = request.success ? JSON.stringify(request.data) : ''
  const [state, setState] = useState<SuggestionsState | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  const cancel = useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
  }, [])

  const regenerate = useCallback(async () => {
    if (!enabled || !key) return
    cancel()
    const controller = new AbortController()
    controllerRef.current = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(95_000)])
    setState({ key, status: 'loading', ideas: [], error: null })
    try {
      const requested = ExploreSuggestionsRequestSchema.parse(JSON.parse(key))
      const response = await fetch('/api/explore/suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: key,
        signal,
      })
      const data: unknown = await response.json()
      if (!response.ok) {
        throw new Error(
          data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
            ? data.error
            : 'Your local coach could not suggest explorations. Please try again.',
        )
      }
      const result = ExploreSuggestionsSchema.safeParse(data)
      if (!result.success)
        throw new Error('The local coach returned incomplete exploration ideas. Please try again.')
      if (
        result.data.level !== requested.level ||
        JSON.stringify(result.data.selection) !== JSON.stringify(requested.selection)
      )
        throw new Error('These ideas did not match your learning path. Please try again.')
      signal.throwIfAborted()
      if (controllerRef.current !== controller) return
      setState({ key, status: 'ready', ideas: result.data.ideas, error: null })
    } catch (error) {
      if (!controller.signal.aborted && controllerRef.current === controller)
        setState({
          key,
          status: 'error',
          ideas: [],
          error: signal.aborted
            ? 'The local coach took too long to suggest explorations. Please try again.'
            : error instanceof Error
              ? error.message
              : 'Exploration ideas could not be generated. Please try again.',
        })
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [key, enabled, cancel])

  useEffect(() => {
    if (!enabled || !key) return
    setState({ key, status: 'loading', ideas: [], error: null })
    // Coalesce quick selector changes without showing cards from a previous path.
    const timer = setTimeout(() => void regenerate(), 180)
    return () => {
      clearTimeout(timer)
      cancel()
    }
  }, [key, enabled, regenerate, cancel])

  const current = state?.key === key ? state : null
  return {
    ideas: enabled && current?.status === 'ready' ? current.ideas : [],
    loading: enabled && !!key && (!current || current.status === 'loading'),
    error: enabled ? (current?.error ?? null) : null,
    regenerate,
    cancel,
  }
}
