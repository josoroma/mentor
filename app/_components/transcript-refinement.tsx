'use client'

import { LoaderCircle, RotateCcw, Sparkles } from 'lucide-react'
import type { TranscriptImprovement, TranscriptMessage } from '@/app/_schema'
import type { PendingImprovement } from '@/lib/ai/live-improvements'
import { ImprovedSpeechButton } from '@/app/_components/improved-speech-button'
import playbackStyles from '@/app/_components/improvement-playback.module.css'

export const TranscriptRefinement = ({
  message,
  improvement,
  pending,
  canPlay,
  onRetry,
}: {
  message: TranscriptMessage
  improvement?: TranscriptImprovement
  pending: PendingImprovement | null
  canPlay: boolean
  onRetry: () => void
}) => {
  const currentPending =
    pending?.messageId === message.id && pending.original === message.content ? pending : null
  const currentImprovement =
    improvement?.messageId === message.id && improvement.original === message.content
      ? improvement
      : null
  const text = currentPending ? currentPending.text : (currentImprovement?.improved ?? '')
  const failed = currentPending?.status === 'error'
  const refining = !failed && (!!currentPending || !currentImprovement)

  return (
    <div className="transcript-message transcript-improved" aria-busy={refining}>
      <div className="transcript-person">
        <span className="transcript-avatar" aria-hidden="true">
          {refining ? <LoaderCircle size={12} className="spin" /> : <Sparkles size={12} />}
        </span>
        <strong>You, refined</strong>
        <span>
          {failed ? 'Needs a retry' : refining || !currentImprovement?.isFinal ? 'Live draft' : ''}
        </span>
      </div>
      {text ? (
        <p>
          {text}
          {refining && <span className="transcript-cursor" aria-hidden="true" />}
        </p>
      ) : !failed ? (
        <p className="improvement-waiting">Refining your words…</p>
      ) : null}
      {text.trim() && (
        <div className={playbackStyles.liveControl}>
          <ImprovedSpeechButton text={text} label="refined response" disabled={!canPlay} />
          {!canPlay && <p className={playbackStyles.pauseHint}>Pause to hear this phrasing.</p>}
        </div>
      )}
      {failed && (
        <div className="improvement-error" role="alert">
          <p>{currentPending.error ?? 'The local coach could not refine this response.'}</p>
          <button type="button" onClick={onRetry}>
            <RotateCcw size={12} aria-hidden="true" />
            Retry improvement
          </button>
        </div>
      )}
    </div>
  )
}
