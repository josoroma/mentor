'use client'

import { useId, useState } from 'react'
import { Check, Copy, LoaderCircle, MessageCircle, RotateCcw } from 'lucide-react'
import type { ReplySuggestions as SuggestedReplies } from '@/app/_reply-suggestions'
import { ImprovedSpeechButton } from '@/app/_components/improved-speech-button'
import styles from '@/app/_components/reply-suggestions.module.css'

export type ReplySuggestionsState = SuggestedReplies & {
  isLoading: boolean
  error: string | null
  isGenerated: boolean
  retry: () => void
  turnId: string | null
}

export const ReplySuggestions = ({
  suggestions,
  canPlay,
}: {
  suggestions: ReplySuggestionsState
  canPlay: boolean
}) => {
  const headingId = useId()
  const [copyStatus, setCopyStatus] = useState<{ text: string; failed: boolean } | null>(null)
  const copyReply = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyStatus({ text, failed: false })
    } catch {
      setCopyStatus({ text, failed: true })
    }
  }

  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <div className={styles.heading}>
        <MessageCircle size={16} aria-hidden="true" />
        <h3 id={headingId}>Try one of these replies</h3>
        <span className={styles.count}>3 ideas</span>
      </div>
      <p className={styles.intro}>
        Say it your way. Copy a reply to practice writing, or pause and press Play to hear the
        pronunciation.
      </p>
      <p className={styles.status} role="status">
        {suggestions.isLoading ? (
          <>
            <LoaderCircle size={12} className="spin" aria-hidden="true" />
            Preparing replies for this turn…
          </>
        ) : suggestions.isGenerated ? (
          'For this turn · updates with each coach response'
        ) : (
          'Practice starters · ask for help whenever you need it'
        )}
      </p>
      <ol className={styles.list}>
        {suggestions.replies.map((reply, index) => (
          <li className={styles.card} key={`${suggestions.turnId}:${reply.text}`}>
            <div className={styles.label}>
              <span className={styles.number} aria-hidden="true">
                {index + 1}
              </span>
              <h4>{reply.label}</h4>
            </div>
            <p className={styles.reply}>{reply.text}</p>
            <div className={styles.actions}>
              <ImprovedSpeechButton
                text={reply.text}
                label={`suggested reply ${index + 1}`}
                disabled={!canPlay}
              />
              <button
                type="button"
                className={styles.copy}
                onClick={() => void copyReply(reply.text)}
                aria-label={`Copy suggested reply ${index + 1}`}
              >
                {copyStatus?.text === reply.text && !copyStatus.failed ? (
                  <Check size={13} aria-hidden="true" />
                ) : (
                  <Copy size={13} aria-hidden="true" />
                )}
                {copyStatus?.text === reply.text && !copyStatus.failed ? 'Copied' : 'Copy'}
              </button>
            </div>
            {copyStatus?.text === reply.text && (
              <p className={styles.copyStatus} role="status">
                {copyStatus.failed
                  ? 'Could not copy. Select the reply text to copy it manually.'
                  : 'Copied. You can paste it into your writing practice.'}
              </p>
            )}
          </li>
        ))}
      </ol>
      {suggestions.error && (
        <div className={styles.error} role="status">
          <p>{suggestions.error} You can still use these practice starters.</p>
          <button type="button" onClick={suggestions.retry}>
            <RotateCcw size={12} aria-hidden="true" />
            Retry reply ideas
          </button>
        </div>
      )}
    </section>
  )
}
