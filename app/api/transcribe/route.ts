import { TranscriptionSchema } from '@/lib/ai/contracts'
import { assertSameOrigin, errorResponse, RequestError } from '@/lib/ai/http'
import { localServiceUrl } from '@/lib/ai/local-provider'

export const runtime = 'nodejs'
export const maxDuration = 60

const maxAudioBytes = 8 * 1024 * 1024

export async function POST(request: Request) {
  try {
    assertSameOrigin(request)
    if (Number(request.headers.get('content-length') ?? 0) > maxAudioBytes + 16_384) {
      throw new RequestError('Please record a shorter audio segment.', 413)
    }
    const form = await request.formData()
    const audio = form.get('audio')
    if (!(audio instanceof File) || audio.size === 0) {
      throw new RequestError('A microphone recording is required.')
    }
    if (audio.size > maxAudioBytes)
      throw new RequestError('Please record a shorter audio segment.', 413)
    const upstreamForm = new FormData()
    upstreamForm.append('audio', audio, 'recording')
    const response = await fetch(`${localServiceUrl('speech')}/transcribe`, {
      method: 'POST',
      body: upstreamForm,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(50_000)]),
    })
    if (!response.ok) {
      if (response.status === 422)
        throw new RequestError('The audio could not be decoded. Please try recording again.', 422)
      if (response.status === 413)
        throw new RequestError('Please record a shorter audio segment.', 413)
      throw new Error('Local recognition failed')
    }
    const transcript = TranscriptionSchema.parse(await response.json())
    return Response.json(transcript, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return errorResponse(
      error,
      'Local transcription is unavailable. Run npm run speech:start, then try again.',
    )
  }
}
