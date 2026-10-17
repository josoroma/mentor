import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { assertSameOrigin, RequestError } from '@/lib/ai/http'
import {
  ExploreArtifactSchema,
  ExploreDetailSchema,
  ExploreLibrarySchema,
  ExploreLearningContextSchema,
  ExploreLearningStateSchema,
  ExploreMessagePageSchema,
  ExploreMessageSchema,
  ExploreMessageImprovementSchema,
  ExploreRevisionSchema,
  ExploreSessionSchema,
  ExploreTurnDraftSchema,
  ExploreTurnRequestSchema,
  type ExploreArtifact,
  type ExploreDetail,
  type ExploreLearningState,
  type ExploreLearningContext,
  type ExploreMessage,
  type ExploreTurnDraft,
  type ExploreTurnRequest,
} from '@/lib/explore/schema'

export type ExploreIdentity = { client: SupabaseClient; userId: string }

type DatabaseError = { code?: string; message: string }

export const throwExploreDatabaseError = (error: DatabaseError | null) => {
  if (!error) return
  if (error.code === 'P0002') throw new RequestError(error.message, 404)
  if (error.code === 'PT409' || error.code === '40001' || error.code === '23505')
    throw new RequestError(
      error.code === '23505'
        ? 'This exploration already exists. Reopen it and try again.'
        : error.message,
      409,
    )
  if (error.code === '28000' || error.code === 'PGRST301')
    throw new RequestError('Sign in again to access your explorations.', 401)
  if (error.code === '42501')
    throw new RequestError('This exploration does not belong to your account.', 403)
  if (error.code === '22023') throw new RequestError(error.message)
  throw new Error('The exploration database could not complete this operation.')
}

export async function requireExploreIdentity(request: Request): Promise<ExploreIdentity> {
  assertSameOrigin(request)
  const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1]
  if (!token) throw new RequestError('Sign in to access your explorations.', 401)
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new RequestError('Configure your learning database to use Explore.', 503)
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: { Authorization: `Bearer ${token}` },
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
        }),
    },
  })
  const { data, error } = await client.auth.getUser(token)
  if (error || !data.user) throw new RequestError('Sign in again to access your explorations.', 401)
  return { client, userId: data.user.id }
}

export const parseExploreId = (id: string) => {
  const result = z.uuid().safeParse(id)
  if (!result.success) throw new RequestError('Exploration identifier is invalid.')
  return result.data
}

export async function readExploreDetail(
  identity: ExploreIdentity,
  id: string,
): Promise<ExploreDetail> {
  const { data, error } = await identity.client.rpc('explore_read_detail', {
    p_session_id: parseExploreId(id),
  })
  throwExploreDatabaseError(error)
  if (!data) throw new RequestError('Exploration not found.', 404)
  const detail = ExploreDetailSchema.parse(data)
  const latestArtifact = detail.artifacts.at(-1)
  let learningContext = latestArtifact?.content.learningContext
  if (!latestArtifact) {
    // A complete message page already contains the original prompt. Only older
    // paginated histories need another read to recover their creation context.
    learningContext =
      detail.nextCursor === null
        ? detail.messages.find((message) => message.role === 'user')?.metadata.learningContext
        : (await readExploreLearningContexts(identity, [detail.session.id])).get(detail.session.id)
  }
  return {
    ...detail,
    session: { ...detail.session, learningContext },
  }
}

const ContextReferenceSchema = z.object({
  context: ExploreLearningContextSchema.nullable(),
})
const SessionContextRowSchema = z.object({
  id: z.uuid(),
  prompts: z.array(ContextReferenceSchema).max(1),
  artifacts: z.array(z.object({ revision: ContextReferenceSchema.nullable() })).max(1),
})

// Read only the first prompt and latest lesson's saved focus for each visible
// session. Embedded limits keep this bounded even for long conversations.
async function readExploreLearningContexts(identity: ExploreIdentity, ids: string[]) {
  const contexts = new Map<string, ExploreLearningContext | undefined>()
  if (!ids.length) return contexts
  const { data, error } = await identity.client
    .from('explore_sessions')
    .select(
      `
      id,
      prompts:explore_messages(context:metadata->learningContext),
      artifacts:explore_artifacts(
        revision:explore_artifact_revisions!explore_current_revision_fk(context:content->learningContext)
      )
    `,
    )
    .eq('user_id', identity.userId)
    .in('id', ids)
    .eq('prompts.role', 'user')
    .order('sequence', { referencedTable: 'prompts', ascending: true })
    .limit(1, { referencedTable: 'prompts' })
    .order('created_at', { referencedTable: 'artifacts', ascending: false })
    .order('id', { referencedTable: 'artifacts', ascending: false })
    .limit(1, { referencedTable: 'artifacts' })
  throwExploreDatabaseError(error)
  for (const row of z.array(SessionContextRowSchema).parse(data)) {
    const artifact = row.artifacts[0]
    contexts.set(
      row.id,
      (artifact ? artifact.revision?.context : row.prompts[0]?.context) ?? undefined,
    )
  }
  return contexts
}

export async function readExploreLibrary(
  identity: ExploreIdentity,
  query: { page: number; pageSize: number; q: string; kind?: string },
) {
  const { data, error } = await identity.client.rpc('explore_list_sessions', {
    p_page: query.page,
    p_page_size: query.pageSize,
    p_query: query.q,
    p_kind: query.kind ?? null,
  })
  throwExploreDatabaseError(error)
  const library = ExploreLibrarySchema.parse(data)
  const contexts = await readExploreLearningContexts(
    identity,
    library.sessions.map((session) => session.id),
  )
  return {
    ...library,
    sessions: library.sessions.map((session) => ({
      ...session,
      learningContext: contexts.get(session.id),
    })),
  }
}

const SessionRowSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  version: z.number(),
  artifact_kind: z.string().nullable(),
})
const parseSessionRow = (value: unknown) => {
  const row = SessionRowSchema.parse(value)
  return ExploreSessionSchema.parse({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    artifactKind: row.artifact_kind,
  })
}

export async function createExploreSession(
  identity: ExploreIdentity,
  input: { id?: string; title: string },
) {
  const { data, error } = await identity.client
    .from('explore_sessions')
    .insert({ user_id: identity.userId, id: input.id ?? crypto.randomUUID(), title: input.title })
    .select()
    .single()
  // A retried create with the same client-generated ID never produces a duplicate session.
  if (error?.code === '23505' && input.id) {
    const detail = await readExploreDetail(identity, input.id)
    return detail.session
  }
  throwExploreDatabaseError(error)
  return parseSessionRow(data)
}

export async function renameExploreSession(identity: ExploreIdentity, id: string, title: string) {
  const { data, error } = await identity.client
    .from('explore_sessions')
    .update({ title, updated_at: new Date().toISOString() })
    .eq('user_id', identity.userId)
    .eq('id', parseExploreId(id))
    .select()
    .maybeSingle()
  throwExploreDatabaseError(error)
  if (!data) throw new RequestError('Exploration not found.', 404)
  return parseSessionRow(data)
}

export async function deleteExploreSession(identity: ExploreIdentity, id: string) {
  const { data, error } = await identity.client
    .from('explore_sessions')
    .delete()
    .eq('user_id', identity.userId)
    .eq('id', parseExploreId(id))
    .select('id')
  throwExploreDatabaseError(error)
  if (!data?.length) throw new RequestError('Exploration not found.', 404)
}

export async function readExploreMessages(
  identity: ExploreIdentity,
  id: string,
  before: number | null,
  limit: number,
) {
  // Do not reveal whether another user's session exists.
  await readExploreSessionIdentity(identity, id)
  const { data, error } = await identity.client.rpc('explore_read_messages', {
    p_session_id: id,
    p_before: before,
    p_limit: limit,
  })
  throwExploreDatabaseError(error)
  return ExploreMessagePageSchema.parse(data)
}

async function readExploreSessionIdentity(identity: ExploreIdentity, id: string) {
  const { data, error } = await identity.client
    .from('explore_sessions')
    .select('id')
    .eq('user_id', identity.userId)
    .eq('id', parseExploreId(id))
    .maybeSingle()
  throwExploreDatabaseError(error)
  if (!data) throw new RequestError('Exploration not found.', 404)
}

async function readExploreArtifactIdentity(identity: ExploreIdentity, id: string) {
  const { data, error } = await identity.client
    .from('explore_artifacts')
    .select('id')
    .eq('user_id', identity.userId)
    .eq('id', parseExploreId(id))
    .maybeSingle()
  throwExploreDatabaseError(error)
  if (!data) throw new RequestError('Artifact not found.', 404)
}

// Reading a saved artifact is separate from inference and never changes learning state.
export async function readExploreArtifactForPractice(
  identity: ExploreIdentity,
  artifactId: string,
): Promise<ExploreArtifact> {
  const { data, error } = await identity.client.rpc('explore_read_artifact', {
    p_artifact_id: parseExploreId(artifactId),
  })
  throwExploreDatabaseError(error)
  if (!data) throw new RequestError('Artifact not found.', 404)
  return ExploreArtifactSchema.parse(data)
}

export async function saveExploreArtifactState(
  identity: ExploreIdentity,
  id: string,
  state: ExploreLearningState,
  expectedRevision: number,
): Promise<ExploreArtifact> {
  const parsed = ExploreLearningStateSchema.safeParse(state)
  if (!parsed.success) throw new RequestError('The saved learning state is invalid or too large.')
  const { data, error } = await identity.client.rpc('explore_save_state', {
    p_artifact_id: parseExploreId(id),
    p_expected_revision: expectedRevision,
    p_state: parsed.data,
  })
  throwExploreDatabaseError(error)
  return ExploreArtifactSchema.parse(data)
}

export async function readExploreRevisions(
  identity: ExploreIdentity,
  id: string,
  before: number | null,
  limit: number,
) {
  await readExploreArtifactIdentity(identity, id)
  const { data, error } = await identity.client.rpc('explore_read_revisions', {
    p_artifact_id: id,
    p_before: before,
    p_limit: limit,
  })
  throwExploreDatabaseError(error)
  const page = z
    .object({
      revisions: ExploreRevisionSchema.array(),
      nextCursor: z.number().int().nonnegative().nullable(),
    })
    .parse(data)
  if (!page.revisions.length) return page
  const prompts = await identity.client
    .from('explore_messages')
    .select('id,session_id,content')
    .eq('user_id', identity.userId)
    .in(
      'id',
      page.revisions.map((revision) => revision.messageId),
    )
  throwExploreDatabaseError(prompts.error)
  const messages = z
    .array(z.object({ id: z.uuid(), session_id: z.uuid(), content: z.string().min(1).max(16000) }))
    .parse(prompts.data)
  return {
    ...page,
    revisions: page.revisions.map((revision) => ({
      ...revision,
      sourcePrompt: messages.find(
        (message) => message.id === revision.messageId && message.session_id === revision.sessionId,
      )?.content,
    })),
  }
}

export async function restoreExploreRevision(
  identity: ExploreIdentity,
  id: string,
  revisionId: string,
  expectedRevision: number,
): Promise<ExploreArtifact> {
  const { data, error } = await identity.client.rpc('explore_restore_revision', {
    p_artifact_id: parseExploreId(id),
    p_revision_id: revisionId,
    p_expected_revision: expectedRevision,
  })
  throwExploreDatabaseError(error)
  return ExploreArtifactSchema.parse(data)
}

export async function beginExploreTurn(identity: ExploreIdentity, input: ExploreTurnRequest) {
  const request = ExploreTurnRequestSchema.parse(input)
  const { data, error } = await identity.client.rpc('explore_begin_turn', {
    p_session_id: request.sessionId,
    p_request_id: request.requestId,
    p_prompt: request.prompt,
    p_artifact_id: request.artifactId,
    p_expected_version: request.expectedVersion,
    p_learning_context: request.learningContext ?? null,
  })
  throwExploreDatabaseError(error)
  const result = z.object({ completed: z.boolean() }).parse(data)
  const detail = await readExploreDetail(identity, request.sessionId)
  const message = detail.messages.find(
    (item) => item.role === 'user' && item.requestId === request.requestId,
  )
  return {
    detail,
    completed: result.completed,
    learningContext: message?.metadata.learningContext,
  }
}

export async function completeExploreTurn(
  identity: ExploreIdentity,
  input: ExploreTurnRequest,
  value: ExploreTurnDraft,
): Promise<ExploreDetail> {
  const request = ExploreTurnRequestSchema.parse(input)
  const draft = ExploreTurnDraftSchema.parse(value)
  // The RPC atomically enforces discussion-only chat once an artifact exists.
  // Keeping this guard inside the commit also preserves completed request replays
  // and closes the race between an application preflight and an artifact write.
  const { error } = await identity.client.rpc('explore_complete_turn', {
    p_session_id: request.sessionId,
    p_request_id: request.requestId,
    p_reply: draft.reply,
    p_action: draft.action,
    p_content: draft.artifact,
  })
  throwExploreDatabaseError(error)
  return readExploreDetail(identity, request.sessionId)
}

export async function failExploreTurn(
  identity: ExploreIdentity,
  input: ExploreTurnRequest,
): Promise<void> {
  const request = ExploreTurnRequestSchema.parse(input)
  const { error } = await identity.client.rpc('explore_fail_turn', {
    p_session_id: request.sessionId,
    p_request_id: request.requestId,
  })
  throwExploreDatabaseError(error)
}

const ExploreMessageRowSchema = z.object({
  id: z.uuid(),
  session_id: z.uuid(),
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(16000),
  created_at: z.string().datetime({ offset: true }),
  sequence: z.number().int().nonnegative(),
  status: z.enum(['pending', 'complete', 'failed']),
  request_id: z.uuid(),
  metadata: ExploreMessageSchema.shape.metadata,
})

export async function readExploreMessageForImprovement(
  identity: ExploreIdentity,
  messageId: string,
): Promise<{
  message: ExploreMessage
  context: Array<{ role: 'user' | 'assistant'; content: string }>
}> {
  const { data, error } = await identity.client
    .from('explore_messages')
    .select('*')
    .eq('user_id', identity.userId)
    .eq('id', parseExploreId(messageId))
    .maybeSingle()
  throwExploreDatabaseError(error)
  if (!data) throw new RequestError('Exploration message not found.', 404)
  const row = ExploreMessageRowSchema.parse(data)
  const message = ExploreMessageSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    sequence: row.sequence,
    status: row.status,
    requestId: row.request_id,
    metadata: row.metadata,
  })
  if (message.role !== 'user' || message.metadata.action === 'restore')
    throw new RequestError('Only your own written prompts can receive improved wording.')
  const history = await identity.client
    .from('explore_messages')
    .select('role,content,sequence,metadata')
    .eq('user_id', identity.userId)
    .eq('session_id', message.sessionId)
    .lt('sequence', message.sequence)
    .eq('status', 'complete')
    .order('sequence', { ascending: false })
    .limit(8)
  throwExploreDatabaseError(history.error)
  const preceding = z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(16000),
        sequence: z.number().int().nonnegative(),
        metadata: ExploreMessageSchema.shape.metadata,
      }),
    )
    .parse(history.data)
  return {
    message,
    context: preceding
      .filter((item) => item.metadata.action !== 'restore')
      .reverse()
      .map(({ role, content }) => ({ role, content })),
  }
}

export async function saveExploreMessageImprovement(
  identity: ExploreIdentity,
  messageId: string,
  text: string,
): Promise<ExploreMessage> {
  const parsed = ExploreMessageImprovementSchema.shape.text.safeParse(text)
  if (!parsed.success) throw new RequestError('The improved wording is empty or too long.')
  const { data, error } = await identity.client.rpc('explore_save_message_improvement', {
    p_message_id: parseExploreId(messageId),
    p_text: parsed.data,
  })
  throwExploreDatabaseError(error)
  return ExploreMessageSchema.parse(data)
}
