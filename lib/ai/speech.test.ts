import { afterEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/speech/route'
import { SpeechLanguageSchema, SpeechProviderSchema, SpeechRequestSchema } from '@/lib/ai/contracts'
import { SpeechPersonaIdSchema } from '@/lib/audio/personas'

const request = (body: Record<string, unknown>) =>
  new Request('http://localhost:3000/api/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('two local speech voices', () => {
  it('preserves the coach voice for existing speech requests', () => {
    expect(SpeechRequestSchema.parse({ text: '  Hello.  ' })).toEqual({
      text: 'Hello.',
      voice: 'coach',
    })
  })

  it.each(['coach', 'partner'])(
    'forwards the %s voice only to the local speech service',
    async (voice) => {
      const fetchMock = vi.fn(
        async () =>
          new Response('local wav', {
            headers: { 'Content-Type': 'audio/wav', 'X-Mentor-Speech-Provider': 'kokoro' },
          }),
      )
      vi.stubGlobal('fetch', fetchMock)
      const response = await POST(request({ text: 'A story about a team.', voice }))
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:8765/speech',
        expect.objectContaining({
          body: JSON.stringify({ text: 'A story about a team.', voice, provider: 'kokoro' }),
          signal: expect.any(AbortSignal),
        }),
      )
    },
  )

  it('explicitly requests Kokoro when the learner has not chosen a provider', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('local wav', {
          headers: { 'Content-Type': 'audio/wav', 'X-Mentor-Speech-Provider': 'kokoro' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(request({ text: 'Hello.' }))

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Mentor-Speech-Provider')).toBe('kokoro')
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({
      text: 'Hello.',
      voice: 'coach',
      provider: 'kokoro',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(SpeechProviderSchema.options)(
    'forwards the explicit %s provider and returns its validated response identity',
    async (provider) => {
      const fetchMock = vi.fn(
        async () =>
          new Response('local wav', {
            headers: { 'Content-Type': 'audio/wav', 'X-Mentor-Speech-Provider': provider },
          }),
      )
      vi.stubGlobal('fetch', fetchMock)
      const response = await POST(request({ text: 'Hello.', voice: 'partner', provider }))
      expect(response.status).toBe(200)
      expect(response.headers.get('X-Mentor-Speech-Provider')).toBe(provider)
      expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({
        text: 'Hello.',
        voice: 'partner',
        provider,
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it.each(SpeechPersonaIdSchema.options)(
    'forwards the exact %s persona and requires the matching audio identity',
    async (persona) => {
      const fetchMock = vi.fn(
        async () =>
          new Response('local wav', {
            headers: {
              'Content-Type': 'audio/wav',
              'X-Mentor-Speech-Provider': 'kokoro',
              'X-Mentor-Speech-Persona': persona,
            },
          }),
      )
      vi.stubGlobal('fetch', fetchMock)
      const response = await POST(request({ text: 'Hello.', provider: 'kokoro', persona }))
      expect(response.status).toBe(200)
      expect(response.headers.get('X-Mentor-Speech-Persona')).toBe(persona)
      expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({
        text: 'Hello.',
        voice: 'coach',
        provider: 'kokoro',
        persona,
      })
    },
  )

  it.each(['custom.wav', '/private/reference.wav', '', null, 42])(
    'rejects arbitrary persona %s before contacting synthesis',
    async (persona) => {
      vi.stubGlobal('fetch', vi.fn())
      expect((await POST(request({ text: 'Hello.', persona }))).status).toBe(400)
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each([undefined, 'sam', 'arbitrary-persona'])(
    'rejects missing or substituted persona identity (%s)',
    async (persona) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('unverified audio', {
              headers: {
                'Content-Type': 'audio/wav',
                'X-Mentor-Speech-Provider': 'kokoro',
                ...(persona ? { 'X-Mentor-Speech-Persona': persona } : {}),
              },
            }),
        ),
      )
      expect((await POST(request({ text: 'Hello.', persona: 'alex' }))).status).toBe(503)
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['hosted', 'auto', '', null, 42])(
    'rejects invalid provider %s before synthesis',
    async (provider) => {
      vi.stubGlobal('fetch', vi.fn())
      expect((await POST(request({ text: 'Hello.', provider }))).status).toBe(400)
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it('does not forward an arbitrary upstream provider response header', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('local wav', {
            headers: {
              'Content-Type': 'audio/wav',
              'X-Mentor-Speech-Provider': 'private diagnostics',
            },
          }),
      ),
    )
    const response = await POST(request({ text: 'Hello.' }))
    expect(response.status).toBe(503)
    expect(response.headers.get('X-Mentor-Speech-Provider')).toBeNull()
  })

  it.each([undefined, 'chatterbox', 'macos'])(
    'rejects an unverified or substituted default provider (%s)',
    async (provider) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('other engine audio', {
              headers: {
                'Content-Type': 'audio/wav',
                ...(provider ? { 'X-Mentor-Speech-Provider': provider } : {}),
              },
            }),
        ),
      )

      const response = await POST(request({ text: 'Hello.' }))

      expect(response.status).toBe(503)
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it('rejects a provider substitution reported by the speech service', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('wrong provider audio', {
            headers: { 'Content-Type': 'audio/wav', 'X-Mentor-Speech-Provider': 'macos' },
          }),
      ),
    )
    const response = await POST(request({ text: 'Hello.', provider: 'kokoro' }))
    expect(response.status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, 'unknown'])(
    'requires verified provider identity for an explicit choice (%s)',
    async (provider) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('unverified audio', {
              headers: {
                'Content-Type': 'audio/wav',
                ...(provider ? { 'X-Mentor-Speech-Provider': provider } : {}),
              },
            }),
        ),
      )
      expect((await POST(request({ text: 'Hello.', provider: 'kokoro' }))).status).toBe(503)
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['Daniel', 'unavailable', 'Samantha; echo hello', '', null])(
    'rejects arbitrary voice selection %s before synthesis',
    async (voice) => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      expect((await POST(request({ text: 'Hello.', voice }))).status).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('reports an unavailable partner without substituting the coach voice', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn(async () =>
      Response.json({ detail: 'The partner voice is unavailable.' }, { status: 503 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const response = await POST(request({ text: 'Hello.', voice: 'partner' }))
    expect(response.status).toBe(503)
    expect(await response.json()).toHaveProperty('error')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    [429, 'Local speech is busy. Wait a moment and try again.'],
    [504, 'Local speech took too long to generate. Try a shorter passage.'],
    [
      422,
      'The selected voice model does not support this speech request or language. Choose another voice model in Settings.',
    ],
  ] as const)('reports upstream %s with a safe actionable message', async (status, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { detail: 'Private model path and internal service diagnostics' },
          { status },
        ),
      ),
    )
    const response = await POST(request({ text: 'Hello.' }))
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: message })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each(SpeechLanguageSchema.options)(
    'forwards the explicit %s language unchanged',
    async (language) => {
      const fetchMock = vi.fn(
        async () =>
          new Response('local wav', {
            headers: { 'Content-Type': 'audio/wav', 'X-Mentor-Speech-Provider': 'kokoro' },
          }),
      )
      vi.stubGlobal('fetch', fetchMock)
      const response = await POST(request({ text: 'Hola.', language, voice: 'partner' }))
      expect(response.status).toBe(200)
      expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({
        text: 'Hola.',
        language,
        voice: 'partner',
        provider: 'kokoro',
      })
    },
  )

  it.each(['auto', 'en-US', 'unsupported', null, 42])(
    'rejects unsupported language %s before synthesis',
    async (language) => {
      vi.stubGlobal('fetch', vi.fn())
      expect((await POST(request({ text: 'Hello.', language }))).status).toBe(400)
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it('bounds text and request bytes before sending anything to the local model', async () => {
    vi.stubGlobal('fetch', vi.fn())
    expect(SpeechRequestSchema.safeParse({ text: 'x'.repeat(2400) }).success).toBe(true)
    expect((await POST(request({ text: 'x'.repeat(2401) }))).status).toBe(400)
    expect((await POST(request({ text: 'Hello.', extra: 'x'.repeat(17000) }))).status).toBe(413)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects cross-origin requests and non-loopback service configuration', async () => {
    vi.stubGlobal('fetch', vi.fn())
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const crossOrigin = request({ text: 'Private practice.' })
    crossOrigin.headers.set('Origin', 'https://outside.example')
    expect((await POST(crossOrigin)).status).toBe(403)
    vi.stubEnv('LOCAL_SPEECH_URL', 'https://outside.example')
    expect((await POST(request({ text: 'Private practice.' }))).status).toBe(503)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    () => Response.json({ audio: 'invalid' }),
    () => new Response(null, { headers: { 'Content-Type': 'audio/wav' } }),
  ])('reports unusable local audio with a provider-neutral retry message', async (reply) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply()),
    )
    const response = await POST(request({ text: 'Hello.' }))
    expect(response.status).toBe(503)
    expect((await response.json()).error).toMatch(/local speech service and configured voice model/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not start synthesis for an already cancelled browser request', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const controller = new AbortController()
    controller.abort()
    const cancelled = new Request(request({ text: 'Hello.' }), { signal: controller.signal })
    expect((await POST(cancelled)).status).toBe(499)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('propagates browser cancellation to an in-flight synthesis request', async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const signal = init?.signal as AbortSignal
        controller.abort()
        signal.throwIfAborted()
        return new Response('unreachable')
      }),
    )
    const cancelled = new Request(request({ text: 'Hello.' }), { signal: controller.signal })
    expect((await POST(cancelled)).status).toBe(499)
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it('limits local synthesis to fifty seconds and returns a useful timeout response', async () => {
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        deadline.abort(new DOMException('Timed out', 'TimeoutError'))
        init?.signal?.throwIfAborted()
        return new Response('unreachable')
      }),
    )
    const response = await POST(request({ text: 'Hello.' }))
    expect(timeout).toHaveBeenCalledWith(50_000)
    expect(response.status).toBe(503)
    expect((await response.json()).error).toContain('took too long')
  })
})
