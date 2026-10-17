import { ArrowRight, AudioLines, ChartNoAxesCombined, Clock3, Flame, Target } from 'lucide-react'
import { format, isSameDay, startOfWeek, addDays } from 'date-fns'
import type { SessionRecord } from '@/app/_types'
import { Button } from '@/app/_components/ui/button'

export const ProgressView = ({
  sessions,
  onPractice,
}: {
  sessions: SessionRecord[]
  onPractice: () => void
}) => {
  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 })
  const activity = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(weekStart, index)
    return {
      date,
      minutes: sessions
        .filter((s) => isSameDay(new Date(s.startedAt), date))
        .reduce((sum, s) => sum + s.durationSeconds / 60, 0),
    }
  })
  const metrics = ['grammar', 'vocabulary', 'clarity', 'conciseness', 'professionalism']
  const totalMinutes = Math.floor(
    sessions.reduce((sum, session) => sum + session.durationSeconds, 0) / 60,
  )
  return (
    <div className="page-enter secondary-view">
      <div className="eyebrow">
        <span />
        YOUR PRACTICE IS ADDING UP
      </div>
      <h1>A clearer voice, one day at a time.</h1>
      <p className="page-subtitle">
        Your progress, grounded in the conversations you’ve actually had.
      </p>
      <div className="progress-stat-grid">
        {[
          { icon: AudioLines, value: sessions.length, label: 'Conversations practiced' },
          { icon: Clock3, value: totalMinutes, label: 'Minutes finding your voice' },
          {
            icon: Target,
            value: new Set(sessions.map((s) => s.scenarioId)).size,
            label: 'Situations explored',
          },
        ].map(({ icon: Icon, value, label }) => (
          <div className="progress-stat" key={label}>
            <Icon size={21} />
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="progress-detail-grid">
        <div className="content-panel">
          <div className="panel-heading">
            <h2>Your week in practice</h2>
            <Flame size={18} />
          </div>
          <p>Small moments of practice build lasting confidence.</p>
          <div className="activity-chart">
            {activity.map(({ date, minutes }) => (
              <div key={date.toISOString()}>
                <span>{Math.round(minutes)}m</span>
                <div className="chart-track">
                  <i
                    style={{
                      height: `${Math.max(3, (minutes / Math.max(15, ...activity.map((d) => d.minutes))) * 100)}%`,
                    }}
                  />
                </div>
                <small>{format(date, 'EEE')}</small>
              </div>
            ))}
          </div>
        </div>
        <div className="content-panel">
          <div className="panel-heading">
            <h2>Your communication skills</h2>
            <ChartNoAxesCombined size={19} />
          </div>
          <p>Average coach observations across reviewed sessions.</p>
          <div className="skill-list">
            {metrics.map((metric) => {
              const scores = sessions.flatMap(
                (s) =>
                  s.feedback?.metrics
                    .filter((m) => m.key === metric && m.score !== null)
                    .map((m) => m.score as number) ?? [],
              )
              const average = scores.length
                ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
                : null
              return (
                <div key={metric}>
                  <div>
                    <span>{metric}</span>
                    <strong>{average === null ? 'Not assessed' : `${average} / 100`}</strong>
                  </div>
                  <div className="skill-track">
                    <i style={{ width: `${average ?? 0}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
      {sessions.length === 0 && (
        <div className="progress-cta">
          <span className="note-icon">
            <AudioLines size={22} />
          </span>
          <div>
            <h3>This is where your growth takes shape.</h3>
            <p>Finish your first conversation to start building your personal progress story.</p>
          </div>
          <Button onClick={onPractice}>
            Find a conversation
            <ArrowRight size={16} />
          </Button>
        </div>
      )}
    </div>
  )
}
