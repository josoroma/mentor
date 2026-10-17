import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { checkExplorePracticePersistence } from '@/tests/fixtures/explore-practice'
import {
  readExploreMessageForImprovement,
  readExploreDetail,
  readExploreLibrary,
  saveExploreMessageImprovement,
} from '@/lib/explore/server'
import {
  ExploreBackupSchema,
  ExploreDetailSchema,
  type ExploreArtifactContent,
} from '@/lib/explore/schema'

// Explicit integration opt-in: never touch the learner's existing authentication or records.
const enabled = process.env.MENTOR_EXPLORE_DB_TEST === '1'
const artifact: ExploreArtifactContent = {
  kind: 'hanoi',
  learningContext: {
    selection: { path: 'professional', roleId: 'frontend-engineer' },
    level: 'B2',
  },
  title: 'Towers of Hanoi',
  summary: 'Move disks between three pegs.',
  objectives: ['Explain recursion'],
  sections: [],
  steps: [],
  examples: [],
  nodes: [],
  edges: [],
  questions: [],
  config: {
    size: 3,
    values: [],
    simulation: 'pendulum',
    pseudocode: 'move(n - 1); move largest; move(n - 1)',
    complexity: '2^n - 1 moves',
  },
  assumptions: [],
}

describe.skipIf(!enabled)('Explore local database integration', () => {
  it('persists isolated histories, atomic revisions, concurrency, pagination, restoration and ownership', async () => {
    const env = Object.fromEntries(
      readFileSync('.env.local', 'utf8')
        .split('\n')
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => {
          const split = line.indexOf('=')
          return [line.slice(0, split), line.slice(split + 1).replace(/^['"]|['"]$/g, '')]
        }),
    )
    expect(new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname).toBe('127.0.0.1')
    const identities: { client: SupabaseClient; userId: string }[] = []
    const rpc = async (client: SupabaseClient, name: string, args?: Record<string, unknown>) => {
      const result = await client.rpc(name, args)
      if (result.error) throw new Error(`${name}: ${result.error.code}: ${result.error.message}`)
      return result.data
    }
    try {
      for (let i = 0; i < 2; i++) {
        const client = createClient(
          env.NEXT_PUBLIC_SUPABASE_URL,
          env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
          { auth: { persistSession: false, autoRefreshToken: false } },
        )
        const { data, error } = await client.auth.signInAnonymously()
        expect(error).toBeNull()
        identities.push({ client, userId: data.user!.id })
      }
      const [owner, other] = identities
      await checkExplorePracticePersistence(owner, other, artifact)
      const sessionId = crypto.randomUUID()
      const insert = await owner.client
        .from('explore_sessions')
        .insert({ user_id: owner.userId, id: sessionId, title: '100% Hanoi exploration' })
      expect(insert.error).toBeNull()
      const invisible = await rpc(other.client, 'explore_read_detail', { p_session_id: sessionId })
      expect(invisible).toBeNull()
      const forbidden = await other.client
        .from('explore_sessions')
        .insert({ user_id: owner.userId, title: 'Intrusion' })
      expect(forbidden.error?.code).toBe('42501')
      const detail = () =>
        rpc(owner.client, 'explore_read_detail', { p_session_id: sessionId }).then((data) =>
          ExploreDetailSchema.parse(data),
        )
      expect((await detail()).session.version).toBe(0)
      const requestId = crypto.randomUUID()
      const turn = {
        p_session_id: sessionId,
        p_request_id: requestId,
        p_prompt: 'Explain Hanoi',
        p_artifact_id: null,
        p_expected_version: 0,
        p_learning_context: artifact.learningContext,
      }
      const concurrent = await Promise.all([
        owner.client.rpc('explore_begin_turn', turn),
        owner.client.rpc('explore_begin_turn', { ...turn, p_request_id: crypto.randomUUID() }),
      ])
      expect(concurrent.filter((result) => !result.error)).toHaveLength(1)
      expect(concurrent.find((result) => result.error)?.error?.code).toBe('PT409')
      let current = await detail()
      const winningId = current.messages[0].requestId
      await rpc(owner.client, 'explore_fail_turn', {
        p_session_id: sessionId,
        p_request_id: winningId,
      })
      expect((await detail()).messages[0].status).toBe('failed')
      const failed = await detail()
      const originalMessage = failed.messages[0]
      expect(originalMessage.metadata.learningContext).toEqual(artifact.learningContext)
      expect((await readExploreDetail(owner, sessionId)).session.learningContext).toEqual(
        artifact.learningContext,
      )
      const contextQuery = { page: 0, pageSize: 12, q: '100% Hanoi' }
      expect((await readExploreLibrary(owner, contextQuery)).sessions[0].learningContext).toEqual(
        artifact.learningContext,
      )
      expect((await readExploreLibrary(other, contextQuery)).sessions).toEqual([])
      const changedContext = await owner.client.rpc('explore_begin_turn', {
        ...turn,
        p_request_id: winningId,
        p_learning_context: {
          selection: { path: 'professional', roleId: 'backend-engineer' },
          level: 'C1',
        },
      })
      expect(changedContext.error?.code).toBe('PT409')
      expect(await detail()).toEqual(failed)
      const improvementInput = await readExploreMessageForImprovement(owner, originalMessage.id)
      expect(improvementInput.message.content).toBe('Explain Hanoi')
      expect(improvementInput.context).toEqual([])
      await expect(
        readExploreMessageForImprovement(other, originalMessage.id),
      ).rejects.toMatchObject({ status: 404 })
      const deniedImprovement = await other.client.rpc('explore_save_message_improvement', {
        p_message_id: originalMessage.id,
        p_text: 'Please explain Hanoi.',
      })
      expect(deniedImprovement.error?.code).toBe('P0002')
      const rewrites = await Promise.all([
        saveExploreMessageImprovement(
          owner,
          originalMessage.id,
          'Please explain the Towers of Hanoi algorithm.',
        ),
        saveExploreMessageImprovement(
          owner,
          originalMessage.id,
          'Could you explain the Hanoi algorithm?',
        ),
      ])
      expect(rewrites[0].metadata.improvement).toEqual(rewrites[1].metadata.improvement)
      expect(rewrites[0].metadata.improvement?.createdAt).toBeTruthy()
      expect(rewrites[0].content).toBe(originalMessage.content)
      expect(rewrites[0].status).toBe('failed')
      expect((await detail()).session.version).toBe(failed.session.version)
      const savedImprovement = rewrites[0].metadata.improvement
      // Older clients can omit context on retry; the originally saved focus survives.
      await rpc(owner.client, 'explore_begin_turn', {
        ...turn,
        p_request_id: winningId,
        p_learning_context: null,
      })
      expect((await detail()).messages[0].metadata.learningContext).toEqual(
        artifact.learningContext,
      )
      await rpc(owner.client, 'explore_complete_turn', {
        p_session_id: sessionId,
        p_request_id: winningId,
        p_reply: 'Here is an interactive recursion demonstration.',
        p_action: 'create',
        p_content: artifact,
      })
      current = await detail()
      expect(current.messages.map((message) => message.status)).toEqual(['complete', 'complete'])
      expect(current.artifacts).toHaveLength(1)
      expect(current.artifacts[0].content.title).toBe('Towers of Hanoi')
      expect((await readExploreLibrary(owner, contextQuery)).sessions[0].learningContext).toEqual(
        artifact.learningContext,
      )
      await expect(
        readExploreMessageForImprovement(owner, current.messages[1].id),
      ).rejects.toMatchObject({ status: 400 })
      const assistantRewrite = await owner.client.rpc('explore_save_message_improvement', {
        p_message_id: current.messages[1].id,
        p_text: 'Assistant rewrite is forbidden.',
      })
      expect(assistantRewrite.error?.code).toBe('22023')
      expect(current.messages[0].metadata.improvement).toEqual(savedImprovement)
      const firstArtifact = current.artifacts[0]
      const beforeCompletedReplay = await detail()
      await rpc(owner.client, 'explore_complete_turn', {
        p_session_id: sessionId,
        p_request_id: winningId,
        p_reply: 'Here is an interactive recursion demonstration.',
        p_action: 'create',
        p_content: artifact,
      })
      expect(await detail()).toEqual(beforeCompletedReplay)
      expect(
        await rpc(owner.client, 'explore_begin_turn', { ...turn, p_request_id: winningId }),
      ).toEqual({ completed: true })
      const changedRetry = await owner.client.rpc('explore_begin_turn', {
        ...turn,
        p_request_id: winningId,
        p_prompt: 'Different prompt',
      })
      expect(changedRetry.error?.code).toBe('PT409')
      await rpc(owner.client, 'explore_fail_turn', {
        p_session_id: sessionId,
        p_request_id: winningId,
      })
      expect((await detail()).messages[0].status).toBe('complete')
      const crossTarget = await other.client.rpc('explore_save_state', {
        p_artifact_id: firstArtifact.id,
        p_expected_revision: 1,
        p_state: { step: 3 },
      })
      expect(crossTarget.error?.code).toBe('P0002')
      const saved = await rpc(owner.client, 'explore_save_state', {
        p_artifact_id: firstArtifact.id,
        p_expected_revision: 1,
        p_state: { step: 3, playing: false },
      })
      expect(saved.state).toEqual({ step: 3, playing: false })
      const nextId = crypto.randomUUID()
      await rpc(owner.client, 'explore_begin_turn', {
        ...turn,
        p_request_id: nextId,
        p_prompt: 'Use four disks',
        p_artifact_id: firstArtifact.id,
        p_expected_version: current.session.version,
      })
      const restorePending = await owner.client.rpc('explore_restore_revision', {
        p_artifact_id: firstArtifact.id,
        p_revision_id: firstArtifact.revisionId,
        p_expected_revision: 1,
      })
      expect(restorePending.error?.code).toBe('PT409')
      const pendingDiscussion = await detail()
      const revisionsBeforeDiscussion = await rpc(owner.client, 'explore_read_revisions', {
        p_artifact_id: firstArtifact.id,
      })
      for (const action of ['revise', 'create']) {
        const rejected = await owner.client.rpc('explore_complete_turn', {
          p_session_id: sessionId,
          p_request_id: nextId,
          p_reply: 'Attempted artifact change.',
          p_action: action,
          p_content: { ...artifact, config: { ...artifact.config, size: 4 } },
        })
        expect(rejected.error?.code).toBe('PT409')
        expect(rejected.error?.message).toBe(
          'Chat questions discuss the current artifact. Start a new exploration to create another lesson.',
        )
        expect(await detail()).toEqual(pendingDiscussion)
        expect(
          await rpc(owner.client, 'explore_read_revisions', { p_artifact_id: firstArtifact.id }),
        ).toEqual(revisionsBeforeDiscussion)
      }
      await rpc(owner.client, 'explore_complete_turn', {
        p_session_id: sessionId,
        p_request_id: nextId,
        p_reply: 'With four disks, the same recursive strategy would require fifteen moves.',
        p_action: 'explain',
        p_content: null,
      })
      current = await detail()
      expect(current.artifacts).toEqual(pendingDiscussion.artifacts)
      expect(current.messages.at(-1)?.metadata).toMatchObject({
        action: 'explain',
        artifactId: firstArtifact.id,
        revisionId: firstArtifact.revisionId,
      })
      expect(
        await rpc(owner.client, 'explore_read_revisions', { p_artifact_id: firstArtifact.id }),
      ).toEqual(revisionsBeforeDiscussion)
      // Import a legacy backup with an earlier generated revision. New chat is
      // discussion-only, but historical revisions must remain resumable/restorable.
      const legacyRevisionBackup = ExploreBackupSchema.parse(
        await rpc(owner.client, 'explore_export_backup'),
      )
      const historicalRevisionId = crypto.randomUUID()
      const historicalDate = new Date().toISOString()
      const historicalContent = { ...artifact, config: { ...artifact.config, size: 4 } }
      const historicalPrompt = current.messages.find(
        (message) => message.requestId === nextId && message.role === 'user',
      )!
      legacyRevisionBackup.revisions.push({
        id: historicalRevisionId,
        artifactId: firstArtifact.id,
        sessionId,
        messageId: historicalPrompt.id,
        number: 2,
        content: historicalContent,
        createdAt: historicalDate,
        restoredFrom: null,
      })
      Object.assign(legacyRevisionBackup.artifacts[0], {
        revision: 2,
        revisionId: historicalRevisionId,
        content: historicalContent,
        updatedAt: historicalDate,
        state: {},
      })
      await rpc(owner.client, 'explore_restore_backup', {
        p_backup: ExploreBackupSchema.parse(legacyRevisionBackup),
      })
      current = await detail()
      expect(current.artifacts[0].revision).toBe(2)
      expect(current.artifacts[0].content.config.size).toBe(4)
      expect(current.artifacts[0].state).toEqual({})
      const staleState = await owner.client.rpc('explore_save_state', {
        p_artifact_id: firstArtifact.id,
        p_expected_revision: 1,
        p_state: { step: 99 },
      })
      expect(staleState.error?.code).toBe('PT409')
      const restored = await rpc(owner.client, 'explore_restore_revision', {
        p_artifact_id: firstArtifact.id,
        p_revision_id: firstArtifact.revisionId,
        p_expected_revision: 2,
      })
      expect(restored.revision).toBe(3)
      expect(restored.content.config.size).toBe(3)
      const restoreMessage = (await detail()).messages.find(
        (message) => message.role === 'user' && message.metadata.action === 'restore',
      )!
      await expect(
        readExploreMessageForImprovement(owner, restoreMessage.id),
      ).rejects.toMatchObject({ status: 400 })
      const syntheticRewrite = await owner.client.rpc('explore_save_message_improvement', {
        p_message_id: restoreMessage.id,
        p_text: 'Synthetic rewrite is forbidden.',
      })
      expect(syntheticRewrite.error?.code).toBe('22023')
      const history = await rpc(owner.client, 'explore_read_revisions', {
        p_artifact_id: firstArtifact.id,
        p_limit: 2,
      })
      expect(history.revisions.map((revision: { number: number }) => revision.number)).toEqual([
        3, 2,
      ])
      expect(history.revisions[0].restoredFrom).toBe(firstArtifact.revisionId)
      expect(history.nextCursor).toBe(2)
      const oldHistory = await rpc(owner.client, 'explore_read_revisions', {
        p_artifact_id: firstArtifact.id,
        p_before: 2,
      })
      expect(oldHistory.revisions).toHaveLength(1)
      const immutable = await owner.client
        .from('explore_artifact_revisions')
        .update({ content: { hacked: true } })
        .eq('id', firstArtifact.revisionId)
      expect(immutable.error?.code).toBe('42501')
      const promptEdit = await owner.client
        .from('explore_messages')
        .update({ content: 'Altered source prompt' })
        .eq('id', current.messages[0].id)
      expect(promptEdit.error?.code).toBe('42501')
      const pointerEdit = await owner.client
        .from('explore_artifacts')
        .update({ revision_id: firstArtifact.revisionId })
        .eq('id', firstArtifact.id)
      expect(pointerEdit.error?.code).toBe('42501')
      const sessionVersionEdit = await owner.client
        .from('explore_sessions')
        .update({ version: 0 })
        .eq('id', sessionId)
      expect(sessionVersionEdit.error?.code).toBe('42501')
      current = await detail()
      const secondRequest = crypto.randomUUID()
      await rpc(owner.client, 'explore_begin_turn', {
        ...turn,
        p_request_id: secondRequest,
        p_prompt: 'Add a request lifecycle diagram',
        p_expected_version: current.session.version,
      })
      const diagram = {
        ...artifact,
        kind: 'diagram' as const,
        title: 'Request lifecycle',
        nodes: [{ id: 'server', label: 'Server', detail: 'Handles the request.' }],
      }
      await rpc(owner.client, 'explore_complete_turn', {
        p_session_id: sessionId,
        p_request_id: secondRequest,
        p_reply:
          'Start a new exploration for a request lifecycle lesson. We can discuss this recursion lesson here.',
        p_action: 'explain',
        p_content: null,
      })
      current = await detail()
      expect(current.artifacts).toHaveLength(1)
      const legacyMultiArtifactBackup = ExploreBackupSchema.parse(
        await rpc(owner.client, 'explore_export_backup'),
      )
      const legacyDiagramId = crypto.randomUUID()
      const legacyDiagramRevisionId = crypto.randomUUID()
      const legacyDiagramDate = new Date().toISOString()
      const legacyDiagramPrompt = current.messages.find(
        (message) => message.requestId === secondRequest && message.role === 'user',
      )!
      legacyMultiArtifactBackup.artifacts.push({
        id: legacyDiagramId,
        sessionId,
        sourceMessageId: legacyDiagramPrompt.id,
        createdAt: legacyDiagramDate,
        updatedAt: legacyDiagramDate,
        revision: 1,
        revisionId: legacyDiagramRevisionId,
        content: diagram,
        state: { selectedNode: 'server' },
      })
      legacyMultiArtifactBackup.revisions.push({
        id: legacyDiagramRevisionId,
        artifactId: legacyDiagramId,
        sessionId,
        messageId: legacyDiagramPrompt.id,
        number: 1,
        content: diagram,
        createdAt: legacyDiagramDate,
        restoredFrom: null,
      })
      await rpc(owner.client, 'explore_restore_backup', {
        p_backup: ExploreBackupSchema.parse(legacyMultiArtifactBackup),
      })
      current = await detail()
      expect(current.artifacts).toHaveLength(2)
      expect(current.artifacts.find((item) => item.id === firstArtifact.id)?.revision).toBe(3)
      expect(current.artifacts.find((item) => item.content.kind === 'diagram')?.revision).toBe(1)
      // Interacting with an older artifact must not change the null-selection
      // fallback: the reopened workspace selects the last-created artifact.
      await rpc(owner.client, 'explore_save_state', {
        p_artifact_id: firstArtifact.id,
        p_expected_revision: 3,
        p_state: { step: 4 },
      })
      current = await detail()
      const protectedLegacyArtifacts = structuredClone(current.artifacts)
      const protectedLegacyRevisions = (await rpc(owner.client, 'explore_export_backup')).revisions
      // More than one history page, with no duplicated or missing message sequences.
      for (let i = 0; i < 9; i++) {
        current = await detail()
        const id = crypto.randomUUID()
        await rpc(owner.client, 'explore_begin_turn', {
          ...turn,
          p_request_id: id,
          p_prompt: `Follow-up ${i}`,
          p_expected_version: current.session.version,
        })
        await rpc(owner.client, 'explore_complete_turn', {
          p_session_id: sessionId,
          p_request_id: id,
          p_reply: `Explanation ${i}`,
          p_action: 'explain',
          p_content: null,
        })
      }
      current = await detail()
      expect(current.messages).toHaveLength(20)
      expect(current.artifacts).toEqual(protectedLegacyArtifacts)
      expect(current.messages.at(-1)?.metadata).toMatchObject({
        action: 'explain',
        artifactId: legacyDiagramId,
        revisionId: legacyDiagramRevisionId,
      })
      expect((await rpc(owner.client, 'explore_export_backup')).revisions).toEqual(
        protectedLegacyRevisions,
      )
      expect(current.nextCursor).not.toBeNull()
      const earlier = await rpc(owner.client, 'explore_read_messages', {
        p_session_id: sessionId,
        p_before: current.nextCursor,
      })
      const allMessages = [...earlier.messages, ...current.messages]
      expect(allMessages).toHaveLength(26)
      expect(allMessages.map((message) => message.sequence)).toEqual(
        Array.from({ length: 26 }, (_, i) => i + 1),
      )
      expect(
        (await readExploreMessageForImprovement(owner, originalMessage.id)).message.metadata
          .improvement,
      ).toEqual(savedImprovement)
      const lastUser = current.messages.filter((message) => message.role === 'user').at(-1)!
      const recentInput = await readExploreMessageForImprovement(owner, lastUser.id)
      expect(recentInput.context.length).toBeLessThanOrEqual(8)
      expect(recentInput.context.map((message) => message.content)).toEqual(
        allMessages
          .filter(
            (message) => message.sequence < lastUser.sequence && message.status === 'complete',
          )
          .slice(-8)
          .filter((message) => message.metadata.action !== 'restore')
          .map((message) => message.content),
      )
      // An initial clarification can precede first-artifact creation. No chat
      // revision is allowed even before a lesson exists, and traces stay honest.
      const clarificationSessionId = crypto.randomUUID()
      expect(
        (
          await owner.client
            .from('explore_sessions')
            .insert({ user_id: owner.userId, id: clarificationSessionId, title: 'Clarify first' })
        ).error,
      ).toBeNull()
      const clarificationRequest = crypto.randomUUID()
      await rpc(owner.client, 'explore_begin_turn', {
        p_session_id: clarificationSessionId,
        p_request_id: clarificationRequest,
        p_prompt: 'Can you explain this?',
        p_artifact_id: null,
        p_expected_version: 0,
      })
      const emptyRevision = await owner.client.rpc('explore_complete_turn', {
        p_session_id: clarificationSessionId,
        p_request_id: clarificationRequest,
        p_reply: 'No revision exists yet.',
        p_action: 'revise',
        p_content: artifact,
      })
      expect(emptyRevision.error?.code).toBe('PT409')
      await rpc(owner.client, 'explore_complete_turn', {
        p_session_id: clarificationSessionId,
        p_request_id: clarificationRequest,
        p_reply: 'Which algorithm would you like to understand?',
        p_action: 'explain',
        p_content: null,
      })
      const clarified = ExploreDetailSchema.parse(
        await rpc(owner.client, 'explore_read_detail', { p_session_id: clarificationSessionId }),
      )
      expect(clarified.artifacts).toEqual([])
      expect(clarified.messages.at(-1)?.metadata).toEqual({
        action: 'explain',
        artifactId: null,
        revisionId: null,
      })
      const firstLessonRequest = crypto.randomUUID()
      await rpc(owner.client, 'explore_begin_turn', {
        p_session_id: clarificationSessionId,
        p_request_id: firstLessonRequest,
        p_prompt: 'Explain Hanoi',
        p_artifact_id: null,
        p_expected_version: clarified.session.version,
      })
      await rpc(owner.client, 'explore_complete_turn', {
        p_session_id: clarificationSessionId,
        p_request_id: firstLessonRequest,
        p_reply: 'Here is the first lesson.',
        p_action: 'create',
        p_content: artifact,
      })
      const firstLesson = ExploreDetailSchema.parse(
        await rpc(owner.client, 'explore_read_detail', { p_session_id: clarificationSessionId }),
      )
      expect(firstLesson.artifacts).toHaveLength(1)
      expect(firstLesson.messages.at(-1)?.metadata).toEqual({
        action: 'create',
        artifactId: firstLesson.artifacts[0].id,
        revisionId: firstLesson.artifacts[0].revisionId,
      })
      expect(
        (await owner.client.from('explore_sessions').delete().eq('id', clarificationSessionId))
          .error,
      ).toBeNull()
      const additional = Array.from({ length: 13 }, (_, i) => ({
        user_id: owner.userId,
        title: `Library ${i}`,
      }))
      expect((await owner.client.from('explore_sessions').insert(additional)).error).toBeNull()
      const page1 = await rpc(owner.client, 'explore_list_sessions', { p_page: 0 })
      const page2 = await rpc(owner.client, 'explore_list_sessions', { p_page: 1 })
      expect(page1.total).toBe(14)
      expect(page1.sessions).toHaveLength(12)
      expect(page2.sessions).toHaveLength(2)
      expect(
        new Set([...page1.sessions, ...page2.sessions].map((session) => session.id)).size,
      ).toBe(14)
      const search = await rpc(owner.client, 'explore_list_sessions', { p_query: '%' })
      expect(search.sessions).toHaveLength(1)
      const filtered = await rpc(owner.client, 'explore_list_sessions', { p_kind: 'hanoi' })
      expect(filtered.sessions).toHaveLength(1)
      const backup = ExploreBackupSchema.parse(await rpc(owner.client, 'explore_export_backup'))
      expect(backup.revisions).toHaveLength(4)
      const legacyBackup = structuredClone(backup)
      for (const message of legacyBackup.messages) {
        delete message.metadata.improvement
        delete message.metadata.learningContext
      }
      await rpc(other.client, 'explore_restore_backup', { p_backup: legacyBackup })
      expect(
        (await readExploreMessageForImprovement(other, originalMessage.id)).message.metadata
          .improvement,
      ).toBeUndefined()
      await rpc(other.client, 'explore_restore_backup', { p_backup: backup })
      expect(
        (await readExploreMessageForImprovement(other, originalMessage.id)).message.metadata
          .improvement,
      ).toEqual(savedImprovement)
      await rpc(other.client, 'explore_restore_backup', { p_backup: legacyBackup })
      expect(
        (await readExploreMessageForImprovement(other, originalMessage.id)).message.metadata
          .improvement,
      ).toEqual(savedImprovement)
      const conflictBackup = structuredClone(backup)
      conflictBackup.messages.find(
        (message) => message.id === originalMessage.id,
      )!.metadata.improvement!.text = 'A conflicting saved rewrite.'
      expect(
        (await other.client.rpc('explore_restore_backup', { p_backup: conflictBackup })).error
          ?.code,
      ).toBe('PT409')
      expect(
        (await readExploreMessageForImprovement(other, originalMessage.id)).message.metadata
          .improvement,
      ).toEqual(savedImprovement)
      const copy = ExploreBackupSchema.parse(await rpc(other.client, 'explore_export_backup'))
      expect(
        copy.messages.find((message) => message.id === originalMessage.id)?.metadata
          .learningContext,
      ).toEqual(artifact.learningContext)
      expect(copy.artifacts.find((item) => item.id === firstArtifact.id)?.content).toEqual(artifact)
      expect(copy.messages).toHaveLength(26)
      await rpc(other.client, 'explore_restore_backup', { p_backup: backup })
      const forged = structuredClone(backup)
      forged.revisions[0].content.title = 'Changed immutable history'
      expect(
        (await other.client.rpc('explore_restore_backup', { p_backup: forged })).error?.code,
      ).toBe('PT409')
      const reset = await rpc(other.client, 'reset_learning_data')
      expect(reset.deletedExplorations).toBe(14)
      expect((await rpc(other.client, 'explore_export_backup')).revisions).toHaveLength(0)
      expect((await detail()).artifacts[0].revision).toBe(3)
      expect(
        (await owner.client.from('explore_sessions').delete().eq('id', sessionId)).error,
      ).toBeNull()
      expect((await rpc(owner.client, 'explore_export_backup')).revisions).toHaveLength(0)
    } finally {
      // Delete only identities created by this test, never existing learner records.
      for (const identity of identities) {
        expect(identity.userId).toMatch(/^[0-9a-f-]{36}$/)
        execFileSync(
          'docker',
          [
            'exec',
            'supabase_db_mentor',
            'psql',
            '-U',
            'postgres',
            '-d',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
            '-c',
            `delete from auth.users where id='${identity.userId}'::uuid`,
          ],
          { stdio: 'pipe' },
        )
      }
    }
  }, 120_000)
})
