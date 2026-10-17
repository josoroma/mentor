'use client'

import { useEffect, useId, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Check, ChevronRight, Compass, LoaderCircle } from 'lucide-react'
import {
  LearningFocusSettingsSchema,
  type LearningFocusSettings as LearningFocusSettingsValues,
} from '@/app/_settings-schema'
import { Button } from '@/app/_components/ui/button'
import { lifeSkillCategories, professionalRoles } from '@/lib/learning/path-catalog'
import {
  getLearningSelectionLabel,
  getProfileLearningSelection,
  type LearningSelection,
} from '@/lib/learning/paths'
import styles from '@/app/_components/learning-focus-settings.module.css'

export const LearningFocusSettings = ({
  selection,
  preferredRoleId,
  onSave,
  ready,
}: {
  selection: LearningSelection
  preferredRoleId: string
  onSave: (selection: LearningSelection) => Promise<void>
  ready: boolean
}) => {
  const id = useId()
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const {
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<LearningFocusSettingsValues>({
    resolver: zodResolver(LearningFocusSettingsSchema),
    defaultValues: { selection },
  })
  useEffect(() => reset({ selection }), [selection, reset])

  return (
    <form
      className={styles.form}
      onSubmit={handleSubmit(async (values) => {
        setSaveError(null)
        setSaving(true)
        try {
          await onSave(values.selection)
        } catch (error) {
          setSaveError(
            error instanceof Error ? error.message : 'Your learning focus could not be saved.',
          )
        } finally {
          setSaving(false)
        }
      })}
    >
      <h3>
        <Compass size={17} /> Your learning focus
      </h3>
      <p className={styles.description}>
        Choose what you want to practice. Mentor remembers this focus across Practice, Explore, and
        new conversations.
      </p>
      <Controller
        control={control}
        name="selection"
        render={({ field }) => {
          const current = field.value
          const category =
            current.path === 'life-skills'
              ? lifeSkillCategories.find(({ id }) => id === current.categoryId)
              : undefined
          return (
            <fieldset className={styles.fields} disabled={!ready || isSubmitting || saving}>
              <legend className="sr-only">Saved learning focus</legend>
              <label htmlFor={`${id}-path`}>
                Learning path
                <select
                  id={`${id}-path`}
                  value={current.path}
                  onBlur={field.onBlur}
                  ref={field.ref}
                  onChange={(event) => {
                    field.onChange(
                      getProfileLearningSelection({
                        roleId: preferredRoleId,
                        learningPath:
                          event.target.value === 'life-skills' ? 'life-skills' : 'professional',
                      }),
                    )
                  }}
                >
                  <option value="professional">Professional Roles</option>
                  <option value="life-skills">Life &amp; Workplace Skills</option>
                </select>
              </label>
              {current.path === 'professional' ? (
                <label htmlFor={`${id}-role`}>
                  Professional role
                  <select
                    id={`${id}-role`}
                    value={current.roleId}
                    onBlur={field.onBlur}
                    onChange={(event) =>
                      field.onChange({ path: 'professional', roleId: event.target.value })
                    }
                  >
                    {professionalRoles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <>
                  <label htmlFor={`${id}-category`}>
                    Category
                    <select
                      id={`${id}-category`}
                      value={current.categoryId}
                      onBlur={field.onBlur}
                      onChange={(event) => {
                        const next = lifeSkillCategories.find(({ id }) => id === event.target.value)
                        if (next)
                          field.onChange({
                            path: 'life-skills',
                            categoryId: next.id,
                            topicId: next.topics[0].id,
                          })
                      }}
                    >
                      {lifeSkillCategories.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label htmlFor={`${id}-topic`}>
                    Topic
                    <select
                      id={`${id}-topic`}
                      value={current.topicId}
                      onBlur={field.onBlur}
                      onChange={(event) =>
                        field.onChange({ ...current, topicId: event.target.value })
                      }
                    >
                      {category?.topics.map((topic) => (
                        <option key={topic.id} value={topic.id}>
                          {topic.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </fieldset>
          )
        }}
      />
      <p className={styles.saved}>
        <Check size={13} /> Current focus <ChevronRight size={12} />
        <span>{getLearningSelectionLabel(selection)}</span>
      </p>
      {!ready && (
        <p role="status" className={styles.description}>
          Restoring your saved learning focus…
        </p>
      )}
      {errors.selection && (
        <p role="alert" className="field-error">
          Choose an available role or a matching category and topic.
        </p>
      )}
      {saveError && (
        <p role="alert" className="field-error">
          {saveError}
        </p>
      )}
      <Button
        type="submit"
        variant="secondary"
        disabled={!ready || !isDirty || isSubmitting || saving}
      >
        {isSubmitting || saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
        {isSubmitting || saving ? 'Saving focus…' : 'Save learning focus'}
      </Button>
    </form>
  )
}
