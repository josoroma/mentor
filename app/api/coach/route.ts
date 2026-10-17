import { streamText } from 'ai'
import { roles, scenarios } from '@/app/_constants'
import { CoachRequestSchema } from '@/lib/ai/contracts'
import { errorResponse, readJson, RequestError } from '@/lib/ai/http'
import { createCoachModel, reportCoachIssue } from '@/lib/ai/local-provider'
import { EmptyModelResponseError, isMemoryPressureError } from '@/lib/ai/local-stream'
import {
  boundConversation,
  buildCoachPrompt,
  buildCompactCoachPrompt,
  compactConversation,
} from '@/lib/ai/prompts'

export const runtime = 'nodejs'
export const maxDuration = 120

export async function POST(request: Request) {
  try {
    const body = await readJson(request, CoachRequestSchema)
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

    const controller = new AbortController()
    const signal = AbortSignal.any([
      request.signal,
      controller.signal,
      AbortSignal.timeout(115_000),
    ])
    const openStream = async (compact: boolean) => {
      const messages = compact
        ? compactConversation(body.messages)
        : boundConversation(body.messages)
      let streamError: unknown
      const result = streamText({
        model: createCoachModel(),
        instructions: compact
          ? buildCompactCoachPrompt(scenario, role, body.level)
          : buildCoachPrompt(scenario, role, body.level),
        messages: messages.length
          ? messages
          : [{ role: 'user', content: 'Begin the selected conversation practice.' }],
        maxOutputTokens: compact ? 100 : 180,
        temperature: 1,
        topP: 0.95,
        maxRetries: 0,
        abortSignal: signal,
        onError: ({ error }) => {
          streamError = error
        },
      })
      // Await actual output so prefill failures can be retried without duplicating speech.
      const iterator = result.textStream[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (first.done) {
        if (streamError) throw streamError
        throw new EmptyModelResponseError()
      }
      return { iterator, first, getError: () => streamError }
    }

    let opened: Awaited<ReturnType<typeof openStream>>
    let compact = false
    try {
      opened = await openStream(false)
    } catch (error) {
      if (
        signal.aborted ||
        (!isMemoryPressureError(error) && !(error instanceof EmptyModelResponseError))
      )
        throw error
      compact = true
      reportCoachIssue(
        'A recent turn hit memory pressure; retrying with a shorter conversation context.',
      )
      opened = await openStream(true)
    }
    const { iterator, first, getError } = opened
    reportCoachIssue()
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode(first.value))
      },
      async pull(streamController) {
        try {
          const next = await iterator.next()
          if (next.done) {
            const streamError = getError()
            if (streamError) throw streamError
            streamController.close()
          } else streamController.enqueue(encoder.encode(next.value))
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
        'X-Mentor-Context': compact ? 'reduced' : 'standard',
      },
    })
  } catch (error) {
    if (isMemoryPressureError(error)) {
      const detail =
        'The local coach needs more free memory, even with a shorter context. Close unused memory-heavy apps, then retry your turn.'
      reportCoachIssue(detail)
      return errorResponse(new RequestError(detail, 503), detail)
    }
    if (error instanceof EmptyModelResponseError) {
      return errorResponse(
        new RequestError(
          'The local coach returned no response after retrying. Check its terminal and try again.',
          503,
        ),
        error.message,
      )
    }
    return errorResponse(
      error,
      'The local coach is unavailable. Run npm run coach:start, then try again.',
    )
  }
}
