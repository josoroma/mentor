'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProficiencyLevel, Scenario, TranscriptMessage } from '@/app/_types'
import { LiveImprovementQueue, type ImprovementSnapshot } from '@/lib/ai/live-improvements'

export const useLiveImprovements = ({
  sessionId,
  scenario,
  roleId,
  level,
  messages,
  pendingMessage,
  coachBusy,
}: {
  sessionId: string | null
  scenario: Scenario
  roleId: string
  level: ProficiencyLevel
  messages: TranscriptMessage[]
  pendingMessage: TranscriptMessage | null
  coachBusy: boolean
}) => {
  const [snapshot, setSnapshot] = useState<ImprovementSnapshot>({
    improvements: [],
    pending: null,
    failures: [],
  })
  const queue = useRef<LiveImprovementQueue | null>(null)
  const options = useRef({ scenario, roleId, level })
  options.current = { scenario, roleId, level }

  useEffect(() => {
    setSnapshot({ improvements: [], pending: null, failures: [] })
    if (!sessionId) return
    const current = new LiveImprovementQueue({
      onChange: setSnapshot,
      request: async (message, context, signal, onText) => {
        const configuration = options.current
        const response = await fetch('/api/improve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scenarioId: configuration.scenario.id,
            ...configuration,
            text: message.content,
            context: context.map(({ role, content }) => ({ role, content })),
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        })
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null
          throw new Error(
            body?.error || 'Improved wording is unavailable. Your original words are saved.',
          )
        }
        if (!response.body) throw new Error('No improved wording was returned. Try again.')
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let text = ''
        try {
          while (true) {
            const { value, done } = await reader.read()
            signal.throwIfAborted()
            text += decoder.decode(value, { stream: !done })
            if (text.length > 20_000)
              throw new Error('The improved response was too long. Try again.')
            onText(text)
            if (done) break
          }
          return text
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      },
    })
    queue.current = current
    return () => {
      current.dispose()
      if (queue.current === current) queue.current = null
    }
  }, [sessionId])

  useEffect(() => {
    queue.current?.update(messages, pendingMessage, coachBusy)
  }, [sessionId, messages, pendingMessage, coachBusy])

  const finish = useCallback(
    async (finalMessages: TranscriptMessage[]) =>
      (await queue.current?.finish(finalMessages)) ?? [],
    [],
  )
  const retry = useCallback(() => queue.current?.retry(), [])

  return { ...snapshot, finish, retry }
}
