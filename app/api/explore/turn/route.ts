import { errorResponse, readJson, RequestError } from '@/lib/ai/http'
import { reportCoachIssue } from '@/lib/ai/local-provider'
import { isMemoryPressureError } from '@/lib/ai/local-stream'
import { generateExploreTurn } from '@/lib/explore/generation'
import {
  ExploreDetailSchema,
  ExploreTurnRequestSchema,
  type ExploreTurnRequest,
} from '@/lib/explore/schema'
import {
  beginExploreTurn,
  completeExploreTurn,
  failExploreTurn,
  requireExploreIdentity,
  type ExploreIdentity,
} from '@/lib/explore/server'

export const runtime = 'nodejs'
export const maxDuration = 180

export async function POST(request: Request) {
  const timeout = AbortSignal.timeout(175_000)
  const signal = AbortSignal.any([request.signal, timeout])
  let identity: ExploreIdentity | undefined
  let body: ExploreTurnRequest | undefined
  let pending = false
  try {
    body = await readJson(request, ExploreTurnRequestSchema)
    identity = await requireExploreIdentity(request)
    signal.throwIfAborted()
    const started = await beginExploreTurn(identity, body)
    if (started.completed)
      return Response.json(ExploreDetailSchema.parse(started.detail), {
        headers: { 'Cache-Control': 'no-store' },
      })
    pending = true
    signal.throwIfAborted()
    // A retried initial question keeps the focus saved with its original prompt,
    // including when an older client omits that context after a reload.
    if (started.learningContext) body = { ...body, learningContext: started.learningContext }
    const draft = await generateExploreTurn(body, started.detail, signal)
    signal.throwIfAborted()
    const detail = await completeExploreTurn(identity, body, draft)
    pending = false
    reportCoachIssue()
    return Response.json(ExploreDetailSchema.parse(detail), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    if (pending && identity && body) {
      // This uses the authenticated DB client, independent of the cancelled inference signal.
      // A failed turn remains visible and can be retried with the same request identity.
      await failExploreTurn(identity, body).catch(() => {
        console.error(
          '[mentor] Could not mark an Explore turn as failed; its pending lease will expire.',
        )
      })
    }
    let failure = error
    const retryMessage = pending
      ? 'Your message is saved and can be retried.'
      : 'You can retry this request.'
    if (request.signal.aborted)
      failure = new RequestError(`Exploration generation was cancelled. ${retryMessage}`, 499)
    else if (timeout.aborted)
      failure = new RequestError(`The local coach took too long. ${retryMessage}`, 504)
    else if (isMemoryPressureError(error)) {
      const message =
        'The local coach needs more free memory. Close unused memory-heavy apps, then retry this exploration.'
      reportCoachIssue(message)
      failure = new RequestError(message, 503)
    }
    const response = errorResponse(
      failure,
      'The local coach could not complete this exploration. Check that it is running, then retry your saved message.',
    )
    response.headers.set('Cache-Control', 'no-store')
    return response
  }
}
