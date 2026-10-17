'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProficiencyLevel, Scenario } from '@/app/_types'
import type { LearningSelection } from '@/lib/learning/paths'
import {
  GeneratedScenariosSchema,
  ScenarioGenerationRequestSchema,
} from '@/lib/ai/generated-scenarios'

type GenerationState = {
  key: string
  status: 'loading' | 'ready' | 'error'
  scenarios: Scenario[]
  error: string | null
}

export const useGeneratedScenarios = ({
  selection,
  roleId,
  level,
  enabled,
}: {
  selection: LearningSelection | null
  roleId: string
  level: ProficiencyLevel
  enabled: boolean
}) => {
  const request = ScenarioGenerationRequestSchema.safeParse({
    selection,
    roleId: selection?.path === 'professional' ? selection.roleId : roleId,
    level,
  })
  const key = request.success ? JSON.stringify(request.data) : ''
  const [state, setState] = useState<GenerationState | null>(null)
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
    setState({ key, status: 'loading', scenarios: [], error: null })
    try {
      const requested = ScenarioGenerationRequestSchema.parse(JSON.parse(key))
      const response = await fetch('/api/scenarios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: key,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(95_000)]),
      })
      const data: unknown = await response.json()
      if (!response.ok) {
        const message =
          data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
            ? data.error
            : 'Your local coach could not create scenarios. Please try again.'
        throw new Error(message)
      }
      const result = GeneratedScenariosSchema.parse(data)
      if (
        result.level !== requested.level ||
        result.roleId !== requested.roleId ||
        JSON.stringify(result.selection) !== JSON.stringify(requested.selection) ||
        result.scenarios.some(
          (scenario) =>
            JSON.stringify(scenario.learningSelection) !== JSON.stringify(requested.selection) ||
            !scenario.roleIds.includes(requested.roleId),
        )
      )
        throw new Error(
          'The scenarios did not match your current selection. Please regenerate them.',
        )
      if (controller.signal.aborted || controllerRef.current !== controller) return
      setState({ key, status: 'ready', scenarios: result.scenarios, error: null })
    } catch (error) {
      if (!controller.signal.aborted && controllerRef.current === controller)
        setState({
          key,
          status: 'error',
          scenarios: [],
          error:
            error instanceof Error
              ? error.message
              : 'Scenarios could not be generated. Please try again.',
        })
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [key, enabled, cancel])

  useEffect(() => {
    if (!enabled || !key) return
    // Clear stale cards through the context key immediately; coalesce rapid selector changes.
    setState({ key, status: 'loading', scenarios: [], error: null })
    const timer = setTimeout(() => void regenerate(), 120)
    return () => {
      clearTimeout(timer)
      cancel()
    }
  }, [key, enabled, regenerate, cancel])

  const current = state?.key === key ? state : null
  return {
    scenarios: enabled && current?.status === 'ready' ? current.scenarios : [],
    loading: enabled && !!key && (!current || current.status === 'loading'),
    error: enabled ? (current?.error ?? null) : null,
    regenerate,
    cancel,
  }
}
