import type { TranscriptImprovement, TranscriptMessage } from '@/app/_types'

export type PendingImprovement = {
  messageId: string
  original: string
  text: string
  status: 'waiting' | 'streaming' | 'error'
  error?: string
}

export type ImprovementSnapshot = {
  improvements: TranscriptImprovement[]
  pending: PendingImprovement | null
  failures: PendingImprovement[]
}

type ImprovementJob = { message: TranscriptMessage; isFinal: boolean }
type QueueOptions = {
  request: (
    message: TranscriptMessage,
    context: TranscriptMessage[],
    signal: AbortSignal,
    onText: (text: string) => void,
  ) => Promise<string>
  onChange: (snapshot: ImprovementSnapshot) => void
  debounceMs?: number
}

// One correction at a time. Coach inference takes priority; audio can play while editing.
export class LiveImprovementQueue {
  private messages: TranscriptMessage[] = []
  private interim: TranscriptMessage | null = null
  private busy = false
  private disposed = false
  private finalizing = false
  private records: TranscriptImprovement[] = []
  private pending: PendingImprovement | null = null
  private failed = new Map<string, PendingImprovement>()
  private active: { controller: AbortController; promise: Promise<void> } | null = null
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: QueueOptions) {}

  private signature(job: ImprovementJob) {
    return JSON.stringify([job.message.id, job.message.content, job.isFinal])
  }

  private emit() {
    if (!this.disposed)
      this.options.onChange({
        improvements: [...this.records],
        pending: this.pending,
        failures: [...this.failed.values()],
      })
  }

  private source(id: string) {
    return (
      this.messages.find((message) => message.id === id && message.role === 'user') ??
      (this.interim?.id === id ? this.interim : undefined)
    )
  }

  private discardStaleFailures() {
    let changed = false
    for (const [signature, failure] of this.failed) {
      if (this.source(failure.messageId)?.content !== failure.original) {
        this.failed.delete(signature)
        changed = true
      }
    }
    return changed
  }

  private nextJob(): ImprovementJob | undefined {
    const jobs: ImprovementJob[] = this.messages
      .filter((message) => message.role === 'user')
      .map((message) => ({ message, isFinal: true }))
    if (this.interim && !jobs.some(({ message }) => message.id === this.interim?.id)) {
      jobs.push({ message: this.interim, isFinal: false })
    }
    return jobs.find((job) => {
      if (this.failed.has(this.signature(job))) return false
      return !this.records.some(
        (record) =>
          record.messageId === job.message.id &&
          record.original === job.message.content &&
          (!job.isFinal || record.isFinal),
      )
    })
  }

  update(messages: TranscriptMessage[], interim: TranscriptMessage | null, busy: boolean) {
    if (this.disposed || this.finalizing) return
    this.messages = messages
    this.interim = interim
    this.busy = busy
    let changed = this.discardStaleFailures()
    if (this.pending && this.source(this.pending.messageId)?.content !== this.pending.original) {
      this.pending = null
      changed = true
    }
    let promoted = false
    this.records = this.records.map((record) => {
      if (
        !record.isFinal &&
        messages.some(
          (message) =>
            message.role === 'user' &&
            message.id === record.messageId &&
            message.content === record.original,
        )
      ) {
        promoted = true
        return { ...record, isFinal: true, updatedAt: new Date().toISOString() }
      }
      return record
    })
    if (busy) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.active?.controller.abort()
      if (this.pending) {
        this.pending = null
        changed = true
      }
    }
    if (promoted || changed) this.emit()
    this.schedule()
  }

  private schedule() {
    if (
      this.disposed ||
      this.busy ||
      this.finalizing ||
      this.active ||
      this.timer ||
      !this.nextJob()
    )
      return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.pump()
    }, this.options.debounceMs ?? 450)
  }

  private async pump() {
    if (this.disposed || this.busy || this.active) return
    const job = this.nextJob()
    if (!job) return
    const controller = new AbortController()
    // A finalized turn can retry a failed interim draft. Its active attempt
    // replaces that draft's error while failures for other turns stay visible.
    for (const [signature, failure] of this.failed) {
      if (failure.messageId === job.message.id) this.failed.delete(signature)
    }
    this.pending = {
      messageId: job.message.id,
      original: job.message.content,
      text: '',
      status: 'waiting',
    }
    this.emit()
    const promise = this.run(job, controller)
    this.active = { controller, promise }
    await promise
    if (this.active?.controller === controller) this.active = null
    this.schedule()
  }

  private async run(job: ImprovementJob, controller: AbortController) {
    try {
      const index = this.messages.findIndex((message) => message.id === job.message.id)
      const context = (index >= 0 ? this.messages.slice(0, index) : this.messages).slice(-6)
      const improved = (
        await this.options.request(job.message, context, controller.signal, (text) => {
          if (
            controller.signal.aborted ||
            this.disposed ||
            this.source(job.message.id)?.content !== job.message.content
          )
            return
          this.pending = {
            messageId: job.message.id,
            original: job.message.content,
            text,
            status: 'streaming',
          }
          this.emit()
        })
      ).trim()
      if (controller.signal.aborted || this.disposed) return
      if (!improved) throw new Error('No improved wording was returned. Try again.')
      // A slower draft must never replace a newer recognition result.
      if (this.source(job.message.id)?.content !== job.message.content) {
        this.pending = null
        this.emit()
        return
      }
      const isFinal = this.messages.some((message) => message.id === job.message.id)
      this.records = [
        ...this.records.filter((record) => record.messageId !== job.message.id),
        {
          messageId: job.message.id,
          original: job.message.content,
          improved,
          isFinal,
          updatedAt: new Date().toISOString(),
        },
      ]
      this.pending = null
      this.emit()
    } catch (error) {
      if (
        controller.signal.aborted ||
        this.disposed ||
        this.source(job.message.id)?.content !== job.message.content
      ) {
        this.pending = null
      } else {
        this.pending = {
          messageId: job.message.id,
          original: job.message.content,
          text: '',
          status: 'error',
          error:
            error instanceof Error ? error.message : 'Improved wording is unavailable. Try again.',
        }
        this.failed.set(this.signature(job), this.pending)
      }
      this.emit()
    }
  }

  retry() {
    this.failed.clear()
    this.pending = null
    this.emit()
    this.schedule()
  }

  async finish(messages: TranscriptMessage[]): Promise<TranscriptImprovement[]> {
    this.finalizing = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.messages = messages
    this.interim = null
    this.busy = false
    const failuresChanged = this.discardStaleFailures()
    if (this.pending && this.source(this.pending.messageId)?.content !== this.pending.original)
      this.pending = null
    if (failuresChanged) this.emit()
    this.records = this.records.map((record) =>
      messages.some(
        (message) =>
          message.role === 'user' &&
          message.id === record.messageId &&
          message.content === record.original,
      )
        ? { ...record, isFinal: true }
        : record,
    )
    this.active?.controller.abort()
    // Finishing a session is bounded; originals remain saved if correction cannot finish.
    let timeout: ReturnType<typeof setTimeout>
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        this.busy = true
        this.active?.controller.abort()
        resolve()
      }, 25_000)
    })
    try {
      await Promise.race([this.active?.promise ?? Promise.resolve(), deadline])
      this.active = null
      while (!this.disposed && !this.busy && this.nextJob()) {
        await Promise.race([this.pump(), deadline])
      }
      return this.records
        .filter((record) =>
          messages.some(
            (message) =>
              message.role === 'user' &&
              message.id === record.messageId &&
              message.content === record.original,
          ),
        )
        .map((record) => ({ ...record, isFinal: true }))
    } finally {
      clearTimeout(timeout!)
    }
  }

  dispose() {
    this.disposed = true
    clearTimeout(this.timer)
    this.active?.controller.abort()
    this.failed.clear()
    this.pending = null
  }
}
