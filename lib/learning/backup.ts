'use client'

import { z } from 'zod'

import { ExploreBackupSchema } from '@/lib/explore/schema'
import { readExploreBackup, restoreExploreBackup } from '@/lib/explore/backup'
import { defaultProfile, scenarios as defaultScenarios } from '@/app/_constants'
import { ProfileSchema, ScenarioSchema, SessionRecordSchema } from '@/app/_schema'
import type { Profile } from '@/app/_types'
import { runLearningMaintenance } from '@/lib/learning/maintenance'
import { syncLearningData, type PersistenceResult } from '@/lib/learning/persistence'
import { readSessionDatabase, replaceSessionDatabase } from '@/lib/learning/session-database'
import {
  mergeSessions,
  mergeScenarioConfigurations,
  STORAGE_KEYS,
  writeStored,
  type LearningData,
} from '@/lib/learning/storage'
import {
  getAuthenticatedClient,
  getExistingAuthenticatedClient,
  isLocalSupabaseConfigured,
  isSupabaseConfigured,
} from '@/lib/supabase/client'
import { readRemoteLearningBackup, resetRemoteLearningData } from '@/lib/supabase/backup'
import { readRemoteScenarioBookmarks } from '@/lib/supabase/bookmarks'
import {
  mergeScenarioBookmarks,
  SCENARIO_BOOKMARKS_KEY,
  ScenarioBookmarkSchema,
} from '@/lib/learning/bookmarks'

export const MAX_LEARNING_BACKUP_BYTES = 25 * 1_024 * 1_024

export const LearningBackupSchema = z
  .object({
    app: z.literal('mentor'),
    version: z.literal(1),
    exportedAt: z.string().datetime(),
    data: z
      .object({
        profile: ProfileSchema,
        sessions: SessionRecordSchema.array(),
        scenarios: ScenarioSchema.array().min(1),
        bookmarks: ScenarioBookmarkSchema.array().optional(),
        explore: ExploreBackupSchema.optional(),
      })
      .strict(),
  })
  .strict()

export type LearningBackup = z.infer<typeof LearningBackupSchema>

const rawStored = (key: string): string | null => {
  if (typeof window === 'undefined') throw new Error('Open Mentor in a browser to manage backups.')
  return window.localStorage.getItem(key)
}

const readStrictValue = <T>(key: string, schema: z.ZodType<T>, fallback: T): T => {
  const raw = rawStored(key)
  if (raw === null) return fallback
  try {
    return schema.parse(JSON.parse(raw))
  } catch {
    throw new Error('Some saved learning data is unreadable. Resolve it before creating a backup.')
  }
}

const readDeviceSnapshot = async (): Promise<LearningData> => ({
  profile: readStrictValue(STORAGE_KEYS.profile, ProfileSchema, { ...defaultProfile }),
  sessions: mergeSessions(
    readStrictValue(STORAGE_KEYS.sessions, SessionRecordSchema.array(), []),
    await readSessionDatabase({ strict: true }),
  ),
  scenarios: mergeScenarioConfigurations(
    readStrictValue(STORAGE_KEYS.scenarios, ScenarioSchema.array().min(1), defaultScenarios),
    readStrictValue(STORAGE_KEYS.scenarioOverrides, ScenarioSchema.array(), []),
  ),
  bookmarks: readStrictValue(SCENARIO_BOOKMARKS_KEY, ScenarioBookmarkSchema.array(), []),
})

const hasRemoteData = (profile: Profile): boolean =>
  isLocalSupabaseConfigured() || (isSupabaseConfigured() && !profile.localOnly)

const readCompleteSnapshot = async (): Promise<LearningData> => {
  const device = await readDeviceSnapshot()
  if (!hasRemoteData(device.profile)) return device
  const identity = await getExistingAuthenticatedClient()
  if (!identity) return device
  const [remote, bookmarks, explore] = await Promise.all([
    readRemoteLearningBackup(identity.client, identity.userId),
    readRemoteScenarioBookmarks(identity.client, identity.userId),
    readExploreBackup(identity.client, identity.userId),
  ])
  return {
    profile:
      rawStored(STORAGE_KEYS.profile) === null && remote.profile
        ? { ...remote.profile, localOnly: device.profile.localOnly }
        : device.profile,
    sessions: mergeSessions(remote.sessions, device.sessions),
    bookmarks: mergeScenarioBookmarks(bookmarks, device.bookmarks ?? []),
    explore,
    scenarios:
      rawStored(STORAGE_KEYS.scenarios) !== null
        ? mergeScenarioConfigurations(remote.scenarios, device.scenarios)
        : remote.scenarios.length > 0
          ? remote.scenarios
          : device.scenarios,
  }
}

const checkBackupSize = (text: string): void => {
  if (new TextEncoder().encode(text).byteLength > MAX_LEARNING_BACKUP_BYTES)
    throw new Error('This backup exceeds the 25 MB limit. No learning data was changed.')
}

export const parseLearningBackup = (text: string): LearningBackup => {
  checkBackupSize(text)
  try {
    return LearningBackupSchema.parse(JSON.parse(text))
  } catch {
    throw new Error(
      'This file is not a valid Mentor version 1 backup. No learning data was changed.',
    )
  }
}

export const createLearningBackup = (): Promise<LearningBackup> =>
  runLearningMaintenance(
    async () => {
      const backup = LearningBackupSchema.parse({
        app: 'mentor',
        version: 1,
        exportedAt: new Date().toISOString(),
        data: await readCompleteSnapshot(),
      })
      // The pretty-printed download must be accepted by the same importer.
      checkBackupSize(JSON.stringify(backup, null, 2))
      return backup
    },
    { changesData: false },
  )

const replaceDeviceSnapshot = async (data: LearningData, reset: boolean): Promise<void> => {
  const keys = [
    ...Object.values(STORAGE_KEYS),
    SCENARIO_BOOKMARKS_KEY,
    'mentor.demo-topics.v1',
    'mentor.storytelling-titles.v1',
  ]
  const previous = new Map(keys.map((key) => [key, rawStored(key)]))
  try {
    await replaceSessionDatabase(data.sessions, () => {
      if (reset) {
        for (const key of keys) window.localStorage.removeItem(key)
      } else {
        writeStored(STORAGE_KEYS.profile, data.profile)
        writeStored(STORAGE_KEYS.sessions, data.sessions)
        writeStored(STORAGE_KEYS.scenarios, data.scenarios)
        writeStored(STORAGE_KEYS.scenarioOverrides, data.scenarios)
        writeStored(SCENARIO_BOOKMARKS_KEY, data.bookmarks ?? [])
        writeStored(STORAGE_KEYS.selectedRole, data.profile.roleId)
        window.localStorage.removeItem(STORAGE_KEYS.selectedScenario)
      }
    })
  } catch (error) {
    // A rejected IndexedDB transaction retains its previous rows. Restore the
    // synchronous recovery copy too if any cache operation failed partway through.
    try {
      for (const [key, value] of previous) {
        if (value === null) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, value)
      }
    } catch {
      throw new Error('Browser storage failed during maintenance. Keep your backup and retry.')
    }
    throw error
  }
}

export const resetLearningData = (): Promise<LearningData> =>
  runLearningMaintenance(
    async () => {
      // Verify the authoritative local database before changing a remote copy.
      const current = await readDeviceSnapshot()
      let databaseReset = false
      if (hasRemoteData(current.profile)) {
        const identity = await getExistingAuthenticatedClient()
        if (identity) {
          await resetRemoteLearningData(identity.client)
          databaseReset = true
        }
      }
      const data: LearningData = {
        profile: { ...defaultProfile },
        sessions: [],
        scenarios: defaultScenarios,
        bookmarks: [],
      }
      try {
        await replaceDeviceSnapshot(data, true)
      } catch (error) {
        if (databaseReset)
          throw new Error(
            'Database learning data was reset, but browser storage could not finish the reset. Your on-device recovery copy was retained; retry the reset.',
            { cause: error },
          )
        throw error
      }
      return data
    },
    { changesData: true },
  )

export const restoreLearningBackup = async (
  value: LearningBackup,
): Promise<PersistenceResult<LearningData>> => {
  // Validate even callers that bypass the file parser, before taking a lock or writing.
  const backup = LearningBackupSchema.parse(value)
  checkBackupSize(JSON.stringify(backup, null, 2))
  let remoteReadError: unknown
  const data = await runLearningMaintenance(
    async () => {
      const device = await readDeviceSnapshot()
      let current = device
      try {
        current = await readCompleteSnapshot()
      } catch (error) {
        // The device read already succeeded. An unavailable remote service must not
        // prevent a local recovery, but do not upload over an unread remote history.
        remoteReadError = error
      }
      let restoredExplore = current.explore
      if (backup.data.explore?.sessions.length) {
        if (!hasRemoteData(device.profile))
          throw new Error(
            'Explorations need your learning database. Start the local database or enable account sync, then restore this backup again. No learning data was changed.',
          )
        if (remoteReadError)
          throw new Error(
            'The exploration database is unavailable. Keep this backup and retry when it reconnects. No learning data was changed.',
            { cause: remoteReadError },
          )
        const identity = await getAuthenticatedClient()
        // The RPC merges all exploration records atomically and returns the complete
        // merged snapshot. An error cannot leave half an artifact or revision behind.
        restoredExplore = await restoreExploreBackup(
          identity.client,
          identity.userId,
          backup.data.explore,
        )
      }
      const restored: LearningData = {
        profile: { ...backup.data.profile, localOnly: device.profile.localOnly },
        sessions: mergeSessions(backup.data.sessions, current.sessions),
        scenarios: mergeScenarioConfigurations(current.scenarios, backup.data.scenarios),
        bookmarks: mergeScenarioBookmarks(backup.data.bookmarks ?? [], current.bookmarks ?? []),
        ...(restoredExplore ? { explore: restoredExplore } : {}),
      }
      try {
        await replaceDeviceSnapshot(restored, false)
      } catch (error) {
        if (backup.data.explore?.sessions.length)
          throw new Error(
            'Your explorations were merged into the database, but browser storage could not restore the remaining learning data. Your previous browser data was retained. Keep the backup and retry.',
            { cause: error },
          )
        throw error
      }
      return restored
    },
    { changesData: true },
  )
  if (remoteReadError)
    return {
      data,
      mode: 'local',
      syncStatus: 'error',
      error:
        'Your backup was restored on this device. Database sync is unavailable; retry sync when it reconnects.',
    }
  if (!hasRemoteData(data.profile)) return { data, mode: 'local', syncStatus: 'local' }
  const result = await syncLearningData()
  const synced = {
    ...result,
    data: { ...result.data, ...(data.explore ? { explore: data.explore } : {}) },
  }
  return synced.syncStatus === 'error'
    ? {
        ...synced,
        error: `Your backup was restored on this device. ${synced.error ?? 'Database sync failed; retry sync.'}`,
      }
    : synced
}
