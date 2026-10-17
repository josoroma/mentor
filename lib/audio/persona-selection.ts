import { z } from 'zod'
import {
  SpeechPersonaIdSchema,
  SpeechPersonaSchema,
  type SpeechPersonaId,
} from '@/lib/audio/personas'
import {
  defaultSpeechProvider,
  resolveSpeechProviderStatus,
  SpeechProviderSchema,
  type SpeechProvider,
  type SpeechProviderStatus,
} from '@/lib/audio/speech-provider'
import type { Scenario } from '@/app/_types'

export const SpeechPersonaPairSchema = z
  .object({
    alex: SpeechPersonaIdSchema,
    sam: SpeechPersonaIdSchema,
  })
  .refine((pair) => pair.alex !== pair.sam, 'Choose two different conversation voices.')
export type SpeechPersonaPair = z.infer<typeof SpeechPersonaPairSchema>
export const defaultPersonaPair: SpeechPersonaPair = { alex: 'alex', sam: 'sam' }

const PersonaCapabilitiesSchema = z.object({
  provider: SpeechProviderSchema.optional(),
  synthesis: z.boolean().optional(),
  personas: z.array(SpeechPersonaSchema).max(32).optional(),
})
const PersonaHealthSchema = z.object({
  speech: PersonaCapabilitiesSchema.extend({
    providers: z.partialRecord(SpeechProviderSchema, PersonaCapabilitiesSchema).optional(),
  }).optional(),
})

export const resolveAvailableSpeechPersonas = (health: unknown, provider?: SpeechProvider) => {
  const parsed = PersonaHealthSchema.parse(health)
  const selected = provider ?? defaultSpeechProvider
  return {
    provider: selected,
    personas: getAvailableSpeechPersonas(resolveSpeechProviderStatus(parsed.speech, selected)),
  }
}

export const getAvailableSpeechPersonas = (
  status: SpeechProviderStatus | undefined,
  language = 'en',
) => {
  if (!status?.synthesis) return []
  const result = z.array(SpeechPersonaSchema).max(32).safeParse(status.personas)
  if (!result.success) return []
  return result.data.filter(
    (persona, index, all) =>
      persona.languages.includes(language) &&
      all.findIndex((item) => item.id === persona.id) === index,
  )
}

export const selectSpeechPersona = (
  available: SpeechPersonaId[],
  previous?: SpeechPersonaId,
  random: () => number = Math.random,
): SpeechPersonaId => {
  const candidates = [...new Set(available)]
  const fresh = candidates.length > 1 ? candidates.filter((id) => id !== previous) : candidates
  if (!fresh.length) throw new Error('No supported conversation voice is ready. Check Settings.')
  return fresh[Math.min(fresh.length - 1, Math.floor(random() * fresh.length))]
}

export const selectSpeechPersonaPair = (
  available: SpeechPersonaId[],
  previous?: SpeechPersonaPair,
  random: () => number = Math.random,
): SpeechPersonaPair => {
  const candidates = [...new Set(available)]
  const pairs = candidates.flatMap((alex) =>
    candidates.filter((sam) => sam !== alex).map((sam) => ({ alex, sam })),
  )
  if (!pairs.length)
    throw new Error('Two distinct conversation voices are not ready. Check Settings.')
  const differentPeople = pairs.filter(
    (pair) =>
      !previous ||
      ![previous.alex, previous.sam].includes(pair.alex) ||
      ![previous.alex, previous.sam].includes(pair.sam),
  )
  const differentOrder = pairs.filter(
    (pair) => pair.alex !== previous?.alex || pair.sam !== previous?.sam,
  )
  const fresh = differentPeople.length
    ? differentPeople
    : differentOrder.length
      ? differentOrder
      : pairs
  return fresh[Math.min(fresh.length - 1, Math.floor(random() * fresh.length))]
}

/** Copy the configured scenario; saved scenarios and past sessions keep their identity. */
export const assignScenarioPersona = (
  scenario: Scenario,
  persona: z.infer<typeof SpeechPersonaSchema>,
): Scenario => {
  const previousName = scenario.persona.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rename = (text: string) =>
    text.replace(new RegExp(`\\b${previousName}\\b`, 'g'), persona.name)
  return {
    ...scenario,
    persona: { ...scenario.persona, id: persona.id, name: persona.name },
    openingLine: rename(scenario.openingLine),
    brief: rename(scenario.brief),
  }
}
