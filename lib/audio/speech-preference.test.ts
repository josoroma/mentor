import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultProfile } from '@/app/_constants'
import { ProfileSchema } from '@/app/_schema'
import { STORAGE_KEYS } from '@/lib/learning/storage'
import {
  notifySpeechProviderChange,
  readSpeechProvider,
  subscribeSpeechProviderChange,
} from '@/lib/audio/speech-preference'
import { resolveSpeechProviderStatus, SpeechProviderSchema } from '@/lib/audio/speech-provider'

describe('saved speech provider preference', () => {
  let values: Map<string, string>
  let browser: EventTarget

  beforeEach(() => {
    values = new Map()
    browser = Object.assign(new EventTarget(), {
      localStorage: { getItem: (key: string) => values.get(key) ?? null },
    })
    vi.stubGlobal('window', browser)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('uses Kokoro for new and legacy profiles without inventing a saved choice', () => {
    expect(readSpeechProvider()).toBe('kokoro')
    expect(ProfileSchema.parse(defaultProfile)).not.toHaveProperty('speechProvider')
    values.set(STORAGE_KEYS.profile, JSON.stringify(defaultProfile))
    expect(readSpeechProvider()).toBe('kokoro')
    expect(JSON.parse(values.get(STORAGE_KEYS.profile)!)).not.toHaveProperty('speechProvider')
  })

  it.each(SpeechProviderSchema.options)('validates and restores the %s preference', (provider) => {
    const profile = ProfileSchema.parse({ ...defaultProfile, speechProvider: provider })
    values.set(STORAGE_KEYS.profile, JSON.stringify(profile))
    expect(readSpeechProvider()).toBe(provider)
  })

  it('rejects unsupported engines and tolerates unavailable browser storage', () => {
    expect(ProfileSchema.safeParse({ ...defaultProfile, speechProvider: 'hosted' }).success).toBe(
      false,
    )
    values.set(STORAGE_KEYS.profile, '{bad json')
    expect(readSpeechProvider()).toBe('kokoro')
    vi.stubGlobal('window', {
      get localStorage() {
        throw new Error('Storage unavailable')
      },
    })
    expect(readSpeechProvider()).toBe('kokoro')
    vi.stubGlobal('window', undefined)
    expect(readSpeechProvider()).toBe('kokoro')
  })

  it('notifies active audio only when the voice preference changes, then detaches', () => {
    const changed = vi.fn()
    const unsubscribe = subscribeSpeechProviderChange(changed)
    notifySpeechProviderChange()
    expect(changed).not.toHaveBeenCalled()
    values.set(
      STORAGE_KEYS.profile,
      JSON.stringify({ ...defaultProfile, speechProvider: 'kokoro' }),
    )
    notifySpeechProviderChange()
    expect(changed).not.toHaveBeenCalled()
    values.set(
      STORAGE_KEYS.profile,
      JSON.stringify({ ...defaultProfile, speechProvider: 'chatterbox' }),
    )
    notifySpeechProviderChange()
    expect(changed).toHaveBeenCalledTimes(1)
    notifySpeechProviderChange()
    expect(changed).toHaveBeenCalledTimes(1)
    values.set(STORAGE_KEYS.profile, JSON.stringify({ ...defaultProfile, speechProvider: 'macos' }))
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: STORAGE_KEYS.sessions }))
    expect(changed).toHaveBeenCalledTimes(1)
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: STORAGE_KEYS.profile }))
    expect(changed).toHaveBeenCalledTimes(2)
    values.clear()
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: null }))
    expect(changed).toHaveBeenCalledTimes(3)
    unsubscribe()
    values.set(STORAGE_KEYS.profile, JSON.stringify({ speechProvider: 'chatterbox' }))
    notifySpeechProviderChange()
    expect(changed).toHaveBeenCalledTimes(3)
  })
})

describe('selected voice readiness', () => {
  const speech = {
    provider: 'chatterbox',
    synthesis: false,
    recognition: true,
    providers: {
      chatterbox: { provider: 'chatterbox', synthesis: false },
      macos: { provider: 'macos', synthesis: true },
      kokoro: { provider: 'kokoro', synthesis: true },
    },
  }

  it('uses the chosen engine even when the server default is unavailable', () => {
    expect(resolveSpeechProviderStatus(speech, 'macos')?.synthesis).toBe(true)
    expect(resolveSpeechProviderStatus(speech, 'kokoro')?.synthesis).toBe(true)
    expect(resolveSpeechProviderStatus(speech)).toEqual(speech.providers.kokoro)
  })

  it('never substitutes the default when a chosen engine is absent from health', () => {
    const oldService = { provider: 'chatterbox', synthesis: true }
    expect(resolveSpeechProviderStatus(oldService, 'kokoro')).toBeUndefined()
    expect(resolveSpeechProviderStatus(oldService, 'chatterbox')).toEqual(oldService)
  })
})
