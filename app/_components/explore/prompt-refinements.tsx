import { ArrowRight, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react'
import { Button } from '@/app/_components/ui/button'
import type { ExplorePromptRefinementOption } from '@/lib/explore/prompt-refinement'
import styles from '@/app/_components/explore/prompt-refinements.module.css'

export const PromptRefinements = ({
  options,
  status,
  error,
  discussion,
  enabled,
  onChoose,
  onRetry,
}: {
  options: ExplorePromptRefinementOption[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  discussion: boolean
  enabled: boolean
  onChoose: (id: string) => void
  onRetry: () => void
}) => {
  if (status === 'idle') return null

  return (
    <section className={styles.root} aria-label="Refined prompt choices">
      <div className={styles.heading}>
        <Sparkles size={19} />
        <div>
          <h2>Choose your direction</h2>
          <p>
            {discussion
              ? 'Three ways to ask about this lesson. Choose the prompt you want to send.'
              : 'One idea, three approaches. Choose the prompt for your interactive exploration.'}
          </p>
        </div>
      </div>
      {status === 'loading' && (
        <p className={styles.status} role="status">
          <LoaderCircle size={16} className="spin" />
          Analyzing your idea and refining three prompts…
        </p>
      )}
      {status === 'error' && (
        <div className={styles.error} role="alert">
          <p>{error}</p>
          <Button type="button" variant="secondary" size="sm" disabled={!enabled} onClick={onRetry}>
            <RefreshCw size={14} /> Retry refinement
          </Button>
        </div>
      )}
      {status === 'ready' && (
        <>
          <p className={styles.srOnly} role="status">
            Three refined prompts are ready to review.
          </p>
          <div className={styles.choices}>
            {options.map((option, index) => (
              <article key={option.id} className={styles.choice}>
                <div className={styles.title}>
                  <span>{index + 1}</span>
                  <h3>{option.title}</h3>
                </div>
                <p className={styles.description}>{option.description}</p>
                <p className={styles.prompt}>{option.prompt}</p>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!enabled}
                  aria-label={`${discussion ? 'Send' : 'Explore with'} prompt ${index + 1}: ${option.title}`}
                  onClick={() => onChoose(option.id)}
                >
                  {discussion ? 'Send this prompt' : 'Explore with this prompt'}
                  <ArrowRight size={15} />
                </Button>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
