'use client'

import { LoaderCircle, RotateCcw, Sparkles } from 'lucide-react'
import { ImprovedSpeechButton } from '@/app/_components/improved-speech-button'
import viewerStyles from '@/app/_components/explore/artifact-viewer.module.css'
import styles from '@/app/_components/explore/example-practice.module.css'

type ExamplePracticeProps = {
  index: number
  draft: string
  improvement: string
  improving: boolean
  error?: string
  enabled: boolean
  playbackEnabled: boolean
  open: boolean
  onChange: (text: string) => void
  onOpenChange: (open: boolean) => void
  onRetry: () => void
}

export const ExamplePractice = ({
  index,
  draft,
  improvement,
  improving,
  error,
  enabled,
  playbackEnabled,
  open,
  onChange,
  onOpenChange,
  onRetry,
}: ExamplePracticeProps) => (
  <details
    className={styles.practice}
    open={open}
    onToggle={(event) => onOpenChange(event.currentTarget.open)}
  >
    <summary>Practice your version</summary>
    <label className={viewerStyles.field}>
      Adapt this for your team
      <textarea
        aria-label={`Practice example ${index + 1}`}
        rows={2}
        maxLength={2000}
        value={draft}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Try saying it aloud, then capture the version you want to remember."
      />
    </label>
    <section
      className={styles.improvement}
      aria-label={`Improved English for example ${index + 1}`}
      aria-live="polite"
      aria-busy={improving}
    >
      <div className={styles.heading}>
        <span className={styles.headingLabel}>
          <Sparkles size={14} aria-hidden="true" />
          <span>Improved English</span>
        </span>
        {draft.trim() && improvement.trim() && (
          <ImprovedSpeechButton
            text={improvement}
            label={`improved English for example ${index + 1}`}
            disabled={!open || !playbackEnabled}
          />
        )}
      </div>
      {draft.trim() && improvement ? (
        <p className={styles.rewrite}>{improvement}</p>
      ) : improving ? (
        <p className={styles.status}>
          <LoaderCircle size={13} className={styles.spinner} aria-hidden="true" />
          Improving your wording…
        </p>
      ) : error ? (
        <div className={styles.failure}>
          <p>{error}</p>
          <button
            type="button"
            onClick={onRetry}
            disabled={!enabled}
            aria-label={`Retry improving example ${index + 1}`}
          >
            <RotateCcw size={12} aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : (
        <p className={styles.status}>
          {draft.trim()
            ? 'Your improved wording will appear when you pause.'
            : 'Write your version above to see a clearer way to say it.'}
        </p>
      )}
    </section>
  </details>
)
