'use client'

import { useId, useState } from 'react'
import { Check, LoaderCircle, Mic, RotateCcw } from 'lucide-react'
import styles from '@/app/_components/conversation-entry-suggestions.module.css'

type ConversationEntrySuggestionsProps = {
  suggestions: Array<{ label: string; text: string }>
  isLoading: boolean
  error: string | null
  isGenerated: boolean
  disabled: boolean
  listening: boolean
  onRetry: () => void
  onListen: () => void
}

export const ConversationEntrySuggestions = ({
  suggestions,
  isLoading,
  error,
  isGenerated,
  disabled,
  listening,
  onRetry,
  onListen,
}: ConversationEntrySuggestionsProps) => {
  const headingId = useId()
  const instructionId = useId()
  const [selectedText, setSelectedText] = useState<string | null>(null)
  const visibleSuggestions = suggestions.slice(0, 3)

  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <div className={styles.heading}>
        <h3 id={headingId}>Join the conversation</h3>
        <button
          type="button"
          className={styles.microphone}
          disabled={disabled || listening}
          onClick={onListen}
        >
          <Mic size={14} aria-hidden="true" />
          {listening ? 'Mic is on' : 'Turn on mic'}
        </button>
      </div>
      <p id={instructionId} className={styles.instruction}>
        {listening
          ? 'Try one aloud, or make it your own.'
          : 'Choose a phrase to turn on your mic, then say it your way.'}
      </p>
      <ol className={styles.list}>
        {visibleSuggestions.map((suggestion, index) => {
          const selected = listening && selectedText === suggestion.text

          return (
            <li key={suggestion.text}>
              <button
                type="button"
                className={styles.phrase}
                disabled={disabled}
                aria-label={`${listening ? 'Practice' : 'Turn on mic and say'}: ${suggestion.text}`}
                aria-describedby={instructionId}
                aria-pressed={selected}
                onClick={() => {
                  setSelectedText(suggestion.text)
                  if (!listening) onListen()
                }}
              >
                <span className={styles.number} aria-hidden="true">
                  {selected ? <Check size={13} /> : index + 1}
                </span>
                <span className={styles.content}>
                  <span className={styles.label}>{suggestion.label}</span>
                  <span className={styles.text}>{suggestion.text}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ol>
      <div className={styles.footer}>
        <p className={styles.status} role="status">
          {isLoading ? (
            <>
              <LoaderCircle size={12} className="spin" aria-hidden="true" />
              Updating ideas…
            </>
          ) : error ? (
            'Fresh ideas are unavailable. These starters still work.'
          ) : isGenerated ? (
            'Ideas follow the conversation.'
          ) : (
            'A few easy ways to jump in.'
          )}
        </p>
        {error && (
          <button
            type="button"
            className={styles.retry}
            onClick={onRetry}
            disabled={disabled || isLoading}
            aria-label="Retry conversation ideas"
            title={error}
          >
            <RotateCcw size={13} aria-hidden="true" />
            Retry
          </button>
        )}
      </div>
    </section>
  )
}
