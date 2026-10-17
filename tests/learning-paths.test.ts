import { afterEach, describe, expect, it, vi } from 'vitest'

import { roles, scenarios } from '@/app/_constants'
import { getDemoConversationSubjects } from '@/lib/ai/demo-topics'
import { lifeSkillCategories, professionalRoles } from '@/lib/learning/path-catalog'
import {
  getLearningSelectionLabel,
  getProfileLearningSelection,
  applyProfileLearningSelection,
  LearningSelectionSchema,
  randomLearningSelection,
  randomLifeSkillSelection,
  resolveLearningSelection,
} from '@/lib/learning/paths'

afterEach(() => vi.restoreAllMocks())

describe('learning path catalogs and boundaries', () => {
  it('covers all professional roles with unique identifiers and relevant conversation subjects', () => {
    expect(professionalRoles).toHaveLength(40)
    expect(new Set(professionalRoles.map(({ id }) => id)).size).toBe(40)
    expect(new Set(professionalRoles.map(({ name }) => name)).size).toBe(40)
    expect(roles).toBe(professionalRoles)
    expect(professionalRoles[0]).toMatchObject({
      id: 'deployed-ai-developer',
      name: 'Forward-Deployed AI Engineer',
    })
    for (const role of professionalRoles) {
      const selection = { path: 'professional', roleId: role.id }
      expect(LearningSelectionSchema.safeParse(selection).success).toBe(true)
      const subjects = getDemoConversationSubjects(role.id)
      expect(new Set(subjects).size).toBeGreaterThanOrEqual(6)
      expect(subjects.every((subject) => subject.length > 35)).toBe(true)
      expect(scenarios.every((scenario) => scenario.roleIds.includes(role.id))).toBe(true)
    }
  })

  it('covers every requested life category with valid topic pairs and unambiguous identifiers', () => {
    expect(lifeSkillCategories.map(({ name }) => name)).toEqual([
      'Mental Health & Burnout',
      'Nutrition & Metabolic Health',
      'Stress Management',
      'Conflict Resolution',
      'Negotiation & Persuasion',
      'Focus & Interruptions',
      'Communication & Leadership',
      'Emotional Intelligence',
      'Critical Thinking',
      'Time Management',
      'Public Speaking',
      'Career Development',
      'Cross-Cultural Communication',
      'Workplace Ethics',
    ])
    const topics = lifeSkillCategories.flatMap(({ topics }) => topics)
    expect(topics).toHaveLength(49)
    expect(new Set(topics.map(({ id }) => id)).size).toBe(topics.length)
    for (const category of lifeSkillCategories) {
      expect(category.topics.length).toBeGreaterThanOrEqual(3)
      for (const topic of category.topics) {
        const selection = LearningSelectionSchema.parse({
          path: 'life-skills',
          categoryId: category.id,
          topicId: topic.id,
        })
        const resolved = resolveLearningSelection(selection)
        expect(resolved.subject).toContain(topic.name)
        expect(resolved.subject).toContain(topic.context)
        expect(resolved.wellness).toBe(category.wellness)
        expect(getLearningSelectionLabel(selection)).toContain(category.name)
        expect(getLearningSelectionLabel(selection)).toContain(topic.name)
      }
    }
  })

  it('rejects unknown roles, unknown categories, mismatched topics, and mixed path inputs', () => {
    for (const invalid of [
      { path: 'professional', roleId: 'invented-role' },
      { path: 'professional', roleId: '__proto__' },
      { path: 'professional', roleId: 'software-engineer', topicId: 'storytelling' },
      { path: 'life-skills', categoryId: 'unknown', topicId: 'storytelling' },
      { path: 'life-skills', categoryId: 'public-speaking', topicId: 'job-interviews' },
      { path: 'life-skills', categoryId: 'public-speaking', topicId: '' },
      { path: 'life-skills', categoryId: 'public-speaking' },
      {
        path: 'life-skills',
        categoryId: 'public-speaking',
        topicId: 'storytelling',
        roleId: 'software-engineer',
      },
    ])
      expect(LearningSelectionSchema.safeParse(invalid).success).toBe(false)
  })

  it('marks health categories for educational handling and keeps their contexts conversational', () => {
    expect(lifeSkillCategories.filter(({ wellness }) => wellness).map(({ id }) => id)).toEqual([
      'mental-health-burnout',
      'nutrition-metabolic-health',
      'stress-management',
    ])
    for (const category of lifeSkillCategories.filter(({ wellness }) => wellness)) {
      expect(category.topics.every(({ context }) => context.startsWith('Practice '))).toBe(true)
    }
    expect(
      resolveLearningSelection({ path: 'professional', roleId: 'devops-engineer' }),
    ).toMatchObject({
      label: 'DevOps Engineer',
      wellness: false,
    })
  })
})

describe('persistent profile learning focus', () => {
  it('restores every saved role and category/topic exactly without another random choice', () => {
    const choices = [
      ...professionalRoles.map(({ id }) => ({ path: 'professional' as const, roleId: id })),
      ...lifeSkillCategories.flatMap((category) =>
        category.topics.map((topic) => ({
          path: 'life-skills' as const,
          categoryId: category.id,
          topicId: topic.id,
        })),
      ),
    ]
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues')
    for (const selection of choices) {
      const profile = { roleId: 'software-engineer', learningSelection: selection }
      for (let visit = 0; visit < 4; visit++)
        expect(getProfileLearningSelection(profile)).toEqual(selection)
    }
    expect(random).not.toHaveBeenCalled()
  })

  it('migrates legacy professional roles and supplies stable missing life-skills depth', () => {
    expect(getProfileLearningSelection({ roleId: 'frontend-engineer' })).toEqual({
      path: 'professional',
      roleId: 'frontend-engineer',
    })
    expect(
      getProfileLearningSelection({ roleId: 'software-engineer', learningPath: 'life-skills' }),
    ).toEqual({
      path: 'life-skills',
      categoryId: 'public-speaking',
      topicId: 'storytelling',
    })
    expect(getProfileLearningSelection({ roleId: 'retired-role' })).toEqual({
      path: 'professional',
      roleId: 'deployed-ai-developer',
    })
  })

  it('keeps compatibility fields aligned with the authoritative selection', () => {
    const profile = {
      roleId: 'software-engineer',
      learningPath: 'life-skills' as const,
      name: 'Learner',
    }
    const next = applyProfileLearningSelection(profile, {
      path: 'professional',
      roleId: 'product-engineer',
    })
    expect(next).toEqual({
      name: 'Learner',
      roleId: 'product-engineer',
      learningPath: 'professional',
      learningSelection: { path: 'professional', roleId: 'product-engineer' },
    })
    const lifeFocus = {
      path: 'life-skills' as const,
      categoryId: 'public-speaking',
      topicId: 'storytelling',
    }
    expect(applyProfileLearningSelection(next, lifeFocus)).toMatchObject({
      roleId: 'product-engineer',
      learningPath: 'life-skills',
      learningSelection: lifeFocus,
    })
  })
})

describe('random choices within the selected learning path', () => {
  it('always chooses a valid role or category/topic within the requested path', () => {
    for (let iteration = 0; iteration < 120; iteration++) {
      for (const path of ['professional', 'life-skills'] as const) {
        const selection = randomLearningSelection(path)
        expect(selection.path).toBe(path)
        expect(LearningSelectionSchema.safeParse(selection).success).toBe(true)
      }
    }
  })

  it('selects only topics from an explicitly chosen category and rejects unknown categories', () => {
    for (const category of lifeSkillCategories) {
      const selection = randomLifeSkillSelection(category.id)
      expect(selection.path).toBe('life-skills')
      if (selection.path !== 'life-skills') throw new Error('Expected a life skills selection.')
      expect(selection.categoryId).toBe(category.id)
      expect(category.topics.some(({ id }) => id === selection.topicId)).toBe(true)
    }
    expect(() => randomLifeSkillSelection('unknown')).toThrow('available category')
  })

  it('discards out-of-range random values instead of biasing category selection', () => {
    const values = [0xffffffff, 10, 1]
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
      if (array instanceof Uint32Array) array[0] = values.shift() ?? 0
      return array
    })
    expect(randomLifeSkillSelection()).toEqual({
      path: 'life-skills',
      categoryId: 'public-speaking',
      topicId: 'storytelling',
    })
    expect(random).toHaveBeenCalledTimes(3)
  })
})
