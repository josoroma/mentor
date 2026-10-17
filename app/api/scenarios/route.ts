import { randomUUID } from 'node:crypto'
import { generateText, Output } from 'ai'
import { roles } from '@/app/_constants'
import {
  buildGeneratedScenarios,
  buildScenarioGenerationInstructions,
  buildScenarioGenerationPrompt,
  ScenarioDraftBatchSchema,
  ScenarioGenerationRequestSchema,
} from '@/lib/ai/generated-scenarios'
import { errorResponse, readJson, RequestError } from '@/lib/ai/http'
import { createCoachModel, reportCoachIssue } from '@/lib/ai/local-provider'
import { isMemoryPressureError } from '@/lib/ai/local-stream'

export const runtime = 'nodejs'
export const maxDuration = 90

const scenarioErrorResponse = (error: unknown, fallback = '') => {
  const response = errorResponse(error, fallback)
  response.headers.set('Cache-Control', 'no-store')
  return response
}

export async function POST(request: Request) {
  const timeout = AbortSignal.timeout(85_000)
  const signal = AbortSignal.any([request.signal, timeout])

  try {
    const body = await readJson(request, ScenarioGenerationRequestSchema)
    const roleId = body.selection.path === 'professional' ? body.selection.roleId : body.roleId
    if (!roles.some((role) => role.id === roleId)) {
      throw new RequestError('Choose a valid learning role before generating scenarios.')
    }
    signal.throwIfAborted()

    const result = await generateText({
      model: createCoachModel(),
      instructions: buildScenarioGenerationInstructions(),
      output: Output.object({ schema: ScenarioDraftBatchSchema }),
      prompt: buildScenarioGenerationPrompt(body, randomUUID()),
      maxOutputTokens: 4300,
      temperature: 0.8,
      maxRetries: 0,
      abortSignal: signal,
    })
    signal.throwIfAborted()
    if (result.finishReason === 'length') {
      throw new RequestError(
        'The local coach’s scenarios were cut short. Try generating them again.',
        503,
      )
    }
    const scenarios = buildGeneratedScenarios(body, result.output)
    reportCoachIssue()
    return Response.json(scenarios, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (request.signal.aborted) {
      return scenarioErrorResponse(new RequestError('Scenario generation was cancelled.', 499))
    }
    if (timeout.aborted) {
      return scenarioErrorResponse(
        new RequestError(
          'The local coach took too long to generate your scenarios. Try again.',
          504,
        ),
      )
    }
    if (isMemoryPressureError(error)) {
      const detail =
        'The local coach needs more free memory to generate your scenarios. Close unused memory-heavy apps, then retry.'
      reportCoachIssue(detail)
      return scenarioErrorResponse(new RequestError(detail, 503))
    }
    return scenarioErrorResponse(
      error,
      'The local coach could not generate complete scenarios for your selection. Check that the coach is running and try again.',
    )
  }
}
