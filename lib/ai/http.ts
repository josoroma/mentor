import { z } from 'zod'

export class RequestError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message)
    this.name = 'RequestError'
  }
}

export const assertSameOrigin = (request: Request) => {
  const origin = request.headers.get('origin')
  if (!origin) return
  let allowed = false
  try {
    // Next dev may normalize request.url to localhost while the browser uses
    // 127.0.0.1. The HTTP Host header preserves the actual requested authority.
    const host = request.headers.get('host') ?? new URL(request.url).host
    allowed = new URL(origin).host === host
  } catch {
    allowed = false
  }
  if (!allowed) {
    throw new RequestError('Cross-origin requests are not allowed.', 403)
  }
}

export const readJson = async <T>(
  request: Request,
  schema: z.ZodType<T>,
  options: { maxBytes?: number } = {},
): Promise<T> => {
  const maxBytes = options.maxBytes ?? 128 * 1024
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error('The request body limit must be a positive integer.')
  assertSameOrigin(request)
  const reader = request.body?.getReader()
  if (!reader) throw new RequestError('Provide a JSON request body.')

  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > maxBytes) {
        await reader.cancel()
        throw new RequestError('This conversation is too large. Start a new practice session.', 413)
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }

  let input: unknown
  try {
    input = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new RequestError('The request must contain valid JSON.')
  }

  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new RequestError('The practice request is incomplete or invalid.')
  return parsed.data
}

export const errorResponse = (error: unknown, fallback: string) => {
  if (error instanceof RequestError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return Response.json({ error: 'The request was cancelled.' }, { status: 499 })
  }
  // Do not log conversation text, recordings, or upstream request bodies.
  console.error(
    '[mentor] Local service request failed:',
    error instanceof Error ? error.name : 'UnknownError',
  )
  return Response.json({ error: fallback }, { status: 503 })
}
