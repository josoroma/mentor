import { createStore } from 'jotai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { learningSelectionAtom, profileAtom } from '@/app/_atoms'
import { defaultProfile } from '@/app/_constants'
import { STORAGE_KEYS } from '@/lib/learning/storage'

describe('one saved learning focus across the app', () => {
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

  it('hydrates the exact saved category/topic and updates all subscribers across tabs', () => {
    const focus = {
      path: 'life-skills' as const,
      categoryId: 'public-speaking',
      topicId: 'storytelling',
    }
    values.set(
      STORAGE_KEYS.profile,
      JSON.stringify({ ...defaultProfile, learningSelection: focus }),
    )
    const store = createStore()
    subscriptions.push(store.sub(learningSelectionAtom, vi.fn()))
    expect(store.get(learningSelectionAtom)).toEqual(focus)
    const next = { path: 'professional' as const, roleId: 'devops-engineer' }
    values.set(STORAGE_KEYS.profile, JSON.stringify({ ...defaultProfile, learningSelection: next }))
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: STORAGE_KEYS.profile }))
    expect(store.get(learningSelectionAtom)).toEqual(next)
    const reloaded = createStore()
    subscriptions.push(reloaded.sub(learningSelectionAtom, vi.fn()))
    expect(reloaded.get(learningSelectionAtom)).toEqual(next)
  })

  it('does not reset a focus form or regenerate content for an unrelated audio preference change', () => {
    const store = createStore()
    const changed = vi.fn()
    subscriptions.push(store.sub(learningSelectionAtom, changed))
    const before = store.get(learningSelectionAtom)
    store.set(profileAtom, { ...store.get(profileAtom), speechProvider: 'kokoro' })
    expect(store.get(learningSelectionAtom)).toBe(before)
    expect(changed).not.toHaveBeenCalled()
  })
})
