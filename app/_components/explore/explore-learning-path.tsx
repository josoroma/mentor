'use client'

import { ChevronDown, ChevronRight, Compass } from 'lucide-react'
import { lifeSkillCategories, professionalRoles } from '@/lib/learning/path-catalog'
import {
  LearningSelectionSchema,
  randomLifeSkillSelection,
  type LearningSelection,
} from '@/lib/learning/paths'
import styles from '@/app/_components/explore/explore-learning-path.module.css'

type ExploreLearningPathProps = {
  selection: LearningSelection | null
  onChange: (selection: LearningSelection) => void
  disabled?: boolean
}

export const ExploreLearningPath = ({
  selection,
  onChange,
  disabled = false,
}: ExploreLearningPathProps) => {
  const parsed = LearningSelectionSchema.safeParse(selection)
  const current = parsed.success ? parsed.data : null
  const role =
    current?.path === 'professional'
      ? professionalRoles.find(({ id }) => id === current.roleId)
      : undefined
  const category =
    current?.path === 'life-skills'
      ? lifeSkillCategories.find(({ id }) => id === current.categoryId)
      : undefined
  const topic =
    current?.path === 'life-skills'
      ? category?.topics.find(({ id }) => id === current.topicId)
      : undefined

  return (
    <nav className={styles.path} aria-label="Explore learning path">
      {!current ? (
        <p className={styles.pending} role="status">
          <Compass size={15} aria-hidden="true" />
          Loading your learning path…
        </p>
      ) : (
        <ol>
          <li className={styles.primary}>
            <Compass size={15} aria-hidden="true" />
            <span>
              {current.path === 'professional' ? 'Professional Roles' : 'Life & Workplace Skills'}
            </span>
          </li>
          {current.path === 'professional' ? (
            <li className={styles.crumb}>
              <ChevronRight size={14} className={styles.separator} aria-hidden="true" />
              <label className={styles.selector} data-disabled={disabled}>
                <span className={styles.srOnly}>Position</span>
                <span aria-hidden="true">{role?.name}</span>
                <select
                  aria-label="Position"
                  value={current.roleId}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({ path: 'professional', roleId: event.target.value })
                  }
                >
                  {professionalRoles.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={13} aria-hidden="true" />
              </label>
            </li>
          ) : (
            <>
              <li className={styles.crumb}>
                <ChevronRight size={14} className={styles.separator} aria-hidden="true" />
                <label className={styles.selector} data-disabled={disabled}>
                  <span className={styles.srOnly}>Category</span>
                  <span aria-hidden="true">{category?.name}</span>
                  <select
                    aria-label="Category"
                    value={current.categoryId}
                    disabled={disabled}
                    onChange={(event) => onChange(randomLifeSkillSelection(event.target.value))}
                  >
                    {lifeSkillCategories.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={13} aria-hidden="true" />
                </label>
              </li>
              <li className={styles.crumb}>
                <ChevronRight size={14} className={styles.separator} aria-hidden="true" />
                <label className={styles.selector} data-disabled={disabled}>
                  <span className={styles.srOnly}>Topic</span>
                  <span aria-hidden="true">{topic?.name}</span>
                  <select
                    aria-label="Topic"
                    value={current.topicId}
                    disabled={disabled}
                    onChange={(event) => onChange({ ...current, topicId: event.target.value })}
                  >
                    {category?.topics.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={13} aria-hidden="true" />
                </label>
              </li>
            </>
          )}
        </ol>
      )}
    </nav>
  )
}
