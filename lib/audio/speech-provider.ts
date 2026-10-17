import { z } from 'zod'
import type { SpeechPersona } from '@/lib/audio/personas'

export const SpeechProviderSchema = z.enum(['macos', 'kokoro', 'chatterbox'])
export type SpeechProvider = z.infer<typeof SpeechProviderSchema>
export const defaultSpeechProvider: SpeechProvider = 'kokoro'

export type SpeechProviderStatus = {
  provider?: string
  synthesis?: boolean
  synthesisModel?: string
  device?: string
  languages?: string[]
  voices?: { coach?: string; partner?: string }
  conversationSynthesis?: boolean
  personas?: SpeechPersona[]
  ready?: boolean
  detail?: string
}

export type SpeechServiceStatus = SpeechProviderStatus & {
  available?: boolean
  recognition?: boolean
  providers?: Partial<Record<SpeechProvider, SpeechProviderStatus>>
}

/** The selected or default engine must never inherit another engine's readiness. */
export const resolveSpeechProviderStatus = (
  speech: SpeechServiceStatus | undefined,
  provider: SpeechProvider = defaultSpeechProvider,
): SpeechProviderStatus | undefined => {
  return speech?.providers?.[provider] ?? (speech?.provider === provider ? speech : undefined)
}
