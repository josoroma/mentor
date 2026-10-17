import { z } from 'zod'
import { readJson, errorResponse, RequestError } from '@/lib/ai/http'
import { ExploreArtifactKindSchema } from '@/lib/explore/schema'
import {
  createExploreSession,
  readExploreLibrary,
  requireExploreIdentity,
} from '@/lib/explore/server'

export const runtime = 'nodejs'
const QuerySchema = z.object({
  page: z.coerce.number().int().min(0).max(100000).default(0),
  pageSize: z.coerce.number().int().min(1).max(12).default(12),
  q: z.string().trim().max(200).default(''),
  kind: ExploreArtifactKindSchema.optional(),
})
const CreateSchema = z.object({ id: z.uuid().optional(), title: z.string().trim().min(1).max(160) })

export async function GET(request: Request) {
  try {
    const identity = await requireExploreIdentity(request)
    const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!parsed.success) throw new RequestError('Invalid exploration library filters.')
    return Response.json(await readExploreLibrary(identity, parsed.data), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return errorResponse(error, 'Could not load your explorations. Try again.')
  }
}

export async function POST(request: Request) {
  try {
    const identity = await requireExploreIdentity(request)
    const input = await readJson(request, CreateSchema)
    return Response.json(await createExploreSession(identity, input), {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return errorResponse(error, 'Could not create your exploration. Try again.')
  }
}
