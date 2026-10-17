import { z } from 'zod'
import { LearningSelectionSchema } from '@/lib/learning/paths'

export const LearningFocusSettingsSchema = z.object({
  selection: LearningSelectionSchema,
})
export type LearningFocusSettings = z.infer<typeof LearningFocusSettingsSchema>
