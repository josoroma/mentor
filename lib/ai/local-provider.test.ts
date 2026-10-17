import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  coachModelName,
  getCoachHealth,
  getSpeechHealth,
  localServiceUrl,
  reportCoachIssue,
} from '@/lib/ai/local-provider'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  reportCoachIssue()
})

describe('local inference privacy boundary', () => {
  it('does not forward a transcript to an accidentally configured hosted service', () => {
    vi.stubEnv('LOCAL_AI_BASE_URL', 'https://example.com/v1')
    expect(() => localServiceUrl('coach')).toThrow('loopback')
  })

  it('supports an explicitly configured local service', () => {
    vi.stubEnv('LOCAL_AI_BASE_URL', 'http://localhost:8000/v1/')
    expect(localServiceUrl('coach')).toBe('http://localhost:8000/v1')
  })
})

describe('local coach model identity', () => {
  const list = { data: [{ id: 'mtplx', owned_by: 'llamacpp' }] }

  it('distinguishes the loaded checkpoint from its request alias without exposing paths', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(list))
      .mockResolvedValueOnce(
        Response.json({
          model_alias: 'mtplx',
          model_path: '/Users/private/Models/gemma-4-E2B-it-UD-Q4_K_XL.gguf',
          chat_template: 'Private runtime configuration',
        }),
      )
    vi.stubGlobal('fetch', fetch)

    const health = await getCoachHealth()
    expect(health).toMatchObject({
      available: true,
      model: 'mtplx',
      displayName: 'gemma-4-E2B-it-UD-Q4_K_XL.gguf',
      runtime: 'llama.cpp',
      local: true,
    })
    expect(coachModelName()).toBe('mtplx')
    expect(JSON.stringify(health)).not.toContain('/Users/')
    expect(health).not.toHaveProperty('chat_template')
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:8000/props',
      expect.objectContaining({ cache: 'no-store', redirect: 'error' }),
    )
  })

  it('reads the loaded MTPLX directory from that runtime’s health metadata', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'mtplx', owned_by: 'mtplx' }] }))
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          model: 'mtplx',
          model_path: '/Users/private/Models/Ternary-Bonsai-2-27B-MTPLX-Optimized-Speed/',
        }),
      )
    vi.stubGlobal('fetch', fetch)

    expect(await getCoachHealth()).toMatchObject({
      available: true,
      displayName: 'Ternary-Bonsai-2-27B-MTPLX-Optimized-Speed',
      runtime: 'MTPLX',
    })
    expect(fetch).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:8000/health', expect.any(Object))
  })

  it('matches the configured alias in a model list instead of picking the first entry', async () => {
    vi.stubEnv('LOCAL_AI_MODEL', 'mentor-coach')
    vi.stubEnv('LOCAL_AI_BASE_URL', 'http://localhost:9000/local/v1/')
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: [
            { id: 'unrelated', owned_by: 'mtplx' },
            { id: 'served-checkpoint', aliases: ['mentor-coach'], owned_by: 'llamacpp' },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ model_alias: 'served-checkpoint', model_path: '/private/correct.gguf' }),
      )
    vi.stubGlobal('fetch', fetch)

    expect(await getCoachHealth()).toMatchObject({
      model: 'mentor-coach',
      displayName: 'correct.gguf',
    })
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'http://localhost:9000/local/props',
      expect.any(Object),
    )
  })

  it.each([
    { data: [{ id: 'other-model', owned_by: 'llamacpp' }] },
    { data: [{ id: 'mtplx', owned_by: 'unknown-runtime' }] },
    { data: [{ id: 'mtplx', owned_by: 12 }] },
    { data: [] },
    {},
  ])('does not guess a checkpoint from unmatched or invalid model metadata: %j', async (body) => {
    const fetch = vi.fn().mockResolvedValue(Response.json(body))
    vi.stubGlobal('fetch', fetch)
    vi.stubEnv('MENTOR_COACH_MODEL', '/private/configured-but-not-loaded.gguf')
    const health = await getCoachHealth()
    expect(health).toMatchObject({ available: true, model: 'mtplx' })
    expect(health).not.toHaveProperty('displayName')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    { model_alias: 'other-model', model_path: '/private/wrong.gguf' },
    { model_alias: 'mtplx', model_path: { name: 'invalid' } },
    { model_alias: 'mtplx', model_path: '/private/model\n.gguf' },
    { model_alias: 'mtplx', model_path: '/private/..' },
    {},
  ])(
    'ignores invalid or mismatched runtime metadata without losing availability: %j',
    async (body) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(Response.json(list))
          .mockResolvedValueOnce(Response.json(body)),
      )
      const health = await getCoachHealth()
      expect(health).toMatchObject({ available: true, model: 'mtplx', runtime: 'llama.cpp' })
      expect(health).not.toHaveProperty('displayName')
    },
  )

  it('keeps recent generation failures visible when identity metadata times out', async () => {
    reportCoachIssue('The previous response exceeded the local model context.')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(list))
        .mockRejectedValueOnce(new DOMException('Metadata timeout', 'TimeoutError')),
    )
    expect(await getCoachHealth()).toMatchObject({
      available: true,
      runtime: 'llama.cpp',
      degraded: true,
      detail: 'The previous response exceeded the local model context.',
    })
  })

  it('keeps a failed model-list request unavailable and does not probe metadata', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    expect(await getCoachHealth()).toMatchObject({ available: false, model: 'mtplx', local: true })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('never contacts a hosted coach for either the model list or metadata', async () => {
    vi.stubEnv('LOCAL_AI_BASE_URL', 'https://example.com/v1')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await getCoachHealth()).toMatchObject({ available: false })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('local speech capabilities', () => {
  const health = {
    recognition: true,
    synthesis: true,
    model: 'faster-whisper-base.en',
    provider: 'chatterbox',
    synthesisModel: 'Chatterbox Multilingual V3',
    device: 'mps',
    languages: ['en', 'es', 'fr'],
    voices: { coach: 'Alex', partner: 'Sam' },
    conversationSynthesis: true,
  }

  it('exposes validated voice capabilities without replacing the recognition model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...health, detail: null, privatePath: '/private' })),
    )
    expect(await getSpeechHealth()).toEqual({ ...health, available: true, local: true })
  })

  it('keeps recognition and synthesis readiness independent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ...health,
          synthesis: false,
          conversationSynthesis: false,
          voices: {},
        }),
      ),
    )
    expect(await getSpeechHealth()).toMatchObject({
      available: false,
      recognition: true,
      synthesis: false,
      model: 'faster-whisper-base.en',
    })
  })

  it('accepts legacy local speech health without inventing provider capabilities', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ recognition: true, synthesis: true, model: 'Whisper' })),
    )
    expect(await getSpeechHealth()).toEqual({
      recognition: true,
      synthesis: true,
      model: 'Whisper',
      available: true,
      local: true,
    })
  })

  it('exposes each installed choice independently from an unavailable default', async () => {
    const providers = {
      chatterbox: {
        synthesis: false,
        provider: 'chatterbox',
        languages: [],
        voices: {},
        detail: 'Run setup.',
      },
      kokoro: {
        synthesis: true,
        provider: 'kokoro',
        languages: ['en', 'es'],
        voices: { coach: 'Alex', partner: 'Sam' },
        privatePath: '/private',
      },
      macos: {
        synthesis: true,
        provider: 'macos',
        languages: ['en'],
        voices: { coach: 'Samantha', partner: 'Daniel' },
      },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...health, synthesis: false, providers })),
    )
    const result = await getSpeechHealth()
    expect(result).toMatchObject({
      available: false,
      recognition: true,
      providers: {
        chatterbox: { synthesis: false },
        kokoro: { synthesis: true, languages: ['en', 'es'] },
        macos: { synthesis: true, languages: ['en'] },
      },
    })
    expect(result).not.toHaveProperty('providers.kokoro.privatePath')
  })

  it('rejects malformed capability data rather than advertising it as ready', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...health, languages: ['unsupported'] })),
    )
    expect(await getSpeechHealth()).toMatchObject({ available: false, local: true })
  })

  it('exposes only validated builtin persona capabilities and discards private fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ...health,
          personas: [
            {
              id: 'alex',
              name: 'Alex',
              languages: ['en', 'es'],
              referencePath: '/private/voice.wav',
            },
          ],
        }),
      ),
    )
    expect(await getSpeechHealth()).toMatchObject({
      personas: [{ id: 'alex', name: 'Alex', languages: ['en', 'es'] }],
    })
    expect(await getSpeechHealth()).not.toHaveProperty('personas.0.referencePath')
  })

  it.each([
    [{ id: 'unknown', name: 'Unknown', languages: ['en'] }],
    [{ id: 'alex', name: 'Custom identity', languages: ['en'] }],
    [{ id: 'alex', name: 'Alex', languages: ['xx'] }],
    [{ id: 'alex', name: 'Alex', languages: [] }],
    [
      { id: 'alex', name: 'Alex', languages: ['en'] },
      { id: 'alex', name: 'Alex', languages: ['es'] },
    ],
  ])('rejects malformed persona health instead of advertising it', async (...personas) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...health, personas })),
    )
    expect(await getSpeechHealth()).toMatchObject({ available: false })
  })
})
