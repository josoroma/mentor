import { z } from 'zod'
import { ProficiencyLevelSchema, ScenarioSchema } from '@/app/_schema'
import { SpeechProviderSchema } from '@/lib/audio/speech-provider'
import { SpeechPersonaIdSchema } from '@/lib/audio/personas'

export { SpeechProviderSchema, type SpeechProvider } from '@/lib/audio/speech-provider'

export const CoachMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(6000),
})

export const CoachRequestSchema = z.object({
  scenarioId: z.string().min(1).max(100),
  roleId: z.string().min(1).max(100),
  level: ProficiencyLevelSchema,
  scenario: ScenarioSchema.optional(),
  messages: z.array(CoachMessageSchema).max(100),
})

export const FeedbackRequestSchema = CoachRequestSchema.extend({
  durationSeconds: z.number().finite().min(0).max(86_400),
})

// Chatterbox Multilingual's supported language identifiers. Omitted language
// keeps existing request JSON unchanged and uses the speech service's English default.
export const SpeechLanguageSchema = z.enum([
  'ar',
  'da',
  'de',
  'el',
  'en',
  'es',
  'fi',
  'fr',
  'he',
  'hi',
  'it',
  'ja',
  'ko',
  'ms',
  'nl',
  'no',
  'pl',
  'pt',
  'ru',
  'sv',
  'sw',
  'tr',
  'zh',
])
export type SpeechLanguage = z.infer<typeof SpeechLanguageSchema>

export const SpeechRequestSchema = z.object({
  text: z.string().trim().min(1).max(2400),
  voice: z.enum(['coach', 'partner']).default('coach'),
  language: SpeechLanguageSchema.optional(),
  provider: SpeechProviderSchema.optional(),
  persona: SpeechPersonaIdSchema.optional(),
})

export const TranscriptionSchema = z.object({
  text: z.string(),
  language: z.string().default('en'),
  durationSeconds: z.number().nonnegative().optional(),
  words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })).optional(),
})

export type CoachRequest = z.infer<typeof CoachRequestSchema>
export type CoachMessage = z.infer<typeof CoachMessageSchema>
export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>
