import { ArrowRight, AudioLines, ChevronRight, Clock3, History } from 'lucide-react'
import { format } from 'date-fns'
import type { Scenario, SessionRecord } from '@/app/_types'
import { Button } from '@/app/_components/ui/button'

export const HistoryView = ({
  sessions,
  scenarios,
  onSelect,
  onPractice,
}: {
  sessions: SessionRecord[]
  scenarios: Scenario[]
  onSelect: (session: SessionRecord) => void
  onPractice: () => void
}) => (
  <div className="secondary-view page-enter">
    <div className="eyebrow">
      <span />
      EVERY CONVERSATION COUNTS
    </div>
    <h1>Your practice, all in one place.</h1>
    <p className="page-subtitle">
      Revisit a moment, pick up a better phrase, and see how far you’ve come.
    </p>
    {sessions.length ? (
      <div className="history-list">
        {[...sessions]
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .map((session) => (
            <button key={session.id} onClick={() => onSelect(session)}>
              <span className="history-icon">
                <AudioLines size={22} />
              </span>
              <div>
                <h3>
                  {session.scenario?.title ??
                    scenarios.find((scenario) => scenario.id === session.scenarioId)?.title ??
                    'Practice conversation'}
                </h3>
                <p>
                  {format(new Date(session.startedAt), 'MMM d, yyyy · h:mm a')}
                  <span>·</span>
                  {session.level}
                  {session.conversation && (
                    <>
                      <span>·</span>
                      {session.scenario?.learningSelection?.path === 'life-skills'
                        ? 'Life & Workplace Skills'
                        : session.scenario?.learningSelection?.path === 'professional'
                          ? 'Professional Roles'
                          : 'Free conversation'}
                    </>
                  )}
                  {session.status === 'in-progress' && (
                    <>
                      <span>·</span>
                      <span className="history-draft-label">In progress</span>
                    </>
                  )}
                </p>
              </div>
              <span className="history-duration">
                <Clock3 size={14} />
                {Math.floor(session.durationSeconds / 60)}m {session.durationSeconds % 60}s
              </span>
              <span className="history-score">
                {session.feedback?.overallScore != null
                  ? `${Math.round(session.feedback.overallScore)} / 100`
                  : 'View session'}
              </span>
              <ChevronRight size={18} />
            </button>
          ))}
      </div>
    ) : (
      <div className="empty-history">
        <span className="empty-history-icon">
          <History size={34} />
        </span>
        <h2>Your story starts with a conversation.</h2>
        <p>
          Your saved sessions, transcripts, and improved English will appear here.
          <br />
          You only need a few minutes to begin.
        </p>
        <Button onClick={onPractice}>
          Start your first practice
          <ArrowRight size={17} />
        </Button>
      </div>
    )}
  </div>
)
