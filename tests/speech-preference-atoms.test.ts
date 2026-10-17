import { createStore } from 'jotai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { profileAtom } from '@/app/_atoms'
import { defaultProfile } from '@/app/_constants'
import { STORAGE_KEYS } from '@/lib/learning/storage'

describe('speech selection across browser tabs', () => {
  let values: Map<string, string>
  let browser: EventTarget
  const subscriptions: Array<() => void> = []

  beforeEach(() => {
    values = new Map()
    browser = Object.assign(new EventTarget(), {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    })
    vi.stubGlobal('window', browser)
  })
  afterEach(() => {
    subscriptions.splice(0).forEach((unsubscribe) => unsubscribe())
    vi.unstubAllGlobals()
  })

  it('refreshes Settings and preserves another tab’s new engine when editing the profile', () => {
    values.set(
      STORAGE_KEYS.profile,
      JSON.stringify({ ...defaultProfile, speechProvider: 'chatterbox' }),
    )
    const store = createStore()
    subscriptions.push(store.sub(profileAtom, vi.fn()))
    expect(store.get(profileAtom).speechProvider).toBe('chatterbox')
    values.set(
      STORAGE_KEYS.profile,
      JSON.stringify({ ...defaultProfile, speechProvider: 'kokoro' }),
    )
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: STORAGE_KEYS.profile }))
    expect(store.get(profileAtom).speechProvider).toBe('kokoro')
    store.set(profileAtom, { ...store.get(profileAtom), name: 'Updated learner' })
    expect(JSON.parse(values.get(STORAGE_KEYS.profile) ?? '{}').speechProvider).toBe('kokoro')
  })

  it('validates external changes, handles removal, and cleans up subscriptions', () => {
    const store = createStore()
    const changed = vi.fn()
    const unsubscribe = store.sub(profileAtom, changed)
    subscriptions.push(unsubscribe)
    values.set(STORAGE_KEYS.profile, JSON.stringify({ ...defaultProfile, speechProvider: 'macos' }))
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: STORAGE_KEYS.sessions }))
    expect(store.get(profileAtom).speechProvider).toBeUndefined()
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: STORAGE_KEYS.profile }))
    expect(store.get(profileAtom).speechProvider).toBe('macos')
    values.set(
      STORAGE_KEYS.profile,
      JSON.stringify({ ...defaultProfile, speechProvider: 'hosted' }),
    )
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: STORAGE_KEYS.profile }))
    expect(store.get(profileAtom)).toEqual(defaultProfile)
    values.clear()
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: null }))
    expect(store.get(profileAtom)).toEqual(defaultProfile)
    unsubscribe()
    changed.mockClear()
    values.set(
      STORAGE_KEYS.profile,
      JSON.stringify({ ...defaultProfile, speechProvider: 'kokoro' }),
    )
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: STORAGE_KEYS.profile }))
    expect(changed).not.toHaveBeenCalled()
  })
})
