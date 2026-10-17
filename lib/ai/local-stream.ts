// MTPLX includes both choices and error in a failed SSE frame. The OpenAI
// provider's union schema otherwise accepts choices first and drops the error.
export const normalizeLocalEventLine = (line: string) => {
  if (!line.startsWith('data:')) return line
  try {
    const event = JSON.parse(line.slice(5).trim()) as Record<string, unknown>
    if (event.error) return `data: ${JSON.stringify({ error: event.error })}`
  } catch {
    // Comments, [DONE], and unrelated frames pass through unchanged.
  }
  return line
}

export const localModelFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
    return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ''
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        controller.enqueue(
          encoder.encode(`${normalizeLocalEventLine(pending.slice(0, newline))}\n`),
        )
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
    },
    flush(controller) {
      pending += decoder.decode()
      if (pending) controller.enqueue(encoder.encode(normalizeLocalEventLine(pending)))
    },
  })
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export const isMemoryPressureError = (error: unknown) => {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { statusCode?: number; message?: string; code?: string }
  return (
    candidate.statusCode === 507 ||
    candidate.code === 'insufficient_memory' ||
    /insufficient.memory|compressor|memory.pressure|out of memory/i.test(candidate.message ?? '')
  )
}

export class EmptyModelResponseError extends Error {
  constructor() {
    super('The local coach returned no spoken response.')
    this.name = 'EmptyModelResponseError'
  }
}
