import { generateText } from 'ai'
import { roles, scenarios } from '@/app/_constants'
import { FeedbackRequestSchema } from '@/lib/ai/contracts'
import { parseFeedback } from '@/lib/ai/feedback'
import { errorResponse, readJson, RequestError } from '@/lib/ai/http'
import { createCoachModel, reportCoachIssue } from '@/lib/ai/local-provider'
import { isMemoryPressureError } from '@/lib/ai/local-stream'
import {
  boundConversation,
  buildFeedbackPrompt,
  buildCompactFeedbackPrompt,
  compactConversation,
} from '@/lib/ai/prompts'

export const runtime = 'nodejs'
export const maxDuration = 180

export async function POST(request: Request) {
  try {
    const body = await readJson(request, FeedbackRequestSchema)
    const scenario = body.scenario ?? scenarios.find((item) => item.id === body.scenarioId)
    const role = roles.find((item) => item.id === body.roleId)
    if (
      !scenario ||
      scenario.id !== body.scenarioId ||
      !role ||
      !scenario.roleIds.includes(role.id)
    ) {
      throw new RequestError('Choose a valid role and practice scenario.')
    }
    if (
      !body.messages.some((message) => message.role === 'user' && message.content.trim().length > 3)
    ) {
      throw new RequestError('Complete at least one spoken response before requesting feedback.')
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(170_000)])
    const review = async (compact: boolean) => {
      const messages = compact
        ? compactConversation(body.messages).filter((message) => message.role === 'user')
        : boundConversation(body.messages, 18_000)
      const result = await generateText({
        model: createCoachModel(),
        instructions: compact
          ? buildCompactFeedbackPrompt(scenario, body.level)
          : buildFeedbackPrompt(scenario, role, body.level),
        prompt: JSON.stringify({ transcript: messages }),
        maxOutputTokens: compact ? 1100 : 1600,
        temperature: 0.5,
        maxRetries: 0,
        abortSignal: signal,
      })
      const feedback = parseFeedback(result.text, messages)
      if (
        compact &&
        body.messages.filter((message) => message.role === 'user').length > messages.length
      ) {
        feedback.summary = `Review of your latest responses: ${feedback.summary}`
      }
      return feedback
    }
    let feedback
    let compact = false
    try {
      feedback = await review(false)
    } catch (error) {
      if (signal.aborted || !isMemoryPressureError(error)) throw error
      compact = true
      reportCoachIssue(
        'A recent review hit memory pressure; retrying with a shorter transcript context.',
      )
      feedback = await review(true)
    }
    reportCoachIssue()
    return Response.json(feedback, {
      headers: {
        'Cache-Control': 'no-store',
        'X-Mentor-Context': compact ? 'reduced' : 'standard',
      },
    })
  } catch (error) {
    if (isMemoryPressureError(error)) {
      const detail =
        'The local coach needs more free memory to review this session. Close unused memory-heavy apps, then retry the review.'
      reportCoachIssue(detail)
      return errorResponse(new RequestError(detail, 503), detail)
    }
    return errorResponse(
      error,
      'The local coach could not prepare this review. Your conversation is still available; try the review again.',
    )
  }
}
