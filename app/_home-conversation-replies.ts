import { ReplySuggestionsRequestSchema } from '@/app/_reply-suggestions'
import type { ReplySuggestionsContext } from '@/app/_reply-suggestions-controller'
import type { Profile } from '@/app/_types'
import type { DemoConversation } from '@/lib/ai/demo-conversation'
import { getSpeechPersonaName } from '@/lib/audio/personas'
import type { LearningSelection } from '@/lib/learning/paths'
import type { HomeConversationEntry } from '@/app/_home-conversation-controller'

// Preserve speaker roles so suggestions never treat an AI statement as the learner's own.
export const createHomeConversationRepliesContext = ({
  conversation,
  startedTurnCount,
  profile,
  selection,
}: {
  conversation:
    | (Pick<DemoConversation, 'id' | 'topic' | 'personas'> & {
        turns: Array<DemoConversation['turns'][number] | HomeConversationEntry>
      })
    | null
  startedTurnCount: number
  profile: Pick<Profile, 'roleId' | 'level'>
  selection: LearningSelection | null
}): ReplySuggestionsContext | null => {
  if (!conversation || !selection || !Number.isFinite(startedTurnCount)) return null
  const count = Math.min(conversation.turns.length, Math.max(0, Math.floor(startedTurnCount)))
  if (!count) return null
  const scenarioId = `demo-${conversation.id}`
  const names = [conversation.personas.alex, conversation.personas.sam].map(getSpeechPersonaName)
  const request = ReplySuggestionsRequestSchema.safeParse({
    mode: 'join',
    scenarioId,
    roleId: profile.roleId,
    level: profile.level,
    scenario: {
      id: scenarioId,
      title: conversation.topic,
      description: 'Join an ongoing conversation with two AI partners.',
      category: 'Daily communication',
      difficulty: 'Beginner',
      minutes: 5,
      roleIds: [profile.roleId],
      persona: { name: names.join(' and '), role: 'Fictional conversation partners' },
      brief:
        'The learner wants a short way to join or continue the displayed exchange. Only user turns establish what the learner has said.',
      objectives: ['Catch up, ask a relevant question, or suggest an idea in your own words.'],
      openingLine: conversation.turns[0].text,
      icon: 'message-circle',
      accent: 'blue',
      learningSelection: selection,
    },
    messages: conversation.turns
      .slice(0, count)
      .slice(-12)
      .map((turn) => ({
        role: turn.speaker === 'user' ? 'user' : 'assistant',
        content:
          turn.speaker === 'user'
            ? turn.text.slice(-6000)
            : `${getSpeechPersonaName(conversation.personas[turn.speaker])}: ${turn.text}`,
      })),
  })
  if (!request.success) return null
  const turnId = `${conversation.id}:${count}`
  return { key: JSON.stringify([turnId, request.data]), turnId, request: request.data }
}
