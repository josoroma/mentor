import { useId } from 'react'
import {
  ArrowUpRight,
  Clock3,
  MessageSquare,
  GitPullRequest,
  Bug,
  Lightbulb,
  Presentation,
  Users,
  AudioLines,
  Code2,
  Compass,
  Heart,
} from 'lucide-react'
import type { Scenario } from '@/app/_types'
import { cn } from '@/lib/utils'
import styles from '@/app/_components/scenario-card.module.css'

const icons = {
  standup: AudioLines,
  code: Code2,
  review: GitPullRequest,
  bug: Bug,
  decision: Lightbulb,
  demo: Presentation,
  guidance: Compass,
  team: Users,
}

export const ScenarioCard = ({
  scenario,
  onSelect,
  index,
  bookmarked,
  bookmarkPending,
  onToggleBookmark,
}: {
  scenario: Scenario
  onSelect: (scenario: Scenario) => void
  index: number
  bookmarked: boolean
  bookmarkPending: boolean
  onToggleBookmark: (scenario: Scenario) => void
}) => {
  const titleId = useId()
  const Icon =
    icons[scenario.icon as keyof typeof icons] ??
    [MessageSquare, GitPullRequest, Bug, Lightbulb, Presentation, Users][index % 6]
  return (
    <article className={cn('scenario-card', styles.card)} aria-labelledby={titleId}>
      <button
        type="button"
        className={styles.open}
        onClick={() => onSelect(scenario)}
        aria-label={`Practice ${scenario.title}`}
      />
      <div className="scenario-top">
        <span className={cn('scenario-icon', `accent-${index % 6}`)}>
          <Icon size={22} strokeWidth={1.7} />
        </span>
        <ArrowUpRight size={17} className="card-arrow" />
      </div>
      <span className="scenario-category">{scenario.category}</span>
      <h3 id={titleId}>{scenario.title}</h3>
      <p>{scenario.description}</p>
      <div className={cn('scenario-meta', styles.meta)}>
        <span>
          <Clock3 size={13} />
          {scenario.minutes} min
        </span>
        <span className={cn('difficulty', scenario.difficulty.toLowerCase())}>
          <i />
          {scenario.difficulty}
        </span>
      </div>
      <button
        type="button"
        className={cn(styles.bookmark, bookmarked && styles.saved)}
        aria-label={
          bookmarked ? `Remove ${scenario.title} from saved scenarios` : `Save ${scenario.title}`
        }
        title={bookmarked ? 'Remove from saved scenarios' : 'Save scenario'}
        aria-pressed={bookmarked}
        aria-busy={bookmarkPending}
        disabled={bookmarkPending}
        onClick={() => onToggleBookmark(scenario)}
      >
        <Heart size={17} fill={bookmarked ? 'currentColor' : 'none'} aria-hidden="true" />
      </button>
    </article>
  )
}
