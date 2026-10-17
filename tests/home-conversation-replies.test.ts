import { describe, expect, it } from 'vitest'
import { createHomeConversationRepliesContext } from '@/app/_home-conversation-replies'
import { createReplySuggestionsSnapshot } from '@/app/_reply-suggestions-controller'
import { DemoConversationSchema } from '@/lib/ai/demo-conversation'

const conversation = DemoConversationSchema.parse({
  id: '24e35c6d-043f-42ca-9101-223b66b9a790',
  topic: 'Making the handover easier',
  turns: [
    { speaker: 'alex', text: 'We could prepare a short visual guide.' },
    { speaker: 'sam', text: 'Which part should we explain first?' },
    { speaker: 'alex', text: 'Let us start with the sign-in screen.' },
    { speaker: 'sam', text: 'A checklist could help with the next steps.' },
    { speaker: 'alex', text: 'We could ask someone to try the guide.' },
    { speaker: 'sam', text: 'That would help us improve the handover.' },
  ],
})
const input = {
  conversation,
  startedTurnCount: 2,
  profile: { roleId: 'deployed-ai-developer', level: 'B1' as const },
  selection: { path: 'professional' as const, roleId: 'deployed-ai-developer' },
}

describe('homepage conversation entry suggestions', () => {
  it('uses only shown turns, keeping every AI statement out of learner history', () => {
    const context = createHomeConversationRepliesContext(input)!
    expect(context.request.mode).toBe('join')
    expect(context.request.messages).toHaveLength(2)
    expect(context.request.messages.every((message) => message.role === 'assistant')).toBe(true)
    expect(context.request.messages[0].content).toMatch(
      /: We could prepare a short visual guide\.$/,
    )
    expect(JSON.stringify(context.request)).not.toContain('sign-in screen')
    expect(JSON.stringify(context.request)).not.toContain('checklist')
  })

  it('waits for a shown turn and a chosen focus before requesting contextual ideas', () => {
    expect(createHomeConversationRepliesContext({ ...input, conversation: null })).toBeNull()
    expect(createHomeConversationRepliesContext({ ...input, selection: null })).toBeNull()
    for (const startedTurnCount of [0, -1, NaN, Infinity]) {
      expect(createHomeConversationRepliesContext({ ...input, startedTurnCount })).toBeNull()
    }
    expect(
      createHomeConversationRepliesContext({ ...input, startedTurnCount: 99 })?.request.messages,
    ).toHaveLength(6)
  })

  it('includes real learner contributions after joining without relabeling AI speech', () => {
    const turns = [
      { id: 'ai-1', speaker: 'alex' as const, text: 'We could prepare a short visual guide.', timestamp: 1 },
      { id: 'user-1', speaker: 'user' as const, text: 'Could the guide be in Spanish too?', timestamp: 2 },
      { id: 'ai-2', speaker: 'sam' as const, text: 'Yes, we could include Spanish instructions.', timestamp: 3 },
    ]
    const context = createHomeConversationRepliesContext({
      ...input,
      conversation: { ...conversation, turns },
      startedTurnCount: turns.length,
    })!
    expect(context.request.messages.map((message) => message.role)).toEqual([
      'assistant',
      'user',
      'assistant',
    ])
    expect(context.request.messages[1].content).toBe('Could the guide be in Spanish too?')
    expect(context.request.messages[2].content).toMatch(/: Yes, we could include Spanish instructions\.$/)
  })

  it('invalidates ideas for each new turn, exchange, focus, or English level', () => {
    const first = createHomeConversationRepliesContext(input)!
    const changes = [
      { ...input, startedTurnCount: 3 },
      { ...input, conversation: { ...conversation, id: '55f7e7cc-2075-4d11-aa33-0a18b38f79f1' } },
      { ...input, profile: { ...input.profile, level: 'A2' as const } },
      { ...input, selection: { path: 'professional' as const, roleId: 'software-engineer' } },
    ]
    changes.forEach((change) => {
      expect(createHomeConversationRepliesContext(change)?.key).not.toBe(first.key)
    })
  })

  it('keeps three usable join-in starters while waiting for context or generation', () => {
    const context = createHomeConversationRepliesContext(input)!
    const starting = createReplySuggestionsSnapshot(null, 'join')
    const pending = createReplySuggestionsSnapshot(context)
    expect(starting.replies).toHaveLength(3)
    expect(starting.replies).toEqual(pending.replies)
    expect(starting.isGenerated).toBe(false)
    expect(pending.isGenerated).toBe(false)
    expect(starting.replies.every((reply) => reply.text.length < 100)).toBe(true)
    expect(starting.replies).not.toEqual(createReplySuggestionsSnapshot().replies)
  })
})
