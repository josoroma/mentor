import { generateText } from 'ai'
import { roles, scenarios } from '@/app/_constants'
import {
  buildReplySuggestionsInstructions,
  buildReplySuggestionsPrompt,
  parseReplySuggestions,
  ReplySuggestionsRequestSchema,
} from '@/app/_reply-suggestions'
import { errorResponse, readJson, RequestError } from '@/lib/ai/http'
import { createCoachModel, reportCoachIssue } from '@/lib/ai/local-provider'
import { isMemoryPressureError } from '@/lib/ai/local-stream'

export const runtime = 'nodejs'
export const maxDuration = 45

export async function POST(request: Request) {
  const timeout = AbortSignal.timeout(40_000)
  const signal = AbortSignal.any([request.signal, timeout])

  try {
    const body = await readJson(request, ReplySuggestionsRequestSchema)
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
    signal.throwIfAborted()

    const result = await generateText({
      model: createCoachModel(),
      instructions: buildReplySuggestionsInstructions(
        body.messages.some((message) => message.role === 'user'),
        body.mode,
      ),
      prompt: buildReplySuggestionsPrompt(body, scenario, role),
      maxOutputTokens: 650,
      temperature: 0.5,
      maxRetries: 0,
      abortSignal: signal,
    })
    signal.throwIfAborted()
    if (result.finishReason === 'length') {
      throw new RequestError('The local coach’s reply suggestions were cut short. Try again.', 503)
    }
    const suggestions = parseReplySuggestions(result.text, body.mode)
    reportCoachIssue()
    return Response.json(suggestions, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (request.signal.aborted) {
      return errorResponse(new RequestError('Reply suggestions were cancelled.', 499), '')
    }
    if (timeout.aborted) {
      return errorResponse(
        new RequestError('The local coach took too long to suggest replies. Try again.', 504),
        '',
      )
    }
    if (isMemoryPressureError(error)) {
      const detail =
        'The local coach needs more free memory to suggest replies. Close unused memory-heavy apps, then retry.'
      reportCoachIssue(detail)
      return errorResponse(new RequestError(detail, 503), detail)
    }
    return errorResponse(
      error,
      'Reply suggestions are unavailable. Check that the local coach is running, then retry.',
    )
  }
}
