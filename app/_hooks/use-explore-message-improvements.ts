'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { exploreRequest } from '@/lib/explore/client'
import {
  ExploreMessageImprovementSchema,
  ExploreMessageSchema,
  type ExploreDetail,
  type ExploreMessageImprovement,
} from '@/lib/explore/schema'

// Corrections have their own lifecycle: a failed lesson can still teach clearer
// wording, and editing a sentence never replaces the learner's original prompt.
export const useExploreMessageImprovements = (detail: ExploreDetail | null, enabled: boolean) => {
  const [completed, setCompleted] = useState(new Map<string, ExploreMessageImprovement>())
  const [errors, setErrors] = useState(new Map<string, string>())
  const [pendingId, setPendingId] = useState<string | null>(null)
  const sessionId = detail?.session.id ?? null
  const currentSession = useRef(sessionId)
  currentSession.current = sessionId

  const improvements = useMemo(() => {
    const result = new Map<string, ExploreMessageImprovement>()
    for (const message of detail?.messages ?? []) {
      const stored = ExploreMessageImprovementSchema.safeParse(message.metadata.improvement)
      const improvement = stored.success ? stored.data : completed.get(message.id)
      if (message.role === 'user' && improvement) result.set(message.id, improvement)
    }
    return result
  }, [detail?.messages, completed])

  // Prioritize the newest question, then gradually improve older visible turns.
  // Synthetic restore events and provisional, not-yet-saved messages are excluded.
  const candidateId = detail?.messages.findLast(
    (message) =>
      message.role === 'user' &&
      message.metadata.action !== 'restore' &&
      message.sequence !== Number.MAX_SAFE_INTEGER &&
      !improvements.has(message.id) &&
      !errors.has(message.id),
  )?.id

  useEffect(() => {
    setCompleted(new Map())
    setErrors(new Map())
  }, [sessionId])

  useEffect(() => {
    if (!enabled || !sessionId || !candidateId) return
    const controller = new AbortController()
    setPendingId(candidateId)
    void exploreRequest(`/messages/${candidateId}/improve`, ExploreMessageSchema, {
      method: 'POST',
      body: {},
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
    })
      .then((message) => {
        if (controller.signal.aborted || currentSession.current !== sessionId) return
        if (message.id !== candidateId || message.sessionId !== sessionId)
          throw new Error('The improved wording did not match this message. Please retry.')
        const improvement = ExploreMessageImprovementSchema.parse(message.metadata.improvement)
        setCompleted((previous) => new Map(previous).set(candidateId, improvement))
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || currentSession.current !== sessionId) return
        setErrors((previous) =>
          new Map(previous).set(
            candidateId,
            cause instanceof Error
              ? cause.name === 'TimeoutError'
                ? 'The local coach took too long to improve your wording. Please retry.'
                : cause.message
              : 'Your wording could not be improved. Please retry.',
          ),
        )
      })
      .finally(() => {
        if (!controller.signal.aborted && currentSession.current === sessionId) setPendingId(null)
      })
    return () => {
      controller.abort()
      setPendingId(null)
    }
  }, [enabled, sessionId, candidateId])

  return {
    improvements,
    pendingId,
    errors,
    retry: (messageId: string) =>
      setErrors((previous) => {
        const next = new Map(previous)
        next.delete(messageId)
        return next
      }),
  }
}
