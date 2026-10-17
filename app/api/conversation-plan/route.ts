import { generateText } from 'ai'
import { roles } from '@/app/_constants'
import {
  buildConversationPlan,
  buildConversationPlanInstructions,
  buildConversationPlanPrompt,
  ConversationPlanRequestSchema,
  parseConversationDraft,
} from '@/lib/ai/conversation-plan'
import { errorResponse, readJson, RequestError } from '@/lib/ai/http'
import { createCoachModel, reportCoachIssue } from '@/lib/ai/local-provider'
import { isMemoryPressureError } from '@/lib/ai/local-stream'

export const runtime = 'nodejs'
export const maxDuration = 90

export async function POST(request: Request) {
  const timeout = AbortSignal.timeout(85_000)
  const signal = AbortSignal.any([request.signal, timeout])

  try {
    const body = await readJson(request, ConversationPlanRequestSchema)
    const roleId = body.selection?.path === 'professional' ? body.selection.roleId : body.roleId
    const role = roles.find((item) => item.id === roleId)
    if (!role)
      throw new RequestError('Choose a valid learning role before planning a conversation.')
    signal.throwIfAborted()

    const result = await generateText({
      model: createCoachModel(),
      instructions: buildConversationPlanInstructions(),
      prompt: buildConversationPlanPrompt(body, role),
      maxOutputTokens: 1400,
      temperature: 0.5,
      maxRetries: 0,
      abortSignal: signal,
    })
    signal.throwIfAborted()
    if (result.finishReason === 'length') {
      throw new RequestError(
        'The local coach’s plan was cut short. Try planning the topic again.',
        503,
      )
    }
    const plan = buildConversationPlan(body, parseConversationDraft(result.text))
    reportCoachIssue()
    return Response.json(plan, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (request.signal.aborted) {
      return errorResponse(new RequestError('Conversation planning was cancelled.', 499), '')
    }
    if (timeout.aborted) {
      return errorResponse(
        new RequestError('The local coach took too long to plan this topic. Try again.', 504),
        '',
      )
    }
    if (isMemoryPressureError(error)) {
      const detail =
        'The local coach needs more free memory to plan your conversation. Close unused memory-heavy apps, then retry.'
      reportCoachIssue(detail)
      return errorResponse(new RequestError(detail, 503), detail)
    }
    return errorResponse(
      error,
      'The local coach could not prepare a complete conversation plan. Your topic is still here; check that the coach is running and try again.',
    )
  }
}
