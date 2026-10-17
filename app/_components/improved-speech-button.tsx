'use client'

import { useId } from 'react'
import { LoaderCircle, RotateCcw, Square, Volume2 } from 'lucide-react'
import { useCorrectionPlayback } from '@/app/_hooks/use-correction-playback'
import styles from '@/app/_components/improved-speech-button.module.css'

type ImprovedSpeechButtonProps = {
  text: string
  label?: string
  disabled?: boolean
  onBeforePlay?: () => void | Promise<void>
}

export const ImprovedSpeechButton = ({
  text,
  label = 'improved version',
  disabled = false,
  onBeforePlay,
}: ImprovedSpeechButtonProps) => {
  const { status, error, toggle } = useCorrectionPlayback(text, disabled, onBeforePlay)
  const errorId = useId()
  const loading = status === 'loading'
  const playing = status === 'playing'
  const failed = status === 'error'
  const action = loading ? 'Cancel' : playing ? 'Stop' : failed ? 'Retry' : 'Play'
  const Icon = loading ? LoaderCircle : playing ? Square : failed ? RotateCcw : Volume2
  return (
    <span className={styles.control}>
      <button
        type="button"
        className={styles.button}
        onClick={toggle}
        disabled={disabled || !text.trim()}
        aria-label={`${action} ${label}${loading || failed ? ' playback' : ''}`}
        aria-pressed={loading || playing}
        aria-busy={loading}
        aria-describedby={error ? errorId : undefined}
      >
        <Icon size={13} aria-hidden="true" className={loading ? styles.spinner : undefined} />
        <span>{action}</span>
      </button>
      {error && (
        <span id={errorId} role="status" className={styles.error}>
          {error}
        </span>
      )}
    </span>
  )
}
