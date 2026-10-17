import { z } from 'zod'
import { errorResponse, readJson, RequestError } from '@/lib/ai/http'
import { reportCoachIssue } from '@/lib/ai/local-provider'
import { isMemoryPressureError } from '@/lib/ai/local-stream'
import { generateExploreImprovement } from '@/lib/explore/improvement'
import { ExploreMessageSchema } from '@/lib/explore/schema'
import {
  parseExploreId,
  readExploreMessageForImprovement,
  requireExploreIdentity,
  saveExploreMessageImprovement,
} from '@/lib/explore/server'

export const runtime = 'nodejs'
export const maxDuration = 90

const ImproveMessageRequestSchema = z.object({}).strict()

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const timeout = AbortSignal.timeout(85_000)
  const signal = AbortSignal.any([request.signal, timeout])
  try {
    await readJson(request, ImproveMessageRequestSchema)
    const identity = await requireExploreIdentity(request)
    const messageId = parseExploreId((await params).id)
    signal.throwIfAborted()
    const { message, context } = await readExploreMessageForImprovement(identity, messageId)
    signal.throwIfAborted()
    if (message.metadata.improvement)
      return Response.json(ExploreMessageSchema.parse(message), {
        headers: { 'Cache-Control': 'no-store' },
      })
    const improved = await generateExploreImprovement(message.content, context, signal)
    signal.throwIfAborted()
    const saved = await saveExploreMessageImprovement(identity, messageId, improved)
    reportCoachIssue()
    return Response.json(ExploreMessageSchema.parse(saved), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    let failure = error
    if (request.signal.aborted)
      failure = new RequestError(
        'Message improvement was cancelled. Your original message is unchanged.',
        499,
      )
    else if (timeout.aborted)
      failure = new RequestError(
        'The local coach took too long to improve this message. Try again.',
        504,
      )
    else if (isMemoryPressureError(error)) {
      const message =
        'The local coach needs more free memory. Close unused memory-heavy apps, then retry improving this message.'
      reportCoachIssue(message)
      failure = new RequestError(message, 503)
    }
    const response = errorResponse(
      failure,
      'The local coach could not improve this message. Check that it is running, then try again.',
    )
    response.headers.set('Cache-Control', 'no-store')
    return response
  }
}
