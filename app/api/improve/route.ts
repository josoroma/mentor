import { streamText } from 'ai'
import { roles, scenarios } from '@/app/_constants'
import { errorResponse, readJson, RequestError } from '@/lib/ai/http'
import {
  buildImprovementInstructions,
  buildImprovementPrompt,
  ImprovementRequestSchema,
  improvementTokenLimit,
} from '@/lib/ai/improvement'
import { createCoachModel, reportCoachIssue } from '@/lib/ai/local-provider'
import { EmptyModelResponseError, isMemoryPressureError } from '@/lib/ai/local-stream'

export const runtime = 'nodejs'
export const maxDuration = 90

export async function POST(request: Request) {
  const controller = new AbortController()
  const timeout = AbortSignal.timeout(85_000)
  const signal = AbortSignal.any([request.signal, controller.signal, timeout])

  try {
    const body = await readJson(request, ImprovementRequestSchema)
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

    let streamError: unknown
    const result = streamText({
      model: createCoachModel(),
      instructions: buildImprovementInstructions(role, body.level, scenario),
      prompt: buildImprovementPrompt(body, scenario),
      maxOutputTokens: improvementTokenLimit(body.text),
      temperature: 0.3,
      maxRetries: 0,
      abortSignal: signal,
      onError: ({ error }) => {
        streamError = error
      },
    })
    const iterator = result.textStream[Symbol.asyncIterator]()
    let firstText = ''

    // Do not report success for empty output or errors hidden by textStream.
    while (!firstText.trim()) {
      const next = await iterator.next()
      signal.throwIfAborted()
      if (streamError) throw streamError
      if (next.done) throw new EmptyModelResponseError()
      firstText += next.value
      if (firstText.length > 12_000) throw new EmptyModelResponseError()
    }

    const encoder = new TextEncoder()
    let characters = firstText.length
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode(firstText))
      },
      async pull(streamController) {
        try {
          const next = await iterator.next()
          signal.throwIfAborted()
          if (streamError) throw streamError
          if (next.done) {
            if ((await result.finishReason) === 'length') {
              throw new Error('The improved wording was cut short. Try a shorter spoken turn.')
            }
            streamController.close()
          } else {
            characters += next.value.length
            if (characters > 12_000) {
              throw new Error('The local coach returned too much text. Try this turn again.')
            }
            streamController.enqueue(encoder.encode(next.value))
          }
        } catch (error) {
          controller.abort()
          streamController.error(error)
        }
      },
      async cancel() {
        controller.abort()
        await iterator.return?.()
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (error) {
    controller.abort()
    if (request.signal.aborted) {
      return errorResponse(new RequestError('The improvement request was cancelled.', 499), '')
    }
    if (timeout.aborted) {
      return errorResponse(
        new RequestError('The local coach took too long to improve this turn. Try again.', 504),
        '',
      )
    }
    if (isMemoryPressureError(error)) {
      const detail =
        'The local coach needs more free memory to improve your wording. Close unused memory-heavy apps, then retry.'
      reportCoachIssue(detail)
      return errorResponse(new RequestError(detail, 503), detail)
    }
    if (error instanceof EmptyModelResponseError) {
      return errorResponse(
        new RequestError(
          'The local coach returned no improved wording. Your original transcript is safe; try again.',
          503,
        ),
        error.message,
      )
    }
    return errorResponse(
      error,
      'Improved wording is unavailable. Check that npm run coach:start is running, then retry.',
    )
  }
}
