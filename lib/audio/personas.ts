import { z } from 'zod'

export const SpeechPersonaIdSchema = z.enum(['alex', 'sam', 'jordan', 'riley'])
export type SpeechPersonaId = z.infer<typeof SpeechPersonaIdSchema>

export const SPEECH_PERSONAS = [
  { id: 'alex', name: 'Alex' },
  { id: 'sam', name: 'Sam' },
  { id: 'jordan', name: 'Jordan' },
  { id: 'riley', name: 'Riley' },
] as const satisfies ReadonlyArray<{ id: SpeechPersonaId; name: string }>

export const getSpeechPersonaName = (id: SpeechPersonaId): string =>
  SPEECH_PERSONAS.find((persona) => persona.id === id)!.name

/** Languages are capabilities of the installed engine, not of a name globally. */
export const SpeechPersonaSchema = z
  .object({
    id: SpeechPersonaIdSchema,
    name: z.string().min(1).max(40),
    languages: z
      .array(z.string().regex(/^[a-z]{2}$/))
      .min(1)
      .max(23),
  })
  .refine((persona) => persona.name === getSpeechPersonaName(persona.id), {
    message: 'Use the built-in name for this voice persona.',
  })
export type SpeechPersona = z.infer<typeof SpeechPersonaSchema>
