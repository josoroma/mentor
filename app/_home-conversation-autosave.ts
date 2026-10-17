import type { SessionRecord } from '@/app/_types'
import { createSessionAutosave, type AutosaveState } from '@/lib/learning/session-autosave'

type Writer = ReturnType<typeof createSessionAutosave>
type Options = Parameters<typeof createSessionAutosave>[0]

// Each transcript part keeps its own serialized writer. Starting a new exchange must
// never replace a previous part that is still waiting for its database or sync write.
export const createHomeConversationAutosave = (options: Options) => {
  const writers = new Map<string, { writer: Writer; signature: string; state: AutosaveState }>()
  let disposed = false
  let published = ''

  const notify = () => {
    if (disposed) return
    const states = [...writers.values()].map((entry) => entry.state)
    const failed = states.find((state) => state.status === 'error')
    const state: AutosaveState = {
      status: failed
        ? 'error'
        : states.some((state) => state.status === 'saving')
          ? 'saving'
          : states.length
            ? 'saved'
            : 'idle',
      destination: states.length
        ? states.every((state) => state.destination === 'supabase')
          ? 'supabase'
          : 'device'
        : options.destination,
      error: failed?.error ?? null,
    }
    const signature = JSON.stringify(state)
    if (published === signature) return
    published = signature
    options.onChange(state)
  }

  const update = (records: SessionRecord[]) => {
    if (disposed) return
    for (const record of records) {
      let entry = writers.get(record.id)
      if (!entry) {
        const writer = createSessionAutosave({
          ...options,
          onChange: (state) => {
            const current = writers.get(record.id)
            if (current) current.state = state
            notify()
          },
        })
        entry = {
          writer,
          signature: '',
          state: { status: 'idle', destination: options.destination, error: null },
        }
        writers.set(record.id, entry)
      }
      const signature = JSON.stringify(record)
      if (signature === entry.signature) continue
      entry.signature = signature
      entry.state = { ...entry.state, status: 'saving', error: null }
      entry.writer.update(record)
    }
    notify()
  }

  const flush = async () => {
    const results = await Promise.allSettled(
      [...writers.values()].map(({ writer }) => writer.flush()),
    )
    return results.every((result) => result.status === 'fulfilled' && result.value)
  }

  return {
    update,
    flush,
    retry: () => {
      for (const { writer } of writers.values()) writer.retry()
    },
    dispose: () => {
      disposed = true
      for (const { writer } of writers.values()) writer.dispose()
    },
  }
}
