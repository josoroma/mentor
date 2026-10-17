import { SpeechProviderSchema, SpeechRequestSchema } from '@/lib/ai/contracts'
import { SpeechPersonaIdSchema } from '@/lib/audio/personas'
import { defaultSpeechProvider } from '@/lib/audio/speech-provider'
import { errorResponse, readJson, RequestError } from '@/lib/ai/http'
import { localServiceUrl } from '@/lib/ai/local-provider'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(request: Request) {
  try {
    request.signal.throwIfAborted()
    const parsed = await readJson(request, SpeechRequestSchema, { maxBytes: 16 * 1024 })
    const body = { ...parsed, provider: parsed.provider ?? defaultSpeechProvider }
    request.signal.throwIfAborted()
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(50_000)])
    const response = await fetch(`${localServiceUrl('speech')}/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (response.status === 429)
      throw new RequestError('Local speech is busy. Wait a moment and try again.', 429)
    if (response.status === 504)
      throw new RequestError('Local speech took too long to generate. Try a shorter passage.', 504)
    if (response.status === 400 || response.status === 422)
      throw new RequestError(
        'The selected voice model does not support this speech request or language. Choose another voice model in Settings.',
        422,
      )
    if (!response.ok || !response.headers.get('content-type')?.includes('audio/wav')) {
      throw new Error('Local synthesis failed')
    }
    const audio = await response.arrayBuffer()
    signal.throwIfAborted()
    if (!audio.byteLength) throw new Error('Local synthesis returned no audio')
    const provider = SpeechProviderSchema.safeParse(
      response.headers.get('X-Mentor-Speech-Provider'),
    )
    if (!provider.success || provider.data !== body.provider)
      throw new Error('The local speech service returned a different voice model')
    const persona = SpeechPersonaIdSchema.safeParse(response.headers.get('X-Mentor-Speech-Persona'))
    if (body.persona && (!persona.success || persona.data !== body.persona))
      throw new Error('The local speech service returned a different voice persona')
    return new Response(audio, {
      headers: {
        'Content-Type': 'audio/wav',
        'Cache-Control': 'no-store',
        ...(provider.success ? { 'X-Mentor-Speech-Provider': provider.data } : {}),
        ...(persona.success ? { 'X-Mentor-Speech-Persona': persona.data } : {}),
      },
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError')
      return errorResponse(
        new RequestError('Local speech took too long to generate. Try a shorter passage.', 503),
        '',
      )
    return errorResponse(
      error,
      'Local speech is unavailable. Check the local speech service and configured voice model, then retry.',
    )
  }
}
