import { errorResponse, readJson, RequestError } from '@/lib/ai/http'
import { reportCoachIssue } from '@/lib/ai/local-provider'
import { isMemoryPressureError } from '@/lib/ai/local-stream'
import { generateExploreImprovement } from '@/lib/explore/improvement'
import {
  buildExplorePracticeImprovementContext,
  ExplorePracticeImprovementRequestSchema,
  ExplorePracticeImprovementResponseSchema,
} from '@/lib/explore/practice-improvement'
import {
  parseExploreId,
  readExploreArtifactForPractice,
  requireExploreIdentity,
} from '@/lib/explore/server'

export const runtime = 'nodejs'
export const maxDuration = 90

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const timeout = AbortSignal.timeout(85_000)
  const signal = AbortSignal.any([request.signal, timeout])
  try {
    const input = await readJson(request, ExplorePracticeImprovementRequestSchema)
    const identity = await requireExploreIdentity(request)
    const artifactId = parseExploreId((await params).id)
    signal.throwIfAborted()
    const artifact = await readExploreArtifactForPractice(identity, artifactId)
    signal.throwIfAborted()
    const context = buildExplorePracticeImprovementContext(input, artifact)
    const improvedText = await generateExploreImprovement(input.text, context, signal)
    signal.throwIfAborted()
    const result = ExplorePracticeImprovementResponseSchema.safeParse({
      text: input.text,
      improvedText,
    })
    if (!result.success)
      throw new RequestError(
        'The local coach returned an invalid or overly long practice improvement. Try again.',
        503,
      )
    reportCoachIssue()
    return Response.json(result.data, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    let failure = error
    if (request.signal.aborted)
      failure = new RequestError(
        'Practice improvement was cancelled. Your draft is unchanged.',
        499,
      )
    else if (timeout.aborted)
      failure = new RequestError(
        'The local coach took too long to improve your practice. Try again.',
        504,
      )
    else if (isMemoryPressureError(error)) {
      const message =
        'The local coach needs more free memory. Close unused memory-heavy apps, then retry improving your practice.'
      reportCoachIssue(message)
      failure = new RequestError(message, 503)
    }
    const response = errorResponse(
      failure,
      'The local coach could not improve your practice. Check that it is running, then try again.',
    )
    response.headers.set('Cache-Control', 'no-store')
    return response
  }
}
