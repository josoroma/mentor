import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { SpeechLanguageSchema, SpeechProviderSchema } from '@/lib/ai/contracts'
import { SpeechPersonaSchema } from '@/lib/audio/personas'
import { localModelFetch } from '@/lib/ai/local-stream'

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
const CoachModelsSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1).max(4096),
        aliases: z.array(z.string().min(1).max(4096)).max(100).optional(),
        owned_by: z.string().min(1).max(200).optional(),
      }),
    )
    .max(100),
})
const ModelPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .regex(/^[^\u0000-\u001f\u007f]+$/)
const LlamaMetadataSchema = z.object({
  model_alias: z.string().min(1).max(4096),
  model_path: ModelPathSchema,
})
const MtplxMetadataSchema = z.object({
  ok: z.literal(true),
  model: z.string().min(1).max(4096),
  model_path: ModelPathSchema,
})
const ModelDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((name) => name !== '.' && name !== '..')
const SpeechProviderStatusSchema = z.object({
  synthesis: z.boolean().default(false),
  ready: z.boolean().optional(),
  provider: SpeechProviderSchema.optional(),
  synthesisModel: z.string().min(1).max(200).optional(),
  device: z.string().min(1).max(80).optional(),
  languages: z.array(SpeechLanguageSchema).max(23).optional(),
  voices: z
    .object({
      coach: z.string().min(1).max(200).optional(),
      partner: z.string().min(1).max(200).optional(),
    })
    .optional(),
  conversationSynthesis: z.boolean().optional(),
  personas: z
    .array(
      SpeechPersonaSchema.refine((persona) =>
        persona.languages.every((language) => SpeechLanguageSchema.safeParse(language).success),
      ),
    )
    .max(4)
    .refine((personas) => new Set(personas.map((persona) => persona.id)).size === personas.length)
    .optional(),
  detail: z
    .string()
    .max(1000)
    .nullish()
    .transform((value) => value ?? undefined),
})
const SpeechServiceStatusSchema = SpeechProviderStatusSchema.extend({
  recognition: z.boolean().default(false),
  model: z.string().min(1).max(200).default('Whisper'),
  providers: z
    .object({
      macos: SpeechProviderStatusSchema.optional(),
      kokoro: SpeechProviderStatusSchema.optional(),
      chatterbox: SpeechProviderStatusSchema.optional(),
    })
    .optional(),
})
let recentCoachIssue: { detail: string; timestamp: number } | undefined

export const reportCoachIssue = (detail?: string) => {
  recentCoachIssue = detail ? { detail, timestamp: Date.now() } : undefined
}

export const localServiceUrl = (kind: 'coach' | 'speech') => {
  const value =
    kind === 'coach'
      ? (process.env.LOCAL_AI_BASE_URL ?? 'http://127.0.0.1:8000/v1')
      : (process.env.LOCAL_SPEECH_URL ?? 'http://127.0.0.1:8765')
  const url = new URL(value)
  if (!loopbackHosts.has(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Local inference endpoints must use a loopback address.')
  }
  return value.replace(/\/+$/, '')
}

export const coachModelName = () => process.env.LOCAL_AI_MODEL ?? 'mtplx'

export const createCoachModel = () => {
  const provider = createOpenAI({
    baseURL: localServiceUrl('coach'),
    apiKey: 'mentor-local',
    fetch: localModelFetch,
  })
  // Explicit chat() avoids the Responses API, which MTPLX does not implement.
  return provider.chat(coachModelName())
}

const getCoachIdentity = async (baseUrl: string, models: unknown) => {
  const parsed = CoachModelsSchema.safeParse(models)
  if (!parsed.success) return {}
  const alias = coachModelName()
  const model = parsed.data.data.find(
    (entry) => entry.id === alias || entry.aliases?.includes(alias),
  )
  const runtime =
    model?.owned_by === 'llamacpp' ? 'llama.cpp' : model?.owned_by === 'mtplx' ? 'MTPLX' : undefined
  if (!runtime || !model) return {}

  try {
    // Model lists can contain API aliases, not checkpoint identities. Ask the
    // recognized runtime what is loaded, and never return its private path.
    const root = baseUrl.replace(/\/v1$/, '')
    const endpoint = runtime === 'llama.cpp' ? 'props' : 'health'
    const response = await fetch(`${root}/${endpoint}`, {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return { runtime }
    const body: unknown = await response.json()
    const metadata =
      runtime === 'llama.cpp' ? LlamaMetadataSchema.parse(body) : MtplxMetadataSchema.parse(body)
    const reportedAlias = 'model_alias' in metadata ? metadata.model_alias : metadata.model
    if (reportedAlias !== alias && reportedAlias !== model.id) return { runtime }
    const displayName = ModelDisplayNameSchema.safeParse(
      metadata.model_path.split(/[/\\]/).filter(Boolean).at(-1),
    )
    return displayName.success ? { runtime, displayName: displayName.data } : { runtime }
  } catch {
    // Optional identity metadata must not make a reachable coach unavailable.
    return { runtime }
  }
}

export const getCoachHealth = async () => {
  try {
    const baseUrl = localServiceUrl('coach')
    const response = await fetch(`${baseUrl}/models`, {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(2500),
    })
    if (!response.ok) throw new Error('Unavailable')
    const models: unknown = await response.json().catch(() => undefined)
    const identity = await getCoachIdentity(baseUrl, models)
    const issue =
      recentCoachIssue && Date.now() - recentCoachIssue.timestamp < 60_000
        ? recentCoachIssue.detail
        : undefined
    return {
      available: true,
      model: coachModelName(),
      ...identity,
      local: true,
      degraded: Boolean(issue),
      detail: issue,
    }
  } catch {
    return {
      available: false,
      model: coachModelName(),
      local: true,
      detail: 'Start the local coach with npm run coach:start.',
    }
  }
}

export const getSpeechHealth = async () => {
  try {
    const response = await fetch(`${localServiceUrl('speech')}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2500),
    })
    if (!response.ok) throw new Error('Unavailable')
    const body = SpeechServiceStatusSchema.parse(await response.json())
    return {
      ...body,
      available: body.recognition && body.synthesis,
      local: true,
    }
  } catch {
    return {
      available: false,
      recognition: false,
      synthesis: false,
      model: 'faster-whisper-base.en',
      local: true,
      detail: 'Run npm run speech:setup, then npm run speech:start.',
    }
  }
}
