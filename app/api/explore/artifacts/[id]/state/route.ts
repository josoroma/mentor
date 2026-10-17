import { z } from 'zod'
import { readJson, errorResponse } from '@/lib/ai/http'
import { ExploreLearningStateSchema } from '@/lib/explore/schema'
import { requireExploreIdentity, saveExploreArtifactState } from '@/lib/explore/server'

export const runtime = 'nodejs'
const StateSchema = z.object({
  state: ExploreLearningStateSchema,
  expectedRevision: z.number().int().positive(),
})
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const identity = await requireExploreIdentity(request)
    // Full state can include 40 original drafts and 40 corrected versions.
    const input = await readJson(request, StateSchema, { maxBytes: 1024 * 1024 })
    return Response.json(
      await saveExploreArtifactState(
        identity,
        (await context.params).id,
        input.state,
        input.expectedRevision,
      ),
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return errorResponse(error, 'Could not save your learning state. Try again.')
  }
}
