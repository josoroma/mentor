import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { SessionRecord } from '@/app/_types'
import { readSessionDatabase, writeSessionDatabase } from '@/lib/learning/session-database'
import { mergeSessions, normalizeSessions } from '@/lib/learning/storage'

const customSession: SessionRecord = {
  id: 'free-conversation-session',
  scenarioId: 'free-conversation-system-design',
  scenario: {
    id: 'free-conversation-system-design',
    title: 'Explaining a system design trade-off',
    description: 'Practice explaining why you chose a queue for asynchronous work.',
    category: 'Technical discussions',
    difficulty: 'Intermediate',
    minutes: 8,
    roleIds: ['deployed-ai-developer'],
    persona: { name: 'Alex', role: 'Your engineering colleague' },
    brief:
      'Discuss your design with a colleague. Start with the problem, explain the trade-off, and agree on a next step.',
    objectives: [
      'Explain the problem in plain English',
      'Compare a queue with a synchronous request',
      'Summarize the decision and its main risk',
    ],
    openingLine: 'What problem are you trying to solve with this design?',
    icon: 'messages-square',
    accent: 'blue',
  },
  conversation: {
    originalTopic: 'I want talk why we use queue instead call service direct',
    improvedTopic: 'I want to explain why we use a queue instead of calling the service directly.',
    stages: [
      { title: 'Set the context', focus: 'Explain the problem and who it affects.' },
      { title: 'Compare the choices', focus: 'Discuss reliability, latency, and complexity.' },
      { title: 'Make a recommendation', focus: 'State your choice, one risk, and the next step.' },
    ],
    usefulPhrases: [
      'The main reason for this choice is…',
      'One trade-off we need to consider is…',
      'My recommendation is to…',
    ],
  },
  roleId: 'deployed-ai-developer',
  level: 'B2',
  startedAt: '2026-10-15T12:00:00.000Z',
  durationSeconds: 90,
  status: 'in-progress',
  updatedAt: '2026-10-15T12:01:30.000Z',
  messages: [
    {
      id: 'custom-message-1',
      role: 'user',
      content: 'We use queue because the service can be down.',
      timestamp: 1_792_065_600_000,
    },
  ],
  improvements: [
    {
      messageId: 'custom-message-1',
      original: 'We use queue because the service can be down.',
      improved: 'We use a queue because the service may be unavailable.',
      updatedAt: '2026-10-15T12:01:25.000Z',
      isFinal: true,
    },
  ],
}

describe('free conversation history compatibility', () => {
  it('preserves the original topic, refined topic, plan, and scenario through JSON normalization', () => {
    const stored: unknown = JSON.parse(JSON.stringify([customSession]))
    const [restored] = normalizeSessions(stored)
    expect(restored).toEqual(customSession)
    expect(restored.conversation?.originalTopic).toBe(customSession.conversation?.originalTopic)
    expect(restored.conversation?.improvedTopic).toBe(customSession.conversation?.improvedTopic)
    expect(restored.conversation?.stages).toEqual(customSession.conversation?.stages)
    expect(restored.conversation?.usefulPhrases).toEqual(customSession.conversation?.usefulPhrases)
    expect(restored.scenario?.brief).toBe(customSession.scenario?.brief)
    expect(restored.messages[0].content).toBe(customSession.messages[0].content)
    expect(restored.improvements).toEqual(customSession.improvements)
  })

  it('continues to read curated legacy sessions without embedded scenario or plan metadata', () => {
    const legacy: SessionRecord = {
      id: 'legacy-session',
      scenarioId: 'daily-standup',
      roleId: 'deployed-ai-developer',
      level: 'B1',
      startedAt: '2026-10-14T12:00:00.000Z',
      durationSeconds: 60,
      messages: [],
    }
    const restored = normalizeSessions(JSON.parse(JSON.stringify([legacy, customSession])))
    expect(restored).toEqual([customSession, legacy])
    expect(restored[1]).not.toHaveProperty('scenario')
    expect(restored[1]).not.toHaveProperty('conversation')
  })

  it.each(['older-first', 'newer-first'])(
    'retains the conversation configuration when a newer partial snapshot omits it (%s)',
    (order) => {
      const partial: SessionRecord = {
        ...customSession,
        scenario: undefined,
        conversation: undefined,
        durationSeconds: 120,
        updatedAt: '2026-10-15T12:02:00.000Z',
        messages: [
          ...customSession.messages,
          {
            id: 'custom-message-2',
            role: 'assistant',
            content: 'How would you handle a message that fails repeatedly?',
            timestamp: 1_792_065_620_000,
          },
        ],
      }
      const [merged] =
        order === 'older-first'
          ? mergeSessions([customSession], [partial])
          : mergeSessions([partial], [customSession])
      expect(merged.durationSeconds).toBe(120)
      expect(merged.messages).toEqual(partial.messages)
      expect(merged.scenario).toEqual(customSession.scenario)
      expect(merged.conversation).toEqual(customSession.conversation)
    },
  )

  it('rejects malformed stored plan data instead of presenting an unvalidated conversation', () => {
    const malformed = {
      ...customSession,
      id: 'invalid-conversation',
      conversation: { ...customSession.conversation, stages: [{ title: 'Missing focus' }] },
    }
    expect(normalizeSessions([malformed, customSession])).toEqual([customSession])
  })
})

describe('free conversation database restoration', () => {
  beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()))
  afterEach(() => vi.unstubAllGlobals())

  it('restores a custom conversation and its transcript without needing the curated scenario catalog', async () => {
    await writeSessionDatabase(customSession)
    const restored = await readSessionDatabase()
    expect(restored).toEqual([customSession])
    expect(restored[0].scenario?.id).toBe(restored[0].scenarioId)
    expect(restored[0].conversation?.stages).toHaveLength(3)
  })

  it('retains the original plan during completion and a delayed autosave', async () => {
    await writeSessionDatabase(customSession)
    const completed: SessionRecord = {
      ...customSession,
      scenario: undefined,
      conversation: undefined,
      status: 'completed',
      durationSeconds: 180,
      updatedAt: '2026-10-15T12:03:00.000Z',
    }
    const saved = await writeSessionDatabase(completed)
    await writeSessionDatabase(customSession)
    const [restored] = await readSessionDatabase()
    expect(restored.status).toBe('completed')
    expect(restored.durationSeconds).toBe(180)
    expect(restored.scenario).toEqual(customSession.scenario)
    expect(restored.conversation).toEqual(customSession.conversation)
    expect(restored).toEqual(saved)
  })
})
