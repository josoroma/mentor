import { ChevronRight, Compass } from 'lucide-react'
import { lifeSkillCategories, professionalRoles } from '@/lib/learning/path-catalog'
import { LearningSelectionSchema, type LearningSelection } from '@/lib/learning/paths'
import styles from '@/app/_components/explore/explore-learning-path.module.css'
import { cn } from '@/lib/utils'

export const LearningPathTrail = ({
  selection,
  compact = false,
  label = 'Learning path',
}: {
  selection: LearningSelection | null
  compact?: boolean
  label?: string
}) => {
  const parsed = LearningSelectionSchema.safeParse(selection)
  const current = parsed.success ? parsed.data : null
  const category =
    current?.path === 'life-skills'
      ? lifeSkillCategories.find(({ id }) => id === current.categoryId)
      : undefined
  const steps = !current
    ? []
    : current.path === 'professional'
      ? [professionalRoles.find(({ id }) => id === current.roleId)!.name]
      : [category!.name, category!.topics.find(({ id }) => id === current.topicId)!.name]

  return (
    <nav className={cn(styles.path, compact && styles.compact)} aria-label={label}>
      {!current ? (
        <p className={styles.pending}>
          <Compass size={15} aria-hidden="true" />
          Learning path unavailable
        </p>
      ) : (
        <ol>
          <li className={styles.primary}>
            <Compass size={15} aria-hidden="true" />
            <span>
              {current.path === 'professional' ? 'Professional Roles' : 'Life & Workplace Skills'}
            </span>
          </li>
          {steps.map((step, index) => (
            <li className={styles.crumb} key={step}>
              <ChevronRight size={14} className={styles.separator} aria-hidden="true" />
              <span
                className={cn(styles.selector, styles.value)}
                aria-current={index === steps.length - 1 ? 'location' : undefined}
              >
                <span>{step}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </nav>
  )
}
