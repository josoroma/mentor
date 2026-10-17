'use client'

import { useEffect, useId, useRef } from 'react'
import {
  Check,
  CircleAlert,
  CloudCheck,
  CloudUpload,
  Headphones,
  LoaderCircle,
  MonitorCheck,
  Save,
  Radio,
  RotateCcw,
} from 'lucide-react'
import type { TranscriptImprovement, TranscriptMessage } from '@/app/_schema'
import { TranscriptRefinement } from '@/app/_components/transcript-refinement'
import type { PendingImprovement } from '@/lib/ai/live-improvements'
import { cn } from '@/lib/utils'

export type TranscriptSaveState = {
  status: 'idle' | 'saving' | 'saved' | 'error'
  destination: 'device' | 'supabase'
  error: string | null
}

export const LiveTranscriptPanels = ({
  messages,
  interimMessage,
  improvements,
  pendingImprovement,
  failedImprovements = [],
  onRetryImprovement,
  coachName,
  userName,
  objectives,
  saveState,
  onRetrySave,
  canPlayImprovements = true,
}: {
  messages: TranscriptMessage[]
  interimMessage: TranscriptMessage | null
  improvements: TranscriptImprovement[]
  pendingImprovement: PendingImprovement | null
  failedImprovements?: PendingImprovement[]
  onRetryImprovement: () => void
  coachName: string
  userName: string
  objectives: string[]
  saveState: TranscriptSaveState
  onRetrySave: () => void
  canPlayImprovements?: boolean
}) => {
  const originalHeadingId = useId()
  const originalLog = useRef<HTMLDivElement>(null)
  const followOriginal = useRef(true)
  const learnerInitial = (userName || 'You').slice(0, 1)
  const improvementsByMessage = new Map(improvements.map((item) => [item.messageId, item]))
  const pendingByMessage = new Map(failedImprovements.map((item) => [item.messageId, item]))
  if (pendingImprovement) pendingByMessage.set(pendingImprovement.messageId, pendingImprovement)
  const saveLabel =
    saveState.status === 'saving'
      ? 'Saving your conversation…'
      : saveState.status === 'saved'
        ? saveState.destination === 'supabase'
          ? 'Saved to Supabase'
          : 'Saved on this device'
        : saveState.status === 'error'
          ? 'Automatic save needs attention'
          : 'Automatic saving ready'

  useEffect(() => {
    if (originalLog.current && followOriginal.current) {
      originalLog.current.scrollTop = originalLog.current.scrollHeight
    }
  }, [messages, interimMessage, improvements, pendingImprovement, failedImprovements])

  return (
    <div className="transcript-columns">
      <aside className="transcript-panel" aria-labelledby={originalHeadingId}>
        <div className="transcript-heading">
          <h2 id={originalHeadingId}>Live transcript</h2>
          <span>
            <Radio size={13} aria-hidden="true" />
            LIVE
          </span>
        </div>
        <p className="transcript-description">Your words, refined as the conversation continues.</p>
        <div className="transcript-tools">
          <div className={cn('transcript-save-state', `save-${saveState.status}`)}>
            <div role="status" aria-live="polite">
              {saveState.status === 'saving' ? (
                <LoaderCircle size={12} className="spin" aria-hidden="true" />
              ) : saveState.status === 'error' ? (
                <CircleAlert size={12} aria-hidden="true" />
              ) : saveState.status === 'idle' ? (
                saveState.destination === 'supabase' ? (
                  <CloudUpload size={12} aria-hidden="true" />
                ) : (
                  <Save size={12} aria-hidden="true" />
                )
              ) : saveState.destination === 'supabase' ? (
                <CloudCheck size={12} aria-hidden="true" />
              ) : (
                <MonitorCheck size={12} aria-hidden="true" />
              )}
              <span>{saveLabel}</span>
            </div>
            {saveState.status === 'error' && (
              <>
                <p>{saveState.error ?? 'Your latest changes could not be saved. Please retry.'}</p>
                <button type="button" onClick={onRetrySave}>
                  <RotateCcw size={12} aria-hidden="true" />
                  Retry save
                </button>
              </>
            )}
          </div>
        </div>
        <div
          ref={originalLog}
          className="transcript-messages"
          role="log"
          aria-label="Conversation and refinements"
          aria-live="polite"
          aria-relevant="additions text"
          aria-busy={!!interimMessage}
          onScroll={(event) => {
            const log = event.currentTarget
            followOriginal.current = log.scrollHeight - log.scrollTop - log.clientHeight < 64
          }}
        >
          {messages.length === 0 && !interimMessage && (
            <div className="transcript-empty">
              <Headphones size={25} aria-hidden="true" />
              <p>
                Your conversation will appear here.
                <br />
                No typing. Just you and your voice.
              </p>
            </div>
          )}
          {messages.map((message) => (
            <div
              key={message.id}
              className={cn('transcript-message', message.role === 'user' && 'transcript-user')}
            >
              <div className="transcript-person">
                <span className="transcript-avatar" aria-hidden="true">
                  {message.role === 'user' ? learnerInitial : coachName.slice(0, 1)}
                </span>
                <strong>{message.role === 'user' ? 'You' : coachName}</strong>
                <span>{message.role === 'user' ? '' : 'AI coach'}</span>
              </div>
              <p>{message.content}</p>
              {message.role === 'user' && (
                <TranscriptRefinement
                  message={message}
                  improvement={improvementsByMessage.get(message.id)}
                  pending={pendingByMessage.get(message.id) ?? null}
                  canPlay={canPlayImprovements}
                  onRetry={onRetryImprovement}
                />
              )}
            </div>
          ))}
          {interimMessage && (
            <div className="transcript-message transcript-user transcript-interim">
              <div className="transcript-person">
                <span className="transcript-avatar" aria-hidden="true">
                  {learnerInitial}
                </span>
                <strong>You</strong>
                <span>Transcribing…</span>
              </div>
              <p>
                {interimMessage.content}
                <span className="transcript-cursor" aria-hidden="true" />
              </p>
              <TranscriptRefinement
                message={interimMessage}
                improvement={improvementsByMessage.get(interimMessage.id)}
                pending={pendingByMessage.get(interimMessage.id) ?? null}
                canPlay={canPlayImprovements}
                onRetry={onRetryImprovement}
              />
            </div>
          )}
        </div>
        <div className="session-goals">
          <h3>Your focus for this conversation</h3>
          {objectives.map((objective) => (
            <p key={objective}>
              <Check size={13} aria-hidden="true" />
              {objective}
            </p>
          ))}
        </div>
      </aside>
    </div>
  )
}
