import { describe, expect, it } from 'vitest'
import { scenarios } from '@/app/_constants'
import { ScenarioSchema, SessionRecordSchema } from '@/app/_schema'
import { getSpeechPersonaName, type SpeechPersonaId } from '@/lib/audio/personas'
import {
  assignScenarioPersona,
  getAvailableSpeechPersonas,
  resolveAvailableSpeechPersonas,
  selectSpeechPersona,
  selectSpeechPersonaPair,
  SpeechPersonaPairSchema,
} from '@/lib/audio/persona-selection'

const ids: SpeechPersonaId[] = ['alex', 'sam', 'jordan', 'riley']
const personas = ids.map((id) => ({ id, name: getSpeechPersonaName(id), languages: ['en'] }))

describe('supported conversation persona selection', () => {
  it('uses only actual ready capabilities from the selected engine and language', () => {
    const health = {
      speech: {
        provider: 'chatterbox',
        synthesis: false,
        providers: {
          chatterbox: { synthesis: false, personas: personas.slice(0, 2) },
          kokoro: { synthesis: true, personas },
        },
      },
    }
    expect(resolveAvailableSpeechPersonas(health, 'kokoro').personas).toEqual(personas)
    expect(resolveAvailableSpeechPersonas(health)).toEqual({ provider: 'kokoro', personas })
    expect(resolveAvailableSpeechPersonas(health, 'macos').personas).toEqual([])
    expect(getAvailableSpeechPersonas({ synthesis: true, personas }, 'es')).toEqual([])
    expect(getAvailableSpeechPersonas({ synthesis: true })).toEqual([])
  })

  it('chooses distinct supported pairs and avoids repeating the same people when possible', () => {
    const pair = selectSpeechPersonaPair(ids, undefined, () => 0)
    expect(pair).toEqual({ alex: 'alex', sam: 'sam' })
    const next = selectSpeechPersonaPair(ids, pair, () => 0)
    expect(new Set(Object.values(next))).not.toEqual(new Set(Object.values(pair)))
    expect(SpeechPersonaPairSchema.safeParse(next).success).toBe(true)
    expect(selectSpeechPersonaPair(['alex', 'sam'], pair, () => 0)).toEqual({
      alex: 'sam',
      sam: 'alex',
    })
    expect(() => selectSpeechPersonaPair(['alex', 'alex'])).toThrow('Two distinct')
    expect(SpeechPersonaPairSchema.safeParse({ alex: 'riley', sam: 'riley' }).success).toBe(false)
  })

  it('varies a practice partner without selecting an unsupported voice', () => {
    expect(selectSpeechPersona(ids, 'alex', () => 0)).toBe('sam')
    expect(selectSpeechPersona(['jordan'], 'jordan', () => 0)).toBe('jordan')
    expect(() => selectSpeechPersona([])).toThrow('No supported')
  })

  it('stores a session-specific name and voice while leaving saved scenarios unchanged', () => {
    const original = ScenarioSchema.parse({
      ...scenarios[0],
      persona: { name: 'Alex', role: 'Your teammate' },
      openingLine: 'I am Alex. What did you work on?',
      brief: 'Explain your next step to Alex.',
    })
    const assigned = assignScenarioPersona(original, personas[3])
    expect(assigned.persona).toEqual({ id: 'riley', name: 'Riley', role: 'Your teammate' })
    expect(assigned.openingLine).toContain('I am Riley.')
    expect(assigned.brief).toContain('to Riley.')
    expect(original.persona).toEqual({ name: 'Alex', role: 'Your teammate' })
    const record = SessionRecordSchema.parse({
      id: 'saved-session',
      scenarioId: assigned.id,
      scenario: assigned,
      roleId: assigned.roleIds[0],
      level: 'B2',
      startedAt: new Date().toISOString(),
      durationSeconds: 1,
      messages: [],
    })
    expect(SessionRecordSchema.parse(JSON.parse(JSON.stringify(record))).scenario?.persona).toEqual(
      assigned.persona,
    )
  })
})
