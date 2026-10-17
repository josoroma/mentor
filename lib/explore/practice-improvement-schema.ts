import { z } from 'zod'

export const ExplorePracticeImprovementRequestSchema = z
  .object({
    exampleIndex: z.number().int().min(0).max(39),
    expectedRevision: z.number().int().positive(),
    text: z.string().trim().min(1).max(2000),
  })
  .strict()
export type ExplorePracticeImprovementRequest = z.infer<
  typeof ExplorePracticeImprovementRequestSchema
>

export const ExplorePracticeImprovementResponseSchema = z.object({
  text: z.string().min(1).max(2000),
  improvedText: z.string().trim().min(1).max(2000),
})
export type ExplorePracticeImprovementResponse = z.infer<
  typeof ExplorePracticeImprovementResponseSchema
>
