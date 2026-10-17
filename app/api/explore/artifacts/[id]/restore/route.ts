import { z } from 'zod'
import { readJson, errorResponse } from '@/lib/ai/http'
import { requireExploreIdentity, restoreExploreRevision } from '@/lib/explore/server'

export const runtime = 'nodejs'
const RestoreSchema = z.object({
  revisionId: z.uuid(),
  expectedRevision: z.number().int().positive(),
})
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const identity = await requireExploreIdentity(request)
    const input = await readJson(request, RestoreSchema)
    return Response.json(
      await restoreExploreRevision(
        identity,
        (await context.params).id,
        input.revisionId,
        input.expectedRevision,
      ),
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return errorResponse(error, 'Could not restore this artifact revision. Try again.')
  }
}
