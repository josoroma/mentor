import { z } from 'zod'

import { lifeSkillCategories, professionalRoles } from '@/lib/learning/path-catalog'

export const LearningSelectionSchema = z
  .discriminatedUnion('path', [
    z
      .object({
        path: z.literal('professional'),
        roleId: z.string().refine((id) => professionalRoles.some((role) => role.id === id), {
          message: 'Choose an available professional role.',
        }),
      })
      .strict(),
    z
      .object({
        path: z.literal('life-skills'),
        categoryId: z.string(),
        topicId: z.string(),
      })
      .strict(),
  ])
  .superRefine((selection, context) => {
    if (selection.path !== 'life-skills') return
    const category = lifeSkillCategories.find(({ id }) => id === selection.categoryId)
    if (!category) {
      context.addIssue({
        code: 'custom',
        path: ['categoryId'],
        message: 'Choose an available category.',
      })
    } else if (!category.topics.some(({ id }) => id === selection.topicId)) {
      context.addIssue({
        code: 'custom',
        path: ['topicId'],
        message: 'Choose a topic from this category.',
      })
    }
  })

export type LearningSelection = z.infer<typeof LearningSelectionSchema>

type ProfileLearningFocus = {
  roleId: string
  learningPath?: LearningSelection['path']
  learningSelection?: LearningSelection
}

/** Older profiles stored a role/path but not the life-skills category and topic. */
export const getProfileLearningSelection = (profile: ProfileLearningFocus): LearningSelection => {
  const saved = LearningSelectionSchema.safeParse(profile.learningSelection)
  if (saved.success) return saved.data
  if (profile.learningPath === 'life-skills')
    return { path: 'life-skills', categoryId: 'public-speaking', topicId: 'storytelling' }
  return {
    path: 'professional',
    roleId: professionalRoles.some(({ id }) => id === profile.roleId)
      ? profile.roleId
      : professionalRoles[0].id,
  }
}

/** Keep the full focus authoritative and legacy profile fields consistent. */
export const applyProfileLearningSelection = <T extends ProfileLearningFocus>(
  profile: T,
  selection: LearningSelection,
) => {
  const valid = LearningSelectionSchema.parse(selection)
  return {
    ...profile,
    learningSelection: valid,
    learningPath: valid.path,
    roleId: valid.path === 'professional' ? valid.roleId : profile.roleId,
  }
}

export const resolveLearningSelection = (selection: LearningSelection) => {
  const valid = LearningSelectionSchema.parse(selection)
  if (valid.path === 'professional') {
    const role = professionalRoles.find(({ id }) => id === valid.roleId)!
    return {
      label: role.name,
      description: role.description,
      subject: `a realistic workplace conversation for a ${role.name}`,
      wellness: false,
    }
  }

  const category = lifeSkillCategories.find(({ id }) => id === valid.categoryId)!
  const topic = category.topics.find(({ id }) => id === valid.topicId)!
  return {
    label: `${category.name} · ${topic.name}`,
    description: category.description,
    subject: `${topic.name}: ${topic.context}`,
    wellness: category.wellness,
  }
}

export const getLearningSelectionLabel = (selection: LearningSelection): string =>
  resolveLearningSelection(selection).label

const randomIndex = (length: number): number => {
  // Rejection sampling keeps each category/topic equally likely without Node-only imports.
  const range = 0x100000000
  const limit = range - (range % length)
  const value = new Uint32Array(1)
  do {
    globalThis.crypto.getRandomValues(value)
  } while (value[0] >= limit)
  return value[0] % length
}

export const randomLifeSkillSelection = (categoryId?: string): LearningSelection => {
  const category =
    categoryId === undefined
      ? lifeSkillCategories[randomIndex(lifeSkillCategories.length)]
      : lifeSkillCategories.find(({ id }) => id === categoryId)
  if (!category) throw new Error('Choose an available category before choosing a topic.')
  const topic = category.topics[randomIndex(category.topics.length)]
  return { path: 'life-skills', categoryId: category.id, topicId: topic.id }
}

export const randomLearningSelection = (path: LearningSelection['path']): LearningSelection => {
  if (path === 'life-skills') return randomLifeSkillSelection()
  const role = professionalRoles[randomIndex(professionalRoles.length)]
  return { path: 'professional', roleId: role.id }
}
