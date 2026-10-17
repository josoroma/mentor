import { describe, expect, it } from 'vitest'

import { defaultProfile, roles, scenarios } from '@/app/_constants'
import { FeedbackSchema, ProfileSchema, ScenarioSchema, SessionRecordSchema } from '@/app/_schema'
import type { Feedback, SessionRecord } from '@/app/_types'
import { getProgressSummary, getRecommendedDifficulty } from '@/lib/learning/progress'
import { mergeSessions, normalizeSessions, parseStoredValue } from '@/lib/learning/storage'

const sessionAt = (day: number, overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: `session-${day}`,
  scenarioId: 'daily-standup',
  roleId: 'deployed-ai-developer',
  level: 'B2',
  startedAt: new Date(2026, 9, day, 10).toISOString(),
  durationSeconds: 300,
  messages: [
    {
      id: `message-${day}`,
      role: 'user',
      content: 'I finished the implementation, and I am testing it today.',
      timestamp: new Date(2026, 9, day, 10).getTime(),
    },
  ],
  ...overrides,
})

const feedbackWithScore = (overallScore: number | null): Feedback => ({
  summary: 'A clear update with a specific next step.',
  overallScore,
  metrics: [
    {
      key: 'pronunciation',
      label: 'Pronunciation',
      score: null,
      feedback: 'Audio assessment is not available.',
    },
  ],
  strengths: ['The next step is clear.'],
  improvements: ['Include a timeframe.'],
  rewrites: [],
  nextStep: 'Try a stakeholder update.',
  source: 'practice-review',
})

describe('curated workplace curriculum', () => {
  it('contains valid scenarios usable by every curated role, including Forward-Deployed AI Engineer', () => {
    expect(roles.find((role) => role.id === 'deployed-ai-developer')?.name).toBe(
      'Forward-Deployed AI Engineer',
    )
    expect(scenarios).toHaveLength(12)
    expect(new Set(scenarios.map(({ id }) => id)).size).toBe(scenarios.length)
    for (const scenario of scenarios) {
      expect(ScenarioSchema.safeParse(scenario).success).toBe(true)
      expect(scenario.roleIds.every((id) => roles.some((role) => role.id === id))).toBe(true)
    }
    for (const role of roles)
      expect(scenarios.filter((scenario) => scenario.roleIds.includes(role.id))).toHaveLength(12)
  })

  it('starts local-only with a validated profile and supports unscored acoustic feedback', () => {
    expect(ProfileSchema.parse(defaultProfile).localOnly).toBe(true)
    expect(FeedbackSchema.parse(feedbackWithScore(null)).metrics[0].score).toBeNull()
    expect(SessionRecordSchema.safeParse(sessionAt(15, { durationSeconds: -1 })).success).toBe(
      false,
    )
    expect(SessionRecordSchema.safeParse(sessionAt(15, { startedAt: 'not-a-date' })).success).toBe(
      false,
    )
  })
})

describe('local history recovery', () => {
  it('drops corrupt records without discarding valid sessions', () => {
    expect(parseStoredValue('{broken')).toBeUndefined()
    expect(normalizeSessions([sessionAt(15), { id: 'bad-record' }, null])).toEqual([sessionAt(15)])
    expect(normalizeSessions({ unexpected: true })).toEqual([])
  })

  it('deduplicates sessions and retains feedback from an assessed copy', () => {
    const assessed = sessionAt(15, { feedback: feedbackWithScore(80) })
    const merged = mergeSessions([sessionAt(14), assessed], [sessionAt(15)])
    expect(merged.map(({ id }) => id)).toEqual(['session-15', 'session-14'])
    expect(merged[0].feedback?.overallScore).toBe(80)
  })

  it('preserves final corrections and completed transcripts against delayed partial snapshots', () => {
    const corrected = sessionAt(15, {
      status: 'completed',
      updatedAt: '2026-10-15T12:02:00.000Z',
      improvements: [
        {
          messageId: 'message-15',
          original: 'I finish test',
          improved: 'I finished the tests.',
          updatedAt: '2026-10-15T12:01:00.000Z',
          isFinal: true,
        },
      ],
    })
    const delayed = sessionAt(15, {
      status: 'in-progress',
      updatedAt: '2026-10-15T12:03:00.000Z',
      messages: [],
      pendingTranscript: { id: 'message-15', role: 'user', content: 'I finish', timestamp: 1 },
      improvements: [
        {
          messageId: 'message-15',
          original: 'I finish',
          improved: 'I finished',
          updatedAt: '2026-10-15T12:03:00.000Z',
          isFinal: false,
        },
      ],
    })
    expect(mergeSessions([corrected], [delayed])).toEqual([corrected])
  })

  it('retains interrupted raw speech until authoritative recognition replaces the draft', () => {
    const draft = {
      id: 'pending-turn',
      role: 'user' as const,
      content: 'Yesterday I fix',
      timestamp: 1,
    }
    const earlier = sessionAt(15, {
      status: 'in-progress',
      updatedAt: '2026-10-15T12:01:00.000Z',
      pendingTranscript: draft,
    })
    const paused = sessionAt(15, {
      status: 'in-progress',
      updatedAt: '2026-10-15T12:02:00.000Z',
    })
    const recovered = mergeSessions([earlier], [paused])[0]
    expect(recovered.pendingTranscript).toEqual(draft)
    const finalized = {
      ...paused,
      updatedAt: '2026-10-15T12:03:00.000Z',
      messages: [...paused.messages, { ...draft, content: 'Yesterday I fixed the login bug.' }],
    }
    expect(mergeSessions([recovered], [finalized])[0].pendingTranscript).toBeUndefined()
    expect(
      mergeSessions([recovered], [{ ...paused, status: 'completed' }])[0].pendingTranscript,
    ).toBeUndefined()
  })

  it('replaces a recovered draft when a new pending turn arrives', () => {
    const earlier = sessionAt(15, {
      status: 'in-progress',
      updatedAt: '2026-10-15T12:01:00.000Z',
      pendingTranscript: { id: 'old-turn', role: 'user', content: 'Yesterday I fix', timestamp: 1 },
    })
    const nextDraft = {
      id: 'new-turn',
      role: 'user' as const,
      content: 'Today I am testing',
      timestamp: 2,
    }
    const latest = {
      ...earlier,
      updatedAt: '2026-10-15T12:02:00.000Z',
      pendingTranscript: nextDraft,
    }
    expect(mergeSessions([earlier], [latest])[0].pendingTranscript).toEqual(nextDraft)
  })
})

describe('measurable progress', () => {
  const now = new Date(2026, 9, 15, 18)

  it('has an honest empty state before a learner practices', () => {
    const summary = getProgressSummary([], now)
    expect(summary.totalSessions).toBe(0)
    expect(summary.totalMinutes).toBe(0)
    expect(summary.currentStreak).toBe(0)
    expect(summary.averageScore).toBeNull()
    expect(summary.weeklyActivity.every((day) => day.sessions === 0)).toBe(true)
  })

  it('counts real practice once per day for streaks and excludes abandoned or future sessions', () => {
    const summary = getProgressSummary(
      [
        sessionAt(15, { id: 'today-a', feedback: feedbackWithScore(80) }),
        sessionAt(15, { id: 'today-b', feedback: feedbackWithScore(90) }),
        sessionAt(14),
        sessionAt(12, { scenarioId: 'code-review' }),
        sessionAt(16),
        sessionAt(13, { id: 'empty', messages: [] }),
        sessionAt(11, { id: 'zero-duration', durationSeconds: 0 }),
        sessionAt(10, {
          id: 'coach-only',
          messages: [{ id: 'coach', role: 'assistant', content: 'Hello', timestamp: 0 }],
        }),
      ],
      now,
    )
    expect(summary.totalSessions).toBe(4)
    expect(summary.totalMinutes).toBe(20)
    expect(summary.completedScenarios).toBe(2)
    expect(summary.currentStreak).toBe(2)
    expect(summary.longestStreak).toBe(2)
    expect(summary.practiceDays).toBe(3)
    expect(summary.averageScore).toBe(85)
    expect(summary.weeklyActivity[6].sessions).toBe(2)
  })

  it('keeps yesterday’s streak alive and resets after a missed day', () => {
    expect(getProgressSummary([sessionAt(14), sessionAt(13)], now).currentStreak).toBe(2)
    expect(getProgressSummary([sessionAt(13), sessionAt(12)], now).currentStreak).toBe(0)
    expect(getProgressSummary([sessionAt(13), sessionAt(12)], now).longestStreak).toBe(2)
  })

  it('does not count autosaved unfinished practice as completed progress', () => {
    const sessions = [sessionAt(15, { status: 'in-progress', feedback: feedbackWithScore(99) })]
    expect(getProgressSummary(sessions, now).totalSessions).toBe(0)
    expect(getProgressSummary(sessions, now).averageScore).toBeNull()
  })

  it('adapts difficulty only after three assessed sessions at the current level', () => {
    const sessions = [15, 14, 13].map((day) => sessionAt(day, { feedback: feedbackWithScore(90) }))
    expect(getRecommendedDifficulty('B2', sessions.slice(0, 2))).toBe('Intermediate')
    expect(getRecommendedDifficulty('B2', sessions)).toBe('Advanced')
    expect(getRecommendedDifficulty('A2', sessions)).toBe('Beginner')
    expect(
      getRecommendedDifficulty(
        'B2',
        sessions.map((session) => ({ ...session, feedback: feedbackWithScore(40) })),
      ),
    ).toBe('Beginner')
  })
})
