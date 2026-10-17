'use client'

import { runLearningOperation } from '@/lib/learning/maintenance'
import { loadScenarioBookmarks } from '@/lib/learning/bookmarks'
import { notifySpeechProviderChange } from '@/lib/audio/speech-preference'
import { applyProfileLearningSelection } from '@/lib/learning/paths'

import { ProfileSchema, ScenarioSchema, SessionRecordSchema } from '@/app/_schema'
import type { Profile, Scenario, SessionRecord, SyncStatus } from '@/app/_types'
import {
  cacheLearningSession,
  mergeSessions,
  mergeScenarioConfigurations,
  normalizeSessions,
  readLearningData,
  readScenarioOverrides,
  STORAGE_KEYS,
  writeStored,
  type LearningData,
} from '@/lib/learning/storage'
import { readSessionDatabase, writeSessionDatabase } from '@/lib/learning/session-database'
import {
  getAuthenticatedClient,
  isLocalSupabaseConfigured,
  isSupabaseConfigured,
} from '@/lib/supabase/client'

export { readLearningData } from '@/lib/learning/storage'

export type PersistenceResult<T> = {
  data: T
  mode: 'local' | 'supabase'
  syncStatus: SyncStatus
  error?: string
}

const localResult = <T>(data: T): PersistenceResult<T> => ({
  data,
  mode: 'local',
  syncStatus: 'local',
})
const failedResult = <T>(data: T, error: unknown): PersistenceResult<T> => ({
  data,
  mode: 'local',
  syncStatus: 'error',
  error:
    error instanceof Error
      ? error.message
      : 'Cloud sync failed. Your data is saved on this device.',
})

const canSyncProfile = (profile: Profile): boolean =>
  isLocalSupabaseConfigured() || !profile.localOnly

export const getStorageMode = (): 'local' | 'supabase' =>
  canSyncProfile(readLearningData().profile) && isSupabaseConfigured() ? 'supabase' : 'local'

const saveLearningProfileInternal = async (value: Profile): Promise<PersistenceResult<Profile>> => {
  const profile = ProfileSchema.parse(value)
  writeStored(STORAGE_KEYS.profile, profile)
  notifySpeechProviderChange()
  if (!canSyncProfile(profile)) return localResult(profile)
  try {
    const { client, userId } = await getAuthenticatedClient()
    const currentProfile = readLearningData().profile
    if (!canSyncProfile(currentProfile)) return localResult(currentProfile)
    const { error } = await client
      .from('learning_profiles')
      .upsert({ user_id: userId, profile: currentProfile, updated_at: new Date().toISOString() })
    if (error) throw error
    const latestProfile = readLearningData().profile
    return !canSyncProfile(latestProfile)
      ? localResult(latestProfile)
      : { data: latestProfile, mode: 'supabase', syncStatus: 'synced' }
  } catch (error) {
    return failedResult(readLearningData().profile, error)
  }
}

const saveLearningSessionInternal = async (
  value: SessionRecord,
  options: { sync?: boolean } = {},
): Promise<PersistenceResult<SessionRecord>> => {
  let session = SessionRecordSchema.parse(value)
  let cacheError: unknown
  try {
    cacheLearningSession(session)
  } catch (error) {
    cacheError = error
  }
  let databaseError: unknown
  try {
    session = await writeSessionDatabase(session)
    // The transaction may have recovered a newer version than the synchronous cache.
    try {
      cacheLearningSession(session)
    } catch {
      // IndexedDB remains authoritative if the smaller localStorage quota is exhausted.
    }
  } catch (error) {
    databaseError = error
    if (cacheError) throw cacheError
  }
  const local = readLearningData()
  // The current persisted preference is authoritative, even if a caller captured stale UI state.
  if (!canSyncProfile(local.profile) || options.sync === false)
    return databaseError
      ? failedResult(
          session,
          new Error(
            'Database save failed. A recovery copy is saved in this browser. Retry to save to the database.',
          ),
        )
      : localResult(session)
  return queueSessionSync(session, databaseError)
}

const pendingSessionSyncs = new Map<string, Promise<PersistenceResult<SessionRecord>>>()

const queueSessionSync = (
  session: SessionRecord,
  databaseError: unknown,
): Promise<PersistenceResult<SessionRecord>> => {
  const previous = pendingSessionSyncs.get(session.id)
  const next = (previous ?? Promise.resolve()).then(() =>
    syncLearningSession(session, databaseError),
  )
  pendingSessionSyncs.set(session.id, next)
  void next.finally(() => {
    if (pendingSessionSyncs.get(session.id) === next) pendingSessionSyncs.delete(session.id)
  })
  return next
}

const syncLearningSession = async (
  value: SessionRecord,
  databaseError: unknown,
): Promise<PersistenceResult<SessionRecord>> => {
  let session = value
  try {
    if (!canSyncProfile(readLearningData().profile))
      return databaseError ? failedResult(session, databaseError) : localResult(session)
    const { client, userId } = await getAuthenticatedClient()
    const current = readLearningData()
    if (!canSyncProfile(current.profile))
      return databaseError ? failedResult(session, databaseError) : localResult(session)
    // An older network request must never overwrite a later completed session.
    session = mergeSessions(
      [session],
      current.sessions.filter((item) => item.id === session.id),
    )[0]
    const { error } = await client.from('learning_sessions').upsert(
      {
        id: session.id,
        user_id: userId,
        scenario_id: session.scenarioId,
        started_at: session.startedAt,
        session,
        updated_at: session.updatedAt ?? new Date().toISOString(),
      },
      { onConflict: 'user_id,id' },
    )
    if (error) throw error
    if (!canSyncProfile(readLearningData().profile)) return localResult(session)
    return { data: session, mode: 'supabase', syncStatus: 'synced' }
  } catch (error) {
    return failedResult(session, error)
  }
}

const loadDeviceData = async (): Promise<PersistenceResult<LearningData>> => {
  try {
    const records = await readSessionDatabase()
    const current = readLearningData()
    const restored = mergeSessions(records, current.sessions)
    // Import the recovery cache and legacy sessions into the database as part of restoration.
    await Promise.all(restored.map(writeSessionDatabase))
    const latestRecords = await readSessionDatabase()
    const latestLocal = readLearningData()
    const data = { ...latestLocal, sessions: mergeSessions(latestRecords, latestLocal.sessions) }
    try {
      writeStored(STORAGE_KEYS.sessions, data.sessions)
    } catch {
      // The database can recover sessions even when localStorage is unavailable or full.
    }
    return localResult(data)
  } catch (error) {
    return failedResult(readLearningData(), error)
  }
}

const loadLearningDataInternal = async (
  options: { sync: boolean } = { sync: false },
): Promise<PersistenceResult<LearningData>> => {
  const device = await loadDeviceData()
  const local = device.data
  if (!options.sync || !canSyncProfile(local.profile)) return device
  try {
    const { client, userId } = await getAuthenticatedClient()
    const beforeFetch = readLearningData()
    if (!canSyncProfile(beforeFetch.profile)) return localResult(beforeFetch)
    const [profileResult, sessionsResult, scenariosResult] = await Promise.all([
      client.from('learning_profiles').select('profile').eq('user_id', userId).maybeSingle(),
      client
        .from('learning_sessions')
        .select('session')
        .eq('user_id', userId)
        .order('started_at', { ascending: false })
        .limit(1_000),
      client.from('scenario_configs').select('configuration').order('sort_order'),
    ])
    for (const result of [profileResult, sessionsResult, scenariosResult]) {
      if (result.error) throw result.error
    }
    // Network requests can overlap a completed session or a privacy preference change.
    // Never replace fresh local work with the snapshot captured before the request.
    const latestLocal = (await loadDeviceData()).data
    if (!canSyncProfile(latestLocal.profile)) return localResult(latestLocal)
    const remoteProfile = ProfileSchema.safeParse(profileResult.data?.profile)
    const remoteScenarios = ScenarioSchema.array().safeParse(
      scenariosResult.data?.map((row) => row.configuration),
    )
    const profileChangedLocally =
      JSON.stringify(latestLocal.profile) !== JSON.stringify(local.profile)
    const mergedProfile =
      remoteProfile.success && !profileChangedLocally
        ? {
            ...remoteProfile.data,
            localOnly: latestLocal.profile.localOnly,
            // Preferences saved on this device survive an older remote profile after sync errors.
            ...(latestLocal.profile.speechProvider && {
              speechProvider: latestLocal.profile.speechProvider,
            }),
            ...(latestLocal.profile.learningSelection && {
              learningSelection: latestLocal.profile.learningSelection,
            }),
          }
        : latestLocal.profile
    const data: LearningData = {
      profile: mergedProfile.learningSelection
        ? applyProfileLearningSelection(mergedProfile, mergedProfile.learningSelection)
        : mergedProfile,
      sessions: mergeSessions(
        normalizeSessions(sessionsResult.data?.map((row) => row.session)),
        latestLocal.sessions,
      ),
      scenarios: mergeScenarioConfigurations(
        remoteScenarios.success && remoteScenarios.data.length > 0
          ? remoteScenarios.data
          : latestLocal.scenarios,
        readScenarioOverrides(),
      ),
    }
    writeStored(STORAGE_KEYS.profile, data.profile)
    writeStored(STORAGE_KEYS.sessions, data.sessions)
    writeStored(STORAGE_KEYS.scenarios, data.scenarios)
    await Promise.all(data.sessions.map(writeSessionDatabase))
    return { data, mode: 'supabase', syncStatus: 'synced' }
  } catch (error) {
    return failedResult(readLearningData(), error)
  }
}

const syncLearningDataInternal = async (): Promise<PersistenceResult<LearningData>> => {
  const device = await loadDeviceData()
  const local = device.data
  if (!canSyncProfile(local.profile)) return device
  try {
    const { client, userId } = await getAuthenticatedClient()
    const latest = readLearningData()
    if (!canSyncProfile(latest.profile)) return localResult(latest)
    const profileResult = await client
      .from('learning_profiles')
      .upsert({ user_id: userId, profile: latest.profile, updated_at: new Date().toISOString() })
    if (profileResult.error) throw profileResult.error
    const afterProfile = readLearningData()
    if (!canSyncProfile(afterProfile.profile)) return localResult(afterProfile)
    const results = await Promise.all(
      afterProfile.sessions.map((session) => queueSessionSync(session, undefined)),
    )
    const failed = results.find((result) => result.error)
    if (failed) throw new Error(failed.error)
    return loadLearningDataInternal({ sync: true })
  } catch (error) {
    return failedResult(readLearningData(), error)
  }
}

export const getConfiguredScenarios = (): Scenario[] => readLearningData().scenarios

// Entry points participate in the maintenance barrier; internal calls do not acquire
// another lock, so a queued exclusive reset cannot deadlock an in-flight sync.
export const saveLearningProfile = (value: Profile): Promise<PersistenceResult<Profile>> =>
  runLearningOperation(() => saveLearningProfileInternal(value))

export const saveLearningSession = (
  value: SessionRecord,
  options: { sync?: boolean } = {},
): Promise<PersistenceResult<SessionRecord>> =>
  runLearningOperation(() => saveLearningSessionInternal(value, options))

export const loadLearningData = (
  options: { sync: boolean } = { sync: false },
): Promise<PersistenceResult<LearningData>> =>
  runLearningOperation(() => loadLearningDataInternal(options))

export const syncLearningData = async (): Promise<PersistenceResult<LearningData>> => {
  const result = await runLearningOperation(syncLearningDataInternal)
  const bookmarks = await loadScenarioBookmarks({ sync: true })
  return {
    ...result,
    data: { ...result.data, bookmarks: bookmarks.data },
    ...(bookmarks.error && { syncStatus: 'error' as const, error: bookmarks.error }),
  }
}
