import { z } from 'zod'

import {
  ScenarioSchema,
  SessionRecordSchema,
  TranscriptImprovementSchema,
  TranscriptMessageSchema,
} from '@/app/_schema'
import type { Profile, Scenario, SessionRecord, TranscriptImprovement } from '@/app/_types'
import { getSpeechPersonaName } from '@/lib/audio/personas'
import type { SpeechPersonaPair } from '@/lib/audio/persona-selection'
import type { LearningSelection } from '@/lib/learning/paths'

export const HomeConversationTurnSchema = z.object({
  id: z.string().min(1),
  speaker: z.enum(['alex', 'sam', 'user']),
  text: z.string().min(1).max(20_000),
  timestamp: z.number().finite().nonnegative().max(253_402_300_799_999),
})
export type HomeConversationTurn = z.infer<typeof HomeConversationTurnSchema>

const HomeConversationTurnsSchema = z
  .array(HomeConversationTurnSchema)
  .refine(
    (turns) => new Set(turns.map((turn) => turn.id)).size === turns.length,
    'Conversation turns must have unique identifiers.',
  )

export const createHomeConversationScenario = ({
  id,
  topic,
  profile,
  selection,
  personas,
  openingLine,
}: {
  id: string
  topic: string
  profile: Pick<Profile, 'roleId' | 'level'>
  selection: LearningSelection | null
  personas: SpeechPersonaPair
  openingLine?: string
}): Scenario =>
  ScenarioSchema.parse({
    id: `home-${id}`,
    title: topic || 'Homepage conversation',
    description: 'An ongoing conversation with two AI partners on the homepage.',
    category: 'Daily communication',
    difficulty: ['A2', 'B1'].includes(profile.level) ? 'Beginner' : 'Intermediate',
    minutes: 5,
    roleIds: [profile.roleId],
    persona: {
      name: [personas.alex, personas.sam].map(getSpeechPersonaName).join(' and '),
      role: 'AI conversation partners',
    },
    brief:
      'The learner can listen, join, and leave space for the two AI partners to continue. Preserve the meaning of the learner’s actual words.',
    objectives: ['Join the conversation and express your ideas in your own words.'],
    openingLine: openingLine || 'Join whenever you are ready.',
    icon: 'message-circle',
    accent: 'blue',
    ...(selection && { learningSelection: selection }),
  })

export const createHomeConversationMessages = (
  turns: HomeConversationTurn[],
  personas: SpeechPersonaPair,
) =>
  HomeConversationTurnsSchema.parse(turns).flatMap((turn) => {
    const content =
      turn.speaker === 'user'
        ? turn.text
        : `${getSpeechPersonaName(personas[turn.speaker])}: ${turn.text}`
    // An author label must not cause a valid long source line to be truncated.
    const fragments = content.match(/[\s\S]{1,20000}/g) ?? []
    return fragments.map((fragment, index) =>
      TranscriptMessageSchema.parse({
        id: index === 0 ? turn.id : `${turn.id}:fragment:${index}`,
        role: turn.speaker === 'user' ? 'user' : 'assistant',
        content: fragment,
        timestamp: turn.timestamp,
      }),
    )
  })

export const createHomeConversationRecords = ({
  id,
  scenario,
  profile,
  messages,
  improvements,
}: {
  id: string
  scenario: Scenario
  profile: Pick<Profile, 'roleId' | 'level'>
  messages: ReturnType<typeof createHomeConversationMessages>
  improvements: TranscriptImprovement[]
}): SessionRecord[] => {
  const conversationId = z.string().min(1).max(90).parse(id)
  const transcript = TranscriptMessageSchema.array().parse(messages)
  const firstLearner = transcript.find((message) => message.role === 'user')
  if (!firstLearner) return []

  const corrections = TranscriptImprovementSchema.array().parse(improvements)
  const groups: (typeof transcript)[] = []
  let group: typeof transcript = []
  let earliest = Infinity
  let latest = 0
  for (const message of transcript) {
    const start = Math.min(earliest, message.timestamp)
    const end = Math.max(latest, message.timestamp)
    if (group.length && (group.length === 1_000 || end - start > 86_400_000)) {
      groups.push(group)
      group = []
      earliest = Infinity
      latest = 0
    }
    group.push(message)
    earliest = Math.min(earliest, message.timestamp)
    latest = Math.max(latest, message.timestamp)
  }
  if (group.length) groups.push(group)

  return groups.map((entries, index) => {
    const start = Math.min(...entries.map((message) => message.timestamp))
    const end = Math.max(...entries.map((message) => message.timestamp))
    const learnerMessages = new Map(
      entries.filter((message) => message.role === 'user').map((message) => [message.id, message]),
    )
    const matchingCorrections = corrections.filter(
      (item) => learnerMessages.get(item.messageId)?.content === item.original,
    )
    const updatedAt = new Date(
      Math.max(end, ...matchingCorrections.map((item) => Date.parse(item.updatedAt))),
    ).toISOString()
    // Listening before the first actual learner turn is never counted as practice time.
    const participationStart = Math.max(start, firstLearner.timestamp)
    return SessionRecordSchema.parse({
      id: `home-${conversationId}-part-${index + 1}`,
      scenarioId: scenario.id,
      scenario,
      roleId: profile.roleId,
      level: profile.level,
      startedAt: new Date(start).toISOString(),
      updatedAt,
      durationSeconds: Math.max(0, Math.floor((end - participationStart) / 1_000)),
      messages: entries,
      improvements: matchingCorrections,
      status: 'in-progress',
    })
  })
}
