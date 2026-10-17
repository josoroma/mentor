import { z } from 'zod'
import { SpeechProviderSchema } from '@/lib/audio/speech-provider'
import { SpeechPersonaIdSchema } from '@/lib/audio/personas'
import { LearningSelectionSchema } from '@/lib/learning/paths'

export const ProficiencyLevelSchema = z.enum(['A2', 'B1', 'B2', 'C1', 'C2'])
export type ProficiencyLevel = z.infer<typeof ProficiencyLevelSchema>

export const RoleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().min(1),
})
export type Role = z.infer<typeof RoleSchema>

export const ScenarioSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.enum([
    'Daily communication',
    'Technical discussions',
    'Presentations',
    'Collaboration',
  ]),
  difficulty: z.enum(['Beginner', 'Intermediate', 'Advanced']),
  minutes: z.number().int().min(1).max(60),
  roleIds: z.array(z.string().min(1)).min(1),
  persona: z.object({
    id: SpeechPersonaIdSchema.optional(),
    name: z.string().min(1),
    role: z.string().min(1),
  }),
  brief: z.string().min(1),
  objectives: z.array(z.string().min(1)).min(1),
  openingLine: z.string().min(1),
  icon: z.string().min(1),
  accent: z.string().min(1),
  learningSelection: LearningSelectionSchema.optional(),
})
export type Scenario = z.infer<typeof ScenarioSchema>

export const ConversationOutlineSchema = z.object({
  originalTopic: z.string().trim().min(3).max(1_000),
  improvedTopic: z.string().trim().min(3).max(500),
  stages: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(120),
        focus: z.string().trim().min(1).max(600),
      }),
    )
    .min(3)
    .max(5),
  usefulPhrases: z.array(z.string().trim().min(1).max(200)).min(3).max(5),
})
export type ConversationOutline = z.infer<typeof ConversationOutlineSchema>

export const ProfileSchema = z.object({
  name: z.string().trim().max(80),
  roleId: z.string().min(1),
  level: ProficiencyLevelSchema,
  dailyGoalMinutes: z.number().int().min(5).max(60),
  localOnly: z.boolean(),
  learningPath: z.enum(['professional', 'life-skills']).optional(),
  learningSelection: LearningSelectionSchema.optional(),
  speechProvider: SpeechProviderSchema.optional(),
})
export type Profile = z.infer<typeof ProfileSchema>

export const TranscriptMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(20_000),
  timestamp: z.number().finite().nonnegative(),
})
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>

export const TranscriptImprovementSchema = z.object({
  messageId: z.string().min(1),
  original: z.string().min(1).max(20_000),
  improved: z.string().min(1).max(20_000),
  updatedAt: z.string().datetime(),
  isFinal: z.boolean(),
})
export type TranscriptImprovement = z.infer<typeof TranscriptImprovementSchema>

export const FeedbackMetricSchema = z.object({
  key: z.enum([
    'grammar',
    'pronunciation',
    'vocabulary',
    'fluency',
    'clarity',
    'conciseness',
    'confidence',
    'professionalism',
  ]),
  label: z.string(),
  score: z.number().min(0).max(100).nullable(),
  feedback: z.string(),
})
export type FeedbackMetric = z.infer<typeof FeedbackMetricSchema>

export const FeedbackSchema = z.object({
  summary: z.string(),
  overallScore: z.number().min(0).max(100).nullable(),
  metrics: z.array(FeedbackMetricSchema),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()),
  rewrites: z.array(z.object({ original: z.string(), improved: z.string(), reason: z.string() })),
  nextStep: z.string(),
  source: z.enum(['local-model', 'practice-review']),
})
export type Feedback = z.infer<typeof FeedbackSchema>

export const SessionRecordSchema = z.object({
  id: z.string().min(1).max(120),
  scenarioId: z.string().min(1),
  scenario: ScenarioSchema.optional(),
  conversation: ConversationOutlineSchema.optional(),
  roleId: z.string().min(1),
  level: ProficiencyLevelSchema,
  startedAt: z.string().datetime(),
  durationSeconds: z.number().int().nonnegative().max(86_400),
  messages: z.array(TranscriptMessageSchema).max(1_000),
  improvements: z.array(TranscriptImprovementSchema).max(1_000).optional(),
  pendingTranscript: TranscriptMessageSchema.extend({ role: z.literal('user') }).optional(),
  status: z.enum(['in-progress', 'completed']).optional(),
  updatedAt: z.string().datetime().optional(),
  feedback: FeedbackSchema.optional(),
})
export type SessionRecord = z.infer<typeof SessionRecordSchema>
