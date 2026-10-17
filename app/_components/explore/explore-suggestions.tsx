'use client'

import { useId } from 'react'
import {
  ArrowRight,
  AudioLines,
  BookOpen,
  Boxes,
  GitBranch,
  Layers3,
  ListOrdered,
  RefreshCw,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import type { ExploreArtifactKind } from '@/lib/explore/schema'
import type { ExploreSuggestion } from '@/lib/explore/suggestions'
import styles from '@/app/_components/explore/explore-suggestions.module.css'

type ExploreSuggestionsProps = {
  ideas: ExploreSuggestion[]
  loading: boolean
  error: string | null
  enabled: boolean
  onRegenerate: () => void
  onChoose: (prompt: string) => void
}

const formats: Record<ExploreArtifactKind, { label: string; icon: LucideIcon }> = {
  walkthrough: { label: 'Guided lesson', icon: BookOpen },
  diagram: { label: 'Visual explanation', icon: GitBranch },
  hanoi: { label: 'Recursion explorer', icon: Layers3 },
  fibonacci: { label: 'Estimation practice', icon: Boxes },
  sorting: { label: 'Algorithm explorer', icon: ListOrdered },
  examples: { label: 'Words to practice', icon: AudioLines },
  simulation: { label: 'Interactive model', icon: Sparkles },
}

export const ExploreSuggestions = ({
  ideas,
  loading,
  error,
  enabled,
  onRegenerate,
  onChoose,
}: ExploreSuggestionsProps) => {
  const id = useId()
  return (
    <section className={styles.suggestions} aria-labelledby={`${id}-heading`} aria-busy={loading}>
      <div className={styles.heading}>
        <div>
          <h2 id={`${id}-heading`}>
            <Sparkles size={16} aria-hidden="true" />
            Ideas for your learning focus
          </h2>
          <p>Explore a fresh idea tailored to the path you’ve selected above.</p>
        </div>
        <button
          type="button"
          className={styles.refresh}
          onClick={onRegenerate}
          disabled={!enabled || loading}
          aria-label="New ideas"
        >
          <RefreshCw size={13} aria-hidden="true" />
          New ideas
        </button>
      </div>
      {loading ? (
        <>
          <p className={styles.status} role="status">
            Finding ideas for your learning focus…
          </p>
          <div className={styles.grid} aria-hidden="true">
            {Array.from({ length: 12 }, (_, index) => (
              <div className={styles.skeleton} key={index}>
                <span />
                <span />
                <span />
              </div>
            ))}
          </div>
        </>
      ) : error ? (
        <div className={styles.error} role="status">
          <strong>Your ideas couldn’t be loaded.</strong>
          <p>{error}</p>
          <button
            type="button"
            className={styles.refresh}
            onClick={onRegenerate}
            disabled={!enabled}
            aria-label="Retry Explore ideas"
          >
            <RefreshCw size={13} aria-hidden="true" />
            Try again
          </button>
        </div>
      ) : ideas.length ? (
        <div className={styles.grid}>
          {ideas.slice(0, 12).map((idea, index) => {
            const { icon: Icon, label } = formats[idea.kind]
            return (
              <button
                key={idea.id}
                type="button"
                className={styles.idea}
                disabled={!enabled}
                onClick={() => onChoose(idea.prompt)}
                aria-label={`Explore ${idea.title}`}
                aria-describedby={`${id}-description-${index}`}
              >
                <span className={styles.format}>
                  <Icon size={15} aria-hidden="true" />
                  {label}
                </span>
                <strong>{idea.title}</strong>
                <span className={styles.description} id={`${id}-description-${index}`}>
                  {idea.description}
                </span>
                <span className={styles.action} aria-hidden="true">
                  Explore this idea <ArrowRight size={13} />
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <p className={styles.empty}>Ideas for your learning focus will appear here.</p>
      )}
    </section>
  )
}
