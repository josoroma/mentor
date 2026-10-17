import {
  ExplorePromptRefinementRequestSchema,
  ExplorePromptRefinementResponseSchema,
  type ExplorePromptRefinementOption,
  type ExplorePromptRefinementRequest,
} from '@/lib/explore/prompt-refinement'

export type ExplorePromptRefinementContext = {
  key: string
  request: ExplorePromptRefinementRequest
}

export type ExplorePromptRefinementSnapshot = {
  key: string | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  options: ExplorePromptRefinementOption[]
  error: string | null
}

export const createExplorePromptRefinementSnapshot = (
  key: string | null = null,
): ExplorePromptRefinementSnapshot => ({ key, status: 'idle', options: [], error: null })

export const createExplorePromptRefinementContext = (
  request: ExplorePromptRefinementRequest,
  contextKey: string,
): ExplorePromptRefinementContext | null => {
  const parsed = ExplorePromptRefinementRequestSchema.safeParse(request)
  if (!parsed.success) return null
  return {
    // Even an edit to whitespace invalidates the displayed choices, while the
    // actual request and response use the same trimmed prompt.
    key: JSON.stringify([contextKey, request.prompt, parsed.data]),
    request: parsed.data,
  }
}

const requestPromptRefinement = async (
  request: ExplorePromptRefinementRequest,
  signal: AbortSignal,
): Promise<unknown> => {
  const response = await fetch('/api/explore/refine-prompt', {
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
        : 'Your local AI could not refine this prompt. Please try again.',
    )
  }
  return data
}

type ActiveRequest = {
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
}

// Refinement produces temporary choices only. The caller must explicitly
// consume a current choice before sending it through the exploration flow.
export class ExplorePromptRefinementController {
  private context: ExplorePromptRefinementContext | null = null
  private enabled = false
  private disposed = false
  private active: ActiveRequest | null = null
  private snapshot = createExplorePromptRefinementSnapshot()
  private readonly onChange: (snapshot: ExplorePromptRefinementSnapshot) => void
  private readonly request: typeof requestPromptRefinement

  constructor({
    onChange,
    request = requestPromptRefinement,
  }: {
    onChange: (snapshot: ExplorePromptRefinementSnapshot) => void
    request?: typeof requestPromptRefinement
  }) {
    this.onChange = onChange
    this.request = request
  }

  update(context: ExplorePromptRefinementContext | null, enabled: boolean) {
    if (this.disposed) return
    const changed = context?.key !== this.context?.key || enabled !== this.enabled
    this.context = context
    this.enabled = enabled
    if (changed) this.clear()
  }

  clear() {
    this.abort()
    this.publish(createExplorePromptRefinementSnapshot(this.context?.key))
  }

  async refine() {
    const context = this.context
    if (this.disposed || !this.enabled || !context) return
    this.abort()
    const controller = new AbortController()
    const active: ActiveRequest = {
      controller,
      timer: setTimeout(() => {
        if (this.active !== active) return
        this.abort()
        this.publish({
          ...createExplorePromptRefinementSnapshot(context.key),
          status: 'error',
          error: 'Your local AI took too long to refine this prompt. Please try again.',
        })
      }, 95_000),
    }
    this.active = active
    this.publish({
      ...createExplorePromptRefinementSnapshot(context.key),
      status: 'loading',
    })

    try {
      const data = await this.request(context.request, controller.signal)
      if (this.active !== active || controller.signal.aborted) return
      const result = ExplorePromptRefinementResponseSchema.safeParse(data)
      if (!result.success) {
        throw new Error('Your local AI returned incomplete prompt options. Please try again.')
      }
      if (result.data.prompt !== context.request.prompt) {
        throw new Error('These options did not match your prompt. Please try again.')
      }
      this.publish({ key: context.key, status: 'ready', options: result.data.options, error: null })
    } catch (error) {
      if (this.active !== active || controller.signal.aborted) return
      this.publish({
        ...createExplorePromptRefinementSnapshot(context.key),
        status: 'error',
        error:
          error instanceof Error
            ? error.message
            : 'Your prompt could not be refined. Please try again.',
      })
    } finally {
      if (this.active === active) {
        clearTimeout(active.timer)
        this.active = null
      }
    }
  }

  choose(
    id: string,
    context: ExplorePromptRefinementContext | null,
    enabled: boolean,
    renderedSnapshot: ExplorePromptRefinementSnapshot,
  ): string | null {
    // Revalidate synchronously: a draft edit or navigation may have rendered
    // before the effect that cancels the previous request has run.
    this.update(context, enabled)
    if (
      this.disposed ||
      !this.enabled ||
      !context ||
      this.snapshot !== renderedSnapshot ||
      this.snapshot.key !== context.key ||
      this.snapshot.status !== 'ready'
    ) {
      return null
    }
    const selected = this.snapshot.options.find((option) => option.id === id)
    if (!selected) return null
    this.clear()
    return selected.prompt
  }

  dispose() {
    this.disposed = true
    this.abort()
  }

  private publish(snapshot: ExplorePromptRefinementSnapshot) {
    this.snapshot = snapshot
    if (!this.disposed) this.onChange(snapshot)
  }

  private abort() {
    if (!this.active) return
    const active = this.active
    this.active = null
    clearTimeout(active.timer)
    active.controller.abort()
  }
}
