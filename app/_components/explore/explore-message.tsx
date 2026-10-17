'use client'

import { LoaderCircle, RefreshCw, Sparkles } from 'lucide-react'
import { ImprovedSpeechButton } from '@/app/_components/improved-speech-button'
import type { ExploreMessage, ExploreMessageImprovement } from '@/lib/explore/schema'
import { cn } from '@/lib/utils'
import styles from '@/app/_components/explore/explore-message.module.css'

type ExploreMessageCardProps = {
  message: ExploreMessage
  improvement?: ExploreMessageImprovement
  improving: boolean
  error?: string
  onRetry: () => void
  playbackEnabled?: boolean
}

export const ExploreMessageCard = ({
  message,
  improvement,
  improving,
  error,
  onRetry,
  playbackEnabled = true,
}: ExploreMessageCardProps) => {
  const learnerMessage = message.role === 'user'
  const showImprovement = learnerMessage && message.metadata.action !== 'restore'

  return (
    <article
      className={cn(styles.message, learnerMessage && styles.userMessage)}
      data-message-id={message.id}
    >
      <header>
        {learnerMessage ? 'You' : 'Mentor'}
        {message.status === 'failed' && <small>Ready to retry</small>}
      </header>
      <p className={styles.original}>{message.content}</p>
      {showImprovement && (
        <section className={styles.improvement} aria-label="Improved English" aria-busy={improving}>
          <div className={styles.improvementHeading}>
            <span className={styles.improvementLabel}>
              <Sparkles size={13} aria-hidden="true" />
              <span>Improved English</span>
            </span>
            {improvement?.text.trim() && (
              <ImprovedSpeechButton
                text={improvement.text}
                label="improved English"
                disabled={!playbackEnabled}
              />
            )}
          </div>
          <div aria-live="polite">
            {improvement ? (
              <p className={styles.rewrite}>{improvement.text}</p>
            ) : improving ? (
              <p className={styles.status}>
                <LoaderCircle size={12} className={styles.spinner} aria-hidden="true" />
                Improving your wording…
              </p>
            ) : error ? (
              <div className={styles.failure}>
                <p>{error}</p>
                <button type="button" onClick={onRetry} aria-label="Retry improving wording">
                  <RefreshCw size={12} aria-hidden="true" /> Retry
                </button>
              </div>
            ) : (
              <p className={styles.status}>Your improved wording will appear here.</p>
            )}
          </div>
        </section>
      )}
    </article>
  )
}
