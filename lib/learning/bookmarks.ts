import { z } from 'zod'
import { ProficiencyLevelSchema, ScenarioSchema } from '@/app/_schema'
import type { ProficiencyLevel, Scenario } from '@/app/_schema'
import { assertLearningWriteAllowed, runLearningOperation } from '@/lib/learning/maintenance'
import { parseStoredValue, readLearningData, writeStored } from '@/lib/learning/storage'
import {
  getAuthenticatedClient,
  isLocalSupabaseConfigured,
  isSupabaseConfigured,
} from '@/lib/supabase/client'

export const SCENARIO_BOOKMARKS_KEY = 'mentor.scenario-bookmarks.v1'

export const ScenarioBookmarkSchema = z
  .object({
    scenario: ScenarioSchema,
    level: ProficiencyLevelSchema,
    savedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    saved: z.boolean(),
  })
  .refine((record) => Date.parse(record.updatedAt) >= Date.parse(record.savedAt), {
    message: 'A bookmark cannot be updated before it was saved.',
  })

export type ScenarioBookmark = z.infer<typeof ScenarioBookmarkSchema>
export type ScenarioBookmarksResult = { data: ScenarioBookmark[]; error?: string }

export const mergeScenarioBookmarks = (
  ...collections: ScenarioBookmark[][]
): ScenarioBookmark[] => {
  const byId = new Map<string, ScenarioBookmark>()
  for (const record of collections.flat()) {
    const previous = byId.get(record.scenario.id)
    // A removal wins equal timestamps so an old backup or offline response cannot revive it.
    if (
      !previous ||
      Date.parse(record.updatedAt) > Date.parse(previous.updatedAt) ||
      (Date.parse(record.updatedAt) === Date.parse(previous.updatedAt) && !record.saved)
    )
      byId.set(record.scenario.id, record)
  }
  return [...byId.values()].sort(
    (left, right) =>
      Date.parse(right.savedAt) - Date.parse(left.savedAt) ||
      left.scenario.id.localeCompare(right.scenario.id),
  )
}

export const readScenarioBookmarks = (): ScenarioBookmark[] => {
  if (typeof window === 'undefined') return []
  try {
    const stored = parseStoredValue(window.localStorage.getItem(SCENARIO_BOOKMARKS_KEY))
    if (!Array.isArray(stored)) return []
    return mergeScenarioBookmarks(
      stored.flatMap((item) => {
        const result = ScenarioBookmarkSchema.safeParse(item)
        return result.success ? [result.data] : []
      }),
    )
  } catch {
    return []
  }
}

export const writeScenarioBookmarks = (records: ScenarioBookmark[]): void => {
  assertLearningWriteAllowed()
  writeStored(
    SCENARIO_BOOKMARKS_KEY,
    mergeScenarioBookmarks(ScenarioBookmarkSchema.array().parse(records)),
  )
}

// Maintenance uses a shared lock for ordinary saves. A separate short lock makes
// each cache read/merge/write atomic across tabs without holding up network requests.
const withBookmarkCacheLock = <T>(action: () => T): Promise<T> => {
  if (typeof navigator !== 'undefined' && navigator.locks)
    return navigator.locks.request('mentor-scenario-bookmarks-cache', { mode: 'exclusive' }, action)
  return Promise.resolve().then(action)
}

const canSyncBookmarks = (sync: boolean): boolean =>
  sync &&
  isSupabaseConfigured() &&
  (isLocalSupabaseConfigured() || !readLearningData().profile.localOnly)

let pendingSync: Promise<ScenarioBookmarksResult> | undefined

const syncScenarioBookmarks = (sync: boolean): Promise<ScenarioBookmarksResult> => {
  if (!canSyncBookmarks(sync)) return Promise.resolve({ data: readScenarioBookmarks() })
  const operation = (pendingSync ?? Promise.resolve()).then(async () => {
    try {
      if (!canSyncBookmarks(sync)) return { data: readScenarioBookmarks() }
      const { client, userId } = await getAuthenticatedClient()
      if (!canSyncBookmarks(sync)) return { data: readScenarioBookmarks() }
      const { readRemoteScenarioBookmarks, writeRemoteScenarioBookmarks } =
        await import('@/lib/supabase/bookmarks')
      const remote = await readRemoteScenarioBookmarks(client, userId)
      if (!canSyncBookmarks(sync)) return { data: readScenarioBookmarks() }
      // Read again after the network request: a heart may have changed in the meantime.
      const merged = await withBookmarkCacheLock(() => {
        if (!canSyncBookmarks(sync)) return readScenarioBookmarks()
        const records = mergeScenarioBookmarks(remote, readScenarioBookmarks())
        writeStored(SCENARIO_BOOKMARKS_KEY, records)
        return records
      })
      if (!canSyncBookmarks(sync)) return { data: readScenarioBookmarks() }
      const persisted = await writeRemoteScenarioBookmarks(client, userId, merged)
      if (!canSyncBookmarks(sync)) return { data: readScenarioBookmarks() }
      const latest = await withBookmarkCacheLock(() => {
        if (!canSyncBookmarks(sync)) return readScenarioBookmarks()
        const records = mergeScenarioBookmarks(persisted, readScenarioBookmarks())
        writeStored(SCENARIO_BOOKMARKS_KEY, records)
        return records
      })
      return { data: latest }
    } catch (error) {
      return {
        data: readScenarioBookmarks(),
        error:
          error instanceof Error
            ? error.message
            : 'Bookmark database sync failed. Your saved scenarios remain on this device.',
      }
    }
  })
  pendingSync = operation
  void operation.then(() => {
    if (pendingSync === operation) pendingSync = undefined
  })
  return operation
}

export const loadScenarioBookmarks = (
  options: { sync: boolean } = { sync: false },
): Promise<ScenarioBookmarksResult> =>
  runLearningOperation(() => syncScenarioBookmarks(options.sync))

export const saveScenarioBookmark = (
  scenario: Scenario,
  level: ProficiencyLevel,
  saved: boolean,
  options: { sync: boolean } = { sync: false },
): Promise<ScenarioBookmarksResult> =>
  runLearningOperation(async () => {
    await withBookmarkCacheLock(() => {
      const current = readScenarioBookmarks()
      const previous = current.find((record) => record.scenario.id === scenario.id)
      // Consecutive clicks can occur in the same millisecond. Preserve their order in every merge.
      const updatedAt = new Date(
        Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0),
      ).toISOString()
      const record = ScenarioBookmarkSchema.parse({
        scenario,
        level,
        saved,
        savedAt: previous && (!saved || previous.saved) ? previous.savedAt : updatedAt,
        updatedAt,
      })
      writeScenarioBookmarks(mergeScenarioBookmarks(current, [record]))
    })
    return syncScenarioBookmarks(options.sync)
  })
