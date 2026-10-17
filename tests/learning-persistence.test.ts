import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

import { defaultProfile } from '@/app/_constants'
import type { SessionRecord } from '@/app/_types'
import {
  loadLearningData,
  saveLearningProfile,
  saveLearningSession,
} from '@/lib/learning/persistence'
import { readLearningData, STORAGE_KEYS } from '@/lib/learning/storage'
import { readSessionDatabase, writeSessionDatabase } from '@/lib/learning/session-database'
import { getAuthenticatedClient, isLocalSupabaseConfigured } from '@/lib/supabase/client'
import { subscribeSpeechProviderChange } from '@/lib/audio/speech-preference'
import type { LearningSelection } from '@/lib/learning/paths'

vi.mock('@/lib/supabase/client', () => ({
  getAuthenticatedClient: vi.fn(),
  isSupabaseConfigured: () => false,
  isLocalSupabaseConfigured: vi.fn(() => false),
}))

const session: SessionRecord = {
  id: 'session-1',
  scenarioId: 'daily-standup',
  roleId: 'deployed-ai-developer',
  level: 'B2',
  startedAt: '2026-10-15T12:00:00.000Z',
  durationSeconds: 120,
  messages: [
    {
      id: 'message-1',
      role: 'user',
      content: 'I finished the tests.',
      timestamp: 1_792_065_600_000,
    },
  ],
}

describe('privacy-preserving learning persistence', () => {
  let values: Map<string, string>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isLocalSupabaseConfigured).mockReturnValue(false)
    vi.stubGlobal('indexedDB', new IDBFactory())
    values = new Map()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('saves and loads locally without creating a remote identity', async () => {
    const result = await saveLearningSession(session)
    const loaded = await loadLearningData()
    expect(result.syncStatus).toBe('local')
    expect(loaded.data.sessions).toEqual([session])
    expect(getAuthenticatedClient).not.toHaveBeenCalled()
  })

  it('retains a local session and reports a cloud failure after an explicit opt-in', async () => {
    values.set(STORAGE_KEYS.profile, JSON.stringify({ ...defaultProfile, localOnly: false }))
    vi.mocked(getAuthenticatedClient).mockRejectedValue(new Error('Sync is unavailable.'))
    const result = await saveLearningSession(session, { sync: true })
    expect(result.syncStatus).toBe('error')
    expect(result.error).toBe('Sync is unavailable.')
    expect(readLearningData().sessions).toEqual([session])
    expect(getAuthenticatedClient).toHaveBeenCalledOnce()
  })

  it('treats a local-only preference as authoritative even when a caller has stale sync state', async () => {
    await saveLearningSession(session, { sync: true })
    await loadLearningData({ sync: true })
    expect(getAuthenticatedClient).not.toHaveBeenCalled()
    expect(readLearningData().profile.localOnly).toBe(true)
  })

  it('preserves a new session saved while a cloud refresh is in flight', async () => {
    values.set(STORAGE_KEYS.profile, JSON.stringify({ ...defaultProfile, localOnly: false }))
    let releaseIdentity!: (value: Awaited<ReturnType<typeof getAuthenticatedClient>>) => void
    vi.mocked(getAuthenticatedClient).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseIdentity = resolve
        }),
    )
    const loading = loadLearningData({ sync: true })
    await vi.waitFor(() => expect(getAuthenticatedClient).toHaveBeenCalledOnce())
    await saveLearningSession(session, { sync: false })
    const from = vi.fn((table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { profile: { ...defaultProfile, localOnly: false } },
            error: null,
          }),
          order: () => ({ limit: async () => ({ data: [], error: null }) }),
        }),
        order: async () => ({ data: [], error: null }),
      }),
      table,
    }))
    releaseIdentity({
      client: { from } as unknown as Awaited<ReturnType<typeof getAuthenticatedClient>>['client'],
      userId: 'learner-1',
    })
    const result = await loading
    expect(result.syncStatus).toBe('synced')
    expect(result.data.sessions).toEqual([session])
    expect(readLearningData().sessions).toEqual([session])
  })

  it('does not upload a pending profile after the learner opts out', async () => {
    let releaseIdentity!: (value: Awaited<ReturnType<typeof getAuthenticatedClient>>) => void
    vi.mocked(getAuthenticatedClient).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseIdentity = resolve
        }),
    )
    const saving = saveLearningProfile({ ...defaultProfile, localOnly: false })
    await saveLearningProfile({ ...defaultProfile, localOnly: true })
    const from = vi.fn()
    releaseIdentity({
      client: { from } as unknown as Awaited<ReturnType<typeof getAuthenticatedClient>>['client'],
      userId: 'learner-1',
    })
    const result = await saving
    expect(result.syncStatus).toBe('local')
    expect(result.data.localOnly).toBe(true)
    expect(from).not.toHaveBeenCalled()
  })

  it('honors a return to local-only mode without making a remote call', async () => {
    const result = await saveLearningProfile({ ...defaultProfile, localOnly: true })
    expect(result.syncStatus).toBe('local')
    expect(readLearningData().profile.localOnly).toBe(true)
    expect(getAuthenticatedClient).not.toHaveBeenCalled()
  })

  it.each(['macos', 'kokoro', 'chatterbox'] as const)(
    'saves the %s voice preference to the local profile and configured local Supabase',
    async (speechProvider) => {
      vi.mocked(isLocalSupabaseConfigured).mockReturnValue(true)
      const upsert = vi.fn(async () => ({ error: null }))
      vi.mocked(getAuthenticatedClient).mockResolvedValue({
        client: { from: vi.fn(() => ({ upsert })) } as unknown as Awaited<
          ReturnType<typeof getAuthenticatedClient>
        >['client'],
        userId: 'learner-1',
      })
      const result = await saveLearningProfile({ ...defaultProfile, speechProvider })
      expect(result.syncStatus).toBe('synced')
      expect(readLearningData().profile.speechProvider).toBe(speechProvider)
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          profile: expect.objectContaining({ speechProvider, localOnly: true }),
        }),
      )
    },
  )

  it('preserves a voice preference on-device if its database sync fails', async () => {
    vi.mocked(isLocalSupabaseConfigured).mockReturnValue(true)
    vi.mocked(getAuthenticatedClient).mockRejectedValue(new Error('Local database unavailable.'))
    const result = await saveLearningProfile({ ...defaultProfile, speechProvider: 'kokoro' })
    expect(result.syncStatus).toBe('error')
    expect(readLearningData().profile.speechProvider).toBe('kokoro')
  })

  it('saves complete learning depth to the local profile and configured local Supabase', async () => {
    vi.mocked(isLocalSupabaseConfigured).mockReturnValue(true)
    const upsert = vi.fn(async () => ({ error: null }))
    vi.mocked(getAuthenticatedClient).mockResolvedValue({
      client: { from: vi.fn(() => ({ upsert })) } as unknown as Awaited<
        ReturnType<typeof getAuthenticatedClient>
      >['client'],
      userId: 'learner-1',
    })
    const learningSelection: LearningSelection = {
      path: 'life-skills',
      categoryId: 'public-speaking',
      topicId: 'storytelling',
    }
    const result = await saveLearningProfile({
      ...defaultProfile,
      learningPath: 'life-skills',
      learningSelection,
    })
    expect(result.syncStatus).toBe('synced')
    expect(readLearningData().profile.learningSelection).toEqual(learningSelection)
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ learningSelection, learningPath: 'life-skills' }),
      }),
    )
  })

  it.each([false, true])(
    'restores remote focus while preserving an explicit local focus: %s',
    async (hasLocalFocus) => {
      vi.mocked(isLocalSupabaseConfigured).mockReturnValue(true)
      const remoteFocus: LearningSelection = { path: 'professional', roleId: 'product-engineer' }
      const localFocus: LearningSelection = {
        path: 'life-skills',
        categoryId: 'public-speaking',
        topicId: 'storytelling',
      }
      values.set(
        STORAGE_KEYS.profile,
        JSON.stringify({
          ...defaultProfile,
          ...(hasLocalFocus ? { learningSelection: localFocus } : {}),
        }),
      )
      const from = vi.fn(() => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { profile: { ...defaultProfile, learningSelection: remoteFocus } },
              error: null,
            }),
            order: () => ({ limit: async () => ({ data: [], error: null }) }),
          }),
          order: async () => ({ data: [], error: null }),
        }),
      }))
      vi.mocked(getAuthenticatedClient).mockResolvedValue({
        client: { from } as unknown as Awaited<ReturnType<typeof getAuthenticatedClient>>['client'],
        userId: 'learner-1',
      })
      const loaded = await loadLearningData({ sync: true })
      expect(loaded.syncStatus).toBe('synced')
      expect(loaded.data.profile.learningSelection).toEqual(
        hasLocalFocus ? localFocus : remoteFocus,
      )
      expect(loaded.data.profile.learningPath).toBe(hasLocalFocus ? 'life-skills' : 'professional')
      if (!hasLocalFocus) expect(loaded.data.profile.roleId).toBe('product-engineer')
    },
  )

  it('notifies active audio as soon as the local choice saves, before database sync finishes', async () => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: window.localStorage }))
    vi.mocked(isLocalSupabaseConfigured).mockReturnValue(true)
    let rejectSync!: (reason: Error) => void
    vi.mocked(getAuthenticatedClient).mockReturnValue(
      new Promise((_, reject) => {
        rejectSync = reject
      }),
    )
    const changed = vi.fn()
    const unsubscribe = subscribeSpeechProviderChange(changed)
    try {
      const saving = saveLearningProfile({ ...defaultProfile, speechProvider: 'macos' })
      await vi.waitFor(() => expect(getAuthenticatedClient).toHaveBeenCalledOnce())
      expect(changed).toHaveBeenCalledOnce()
      expect(readLearningData().profile.speechProvider).toBe('macos')
      rejectSync(new Error('Database unavailable.'))
      expect((await saving).syncStatus).toBe('error')
    } finally {
      unsubscribe()
    }
  })

  it.each([undefined, 'chatterbox'] as const)(
    'does not overwrite a local voice choice with the remote %s preference on refresh',
    async (speechProvider) => {
      vi.mocked(isLocalSupabaseConfigured).mockReturnValue(true)
      values.set(
        STORAGE_KEYS.profile,
        JSON.stringify({ ...defaultProfile, speechProvider: 'kokoro' }),
      )
      const from = vi.fn(() => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { profile: { ...defaultProfile, speechProvider } },
              error: null,
            }),
            order: () => ({ limit: async () => ({ data: [], error: null }) }),
          }),
          order: async () => ({ data: [], error: null }),
        }),
      }))
      vi.mocked(getAuthenticatedClient).mockResolvedValue({
        client: { from } as unknown as Awaited<ReturnType<typeof getAuthenticatedClient>>['client'],
        userId: 'learner-1',
      })
      const loaded = await loadLearningData({ sync: true })
      expect(loaded.syncStatus).toBe('synced')
      expect(loaded.data.profile.speechProvider).toBe('kokoro')
      expect(readLearningData().profile.speechProvider).toBe('kokoro')
    },
  )

  it('does not report success when browser storage is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined)
    vi.stubGlobal('window', {
      localStorage: {
        setItem: () => {
          throw new Error('Quota exceeded')
        },
        getItem: () => null,
      },
    })
    await expect(saveLearningSession(session)).rejects.toThrow(
      'Your browser could not save this data',
    )
    expect(getAuthenticatedClient).not.toHaveBeenCalled()
  })

  it('restores pending speech and improved transcripts from IndexedDB after the recovery cache is cleared', async () => {
    const pending: SessionRecord = {
      ...session,
      status: 'in-progress',
      updatedAt: '2026-10-15T12:02:00.000Z',
      pendingTranscript: {
        id: 'pending-1',
        role: 'user',
        content: 'Yesterday I fix',
        timestamp: 2,
      },
      improvements: [
        {
          messageId: 'pending-1',
          original: 'Yesterday I fix',
          improved: 'Yesterday I fixed',
          updatedAt: '2026-10-15T12:02:00.000Z',
          isFinal: false,
        },
      ],
    }
    await saveLearningSession(pending)
    values.delete(STORAGE_KEYS.sessions)
    const result = await loadLearningData()
    expect(result.data.sessions).toEqual([pending])
    expect(readLearningData().sessions).toEqual([pending])
    expect(getAuthenticatedClient).not.toHaveBeenCalled()
  })

  it('reports a database failure while retaining a recovery copy', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const result = await saveLearningSession(session)
    expect(result.syncStatus).toBe('error')
    expect(result.error).toContain('recovery copy')
    expect(readLearningData().sessions).toEqual([session])
  })

  it('saves to IndexedDB when the smaller localStorage quota is exhausted', async () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('Quota exceeded')
        },
      },
    })
    const result = await saveLearningSession(session)
    expect(result.syncStatus).toBe('local')
    expect(await readSessionDatabase()).toEqual([session])
  })

  it('automatically saves to configured local Supabase while the profile remains local-only', async () => {
    vi.mocked(isLocalSupabaseConfigured).mockReturnValue(true)
    const upsert = vi.fn(async () => ({ error: null }))
    const from = vi.fn(() => ({ upsert }))
    vi.mocked(getAuthenticatedClient).mockResolvedValue({
      client: { from } as unknown as Awaited<ReturnType<typeof getAuthenticatedClient>>['client'],
      userId: 'learner-1',
    })
    const result = await saveLearningSession(session)
    expect(result.syncStatus).toBe('synced')
    expect(readLearningData().profile.localOnly).toBe(true)
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ session }), {
      onConflict: 'user_id,id',
    })
  })

  it('does not turn a local database profile into consent to upload to a hosted database', async () => {
    vi.mocked(isLocalSupabaseConfigured).mockReturnValue(true)
    const from = vi.fn(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { profile: { ...defaultProfile, name: 'Database profile', localOnly: false } },
            error: null,
          }),
          order: () => ({ limit: async () => ({ data: [], error: null }) }),
        }),
        order: async () => ({ data: [], error: null }),
      }),
    }))
    vi.mocked(getAuthenticatedClient).mockResolvedValue({
      client: { from } as unknown as Awaited<ReturnType<typeof getAuthenticatedClient>>['client'],
      userId: 'learner-1',
    })
    const loaded = await loadLearningData({ sync: true })
    expect(loaded.syncStatus).toBe('synced')
    expect(loaded.data.profile.name).toBe('Database profile')
    expect(loaded.data.profile.localOnly).toBe(true)
    expect(readLearningData().profile.localOnly).toBe(true)
    vi.mocked(isLocalSupabaseConfigured).mockReturnValue(false)
    vi.mocked(getAuthenticatedClient).mockClear()
    await saveLearningSession(session)
    expect(getAuthenticatedClient).not.toHaveBeenCalled()
  })

  it('does not regress a completed database record when an older live write arrives later', async () => {
    const completed: SessionRecord = {
      ...session,
      status: 'completed',
      updatedAt: '2026-10-15T12:02:00.000Z',
    }
    const partial: SessionRecord = {
      ...session,
      status: 'in-progress',
      updatedAt: '2026-10-15T12:01:00.000Z',
      messages: [],
    }
    await writeSessionDatabase(completed)
    await writeSessionDatabase(partial)
    expect(await readSessionDatabase()).toEqual([completed])
  })

  it('cancels a queued cloud session upload after the learner switches to local-only', async () => {
    values.set(STORAGE_KEYS.profile, JSON.stringify({ ...defaultProfile, localOnly: false }))
    let releaseIdentity!: (value: Awaited<ReturnType<typeof getAuthenticatedClient>>) => void
    vi.mocked(getAuthenticatedClient).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseIdentity = resolve
        }),
    )
    const saving = saveLearningSession(session)
    await vi.waitFor(() => expect(getAuthenticatedClient).toHaveBeenCalledOnce())
    values.set(STORAGE_KEYS.profile, JSON.stringify(defaultProfile))
    const from = vi.fn()
    releaseIdentity({
      client: { from } as unknown as Awaited<ReturnType<typeof getAuthenticatedClient>>['client'],
      userId: 'learner-1',
    })
    expect((await saving).syncStatus).toBe('local')
    expect(from).not.toHaveBeenCalled()
    expect(await readSessionDatabase()).toEqual([session])
  })

  it('serializes database sync so a slow live request finishes before the completed record', async () => {
    vi.mocked(isLocalSupabaseConfigured).mockReturnValue(true)
    let releaseFirst!: (value: { error: null }) => void
    const upsert = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve
          }),
      )
      .mockResolvedValue({ error: null })
    vi.mocked(getAuthenticatedClient).mockResolvedValue({
      client: { from: () => ({ upsert }) } as unknown as Awaited<
        ReturnType<typeof getAuthenticatedClient>
      >['client'],
      userId: 'learner-1',
    })
    const partial: SessionRecord = {
      ...session,
      status: 'in-progress',
      updatedAt: '2026-10-15T12:01:00.000Z',
      messages: [],
    }
    const completed: SessionRecord = {
      ...session,
      status: 'completed',
      updatedAt: '2026-10-15T12:02:00.000Z',
    }
    const firstSave = saveLearningSession(partial)
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce())
    const finalSave = saveLearningSession(completed)
    await vi.waitFor(async () => expect(await readSessionDatabase()).toEqual([completed]))
    expect(upsert).toHaveBeenCalledOnce()
    releaseFirst({ error: null })
    await Promise.all([firstSave, finalSave])
    expect(upsert).toHaveBeenCalledTimes(2)
    expect(upsert).toHaveBeenLastCalledWith(expect.objectContaining({ session: completed }), {
      onConflict: 'user_id,id',
    })
  })

  it('recovers safely from malformed stored profiles and history', () => {
    values.set(STORAGE_KEYS.profile, '{invalid')
    values.set(STORAGE_KEYS.sessions, JSON.stringify([session, { broken: true }]))
    expect(readLearningData().profile).toEqual(defaultProfile)
    expect(readLearningData().sessions).toEqual([session])
  })
})
