import { differenceInCalendarDays, format, isValid, parseISO, startOfDay, subDays } from 'date-fns'

import type { SessionRecord } from '@/app/_types'

export type PracticeDay = {
  date: string
  label: string
  minutes: number
  sessions: number
}

export type ProgressSummary = {
  totalSessions: number
  totalMinutes: number
  completedScenarios: number
  currentStreak: number
  longestStreak: number
  averageScore: number | null
  practiceDays: number
  thisWeekMinutes: number
  weeklyActivity: PracticeDay[]
}

export const getProgressSummary = (
  sessions: SessionRecord[],
  now = new Date(),
): ProgressSummary => {
  const today = startOfDay(now)
  const completed = sessions.filter((session) => {
    const date = parseISO(session.startedAt)
    return (
      session.status !== 'in-progress' &&
      isValid(date) &&
      date <= now &&
      session.durationSeconds > 0 &&
      session.messages.some((message) => message.role === 'user')
    )
  })
  const byDay = new Map<string, { seconds: number; sessions: number }>()
  for (const session of completed) {
    const key = format(parseISO(session.startedAt), 'yyyy-MM-dd')
    const day = byDay.get(key) ?? { seconds: 0, sessions: 0 }
    byDay.set(key, { seconds: day.seconds + session.durationSeconds, sessions: day.sessions + 1 })
  }

  const dates = [...byDay.keys()].sort().reverse()
  let currentStreak = 0
  const firstDay = dates[0] ? differenceInCalendarDays(today, parseISO(dates[0])) : null
  if (firstDay === 0 || firstDay === 1) {
    for (const [index, date] of dates.entries()) {
      if (differenceInCalendarDays(today, parseISO(date)) !== firstDay + index) break
      currentStreak += 1
    }
  }

  let longestStreak = 0
  let runningStreak = 0
  let previous: string | undefined
  for (const date of dates) {
    runningStreak =
      previous && differenceInCalendarDays(parseISO(previous), parseISO(date)) === 1
        ? runningStreak + 1
        : 1
    longestStreak = Math.max(longestStreak, runningStreak)
    previous = date
  }

  const weeklyActivity = Array.from({ length: 7 }, (_, index) => {
    const date = subDays(today, 6 - index)
    const key = format(date, 'yyyy-MM-dd')
    const day = byDay.get(key)
    return {
      date: key,
      label: format(date, 'EEE'),
      minutes: Math.round(((day?.seconds ?? 0) / 60) * 10) / 10,
      sessions: day?.sessions ?? 0,
    }
  })

  const scores = completed.flatMap((session) =>
    typeof session.feedback?.overallScore === 'number' ? [session.feedback.overallScore] : [],
  )
  return {
    totalSessions: completed.length,
    totalMinutes: Math.round(
      completed.reduce((total, session) => total + session.durationSeconds, 0) / 60,
    ),
    completedScenarios: new Set(completed.map(({ scenarioId }) => scenarioId)).size,
    currentStreak,
    longestStreak,
    averageScore: scores.length
      ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
      : null,
    practiceDays: dates.length,
    thisWeekMinutes: Math.round(weeklyActivity.reduce((total, day) => total + day.minutes, 0)),
    weeklyActivity,
  }
}

export const getRecommendedDifficulty = (
  level: SessionRecord['level'],
  sessions: SessionRecord[],
): 'Beginner' | 'Intermediate' | 'Advanced' => {
  const recentScores = [...sessions]
    .filter(
      (session) =>
        session.status !== 'in-progress' &&
        session.level === level &&
        session.messages.some((message) => message.role === 'user'),
    )
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, 3)
    .flatMap((session) =>
      typeof session.feedback?.overallScore === 'number' ? [session.feedback.overallScore] : [],
    )
  const baseline = level === 'A2' ? 0 : level === 'C1' || level === 'C2' ? 2 : 1
  // Adapt only after three assessed sessions; insufficient evidence keeps the learner's selected level.
  const average =
    recentScores.length === 3 ? recentScores.reduce((sum, score) => sum + score, 0) / 3 : null
  const adjustment = average === null ? 0 : average >= 85 ? 1 : average < 55 ? -1 : 0
  return (['Beginner', 'Intermediate', 'Advanced'] as const)[
    Math.max(0, Math.min(2, baseline + adjustment))
  ]
}
