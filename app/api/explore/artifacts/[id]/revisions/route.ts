import { z } from 'zod'
import { errorResponse, RequestError } from '@/lib/ai/http'
import { readExploreRevisions, requireExploreIdentity } from '@/lib/explore/server'

export const runtime = 'nodejs'
const QuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const identity = await requireExploreIdentity(request)
    const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!parsed.success) throw new RequestError('Invalid revision history cursor.')
    return Response.json(
      await readExploreRevisions(
        identity,
        (await context.params).id,
        parsed.data.before ?? null,
        parsed.data.limit,
      ),
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return errorResponse(error, 'Could not load artifact revisions. Try again.')
  }
}
