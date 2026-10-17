'use client'

import { ArrowRight, ChevronDown, LoaderCircle, Mic, Sparkles } from 'lucide-react'
import { Button } from '@/app/_components/ui/button'
import { lifeSkillCategories, professionalRoles } from '@/lib/learning/path-catalog'
import {
  LearningSelectionSchema,
  randomLifeSkillSelection,
  resolveLearningSelection,
  type LearningSelection,
} from '@/lib/learning/paths'
import styles from '@/app/_components/learning-path-picker.module.css'

export const LearningPathPicker = ({
  selection,
  onChange,
  onStart,
  disabledStart = false,
  creatingScenarios = false,
}: {
  selection: LearningSelection | null
  onChange: (selection: LearningSelection) => void
  onStart: () => void
  disabledStart?: boolean
  creatingScenarios?: boolean
}) => {
  const category =
    selection?.path === 'life-skills'
      ? lifeSkillCategories.find((item) => item.id === selection.categoryId)
      : undefined
  const parsedSelection = LearningSelectionSchema.safeParse(selection)
  const context = parsedSelection.success ? resolveLearningSelection(parsedSelection.data) : null

  return (
    <section className={styles.card} aria-labelledby="learning-focus-heading">
      <div className={styles.heading}>
        <span>
          <Sparkles size={14} /> YOUR LEARNING FOCUS
        </span>
        <h2 id="learning-focus-heading">
          {selection?.path === 'professional'
            ? 'Practice for your position'
            : 'Make it relevant to you'}
        </h2>
        <p>
          {selection?.path === 'professional'
            ? 'Your saved position shapes your practice. Change it here or in Settings whenever your focus changes.'
            : 'Your saved category and topic shape your practice. Change either here or in Settings.'}
        </p>
      </div>
      {!selection ? (
        <p className={styles.pending} role="status">
          <LoaderCircle size={15} className="spin" /> Restoring your learning focus…
        </p>
      ) : (
        <div className={styles.controls}>
          {selection.path === 'professional' ? (
            <label className={styles.field}>
              <span>Position</span>
              <div className={styles.select}>
                <select
                  aria-label="Position"
                  value={selection.roleId}
                  onChange={(event) =>
                    onChange({ path: 'professional', roleId: event.target.value })
                  }
                >
                  {professionalRoles.map((role) => (
                    <option value={role.id} key={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} aria-hidden="true" />
              </div>
            </label>
          ) : (
            <>
              <label className={styles.field}>
                <span>Category</span>
                <div className={styles.select}>
                  <select
                    aria-label="Category"
                    value={selection.categoryId}
                    onChange={(event) => onChange(randomLifeSkillSelection(event.target.value))}
                  >
                    {lifeSkillCategories.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={15} aria-hidden="true" />
                </div>
              </label>
              <label className={styles.field}>
                <span>Topic</span>
                <div className={styles.select}>
                  <select
                    aria-label="Topic"
                    value={selection.topicId}
                    onChange={(event) => onChange({ ...selection, topicId: event.target.value })}
                    required
                    aria-describedby={!context ? 'learning-topic-hint' : undefined}
                  >
                    <option value="" disabled>
                      Choose a topic
                    </option>
                    {category?.topics.map((topic) => (
                      <option value={topic.id} key={topic.id}>
                        {topic.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={15} aria-hidden="true" />
                </div>
              </label>
            </>
          )}
          <Button
            className={styles.start}
            onClick={onStart}
            disabled={!context || disabledStart}
            aria-busy={creatingScenarios}
          >
            {creatingScenarios ? <LoaderCircle size={16} className="spin" /> : <Mic size={16} />}
            {creatingScenarios ? 'Creating your scenarios…' : 'Start voice practice'}
            {!creatingScenarios && <ArrowRight size={16} />}
          </Button>
        </div>
      )}
      {selection && !context && (
        <p className={styles.hint} id="learning-topic-hint">
          Choose a topic to begin your voice conversation.
        </p>
      )}
      {context && <p className={styles.hint}>{context.description}</p>}
    </section>
  )
}
