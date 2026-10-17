import { defaultProfile, scenarios } from '@/app/_constants'
import { ProfileSchema, ScenarioSchema, SessionRecordSchema } from '@/app/_schema'
import type { Profile, Scenario, SessionRecord } from '@/app/_types'
import type { ExploreBackup } from '@/lib/explore/schema'
import type { ScenarioBookmark } from '@/lib/learning/bookmarks'
import { assertLearningWriteAllowed } from '@/lib/learning/maintenance'

export const STORAGE_KEYS = {
  profile: 'mentor.profile.v1',
  sessions: 'mentor.sessions.v1',
  scenarios: 'mentor.scenarios.v1',
  scenarioOverrides: 'mentor.scenario-overrides.v1',
  selectedRole: 'mentor.selected-role.v1',
  selectedScenario: 'mentor.selected-scenario.v1',
} as const

export type LearningData = {
  profile: Profile
  sessions: SessionRecord[]
  scenarios: Scenario[]
  bookmarks?: ScenarioBookmark[]
  explore?: ExploreBackup
}

export const parseStoredValue = (value: string | null): unknown => {
  if (!value) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

export const normalizeSessions = (value: unknown): SessionRecord[] => {
  if (!Array.isArray(value)) return []
  const records = value.flatMap((item) => {
    const result = SessionRecordSchema.safeParse(item)
    return result.success ? [result.data] : []
  })
  return mergeSessions(records)
}

export const mergeSessions = (...collections: SessionRecord[][]): SessionRecord[] => {
  const byId = new Map<string, SessionRecord>()
  for (const session of collections.flat()) {
    const existing = byId.get(session.id)
    if (!existing) {
      byId.set(session.id, session)
      continue
    }
    // Completed records cannot be replaced by a delayed autosave. Legacy records are completed.
    const existingComplete = existing.status !== 'in-progress'
    const incomingComplete = session.status !== 'in-progress'
    const useIncoming =
      existingComplete !== incomingComplete
        ? incomingComplete
        : (session.updatedAt ?? session.startedAt) >= (existing.updatedAt ?? existing.startedAt)
    const latest = useIncoming ? session : existing
    const older = useIncoming ? existing : session
    const improvements = new Map<string, NonNullable<SessionRecord['improvements']>[number]>()
    for (const improvement of [...(older.improvements ?? []), ...(latest.improvements ?? [])]) {
      const previous = improvements.get(improvement.messageId)
      if (
        !previous ||
        (improvement.isFinal && !previous.isFinal) ||
        (improvement.isFinal === previous.isFinal && improvement.updatedAt >= previous.updatedAt)
      )
        improvements.set(improvement.messageId, improvement)
    }
    const merged = {
      ...latest,
      feedback: latest.feedback ?? older.feedback,
      scenario: latest.scenario ?? older.scenario,
      conversation: latest.conversation ?? older.conversation,
    }
    if (older.improvements || latest.improvements) merged.improvements = [...improvements.values()]
    // Pausing or interrupted final recognition can clear the live UI before a turn is finalized.
    if (merged.status === 'in-progress' && !merged.pendingTranscript && older.pendingTranscript)
      merged.pendingTranscript = older.pendingTranscript
    if (
      merged.status !== 'in-progress' ||
      merged.messages.some((message) => message.id === merged.pendingTranscript?.id)
    )
      delete merged.pendingTranscript
    byId.set(session.id, merged)
  }
  return [...byId.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt))
}

// A synchronous recovery copy complements IndexedDB when a tab is closed during a write.
export const cacheLearningSession = (session: SessionRecord): void => {
  assertLearningWriteAllowed()
  const validated = SessionRecordSchema.parse(session)
  writeStored(STORAGE_KEYS.sessions, mergeSessions(readLearningData().sessions, [validated]))
}

const readStored = (key: string): unknown => {
  if (typeof window === 'undefined') return undefined
  try {
    return parseStoredValue(window.localStorage.getItem(key))
  } catch {
    return undefined
  }
}

export const readScenarioOverrides = (): Scenario[] => {
  const result = ScenarioSchema.array().safeParse(readStored(STORAGE_KEYS.scenarioOverrides))
  return result.success ? result.data : []
}

export const mergeScenarioConfigurations = (...collections: Scenario[][]): Scenario[] => [
  ...new Map(collections.flat().map((scenario) => [scenario.id, scenario])).values(),
]

export const writeStored = (key: string, value: unknown): void => {
  if (typeof window === 'undefined')
    throw new Error('Learning data can only be saved in your browser.')
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    throw new Error(
      'Your browser could not save this data. Check available storage and browser privacy settings.',
    )
  }
}

export const readLearningData = (): LearningData => {
  const storedProfile = ProfileSchema.safeParse(readStored(STORAGE_KEYS.profile))
  const storedScenarios = ScenarioSchema.array().safeParse(readStored(STORAGE_KEYS.scenarios))
  return {
    profile: storedProfile.success ? storedProfile.data : { ...defaultProfile },
    sessions: normalizeSessions(readStored(STORAGE_KEYS.sessions)),
    scenarios: mergeScenarioConfigurations(
      storedScenarios.success && storedScenarios.data.length > 0 ? storedScenarios.data : scenarios,
      readScenarioOverrides(),
    ),
  }
}
