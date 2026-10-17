import { generateText, Output } from 'ai'
import { errorResponse, readJson, RequestError } from '@/lib/ai/http'
import { createCoachModel, reportCoachIssue } from '@/lib/ai/local-provider'
import { isMemoryPressureError } from '@/lib/ai/local-stream'
import {
  buildExplorePromptRefinement,
  buildExplorePromptRefinementInstructions,
  buildExplorePromptRefinementPrompt,
  ExplorePromptRefinementDraftSchema,
  ExplorePromptRefinementRequestSchema,
} from '@/lib/explore/prompt-refinement'

export const runtime = 'nodejs'
export const maxDuration = 90

const refinementErrorResponse = (error: unknown, fallback = '') => {
  const response = errorResponse(error, fallback)
  response.headers.set('Cache-Control', 'no-store')
  return response
}

export async function POST(request: Request) {
  const timeout = AbortSignal.timeout(85_000)
  const signal = AbortSignal.any([request.signal, timeout])

  try {
    const body = await readJson(request, ExplorePromptRefinementRequestSchema)
    signal.throwIfAborted()
    const instructions = buildExplorePromptRefinementInstructions()
    const prompt = buildExplorePromptRefinementPrompt(body)
    const configuredContext = Number(process.env.MENTOR_COACH_CONTEXT ?? 8192)
    const contextTokens =
      Number.isFinite(configuredContext) && configuredContext >= 4096 ? configuredContext : 8192
    const outputTokens = Math.min(
      4300,
      Math.floor(contextTokens - (instructions.length + prompt.length) / 3.5 - 256),
    )
    if (outputTokens < 1500) {
      throw new RequestError(
        'This draft exceeds the local coach’s context. Shorten the draft and try refining it again.',
        422,
      )
    }
    const result = await generateText({
      model: createCoachModel(),
      instructions,
      output: Output.object({ schema: ExplorePromptRefinementDraftSchema }),
      prompt,
      maxOutputTokens: outputTokens,
      temperature: 0.65,
      maxRetries: 0,
      abortSignal: signal,
    })
    signal.throwIfAborted()
    if (result.finishReason !== 'stop') {
      throw new RequestError(
        'The local coach’s three prompt choices were incomplete. Try refining your draft again.',
        503,
      )
    }
    const refinement = buildExplorePromptRefinement(body, result.output)
    reportCoachIssue()
    return Response.json(refinement, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (request.signal.aborted) {
      return refinementErrorResponse(new RequestError('Prompt refinement was cancelled.', 499))
    }
    if (timeout.aborted) {
      return refinementErrorResponse(
        new RequestError('The local coach took too long to refine your draft. Try again.', 504),
      )
    }
    if (isMemoryPressureError(error)) {
      const detail =
        'The local coach needs more free memory to refine your draft. Close unused memory-heavy apps, then retry.'
      reportCoachIssue(detail)
      return refinementErrorResponse(new RequestError(detail, 503))
    }
    return refinementErrorResponse(
      error,
      'The local coach could not prepare three distinct prompt choices. Your draft is unchanged. Check that the coach is running and try again.',
    )
  }
}
