import { z } from 'zod'
import { readJson, errorResponse } from '@/lib/ai/http'
import {
  deleteExploreSession,
  readExploreDetail,
  renameExploreSession,
  requireExploreIdentity,
} from '@/lib/explore/server'

export const runtime = 'nodejs'
type Context = { params: Promise<{ id: string }> }
const RenameSchema = z.object({ title: z.string().trim().min(1).max(160) })

export async function GET(request: Request, context: Context) {
  try {
    const identity = await requireExploreIdentity(request)
    return Response.json(await readExploreDetail(identity, (await context.params).id), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return errorResponse(error, 'Could not reopen your exploration. Try again.')
  }
}
export async function PATCH(request: Request, context: Context) {
  try {
    const identity = await requireExploreIdentity(request)
    const input = await readJson(request, RenameSchema)
    return Response.json(
      await renameExploreSession(identity, (await context.params).id, input.title),
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return errorResponse(error, 'Could not rename your exploration. Try again.')
  }
}
export async function DELETE(request: Request, context: Context) {
  try {
    const identity = await requireExploreIdentity(request)
    await deleteExploreSession(identity, (await context.params).id)
    return Response.json({ deleted: true }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return errorResponse(error, 'Could not delete your exploration. Try again.')
  }
}
