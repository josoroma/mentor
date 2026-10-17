'use client'

const LOCK_NAME = 'mentor-learning-data'
const REVISION_KEY = 'mentor.learning-revision.v1'
const MAINTENANCE_KEY = 'mentor.learning-maintenance.v1'
const EVENT_NAME = 'mentor-learning-maintenance'

export type LearningMaintenanceEvent = {
  phase: 'start' | 'complete'
  changed: boolean
  external: boolean
  changesData: boolean
}

let maintenancePending = false
let observedRevision: string | undefined
const operations = new Set<Promise<unknown>>()

const storage = (): Storage | undefined =>
  typeof window === 'undefined' ? undefined : window.localStorage

const revision = (): string => storage()?.getItem(REVISION_KEY) ?? 'initial'

type MaintenanceLease = { id: string; expiresAt: number; changesData: boolean }

const parseLease = (value: string | null): MaintenanceLease | null => {
  if (!value) return null
  try {
    const lease = JSON.parse(value) as Partial<MaintenanceLease>
    return typeof lease.id === 'string' &&
      typeof lease.expiresAt === 'number' &&
      typeof lease.changesData === 'boolean'
      ? (lease as MaintenanceLease)
      : null
  } catch {
    return null
  }
}

const activeLease = (): MaintenanceLease | null => {
  const raw = storage()?.getItem(MAINTENANCE_KEY) ?? null
  const lease = parseLease(raw)
  if (lease && lease.expiresAt > Date.now()) return lease
  // A crashed/closed tab stops renewing its lease. Never clear a live owner's marker.
  const latest = storage()?.getItem(MAINTENANCE_KEY) ?? null
  if (latest !== raw) {
    const newerLease = parseLease(latest)
    return newerLease && newerLease.expiresAt > Date.now() ? newerLease : null
  }
  if (raw) storage()?.removeItem(MAINTENANCE_KEY)
  return null
}

const notify = (event: LearningMaintenanceEvent): void => {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function')
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: event }))
}

export const assertLearningWriteAllowed = (): void => {
  const current = revision()
  observedRevision ??= current
  if (maintenancePending || activeLease())
    throw new Error(
      'Learning data maintenance is in progress. If its tab closed, wait one minute and retry.',
    )
  if (observedRevision !== current)
    throw new Error('Your learning data changed in another tab. Refresh Mentor before saving.')
}

export const acknowledgeLearningRevision = (): void => {
  observedRevision = revision()
}

export const subscribeLearningMaintenance = (
  listener: (event: LearningMaintenanceEvent) => void,
): (() => void) => {
  observedRevision ??= revision()
  const handleLocal = (event: Event) =>
    listener((event as CustomEvent<LearningMaintenanceEvent>).detail)
  const handleStorage = (event: StorageEvent) => {
    if (event.key === MAINTENANCE_KEY)
      listener({
        phase: event.newValue ? 'start' : 'complete',
        changed: !event.newValue && observedRevision !== revision(),
        external: true,
        changesData: parseLease(event.newValue ?? event.oldValue)?.changesData ?? true,
      })
  }
  window.addEventListener(EVENT_NAME, handleLocal)
  window.addEventListener('storage', handleStorage)
  return () => {
    window.removeEventListener(EVENT_NAME, handleLocal)
    window.removeEventListener('storage', handleStorage)
  }
}

const withLock = async <T>(mode: 'shared' | 'exclusive', action: () => Promise<T>): Promise<T> => {
  if (typeof navigator !== 'undefined' && navigator.locks)
    return navigator.locks.request(LOCK_NAME, { mode }, action)
  return action()
}

// Shared browser locks let ordinary autosaves remain concurrent while an export or reset
// waits for every earlier load/save, including operations in another Mentor tab.
export const runLearningOperation = <T>(action: () => Promise<T>): Promise<T> => {
  try {
    assertLearningWriteAllowed()
  } catch (error) {
    return Promise.reject(error)
  }
  const startedRevision = revision()
  const operation = withLock('shared', async () => {
    if (startedRevision !== revision())
      throw new Error('Learning data changed before this save started. Refresh Mentor and retry.')
    return action()
  })
  operations.add(operation)
  void operation.then(
    () => operations.delete(operation),
    () => operations.delete(operation),
  )
  return operation
}

export const runLearningMaintenance = async <T>(
  action: () => Promise<T>,
  options: { changesData: boolean },
): Promise<T> => {
  assertLearningWriteAllowed()
  const startedRevision = revision()
  maintenancePending = true
  let changed = false
  let ownsMarker = false
  const leaseId = crypto.randomUUID()
  let heartbeat: ReturnType<typeof setInterval> | undefined
  try {
    // The marker blocks synchronous recovery-cache writes, which cannot take a Web Lock.
    const renewLease = () =>
      storage()?.setItem(
        MAINTENANCE_KEY,
        JSON.stringify({
          id: leaseId,
          expiresAt: Date.now() + 60_000,
          changesData: options.changesData,
        }),
      )
    renewLease()
    ownsMarker = true
    heartbeat = setInterval(() => {
      if (parseLease(storage()?.getItem(MAINTENANCE_KEY) ?? null)?.id === leaseId) renewLease()
    }, 5_000)
    notify({ phase: 'start', changed: false, external: false, changesData: options.changesData })
    await Promise.allSettled([...operations])
    return await withLock('exclusive', async () => {
      if (startedRevision !== revision())
        throw new Error('Your learning data changed while waiting. Refresh Mentor and retry.')
      const currentLease = activeLease()
      if (currentLease && currentLease.id !== leaseId)
        throw new Error('Another Mentor tab started maintenance. Wait for it to finish and retry.')
      renewLease()
      const result = await action()
      if (options.changesData) {
        const nextRevision = crypto.randomUUID()
        storage()?.setItem(REVISION_KEY, nextRevision)
        observedRevision = nextRevision
        changed = true
      }
      return result
    })
  } finally {
    clearInterval(heartbeat)
    if (ownsMarker && parseLease(storage()?.getItem(MAINTENANCE_KEY) ?? null)?.id === leaseId)
      storage()?.removeItem(MAINTENANCE_KEY)
    maintenancePending = false
    notify({ phase: 'complete', changed, external: false, changesData: options.changesData })
  }
}
