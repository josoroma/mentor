import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultProfile, scenarios } from '@/app/_constants'
import { ProfileSchema, ScenarioSchema, SessionRecordSchema } from '@/app/_schema'
import type { Profile, Scenario, SessionRecord } from '@/app/_types'
import type { LearningSelection } from '@/lib/learning/paths'
import { createSessionAutosave } from '@/lib/learning/session-autosave'

vi.mock('@/lib/supabase/client', () => ({
  getAuthenticatedClient: vi.fn(),
  getExistingAuthenticatedClient: vi.fn(),
  isSupabaseConfigured: () => false,
  isLocalSupabaseConfigured: () => false,
}))

const selections: LearningSelection[] = [
  { path: 'professional', roleId: 'devops-engineer' },
  { path: 'life-skills', categoryId: 'public-speaking', topicId: 'storytelling' },
]

const fixture = (selection: LearningSelection) => {
  const profile: Profile = {
    ...defaultProfile,
    level: 'C2',
    speechProvider: 'kokoro',
    learningPath: selection.path,
    learningSelection: selection,
    roleId: selection.path === 'professional' ? selection.roleId : defaultProfile.roleId,
  }
  const scenario: Scenario = {
    ...scenarios[0],
    id: `selected-practice-${selection.path}`,
    learningSelection: selection,
    difficulty: 'Advanced',
    roleIds: [profile.roleId],
  }
  const session: SessionRecord = {
    id: `selected-session-${selection.path}`,
    scenarioId: scenario.id,
    scenario,
    roleId: profile.roleId,
    level: 'C2',
    startedAt: '2026-10-15T12:00:00.000Z',
    updatedAt: '2026-10-15T12:01:00.000Z',
    durationSeconds: 60,
    status: 'in-progress',
    messages: [
      {
        id: 'selected-message',
        role: 'user',
        content: 'I would begin by clarifying the context and agreeing on the next step.',
        timestamp: 1_792_065_600_000,
      },
    ],
    improvements: [
      {
        messageId: 'selected-message',
        original: 'I would begin by clarifying the context and agreeing on the next step.',
        improved: 'First, I would clarify the context and agree on the next step.',
        updatedAt: '2026-10-15T12:01:00.000Z',
        isFinal: true,
      },
    ],
  }
  return { profile, scenario, session }
}

describe('learning selection persistence compatibility', () => {
  let values: Map<string, string>
  let backup: typeof import('@/lib/learning/backup')
  let database: typeof import('@/lib/learning/session-database')
  let persistence: typeof import('@/lib/learning/persistence')
  let storage: typeof import('@/lib/learning/storage')

  beforeEach(async () => {
    vi.resetModules()
    values = new Map()
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    })
    backup = await import('@/lib/learning/backup')
    database = await import('@/lib/learning/session-database')
    persistence = await import('@/lib/learning/persistence')
    storage = await import('@/lib/learning/storage')
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each(selections)(
    'retains $path selection and C2 through autosave, reload, and backup restore',
    async (selection) => {
      const { profile, scenario, session } = fixture(selection)
      expect(ProfileSchema.parse(JSON.parse(JSON.stringify(profile)))).toEqual(profile)
      expect(ScenarioSchema.parse(JSON.parse(JSON.stringify(scenario)))).toEqual(scenario)
      expect(SessionRecordSchema.parse(JSON.parse(JSON.stringify(session)))).toEqual(session)

      await persistence.saveLearningProfile(profile)
      storage.writeStored(storage.STORAGE_KEYS.scenarios, [scenario])
      const autosave = createSessionAutosave({
        save: (value) => persistence.saveLearningSession(value, { sync: false }),
        cache: storage.cacheLearningSession,
        onChange: vi.fn(),
        destination: 'device',
      })
      try {
        autosave.update(session)
        expect(await autosave.flush()).toBe(true)
        expect(
          await autosave.flush({
            ...session,
            scenario: undefined,
            status: 'completed',
            durationSeconds: 120,
            updatedAt: '2026-10-15T12:02:00.000Z',
          }),
        ).toBe(true)
      } finally {
        autosave.dispose()
      }

      values.delete(storage.STORAGE_KEYS.sessions)
      const loaded = await persistence.loadLearningData()
      expect(loaded.data.profile).toEqual(profile)
      expect(loaded.data.sessions[0]).toMatchObject({
        level: 'C2',
        status: 'completed',
        durationSeconds: 120,
        scenario: { learningSelection: selection },
        messages: session.messages,
        improvements: session.improvements,
      })
      expect(loaded.data.scenarios[0].learningSelection).toEqual(selection)

      const exported = await backup.createLearningBackup()
      const parsed = backup.parseLearningBackup(JSON.stringify(exported))
      expect(parsed.data.profile.learningPath).toBe(selection.path)
      expect(parsed.data.profile.learningSelection).toEqual(selection)
      expect(parsed.data.profile.level).toBe('C2')
      expect(parsed.data.profile.speechProvider).toBe('kokoro')
      expect(parsed.data.sessions[0].scenario?.learningSelection).toEqual(selection)
      expect(parsed.data.scenarios[0].learningSelection).toEqual(selection)

      await database.replaceSessionDatabase([])
      values.clear()
      expect((await persistence.loadLearningData()).data.sessions).toEqual([])
      const restored = await backup.restoreLearningBackup(parsed)
      expect(restored.syncStatus).toBe('local')
      const reloaded = await persistence.loadLearningData()
      expect(reloaded.data.profile).toEqual(profile)
      expect(reloaded.data.sessions).toEqual(parsed.data.sessions)
      expect(reloaded.data.scenarios.find(({ id }) => id === scenario.id)).toEqual(scenario)
      expect((await database.readSessionDatabase())[0].scenario?.learningSelection).toEqual(
        selection,
      )
    },
  )

  it('accepts older profiles and sessions without requiring a learning path', () => {
    const { profile, scenario, session } = fixture(selections[0])
    const { learningPath: _path, learningSelection: _profileSelection, ...legacyProfile } = profile
    const { learningSelection: _selection, ...legacyScenario } = scenario
    expect(ProfileSchema.parse(legacyProfile)).not.toHaveProperty('learningPath')
    expect(ProfileSchema.parse(legacyProfile)).not.toHaveProperty('learningSelection')
    expect(
      SessionRecordSchema.parse({ ...session, scenario: legacyScenario }).scenario,
    ).not.toHaveProperty('learningSelection')
  })

  it('rejects a mismatched stored category/topic without accepting a corrupt backup', () => {
    const { profile, scenario, session } = fixture(selections[1])
    const malformed = {
      ...scenario,
      learningSelection: {
        path: 'life-skills',
        categoryId: 'public-speaking',
        topicId: 'job-interviews',
      },
    }
    expect(ScenarioSchema.safeParse(malformed).success).toBe(false)
    expect(
      ProfileSchema.safeParse({ ...profile, learningSelection: malformed.learningSelection })
        .success,
    ).toBe(false)
    expect(storage.normalizeSessions([{ ...session, scenario: malformed }])).toEqual([])
    expect(() =>
      backup.parseLearningBackup(
        JSON.stringify({
          app: 'mentor',
          version: 1,
          exportedAt: '2026-10-15T12:05:00.000Z',
          data: { profile, scenarios: [malformed], sessions: [session] },
        }),
      ),
    ).toThrow('not a valid Mentor')
  })
})
