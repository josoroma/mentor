import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createExploreBackupFixture } from '@/tests/fixtures/explore'
import { defaultProfile, scenarios } from '@/app/_constants'
import type { SessionRecord } from '@/app/_types'
import {
  getAuthenticatedClient,
  getExistingAuthenticatedClient,
  isLocalSupabaseConfigured,
} from '@/lib/supabase/client'
import { readExploreBackup, restoreExploreBackup } from '@/lib/explore/backup'
import { readRemoteLearningBackup, resetRemoteLearningData } from '@/lib/supabase/backup'
import { readRemoteScenarioBookmarks, writeRemoteScenarioBookmarks } from '@/lib/supabase/bookmarks'

vi.mock('@/lib/supabase/client', () => ({
  getAuthenticatedClient: vi.fn(),
  getExistingAuthenticatedClient: vi.fn(),
  isSupabaseConfigured: vi.fn(() => true),
  isLocalSupabaseConfigured: vi.fn(() => false),
}))
vi.mock('@/lib/supabase/backup', () => ({
  readRemoteLearningBackup: vi.fn(),
  resetRemoteLearningData: vi.fn(),
}))
vi.mock('@/lib/explore/backup', () => ({
  readExploreBackup: vi.fn(),
  restoreExploreBackup: vi.fn(),
}))
vi.mock('@/lib/supabase/bookmarks', () => ({
  readRemoteScenarioBookmarks: vi.fn(),
  writeRemoteScenarioBookmarks: vi.fn(),
}))

const session: SessionRecord = {
  id: 'backup-session',
  scenarioId: scenarios[0].id,
  scenario: scenarios[0],
  roleId: defaultProfile.roleId,
  level: 'B2',
  startedAt: '2026-10-15T12:00:00.000Z',
  updatedAt: '2026-10-15T12:02:00.000Z',
  durationSeconds: 120,
  status: 'in-progress',
  messages: [],
  pendingTranscript: {
    id: 'pending-1',
    role: 'user',
    content: 'Yesterday I fix the bug',
    timestamp: 1,
  },
  improvements: [
    {
      messageId: 'pending-1',
      original: 'Yesterday I fix the bug',
      improved: 'Yesterday I fixed the bug.',
      updatedAt: '2026-10-15T12:02:00.000Z',
      isFinal: false,
    },
  ],
  conversation: {
    originalTopic: 'I want talk about bugs',
    improvedTopic: 'I want to talk about bugs.',
    stages: [
      { title: 'Describe', focus: 'Describe the issue.' },
      { title: 'Investigate', focus: 'Explain the investigation.' },
      { title: 'Resolve', focus: 'Share the next step.' },
    ],
    usefulPhrases: ['I noticed that', 'I tried to', 'Next I will'],
  },
  feedback: {
    summary: 'Practice review.',
    overallScore: null,
    metrics: [],
    strengths: ['Clear issue.'],
    improvements: ['Use the past tense.'],
    rewrites: [{ original: 'I fix', improved: 'I fixed', reason: 'Past tense.' }],
    nextStep: 'Practice your progress update.',
    source: 'practice-review',
  },
}

const fixture = (sessions: SessionRecord[] = [session]) => ({
  app: 'mentor' as const,
  version: 1 as const,
  exportedAt: '2026-10-15T12:05:00.000Z',
  data: {
    profile: { ...defaultProfile, name: 'Imported learner', localOnly: false },
    sessions,
    scenarios,
  },
})

describe('portable learning backup and reset', () => {
  let values: Map<string, string>
  let backup: typeof import('@/lib/learning/backup')
  let database: typeof import('@/lib/learning/session-database')
  let storage: typeof import('@/lib/learning/storage')
  let persistence: typeof import('@/lib/learning/persistence')

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.mocked(isLocalSupabaseConfigured).mockReturnValue(false)
    vi.mocked(getExistingAuthenticatedClient).mockResolvedValue(null)
    vi.mocked(resetRemoteLearningData).mockResolvedValue({ deletedSessions: 1, deletedProfiles: 1 })
    vi.mocked(readRemoteLearningBackup).mockResolvedValue({
      profile: null,
      sessions: [],
      scenarios,
    })
    vi.mocked(readRemoteScenarioBookmarks).mockResolvedValue([])
    vi.mocked(readExploreBackup).mockResolvedValue({
      sessions: [],
      messages: [],
      artifacts: [],
      revisions: [],
    })
    vi.mocked(restoreExploreBackup).mockImplementation(async (_client, _userId, value) => value)
    vi.mocked(writeRemoteScenarioBookmarks).mockImplementation(
      async (_client, _userId, records) => records,
    )
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
    storage = await import('@/lib/learning/storage')
    persistence = await import('@/lib/learning/persistence')
  })

  afterEach(() => vi.unstubAllGlobals())

  it('exports authoritative database rows and recovery drafts without authentication or theme data', async () => {
    values.set('sb-private-auth-token', 'secret')
    values.set('mentor.theme', 'dark')
    await database.writeSessionDatabase(session)
    const recovery = { ...session, id: 'cache-session' }
    values.set(storage.STORAGE_KEYS.sessions, JSON.stringify([recovery]))
    const exported = await backup.createLearningBackup()
    expect(exported.data.sessions).toHaveLength(2)
    expect(exported.data.sessions.find((item) => item.id === session.id)).toEqual(session)
    expect(backup.parseLearningBackup(JSON.stringify(exported))).toEqual(exported)
    expect(JSON.stringify(exported)).not.toContain('secret')
    expect(getExistingAuthenticatedClient).not.toHaveBeenCalled()
    expect(getAuthenticatedClient).not.toHaveBeenCalled()
  })

  it('includes remote-only history and refuses an incomplete backup when remote reading fails', async () => {
    vi.mocked(isLocalSupabaseConfigured).mockReturnValue(true)
    vi.mocked(getExistingAuthenticatedClient).mockResolvedValue({
      client: {} as never,
      userId: 'owner',
    })
    vi.mocked(readRemoteLearningBackup).mockResolvedValue({
      profile: null,
      sessions: [session],
      scenarios,
    })
    expect((await backup.createLearningBackup()).data.sessions).toEqual([session])
    vi.mocked(readRemoteLearningBackup).mockRejectedValue(new Error('Database offline'))
    await expect(backup.createLearningBackup()).rejects.toThrow('Database offline')
    expect(resetRemoteLearningData).not.toHaveBeenCalled()
  })

  it('rejects corrupt recovery data instead of silently leaving it out of an export', async () => {
    values.set(storage.STORAGE_KEYS.sessions, '[{"broken":true}]')
    await expect(backup.createLearningBackup()).rejects.toThrow('unreadable')
    expect(values.get(storage.STORAGE_KEYS.sessions)).toBe('[{"broken":true}]')
  })

  it('rejects invalid versions and malformed sessions before any restore writes', async () => {
    await database.writeSessionDatabase(session)
    await expect(
      backup.restoreLearningBackup({ ...fixture(), version: 2 } as never),
    ).rejects.toThrow()
    expect(() =>
      backup.parseLearningBackup(
        JSON.stringify({ ...fixture(), data: { ...fixture().data, sessions: [{}] } }),
      ),
    ).toThrow('valid Mentor')
    expect(await database.readSessionDatabase()).toEqual([session])
    expect(getExistingAuthenticatedClient).not.toHaveBeenCalled()
  })

  it('restores all transcript and plan fields while keeping current privacy and newer sessions', async () => {
    const completed = {
      ...session,
      id: 'existing-session',
      status: 'completed' as const,
      pendingTranscript: undefined,
    }
    await database.writeSessionDatabase(completed)
    const result = await backup.restoreLearningBackup(fixture())
    expect(result.syncStatus).toBe('local')
    expect(result.data.profile).toEqual({ ...defaultProfile, name: 'Imported learner' })
    expect(result.data.sessions).toHaveLength(2)
    expect(result.data.sessions.find((item) => item.id === session.id)).toEqual(session)
    expect((await backup.createLearningBackup()).data).toEqual(result.data)
    expect(getAuthenticatedClient).not.toHaveBeenCalled()
  })

  it('keeps local data intact if the connected database refuses the reset', async () => {
    vi.mocked(isLocalSupabaseConfigured).mockReturnValue(true)
    vi.mocked(getExistingAuthenticatedClient).mockResolvedValue({
      client: {} as never,
      userId: 'owner',
    })
    vi.mocked(resetRemoteLearningData).mockRejectedValue(new Error('Reset unavailable'))
    await database.writeSessionDatabase(session)
    values.set(storage.STORAGE_KEYS.profile, JSON.stringify(defaultProfile))
    await expect(backup.resetLearningData()).rejects.toThrow('Reset unavailable')
    expect(await database.readSessionDatabase()).toEqual([session])
    expect(JSON.parse(values.get(storage.STORAGE_KEYS.profile)!)).toEqual(defaultProfile)
    expect(values.has('mentor.learning-maintenance.v1')).toBe(false)
  })

  it('clears only learning stores and preserves theme, identity, and the shared curriculum', async () => {
    await database.writeSessionDatabase(session)
    values.set(storage.STORAGE_KEYS.sessions, JSON.stringify([session]))
    values.set(
      storage.STORAGE_KEYS.profile,
      JSON.stringify({ ...defaultProfile, name: 'Before reset' }),
    )
    values.set('mentor.demo-topics.v1', '["Previous topic"]')
    values.set('mentor.theme', 'light')
    values.set('sb-private-auth-token', 'keep-auth')
    const data = await backup.resetLearningData()
    expect(data).toEqual({ profile: defaultProfile, sessions: [], scenarios, bookmarks: [] })
    expect(await database.readSessionDatabase()).toEqual([])
    expect(values.has(storage.STORAGE_KEYS.sessions)).toBe(false)
    expect(values.has('mentor.demo-topics.v1')).toBe(false)
    expect(values.get('mentor.theme')).toBe('light')
    expect(values.get('sb-private-auth-token')).toBe('keep-auth')
    expect((await persistence.loadLearningData()).data.sessions).toEqual([])
  })

  it('waits for a pending session upload before reset so the late upload cannot resurrect it', async () => {
    vi.mocked(isLocalSupabaseConfigured).mockReturnValue(true)
    let finishUpload!: (value: { error: null }) => void
    const upsert = vi.fn(
      () =>
        new Promise<{ error: null }>((resolve) => {
          finishUpload = resolve
        }),
    )
    const client = { from: () => ({ upsert }) } as never
    vi.mocked(getAuthenticatedClient).mockResolvedValue({ client, userId: 'owner' })
    vi.mocked(getExistingAuthenticatedClient).mockResolvedValue({ client, userId: 'owner' })
    const saving = persistence.saveLearningSession(session)
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce())
    const resetting = backup.resetLearningData()
    await Promise.resolve()
    expect(resetRemoteLearningData).not.toHaveBeenCalled()
    finishUpload({ error: null })
    await saving
    await resetting
    expect(resetRemoteLearningData).toHaveBeenCalledOnce()
    expect(await database.readSessionDatabase()).toEqual([])
    expect(storage.readLearningData().sessions).toEqual([])
  })

  it('restores locally and reports a retryable error when the configured database is offline', async () => {
    vi.mocked(isLocalSupabaseConfigured).mockReturnValue(true)
    vi.mocked(getExistingAuthenticatedClient).mockRejectedValue(new Error('Database offline'))
    const result = await backup.restoreLearningBackup(fixture())
    expect(result.syncStatus).toBe('error')
    expect(result.error).toContain('restored on this device')
    expect(await database.readSessionDatabase()).toEqual([session])
    expect(getAuthenticatedClient).not.toHaveBeenCalled()
  })

  it('keeps imported scenario settings after a remote curriculum refresh', async () => {
    const imported = fixture()
    imported.data.scenarios = [{ ...scenarios[0], title: 'Imported scenario configuration' }]
    await backup.restoreLearningBackup(imported)
    vi.mocked(isLocalSupabaseConfigured).mockReturnValue(true)
    vi.mocked(getAuthenticatedClient).mockResolvedValue({
      userId: 'owner',
      client: {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
              order: () => ({ limit: async () => ({ data: [], error: null }) }),
            }),
            order: async () => ({
              data: scenarios.map((configuration) => ({ configuration })),
              error: null,
            }),
          }),
        }),
      } as never,
    })
    const result = await persistence.loadLearningData({ sync: true })
    expect(result.data.scenarios.find((item) => item.id === scenarios[0].id)?.title).toBe(
      'Imported scenario configuration',
    )
    expect(storage.readLearningData().scenarios).toEqual(result.data.scenarios)
  })

  it('waits for a pending load before reset so an old snapshot cannot repopulate history', async () => {
    values.set(
      storage.STORAGE_KEYS.profile,
      JSON.stringify({ ...defaultProfile, localOnly: false }),
    )
    let release!: (value: Awaited<ReturnType<typeof getAuthenticatedClient>>) => void
    vi.mocked(getAuthenticatedClient).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const loading = persistence.loadLearningData({ sync: true })
    await vi.waitFor(() => expect(getAuthenticatedClient).toHaveBeenCalledOnce())
    const resetting = backup.resetLearningData()
    release({
      userId: 'owner',
      client: {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
              order: () => ({ limit: async () => ({ data: [{ session }], error: null }) }),
            }),
            order: async () => ({ data: [], error: null }),
          }),
        }),
      } as never,
    })
    await Promise.all([loading, resetting])
    expect(await database.readSessionDatabase()).toEqual([])
    expect(storage.readLearningData().sessions).toEqual([])
  })

  it('rolls back the database transaction and recovery cache when a restore cache write fails', async () => {
    await persistence.saveLearningSession(session, { sync: false })
    values.set(storage.STORAGE_KEYS.profile, JSON.stringify(defaultProfile))
    const before = new Map(values)
    const originalSet = window.localStorage.setItem
    let failProfile = true
    vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === storage.STORAGE_KEYS.profile && failProfile) {
        failProfile = false
        throw new Error('Storage quota exceeded')
      }
      originalSet(key, value)
    })
    await expect(
      backup.restoreLearningBackup(fixture([{ ...session, id: 'new-import' }])),
    ).rejects.toThrow('browser could not save')
    expect(await database.readSessionDatabase()).toEqual([session])
    expect(values).toEqual(before)
  })

  it('backs up full saved scenarios and preserves newer removals when restoring', async () => {
    const bookmarksKey = 'mentor.scenario-bookmarks.v1'
    const bookmark = {
      scenario: {
        ...scenarios[0],
        id: 'learning-bookmarked',
        title: 'A saved generated situation',
      },
      level: 'C1' as const,
      savedAt: '2026-10-15T12:00:00.000Z',
      updatedAt: '2026-10-15T12:00:00.000Z',
      saved: true,
    }
    values.set(bookmarksKey, JSON.stringify([bookmark]))
    const exported = await backup.createLearningBackup()
    expect(exported.data.bookmarks).toEqual([bookmark])
    const removed = { ...bookmark, saved: false, updatedAt: '2026-10-15T12:10:00.000Z' }
    values.set(bookmarksKey, JSON.stringify([removed]))
    const restored = await backup.restoreLearningBackup(exported)
    expect(restored.data.bookmarks).toEqual([removed])
    expect(JSON.parse(values.get(bookmarksKey)!)).toEqual([removed])
    await backup.resetLearningData()
    expect(values.has(bookmarksKey)).toBe(false)
  })

  it('includes remote-only saved scenarios and refuses incomplete bookmark backups', async () => {
    vi.mocked(isLocalSupabaseConfigured).mockReturnValue(true)
    vi.mocked(getExistingAuthenticatedClient).mockResolvedValue({
      client: {} as never,
      userId: 'owner',
    })
    const bookmark = {
      scenario: scenarios[0],
      level: 'B2' as const,
      savedAt: '2026-10-15T12:00:00.000Z',
      updatedAt: '2026-10-15T12:00:00.000Z',
      saved: true,
    }
    vi.mocked(readRemoteScenarioBookmarks).mockResolvedValue([bookmark])
    expect((await backup.createLearningBackup()).data.bookmarks).toEqual([bookmark])
    vi.mocked(readRemoteScenarioBookmarks).mockRejectedValue(
      new Error('Saved scenarios unavailable'),
    )
    await expect(backup.createLearningBackup()).rejects.toThrow('Saved scenarios unavailable')
  })
  it('includes complete Explore history and refuses an incomplete exploration export', async () => {
    vi.mocked(isLocalSupabaseConfigured).mockReturnValue(true)
    vi.mocked(getExistingAuthenticatedClient).mockResolvedValue({
      client: {} as never,
      userId: 'owner',
    })
    const explore = createExploreBackupFixture()
    vi.mocked(readExploreBackup).mockResolvedValue(explore)
    expect((await backup.createLearningBackup()).data.explore).toEqual(explore)
    vi.mocked(readExploreBackup).mockRejectedValue(new Error('Exploration history unavailable'))
    await expect(backup.createLearningBackup()).rejects.toThrow('Exploration history unavailable')
  })

  it('preserves all existing data when Explore cannot be restored without an authorized database', async () => {
    await database.writeSessionDatabase(session)
    const imported = {
      ...fixture(),
      data: { ...fixture().data, explore: createExploreBackupFixture() },
    }
    await expect(backup.restoreLearningBackup(imported)).rejects.toThrow(
      'No learning data was changed',
    )
    expect(await database.readSessionDatabase()).toEqual([session])
    expect(restoreExploreBackup).not.toHaveBeenCalled()
    expect(getAuthenticatedClient).not.toHaveBeenCalled()
  })

  it('keeps browser records intact when an exploration database read or restore fails', async () => {
    vi.mocked(isLocalSupabaseConfigured).mockReturnValue(true)
    const identity = { client: {} as never, userId: 'owner' }
    vi.mocked(getExistingAuthenticatedClient).mockResolvedValue(identity)
    vi.mocked(getAuthenticatedClient).mockResolvedValue(identity)
    await database.writeSessionDatabase(session)
    const imported = {
      ...fixture([{ ...session, id: 'new-import' }]),
      data: {
        ...fixture([{ ...session, id: 'new-import' }]).data,
        explore: createExploreBackupFixture(),
      },
    }
    vi.mocked(readExploreBackup).mockRejectedValueOnce(new Error('Database offline'))
    await expect(backup.restoreLearningBackup(imported)).rejects.toThrow(
      'No learning data was changed',
    )
    expect(await database.readSessionDatabase()).toEqual([session])
    expect(restoreExploreBackup).not.toHaveBeenCalled()
    vi.mocked(restoreExploreBackup).mockRejectedValueOnce(new Error('Revision conflict'))
    await expect(backup.restoreLearningBackup(imported)).rejects.toThrow('Revision conflict')
    expect(await database.readSessionDatabase()).toEqual([session])
  })

  it('merges explorations transactionally and retains their complete snapshot after practice sync', async () => {
    vi.mocked(isLocalSupabaseConfigured).mockReturnValue(true)
    const identity = { client: {} as never, userId: 'owner' }
    vi.mocked(getExistingAuthenticatedClient).mockResolvedValue(identity)
    vi.mocked(getAuthenticatedClient).mockResolvedValue(identity)
    const explore = createExploreBackupFixture()
    vi.spyOn(persistence, 'syncLearningData').mockResolvedValue({
      data: { profile: defaultProfile, sessions: [session], scenarios },
      mode: 'supabase',
      syncStatus: 'synced',
    })
    const imported = { ...fixture(), data: { ...fixture().data, explore } }
    const result = await backup.restoreLearningBackup(imported)
    expect(restoreExploreBackup).toHaveBeenCalledWith(identity.client, identity.userId, explore)
    expect(result.syncStatus).toBe('synced')
    expect(result.data.explore).toEqual(explore)
    expect(await database.readSessionDatabase()).toEqual([session])
  })
})
