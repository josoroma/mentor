import { expect } from 'vitest'
import { readExploreBackup, restoreExploreBackup } from '@/lib/explore/backup'
import {
  ExploreBackupSchema,
  ExploreDetailSchema,
  ExploreLearningStateSchema,
  type ExploreArtifactContent,
} from '@/lib/explore/schema'
import { readExploreArtifactForPractice, type ExploreIdentity } from '@/lib/explore/server'

// Called only by the opt-in database suite, with its disposable owned identities.
export async function checkExplorePracticePersistence(
  owner: ExploreIdentity,
  other: ExploreIdentity,
  baseContent: ExploreArtifactContent,
) {
  const sessionId = crypto.randomUUID()
  const requestId = crypto.randomUUID()
  const rpc = async (name: string, args?: Record<string, unknown>) => {
    const result = await owner.client.rpc(name, args)
    if (result.error) throw new Error(`${name}: ${result.error.code}: ${result.error.message}`)
    return result.data
  }
  expect(
    (
      await owner.client.from('explore_sessions').insert({
        user_id: owner.userId,
        id: sessionId,
        title: 'Forty example practice state checks',
      })
    ).error,
  ).toBeNull()
  await rpc('explore_begin_turn', {
    p_session_id: sessionId,
    p_request_id: requestId,
    p_prompt: 'Give me forty ways to ask a colleague for help.',
    p_artifact_id: null,
    p_expected_version: 0,
  })
  await rpc('explore_complete_turn', {
    p_session_id: sessionId,
    p_request_id: requestId,
    p_reply: 'Here are forty examples to practice.',
    p_action: 'create',
    p_content: {
      ...baseContent,
      kind: 'examples',
      title: 'Asking for help',
      examples: Array.from({ length: 40 }, (_, index) => ({
        phrase: `Could you help me understand item ${index + 1}?`,
        context: 'Asking a teammate about a technical implementation.',
        formality: 'neutral',
        urgency: 'normal',
        channel: 'Team conversation',
        note: 'Give useful context before asking.',
      })),
    },
  })
  const readDetail = async () =>
    ExploreDetailSchema.parse(await rpc('explore_read_detail', { p_session_id: sessionId }))
  const before = await readDetail()
  const artifact = before.artifacts[0]
  await expect(readExploreArtifactForPractice(other, artifact.id)).rejects.toMatchObject({
    status: 404,
  })
  const state = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [
      [`examplePractice${index}`, '😀'.repeat(2000)],
      [`examplePracticeImproved${index}`, '語'.repeat(2000)],
    ]).flat(),
  )
  const body = JSON.stringify({ state, expectedRevision: 1 })
  expect(new TextEncoder().encode(body).length).toBeGreaterThan(128 * 1024)
  const { data } = await owner.client.auth.getSession()
  expect(data.session).not.toBeNull()
  const appUrl = new URL(process.env.MENTOR_TEST_URL ?? 'http://127.0.0.1:3000')
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(appUrl.hostname)
  const patch = (input: unknown) =>
    fetch(new URL(`/api/explore/artifacts/${artifact.id}/state`, appUrl), {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${data.session!.access_token}`,
        origin: appUrl.origin,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    })
  const response = await patch({ state, expectedRevision: 1 })
  expect(response.status).toBe(200)
  expect((await response.json()).state).toEqual(state)
  const reopened = await readExploreArtifactForPractice(owner, artifact.id)
  expect(reopened.state).toEqual(state)
  expect(reopened.content).toEqual(artifact.content)
  expect(reopened.revisionId).toBe(artifact.revisionId)
  expect(reopened.revision).toBe(1)
  expect((await readDetail()).session.version).toBe(before.session.version)
  expect(await rpc('explore_read_revisions', { p_artifact_id: artifact.id })).toMatchObject({
    revisions: [expect.objectContaining({ id: artifact.revisionId, number: 1 })],
    nextCursor: null,
  })
  const tooMany = Object.fromEntries(
    Array.from({ length: 123 }, (_, index) => [`field${index}`, 0]),
  )
  expect((await patch({ state: tooMany, expectedRevision: 1 })).status).toBe(400)
  expect((await patch({ state: {}, expectedRevision: 2 })).status).toBe(409)
  for (const value of [
    {},
    state,
    { text: '😀'.repeat(1000) },
    { text: '😀'.repeat(1001) },
    { text: '😀'.repeat(2000) },
    { text: '😀'.repeat(2001) },
    { text: 'x'.repeat(2001) },
    { ['😀'.repeat(41)]: 'value' },
    { ['😀'.repeat(81)]: 'value' },
    { values: [1, 'two'] },
    { values: ['文'.repeat(501)] },
    { values: Array.from({ length: 101 }, () => 0) },
    { values: [] },
    { values: [true] },
    { nested: {} },
    { '': '' },
    tooMany,
  ]) {
    const valid = ExploreLearningStateSchema.safeParse(value).success
    expect(await rpc('explore_valid_learning_state', { value })).toBe(valid)
    if (!valid) {
      const rejected = await owner.client.rpc('explore_save_state', {
        p_artifact_id: artifact.id,
        p_expected_revision: 1,
        p_state: value,
      })
      expect(rejected.error?.code).toBe('22023')
    }
  }
  expect((await readExploreArtifactForPractice(owner, artifact.id)).state).toEqual(state)
  const backup = await readExploreBackup(owner.client, owner.userId)
  const practiceBackup = ExploreBackupSchema.parse({
    sessions: backup.sessions.filter((session) => session.id === sessionId),
    messages: backup.messages.filter((message) => message.sessionId === sessionId),
    artifacts: backup.artifacts.filter((item) => item.sessionId === sessionId),
    revisions: backup.revisions.filter((revision) => revision.sessionId === sessionId),
  })
  expect(practiceBackup.artifacts[0].state).toEqual(state)
  const restored = await restoreExploreBackup(other.client, other.userId, practiceBackup)
  expect(restored.artifacts.find((item) => item.id === artifact.id)?.state).toEqual(state)
  expect((await readExploreArtifactForPractice(other, artifact.id)).state).toEqual(state)
  expect((await readExploreArtifactForPractice(other, artifact.id)).revisionId).toBe(
    artifact.revisionId,
  )
  // A changed original and removal of its stale correction save together.
  const edited = { ...state, examplePractice0: 'Can you explain this decision?' }
  delete edited.examplePracticeImproved0
  expect((await patch({ state: edited, expectedRevision: 1 })).status).toBe(200)
  expect((await readExploreArtifactForPractice(owner, artifact.id)).state).toEqual(edited)
  expect((await readDetail()).session.version).toBe(before.session.version)
  for (const identity of [owner, other]) {
    const removed = await identity.client
      .from('explore_sessions')
      .delete()
      .eq('user_id', identity.userId)
      .eq('id', sessionId)
    expect(removed.error).toBeNull()
  }
}
