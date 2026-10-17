import { z } from 'zod'
import {
  defaultSpeechProvider,
  SpeechProviderSchema,
  type SpeechProvider,
} from '@/lib/audio/speech-provider'
import { parseStoredValue, STORAGE_KEYS } from '@/lib/learning/storage'

const StoredPreferenceSchema = z.object({ speechProvider: SpeechProviderSchema.optional() })
const preferenceEvent = 'mentor:speech-provider-changed'

/** Read once per playback/turn so queued chunks keep one voice engine. */
export const readSpeechProvider = (): SpeechProvider => {
  if (typeof window === 'undefined') return defaultSpeechProvider
  try {
    const profile = StoredPreferenceSchema.safeParse(
      parseStoredValue(window.localStorage.getItem(STORAGE_KEYS.profile)),
    )
    return (profile.success ? profile.data.speechProvider : undefined) ?? defaultSpeechProvider
  } catch {
    return defaultSpeechProvider
  }
}

export const notifySpeechProviderChange = () => {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function')
    window.dispatchEvent(new Event(preferenceEvent))
}

/** Stop active audio when Settings, another tab, or a restore changes the choice. */
export const subscribeSpeechProviderChange = (listener: () => void) => {
  if (typeof window === 'undefined') return () => {}
  let previous = readSpeechProvider()
  const changed = () => {
    const next = readSpeechProvider()
    if (previous === next) return
    previous = next
    listener()
  }
  const stored = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEYS.profile) changed()
  }
  window.addEventListener(preferenceEvent, changed)
  window.addEventListener('storage', stored)
  return () => {
    window.removeEventListener(preferenceEvent, changed)
    window.removeEventListener('storage', stored)
  }
}
