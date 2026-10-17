import {
  ReplySuggestionsRequestSchema,
  ReplySuggestionsSchema,
  type ReplySuggestions,
  type ReplySuggestionsRequest,
} from '@/app/_reply-suggestions'
import type { ProficiencyLevel, Scenario, TranscriptMessage } from '@/app/_types'

const practiceStarters: ReplySuggestions['replies'] = [
  {
    label: 'Ask for an example',
    text: 'Could you give me a simple example so I can try answering in my own words?',
  },
  {
    label: 'Take it step by step',
    text: 'Could we practice one short sentence at a time? I would like to make my answer clearer.',
  },
  {
    label: 'Learn how to practice',
    text: 'I am learning how to use this app. Could you help me practice a short reply that I can write and say aloud?',
  },
]

const conversationStarters: ReplySuggestions['replies'] = [
  { label: 'Catch up', text: 'Could you quickly recap the main idea?' },
  { label: 'Ask a question', text: 'What would be a useful next step?' },
  { label: 'Explore together', text: 'Could we walk through a simple example together?' },
]

export type ReplySuggestionsContext = {
  key: string
  turnId: string
  request: ReplySuggestionsRequest
}

export type ReplySuggestionsSnapshot = {
  key: string | null
  turnId: string | null
  replies: ReplySuggestions['replies']
  isLoading: boolean
  error: string | null
  isGenerated: boolean
}

export const createReplySuggestionsSnapshot = (
  context: ReplySuggestionsContext | null = null,
  mode: 'practice' | 'join' = context?.request.mode ?? 'practice',
): ReplySuggestionsSnapshot => ({
  key: context?.key ?? null,
  turnId: context?.turnId ?? null,
  replies: mode === 'join' ? conversationStarters : practiceStarters,
  isLoading: false,
  error: null,
  isGenerated: false,
})

export const createReplySuggestionsContext = ({
  sessionId,
  scenario,
  roleId,
  level,
  messages,
}: {
  sessionId: string | null
  scenario: Scenario
  roleId: string
  level: ProficiencyLevel
  messages: TranscriptMessage[]
}): ReplySuggestionsContext | null => {
  const latest = messages.at(-1)
  if (!sessionId || latest?.role !== 'assistant') return null
  const request = ReplySuggestionsRequestSchema.safeParse({
    scenarioId: scenario.id,
    scenario,
    roleId,
    level,
    messages: messages.slice(-12).map(({ role, content }) => ({
      role,
      content: content.slice(-6000),
    })),
  })
  if (!request.success) return null
  return {
    key: JSON.stringify([sessionId, latest.id, request.data]),
    turnId: latest.id,
    request: request.data,
  }
}

const requestReplySuggestions = async (
  request: ReplySuggestionsRequest,
  signal: AbortSignal,
): Promise<unknown> => {
  const response = await fetch('/api/reply-suggestions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  const data: unknown = await response.json()
  if (!response.ok) {
    throw new Error(
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : 'The local coach could not suggest replies. Please try again.',
    )
  }
  return data
}

type ActiveRequest = {
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
}

// Reply ideas are temporary practice aids, scoped to one completed coach turn.
// Keep their cancellation separate from recording, corrections, and autosave.
export class ReplySuggestionsController {
  private context: ReplySuggestionsContext | null = null
  private enabled = false
  private busy = false
  private disposed = false
  private scheduled: ReturnType<typeof setTimeout> | null = null
  private active: ActiveRequest | null = null
  private snapshot = createReplySuggestionsSnapshot()
  private readonly onChange: (snapshot: ReplySuggestionsSnapshot) => void
  private readonly request: typeof requestReplySuggestions

  constructor({
    onChange,
    request = requestReplySuggestions,
  }: {
    onChange: (snapshot: ReplySuggestionsSnapshot) => void
    request?: typeof requestReplySuggestions
  }) {
    this.onChange = onChange
    this.request = request
  }

  update(context: ReplySuggestionsContext | null, enabled: boolean, busy: boolean) {
    if (this.disposed) return
    const changed = context?.key !== this.context?.key
    this.enabled = enabled
    this.busy = busy
    if (changed) {
      this.cancel()
      this.context = context
      this.publish(createReplySuggestionsSnapshot(context))
    }
    if (!enabled || busy || !context) {
      this.cancel()
      return
    }
    // Keep successes and known failures through timer renders and panel toggles.
    if (!this.active && !this.scheduled && !this.snapshot.isGenerated && !this.snapshot.error)
      this.schedule()
  }

  retry() {
    if (this.disposed || !this.enabled || this.busy || !this.context) return
    this.cancel()
    this.publish(createReplySuggestionsSnapshot(this.context))
    this.schedule()
  }

  dispose() {
    this.disposed = true
    this.cancel()
  }

  private publish(snapshot: ReplySuggestionsSnapshot) {
    this.snapshot = snapshot
    if (!this.disposed) this.onChange(snapshot)
  }

  private cancel() {
    if (this.scheduled) {
      clearTimeout(this.scheduled)
      this.scheduled = null
    }
    if (this.active) {
      const active = this.active
      this.active = null
      clearTimeout(active.timer)
      active.controller.abort()
    }
    if (this.snapshot.isLoading) this.publish({ ...this.snapshot, isLoading: false })
  }

  private schedule() {
    const context = this.context
    if (!context) return
    this.publish({ ...createReplySuggestionsSnapshot(context), isLoading: true })
    // Corrections start after 450 ms. Give them priority before using the coach.
    this.scheduled = setTimeout(() => {
      this.scheduled = null
      this.start(context)
    }, 650)
  }

  private start(context: ReplySuggestionsContext) {
    const controller = new AbortController()
    const active: ActiveRequest = {
      controller,
      timer: setTimeout(() => {
        if (this.active !== active) return
        this.active = null
        controller.abort()
        this.publish({
          ...createReplySuggestionsSnapshot(context),
          error: 'The local coach took too long to suggest replies. Please try again.',
        })
      }, 85_000),
    }
    this.active = active
    void this.request(context.request, controller.signal)
      .then((data) => {
        if (this.active !== active || controller.signal.aborted) return
        const result = ReplySuggestionsSchema.safeParse(data)
        if (!result.success) {
          throw new Error('The local coach returned incomplete reply ideas. Please try again.')
        }
        this.publish({
          key: context.key,
          turnId: context.turnId,
          replies: result.data.replies,
          isLoading: false,
          error: null,
          isGenerated: true,
        })
      })
      .catch((cause: unknown) => {
        if (this.active !== active || controller.signal.aborted) return
        this.publish({
          ...createReplySuggestionsSnapshot(context),
          error:
            cause instanceof Error
              ? cause.message
              : 'The local coach could not suggest replies. Please try again.',
        })
      })
      .finally(() => {
        clearTimeout(active.timer)
        if (this.active === active) this.active = null
      })
  }
}
