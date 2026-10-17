import { describe, expect, it } from 'vitest'
import { getDemoConversationSubjects } from '@/lib/ai/demo-topics'
import {
  HomeConversationRequestSchema,
  HomeConversationSchema,
  type HomeConversation,
  type HomeConversationRequest,
} from '@/lib/ai/home-conversation'
import { selectHomeConversationTransition } from '@/lib/ai/home-conversation-transition'
import { lifeSkillCategories, professionalRoles } from '@/lib/learning/path-catalog'

const role = professionalRoles[0]
const makeRequest = (changes: Partial<HomeConversationRequest> = {}) =>
  HomeConversationRequestSchema.parse({ roleId: role.id, level: 'B1', ...changes })

const appendConversation = (
  request: HomeConversationRequest,
  conversation: HomeConversation,
  batch: number,
): HomeConversationRequest => ({
  ...request,
  topic: conversation.topic,
  recentTopics: [conversation.topic, ...request.recentTopics].slice(0, 8),
  history: [
    ...request.history,
    ...conversation.turns.map((turn, index) => ({ ...turn, id: `${batch}-${index}` })),
  ].slice(-24),
})

describe('homepage related-topic transitions', () => {
  it.each(['alex', 'sam'] as const)(
    'continues with %s and its partner without asking another question',
    (nextSpeaker) => {
      const request = makeRequest({ nextSpeaker })
      const conversation = selectHomeConversationTransition(request, role)

      expect(HomeConversationSchema.safeParse(conversation).success).toBe(true)
      expect(conversation.turns.map(({ speaker }) => speaker)).toEqual([
        nextSpeaker,
        nextSpeaker === 'alex' ? 'sam' : 'alex',
      ])
      expect(conversation.turns.map(({ text }) => text).join(' ')).not.toMatch(
        /\?|retry|try again|repeated|stuck|paused|local model|error/i,
      )
    },
  )

  it('moves away from the current subject and recent subjects while retaining role relevance', () => {
    const subjects = getDemoConversationSubjects(role.id)
    const request = makeRequest({
      topic: subjects[0].slice(0, 100),
      recentTopics: [subjects[1].slice(0, 100)],
      history: [{ id: 'last', speaker: 'sam', text: `We were discussing ${subjects[2]}.` }],
    })

    const conversation = selectHomeConversationTransition(request, role)
    const opening = conversation.turns[0].text
    expect(subjects.slice(3).some((subject) => opening.includes(subject))).toBe(true)
    expect(subjects.slice(0, 3).some((subject) => opening.includes(subject))).toBe(false)
    expect(conversation.topic).not.toBe(request.topic)
  })

  it('uses the explicitly selected role instead of an older saved role', () => {
    const selectedRole = professionalRoles.find(({ id }) => id === 'ux-researcher')!
    const conversation = selectHomeConversationTransition(
      makeRequest({ selection: { path: 'professional', roleId: selectedRole.id } }),
      role,
    )

    expect(
      getDemoConversationSubjects(selectedRole.id).some((subject) =>
        conversation.turns[0].text.includes(subject),
      ),
    ).toBe(true)
    expect(conversation.turns[0].text).not.toContain('customer support workflow')
  })

  it('considers older actual excerpts without mutating or inventing learner history', () => {
    const first = selectHomeConversationTransition(makeRequest(), role)
    const request = makeRequest({
      earlierContext: first.turns.map((turn, index) => ({ ...turn, id: `older-${index}` })),
      history: [{ id: 'user', speaker: 'user', text: 'I do not agree to that plan.' }],
    })
    const snapshot = structuredClone(request)
    const next = selectHomeConversationTransition(request, role)

    expect(next.topic).not.toBe(first.topic)
    expect(next.turns.every((turn) => first.turns.every((older) => older.text !== turn.text))).toBe(
      true,
    )
    expect(next.turns.map(({ text }) => text).join(' ')).not.toMatch(
      /you (said|agreed|need|have|are)|we (agreed|decided)|as agreed|your (experience|symptoms|history)/i,
    )
    expect(request).toEqual(snapshot)
  })

  it('keeps providing new spoken angles through a bounded recent-history window', () => {
    let request = makeRequest()

    for (let batch = 0; batch < 32; batch++) {
      const conversation = selectHomeConversationTransition(request, role)
      expect(request.recentTopics).not.toContain(conversation.topic)
      for (const { text } of conversation.turns) {
        expect(request.history.some((turn) => turn.text === text)).toBe(false)
      }
      request = appendConversation(request, conversation, batch)
    }
  })

  it('keeps life-skills pivots inside the exact topic and varies their substance', () => {
    let request = makeRequest({
      selection: { path: 'life-skills', categoryId: 'public-speaking', topicId: 'storytelling' },
    })
    const topics = new Set<string>()
    const secondTurns = new Set<string>()

    for (let batch = 0; batch < 12; batch++) {
      const conversation = selectHomeConversationTransition(request, role)
      expect(conversation.topic).toMatch(/^Storytelling: /)
      expect(conversation.turns[0].text).toContain('storytelling')
      expect(conversation.turns.map(({ text }) => text).join(' ')).not.toMatch(
        /AI pilot|customer CRM|retrieval|job interviews|salary negotiation/i,
      )
      expect(topics.has(conversation.topic)).toBe(false)
      expect(secondTurns.has(conversation.turns[1].text)).toBe(false)
      topics.add(conversation.topic)
      secondTurns.add(conversation.turns[1].text)
      request = appendConversation(request, conversation, batch)
    }
  })

  it('models communication for wellness without offering medical answers or inventing symptoms', () => {
    let request = makeRequest({
      selection: {
        path: 'life-skills',
        categoryId: 'nutrition-metabolic-health',
        topicId: 'understanding-insulin-resistance',
      },
      history: [{ id: 'user', speaker: 'user', text: 'Does this mean I need medication?' }],
    })

    for (let batch = 0; batch < 16; batch++) {
      const conversation = selectHomeConversationTransition(request, role)
      expect(conversation.topic).toMatch(/^Understanding Insulin Resistance: /)
      expect(conversation.turns.map(({ text }) => text).join(' ')).not.toMatch(
        /diagnos|prescri|medication|treatment|symptoms|diet|you (need|have|should)|blood sugar|\d+%/i,
      )
      request = appendConversation(request, conversation, batch)
    }
  })

  it('produces speakable, valid transitions for every configured role and life-skills topic', () => {
    for (const catalogRole of professionalRoles) {
      let request = makeRequest({ roleId: catalogRole.id })
      for (let batch = 0; batch < 8; batch++) {
        const conversation = selectHomeConversationTransition(request, catalogRole)
        expect(HomeConversationSchema.safeParse(conversation).success).toBe(true)
        expect(
          getDemoConversationSubjects(catalogRole.id).some((subject) =>
            conversation.turns[0].text.includes(subject),
          ),
        ).toBe(true)
        request = appendConversation(request, conversation, batch)
      }
    }
    for (const category of lifeSkillCategories) {
      for (const topic of category.topics) {
        const request = makeRequest({
          selection: { path: 'life-skills', categoryId: category.id, topicId: topic.id },
        })
        const conversation = selectHomeConversationTransition(request, role)
        expect(HomeConversationSchema.safeParse(conversation).success).toBe(true)
        expect(conversation.topic).toContain(topic.name)
        expect(conversation.turns[0].text).toContain(topic.name.toLowerCase())
      }
    }
  })
})
