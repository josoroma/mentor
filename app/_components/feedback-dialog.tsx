'use client'

import { useState } from 'react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  Download,
  LoaderCircle,
  MessageSquare,
  Sparkles,
  Target,
} from 'lucide-react'
import type { Scenario, SessionRecord } from '@/app/_types'
import { Modal } from '@/app/_components/ui/modal'
import { Button } from '@/app/_components/ui/button'
import { ImprovedSpeechButton } from '@/app/_components/improved-speech-button'
import styles from '@/app/_components/free-conversation.module.css'
import playbackStyles from '@/app/_components/improvement-playback.module.css'

const downloadTranscript = (session: SessionRecord, title: string) => {
  const text = [
    `mentor · ${title}`,
    new Date(session.startedAt).toLocaleString(),
    ...(session.status === 'in-progress' ? ['Session in progress · saved draft'] : []),
    '',
    ...(session.conversation
      ? [
          `${session.scenario?.learningSelection ? 'Selected focus' : 'Your topic'}: ${session.conversation.originalTopic}`,
          `${session.scenario?.learningSelection ? 'Practice goal' : 'Improved topic'}: ${session.conversation.improvedTopic}`,
          'Your conversation plan:',
          ...session.conversation.stages.map(
            (stage, index) => `${index + 1}. ${stage.title}: ${stage.focus}`,
          ),
          `Useful phrases: ${session.conversation.usefulPhrases.join(' · ')}`,
          '',
        ]
      : []),
    ...session.messages.flatMap((message) => {
      const improvement = session.improvements?.find((item) => item.messageId === message.id)
      return [
        `${message.role === 'user' ? 'You' : 'Coach'}: ${message.content}`,
        ...(improvement
          ? [
              `Improved English${improvement.isFinal ? '' : ' (live draft)'}: ${improvement.improved}`,
            ]
          : []),
        '',
      ]
    }),
    ...(session.pendingTranscript
      ? [
          `You (unfinished transcript): ${session.pendingTranscript.content}`,
          ...(session.improvements ?? [])
            .filter((item) => item.messageId === session.pendingTranscript?.id)
            .map((item) => `Improved English (live draft): ${item.improved}`),
          '',
        ]
      : []),
    ...(session.feedback
      ? ['', 'Coach feedback', session.feedback.summary, '', ...session.feedback.improvements]
      : []),
  ].join('\n')
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `mentor-${session.scenarioId}-${session.startedAt.slice(0, 10)}.txt`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const FeedbackDialog = ({
  session,
  saved,
  scenario,
  loading,
  error,
  onClose,
  onRetry,
}: {
  session: SessionRecord | null
  saved: boolean
  scenario?: Scenario
  loading: boolean
  error: string | null
  onClose: () => void
  onRetry: () => void
}) => {
  const [expandedDetails, setExpandedDetails] = useState<{
    sessionId: string
    plan: boolean
    transcript: boolean
  } | null>(null)
  const planExpanded = expandedDetails?.sessionId === session?.id && expandedDetails?.plan
  const transcriptExpanded =
    expandedDetails?.sessionId === session?.id && expandedDetails?.transcript
  const toggleDetails = (section: 'plan' | 'transcript', open: boolean) => {
    if (!session) return
    setExpandedDetails((current) => ({
      sessionId: session.id,
      plan: current?.sessionId === session.id ? current.plan : false,
      transcript: current?.sessionId === session.id ? current.transcript : false,
      [section]: open,
    }))
  }

  return (
    <Modal
      open={!!session}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={
        loading
          ? 'A moment to reflect'
          : session?.status === 'in-progress'
            ? 'Your conversation, saved so far.'
            : 'Every conversation is a step forward.'
      }
      description={scenario?.title ?? 'Your practice session'}
      className="feedback-modal"
    >
      {session && (
        <div className="feedback-body">
          <div className="feedback-session-meta">
            <span>
              {Math.floor(session.durationSeconds / 60)}m {session.durationSeconds % 60}s practiced
            </span>
            <span>{session.messages.filter((m) => m.role === 'user').length} responses</span>
            <span>{session.level} level</span>
            {session.status === 'in-progress' && (
              <span className="session-draft-label">In progress · saved draft</span>
            )}
          </div>
          {loading ? (
            <div className="feedback-loading">
              <LoaderCircle size={30} className="spin" />
              <h3>Your coach is reviewing your conversation.</h3>
              <p>
                Looking for the things you did well and the small changes that make a difference.
              </p>
            </div>
          ) : session.feedback ? (
            <>
              <div className="feedback-summary">
                <span className="note-icon">
                  <Sparkles size={21} />
                </span>
                <p>{session.feedback.summary}</p>
                {session.feedback.overallScore !== null && (
                  <strong>
                    {Math.round(session.feedback.overallScore)}
                    <small>/100</small>
                  </strong>
                )}
              </div>
              <div className="feedback-columns">
                <section>
                  <h3>
                    <Check size={16} />
                    What’s working
                  </h3>
                  <ul>
                    {session.feedback.strengths.map((strength) => (
                      <li key={strength}>{strength}</li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3>
                    <Target size={16} />
                    Try this next time
                  </h3>
                  <ul>
                    {session.feedback.improvements.map((improvement) => (
                      <li key={improvement}>{improvement}</li>
                    ))}
                  </ul>
                </section>
              </div>
              <div className="feedback-metrics">
                {session.feedback.metrics.map((metric) => (
                  <div key={metric.key}>
                    <div>
                      <span>{metric.label}</span>
                      <strong>
                        {metric.score === null
                          ? 'Not assessed'
                          : `${Math.round(metric.score)} / 100`}
                      </strong>
                    </div>
                    <p>{metric.feedback}</p>
                  </div>
                ))}
              </div>
              {session.feedback.rewrites.length > 0 && (
                <section className="rewrite-section">
                  <h3>A clearer way to say it</h3>
                  {session.feedback.rewrites.map((rewrite, index) => (
                    <div className="rewrite" key={index}>
                      <p className="original-quote">“{rewrite.original}”</p>
                      <ArrowRight size={16} />
                      <div className={playbackStyles.rewrite}>
                        <p className="improved-quote">“{rewrite.improved}”</p>
                        {rewrite.improved.trim() && (
                          <div className={playbackStyles.control}>
                            <ImprovedSpeechButton
                              text={rewrite.improved}
                              label={`improved feedback example ${index + 1}`}
                            />
                          </div>
                        )}
                      </div>
                      <small>{rewrite.reason}</small>
                    </div>
                  ))}
                </section>
              )}
              <div className="next-step">
                <Target size={18} />
                <p>{session.feedback.nextStep}</p>
              </div>
              <p className="feedback-disclaimer">
                Coach feedback is based on your transcript. Pronunciation and vocal delivery need
                audio-based assessment and aren’t scored here.
              </p>
            </>
          ) : (
            <div className="feedback-unavailable">
              <MessageSquare size={27} />
              <h3>
                {saved ? 'Your conversation is saved.' : 'Your conversation is ready to review.'}
              </h3>
              <p>
                {error ??
                  (session.status === 'in-progress'
                    ? 'Review the transcript and improved phrasing saved during your conversation.'
                    : 'Practice a few spoken responses to receive personalized feedback.')}
              </p>
              {session.status !== 'in-progress' &&
                session.messages.some((message) => message.role === 'user') && (
                  <Button variant="secondary" onClick={onRetry}>
                    Get coach feedback
                    <Sparkles size={15} />
                  </Button>
                )}
            </div>
          )}
          {session.conversation && (
            <details
              className={styles.savedPlan}
              open={planExpanded}
              onToggle={(event) => toggleDetails('plan', event.currentTarget.open)}
            >
              <summary>Your topic & conversation plan</summary>
              <p>
                <strong>
                  {session.scenario?.learningSelection ? 'Selected focus:' : 'You said:'}
                </strong>{' '}
                {session.conversation.originalTopic}
              </p>
              <p>
                <strong>
                  {session.scenario?.learningSelection ? 'Practice goal:' : 'A clearer topic:'}
                </strong>{' '}
                {session.conversation.improvedTopic}
              </p>
              {planExpanded && session.conversation.improvedTopic.trim() && (
                <div className={playbackStyles.control}>
                  <ImprovedSpeechButton
                    text={session.conversation.improvedTopic}
                    label="saved improved topic"
                  />
                </div>
              )}
              <ol>
                {session.conversation.stages.map((stage, index) => (
                  <li key={index}>
                    <strong>{stage.title}.</strong> {stage.focus}
                  </li>
                ))}
              </ol>
              <p>
                <strong>Phrases to try:</strong> {session.conversation.usefulPhrases.join(' · ')}
              </p>
            </details>
          )}
          <details
            className="saved-transcript"
            open={transcriptExpanded}
            onToggle={(event) => toggleDetails('transcript', event.currentTarget.open)}
          >
            <summary>
              {session.improvements?.length
                ? 'Review transcript & improved English'
                : 'Review your conversation'}
              <ChevronDown size={16} />
            </summary>
            <div>
              {session.messages.map((message, index) => {
                const improvement = session.improvements?.find(
                  (item) => item.messageId === message.id,
                )
                return (
                  <div className={`saved-message saved-${message.role}`} key={message.id}>
                    {improvement ? (
                      <div className="saved-message-pair">
                        <div>
                          <strong>You · original</strong>
                          <p>{message.content}</p>
                        </div>
                        <div className="saved-improvement">
                          <strong>
                            <Sparkles size={11} /> Improved English
                          </strong>
                          <p>{improvement.improved}</p>
                          {transcriptExpanded && improvement.improved.trim() && (
                            <div className={playbackStyles.control}>
                              <ImprovedSpeechButton
                                text={improvement.improved}
                                label={`saved improved response ${index + 1}`}
                              />
                            </div>
                          )}
                          {!improvement.isFinal && (
                            <small>Live draft · phrasing may be incomplete</small>
                          )}
                        </div>
                      </div>
                    ) : (
                      <>
                        <strong>
                          {message.role === 'user' ? 'You' : (scenario?.persona.name ?? 'Coach')}
                        </strong>
                        <p>{message.content}</p>
                      </>
                    )}
                  </div>
                )
              })}
              {session.pendingTranscript && (
                <div className="saved-pending-transcript">
                  <strong>You · unfinished transcript</strong>
                  <p>{session.pendingTranscript.content}</p>
                  {session.improvements
                    ?.filter((item) => item.messageId === session.pendingTranscript?.id)
                    .map((item) => (
                      <div className="saved-message-pair" key={item.messageId}>
                        <div className="saved-improvement">
                          <strong>
                            <Sparkles size={11} /> Improved English
                          </strong>
                          <p>{item.improved}</p>
                          {transcriptExpanded && item.improved.trim() && (
                            <div className={playbackStyles.control}>
                              <ImprovedSpeechButton
                                text={item.improved}
                                label="saved improved draft"
                              />
                            </div>
                          )}
                          <small>Live draft · phrasing may be incomplete</small>
                        </div>
                      </div>
                    ))}
                  <small>This response was still being transcribed when the draft was saved.</small>
                </div>
              )}
            </div>
          </details>
          <Button
            className="feedback-export"
            variant="secondary"
            onClick={() => downloadTranscript(session, scenario?.title ?? 'Practice conversation')}
          >
            <Download size={15} />
            Download transcript
          </Button>
          <Button className="feedback-done" onClick={onClose}>
            Keep growing
            <ArrowRight size={16} />
          </Button>
        </div>
      )}
    </Modal>
  )
}
