'use client'

import { useEffect, useRef, useState } from 'react'
import { exploreRequest } from '@/lib/explore/client'
import { ExplorePracticeImprovementResponseSchema } from '@/lib/explore/practice-improvement-schema'
import type { ExploreLearningState } from '@/lib/explore/schema'

type PracticeOptions = {
  artifactId: string
  revision: number
  enabled: boolean
  scope: string
  activeIndices: number[]
  state: ExploreLearningState
  update: (patch: ExploreLearningState) => void
}

type PracticeError = { text: string; message: string }

const draftAt = (state: ExploreLearningState, index: number) => {
  const value = state[`examplePractice${index}`]
  return typeof value === 'string' ? value : ''
}

export const useExplorePracticeImprovements = (options: PracticeOptions) => {
  const { artifactId, revision, enabled, scope, activeIndices, state } = options
  const [errors, setErrors] = useState(new Map<number, PracticeError>())
  const [pendingIndex, setPendingIndex] = useState<number | null>(null)
  const latest = useRef(options)
  latest.current = options
  const activeRequest = useRef<{ index: number; controller: AbortController } | null>(null)

  // Only expanded, visible drafts enter this single queue. Reopening a lesson
  // with many saved drafts does not submit all of them to the local model.
  const candidateIndex = activeIndices.find((index) => {
    const text = draftAt(state, index)
    const improvement = state[`examplePracticeImproved${index}`]
    return (
      text.trim().length > 0 &&
      text.length <= 2000 &&
      !(typeof improvement === 'string' && improvement.trim()) &&
      errors.get(index)?.text !== text
    )
  })
  const candidateText = candidateIndex === undefined ? '' : draftAt(state, candidateIndex)

  useEffect(() => {
    setErrors(new Map())
  }, [artifactId, revision])

  useEffect(() => {
    if (!enabled || candidateIndex === undefined) return
    const index = candidateIndex
    const controller = new AbortController()
    activeRequest.current = { index, controller }
    const isCurrent = () => {
      const current = latest.current
      return (
        !controller.signal.aborted &&
        current.enabled &&
        current.artifactId === artifactId &&
        current.revision === revision &&
        current.scope === scope &&
        current.activeIndices.includes(index) &&
        draftAt(current.state, index) === candidateText
      )
    }

    const timer = setTimeout(() => {
      if (!isCurrent()) return
      setPendingIndex(index)
      void exploreRequest(
        `/artifacts/${artifactId}/improve-practice`,
        ExplorePracticeImprovementResponseSchema,
        {
          method: 'POST',
          body: { exampleIndex: index, expectedRevision: revision, text: candidateText.trim() },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
        },
      )
        .then((result) => {
          if (!isCurrent()) return
          if (result.text !== candidateText.trim())
            throw new Error('The improved wording did not match your draft. Please retry.')
          latest.current.update({ [`examplePracticeImproved${index}`]: result.improvedText })
        })
        .catch((cause: unknown) => {
          if (!isCurrent()) return
          setErrors((previous) =>
            new Map(previous).set(index, {
              text: candidateText,
              message:
                cause instanceof Error
                  ? cause.name === 'TimeoutError'
                    ? 'The local coach took too long. Please retry.'
                    : cause.message
                  : 'Your wording could not be improved. Please retry.',
            }),
          )
        })
        .finally(() => {
          if (activeRequest.current?.controller === controller) {
            activeRequest.current = null
            setPendingIndex(null)
          }
        })
    }, 1000)

    return () => {
      clearTimeout(timer)
      controller.abort()
      if (activeRequest.current?.controller === controller) {
        activeRequest.current = null
        setPendingIndex(null)
      }
    }
  }, [artifactId, revision, scope, enabled, candidateIndex, candidateText])

  return {
    pendingIndex,
    errorFor: (index: number) => {
      const error = errors.get(index)
      return error?.text === draftAt(state, index) ? error.message : undefined
    },
    change: (index: number, text: string) => {
      if (text === draftAt(latest.current.state, index)) return
      if (activeRequest.current?.index === index) activeRequest.current.controller.abort()
      const patch = {
        [`examplePractice${index}`]: text.slice(0, 2000),
        [`examplePracticeImproved${index}`]: '',
      }
      // Invalidate a result immediately, even before React renders the edit.
      latest.current = { ...latest.current, state: { ...latest.current.state, ...patch } }
      latest.current.update(patch)
    },
    retry: (index: number) =>
      setErrors((previous) => {
        const next = new Map(previous)
        next.delete(index)
        return next
      }),
  }
}
