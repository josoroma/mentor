import type { ExploreBackup } from '@/lib/explore/schema'

export const createExploreBackupFixture = (): ExploreBackup => {
  const sessionId = crypto.randomUUID()
  const messageId = crypto.randomUUID()
  const artifactId = crypto.randomUUID()
  const revisionId = crypto.randomUUID()
  const date = '2026-10-15T12:00:00.000Z'
  const content = {
    kind: 'hanoi' as const,
    title: 'Towers of Hanoi',
    summary: 'Explore recursive disk movement.',
    objectives: ['Understand recursive subproblems'],
    sections: [],
    steps: [],
    examples: [],
    nodes: [],
    edges: [],
    questions: [],
    config: {
      size: 3,
      values: [],
      simulation: 'pendulum' as const,
      pseudocode: '',
      complexity: '2^n - 1 moves',
    },
    assumptions: [],
  }
  return {
    sessions: [
      {
        id: sessionId,
        title: 'Hanoi',
        createdAt: date,
        updatedAt: date,
        version: 2,
        artifactKind: 'hanoi',
      },
    ],
    messages: [
      {
        id: messageId,
        sessionId,
        role: 'user',
        content: 'Explain Hanoi',
        createdAt: date,
        sequence: 1,
        status: 'complete',
        requestId: crypto.randomUUID(),
        metadata: {},
      },
    ],
    artifacts: [
      {
        id: artifactId,
        sessionId,
        sourceMessageId: messageId,
        createdAt: date,
        updatedAt: date,
        revision: 1,
        revisionId,
        content,
        state: { step: 2 },
      },
    ],
    revisions: [
      {
        id: revisionId,
        artifactId,
        sessionId,
        messageId,
        number: 1,
        content,
        createdAt: date,
        restoredFrom: null,
      },
    ],
  }
}
