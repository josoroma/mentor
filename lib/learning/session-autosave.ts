import type { SessionRecord } from '@/app/_types'
import type { PersistenceResult } from '@/lib/learning/persistence'
import { mergeSessions } from '@/lib/learning/storage'

export type AutosaveState = {
  status: 'idle' | 'saving' | 'saved' | 'error'
  destination: 'device' | 'supabase'
  error: string | null
}

type AutosaveOptions = {
  save: (session: SessionRecord) => Promise<PersistenceResult<SessionRecord>>
  cache: (session: SessionRecord) => void
  onChange: (state: AutosaveState) => void
  destination: AutosaveState['destination']
}

// A single writer coalesces rapid transcript updates and keeps final writes behind pending writes.
export const createSessionAutosave = ({ save, cache, onChange, destination }: AutosaveOptions) => {
  let latest: SessionRecord | null = null
  let queued = false
  let active: Promise<boolean> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let retryDelay = 2_000
  let lastSuccessful = true

  const notify = (state: AutosaveState) => {
    if (!disposed) onChange(state)
  }
  const schedule = (delay: number) => {
    if (disposed || timer || active) return
    timer = setTimeout(() => {
      timer = undefined
      void run()
    }, delay)
  }

  const run = (): Promise<boolean> => {
    clearTimeout(timer)
    timer = undefined
    if (active) return active
    if (!queued || !latest) return Promise.resolve(lastSuccessful)
    const snapshot = latest
    queued = false
    notify({ status: 'saving', destination, error: null })
    active = save(snapshot)
      .then((result) => {
        if (result.syncStatus === 'error')
          throw new Error(result.error ?? 'Your session could not be saved. Please retry.')
        destination = result.mode === 'supabase' ? 'supabase' : 'device'
        lastSuccessful = true
        retryDelay = 2_000
        notify({ status: queued ? 'saving' : 'saved', destination, error: null })
        return true
      })
      .catch((error: unknown) => {
        queued = true
        lastSuccessful = false
        notify({
          status: 'error',
          destination,
          error:
            error instanceof Error
              ? error.message
              : 'Your session could not be saved. Please retry.',
        })
        return false
      })
      .finally(() => {
        active = null
        if (queued) {
          schedule(lastSuccessful ? 750 : retryDelay)
          if (!lastSuccessful) retryDelay = Math.min(retryDelay * 2, 30_000)
        }
      })
    return active
  }

  const update = (session: SessionRecord) => {
    latest = latest?.id === session.id ? mergeSessions([latest], [session])[0] : session
    queued = true
    try {
      cache(latest)
    } catch {
      // The database write is still attempted when localStorage is full or unavailable.
    }
    schedule(750)
  }

  const flush = async (session?: SessionRecord): Promise<boolean> => {
    if (session) update(session)
    if (active && !(await active)) return false
    while (queued) {
      if (!(await run())) return false
    }
    return lastSuccessful
  }

  return {
    update,
    flush,
    retry: () => {
      if (latest) queued = true
      void run()
    },
    dispose: () => {
      disposed = true
      clearTimeout(timer)
      timer = undefined
      // Best effort on navigation; each update already has a synchronous recovery copy.
      void flush()
    },
  }
}
