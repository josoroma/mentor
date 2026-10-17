'use client'

import { atom } from 'jotai'
import { atomWithStorage, selectAtom } from 'jotai/utils'

import { defaultProfile } from '@/app/_constants'
import { ProfileSchema } from '@/app/_schema'
import type {
  ActiveTab,
  Profile,
  SessionRecord,
  SessionState,
  TranscriptMessage,
} from '@/app/_types'
import { getProgressSummary } from '@/lib/learning/progress'
import { getProfileLearningSelection } from '@/lib/learning/paths'
import {
  normalizeSessions,
  parseStoredValue,
  STORAGE_KEYS,
  writeStored,
} from '@/lib/learning/storage'

const validatedStorage = <T>(validate: (value: unknown) => T | undefined) => ({
  getItem: (key: string, initialValue: T): T => {
    if (typeof window === 'undefined') return initialValue
    try {
      return validate(parseStoredValue(window.localStorage.getItem(key))) ?? initialValue
    } catch {
      return initialValue
    }
  },
  setItem: (key: string, value: T): void => writeStored(key, value),
  removeItem: (key: string): void => {
    if (typeof window !== 'undefined') window.localStorage.removeItem(key)
  },
  subscribe: (key: string, callback: (value: T) => void, initialValue: T) => {
    if (typeof window === 'undefined') return () => {}
    const changed = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return
      if (event.storageArea && event.storageArea !== window.localStorage) return
      try {
        callback(validate(parseStoredValue(window.localStorage.getItem(key))) ?? initialValue)
      } catch {
        callback(initialValue)
      }
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  },
})

export const profileAtom = atomWithStorage<Profile>(
  STORAGE_KEYS.profile,
  defaultProfile,
  validatedStorage((value) => {
    const result = ProfileSchema.safeParse(value)
    return result.success ? result.data : undefined
  }),
)
export const selectedRoleIdAtom = atomWithStorage<string>(
  STORAGE_KEYS.selectedRole,
  defaultProfile.roleId,
  validatedStorage((value) => (typeof value === 'string' ? value : undefined)),
)
export const selectedScenarioIdAtom = atomWithStorage<string | null>(
  STORAGE_KEYS.selectedScenario,
  null,
  validatedStorage((value) => (typeof value === 'string' ? value : null)),
)
export const sessionHistoryAtom = atomWithStorage<SessionRecord[]>(
  STORAGE_KEYS.sessions,
  [],
  validatedStorage(normalizeSessions),
)
export const activeTabAtom = atom<ActiveTab>('practice')
// One persisted profile is authoritative for Settings, Practice, and Explore.
export const learningSelectionAtom = selectAtom(
  profileAtom,
  getProfileLearningSelection,
  (previous, next) => JSON.stringify(previous) === JSON.stringify(next),
)
export const sessionStateAtom = atom<SessionState>('idle')
export const transcriptAtom = atom<TranscriptMessage[]>([])
export const progressAtom = atom((get) => getProgressSummary(get(sessionHistoryAtom)))
