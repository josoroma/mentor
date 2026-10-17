import { randomInt, randomUUID } from 'node:crypto'
import { generateText, Output } from 'ai'
import { roles } from '@/app/_constants'
import { ConversationDraftSchema } from '@/lib/ai/conversation-plan'
import { getDemoConversationSubjects } from '@/lib/ai/demo-topics'
import { errorResponse, readJson, RequestError } from '@/lib/ai/http'
import {
  buildLearningSessionInstructions,
  buildLearningSessionPlan,
  buildLearningSessionPrompt,
  LearningSessionRequestSchema,
} from '@/lib/ai/learning-session'
import { createCoachModel, reportCoachIssue } from '@/lib/ai/local-provider'
import { isMemoryPressureError } from '@/lib/ai/local-stream'
import { resolveLearningSelection } from '@/lib/learning/paths'

export const runtime = 'nodejs'
export const maxDuration = 90

export async function POST(request: Request) {
  const timeout = AbortSignal.timeout(85_000)
  const signal = AbortSignal.any([request.signal, timeout])

  try {
    const body = await readJson(request, LearningSessionRequestSchema)
    const roleId = body.selection.path === 'professional' ? body.selection.roleId : body.roleId
    if (!roles.some((role) => role.id === roleId)) {
      throw new RequestError('Choose a valid learning role before starting a conversation.')
    }
    signal.throwIfAborted()
    const subjects =
      body.selection.path === 'professional'
        ? getDemoConversationSubjects(body.selection.roleId)
        : [resolveLearningSelection(body.selection).subject]

    const result = await generateText({
      model: createCoachModel(),
      instructions: buildLearningSessionInstructions(),
      output: Output.object({ schema: ConversationDraftSchema }),
      prompt: buildLearningSessionPrompt(body, {
        subject: subjects[randomInt(subjects.length)],
        seed: randomUUID(),
      }),
      maxOutputTokens: 1400,
      temperature: 0.65,
      maxRetries: 0,
      abortSignal: signal,
    })
    signal.throwIfAborted()
    if (result.finishReason === 'length') {
      throw new RequestError('The local coach’s practice plan was cut short. Try again.', 503)
    }
    const plan = buildLearningSessionPlan(body, result.output)
    reportCoachIssue()
    return Response.json(plan, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (request.signal.aborted) {
      return errorResponse(new RequestError('Practice planning was cancelled.', 499), '')
    }
    if (timeout.aborted) {
      return errorResponse(
        new RequestError('The local coach took too long to prepare your practice. Try again.', 504),
        '',
      )
    }
    if (isMemoryPressureError(error)) {
      const detail =
        'The local coach needs more free memory to prepare your practice. Close unused memory-heavy apps, then retry.'
      reportCoachIssue(detail)
      return errorResponse(new RequestError(detail, 503), detail)
    }
    return errorResponse(
      error,
      'The local coach could not prepare your practice. Check that the coach is running and try again.',
    )
  }
}
