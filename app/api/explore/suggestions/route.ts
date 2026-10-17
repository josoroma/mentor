import { randomUUID } from 'node:crypto'
import { generateText, Output } from 'ai'
import { errorResponse, readJson, RequestError } from '@/lib/ai/http'
import { createCoachModel, reportCoachIssue } from '@/lib/ai/local-provider'
import { isMemoryPressureError } from '@/lib/ai/local-stream'
import {
  buildExploreSuggestionInstructions,
  buildExploreSuggestionPrompt,
  buildExploreSuggestions,
  ExploreSuggestionDraftBatchSchema,
  ExploreSuggestionsRequestSchema,
} from '@/lib/explore/suggestions'

export const runtime = 'nodejs'
export const maxDuration = 90

const suggestionErrorResponse = (error: unknown, fallback = '') => {
  const response = errorResponse(error, fallback)
  response.headers.set('Cache-Control', 'no-store')
  return response
}

export async function POST(request: Request) {
  const timeout = AbortSignal.timeout(85_000)
  const signal = AbortSignal.any([request.signal, timeout])

  try {
    const body = await readJson(request, ExploreSuggestionsRequestSchema)
    signal.throwIfAborted()
    const result = await generateText({
      model: createCoachModel(),
      instructions: buildExploreSuggestionInstructions(),
      output: Output.object({ schema: ExploreSuggestionDraftBatchSchema }),
      prompt: buildExploreSuggestionPrompt(body, randomUUID()),
      maxOutputTokens: 4300,
      temperature: 0.8,
      maxRetries: 0,
      abortSignal: signal,
    })
    signal.throwIfAborted()
    if (result.finishReason !== 'stop') {
      throw new RequestError(
        'The local coach’s exploration ideas were incomplete. Try generating them again.',
        503,
      )
    }
    const suggestions = buildExploreSuggestions(body, result.output)
    reportCoachIssue()
    return Response.json(suggestions, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (request.signal.aborted) {
      return suggestionErrorResponse(new RequestError('Exploration ideas were cancelled.', 499))
    }
    if (timeout.aborted) {
      return suggestionErrorResponse(
        new RequestError('The local coach took too long to suggest explorations. Try again.', 504),
      )
    }
    if (isMemoryPressureError(error)) {
      const detail =
        'The local coach needs more free memory to suggest explorations. Close unused memory-heavy apps, then retry.'
      reportCoachIssue(detail)
      return suggestionErrorResponse(new RequestError(detail, 503))
    }
    return suggestionErrorResponse(
      error,
      'The local coach could not suggest explorations for your selection. Check that the coach is running and try again.',
    )
  }
}
