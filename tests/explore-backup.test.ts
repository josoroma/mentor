import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { ExploreBackupSchema, type ExploreBackup } from '@/lib/explore/schema'
import { readExploreBackup, restoreExploreBackup } from '@/lib/explore/backup'

import { createExploreBackupFixture } from '@/tests/fixtures/explore'

describe('Explore portable history contracts', () => {
  it('round-trips full relationships, current content and saved learning state', () => {
    const backup = createExploreBackupFixture()
    expect(ExploreBackupSchema.parse(JSON.parse(JSON.stringify(backup)))).toEqual(backup)
  })

  it('preserves original question focus through portable backups and validates the stored selection', () => {
    const backup = createExploreBackupFixture()
    backup.messages[0].metadata.learningContext = {
      selection: { path: 'life-skills', categoryId: 'public-speaking', topicId: 'storytelling' },
      level: 'B1',
    }
    expect(ExploreBackupSchema.parse(JSON.parse(JSON.stringify(backup)))).toEqual(backup)
    Object.assign(backup.messages[0].metadata.learningContext.selection, { topicId: 'unknown-topic' })
    expect(ExploreBackupSchema.safeParse(backup).success).toBe(false)
  })

  it.each([
    ['duplicate session', (backup: ExploreBackup) => backup.sessions.push(backup.sessions[0])],
    [
      'orphan message',
      (backup: ExploreBackup) => {
        backup.messages[0].sessionId = crypto.randomUUID()
      },
    ],
    [
      'duplicate sequence',
      (backup: ExploreBackup) =>
        backup.messages.push({
          ...backup.messages[0],
          id: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
        }),
    ],
    [
      'duplicate request role',
      (backup: ExploreBackup) =>
        backup.messages.push({ ...backup.messages[0], id: crypto.randomUUID(), sequence: 2 }),
    ],
    [
      'orphan artifact',
      (backup: ExploreBackup) => {
        backup.artifacts[0].sessionId = crypto.randomUUID()
      },
    ],
    [
      'missing original prompt',
      (backup: ExploreBackup) => {
        backup.artifacts[0].sourceMessageId = crypto.randomUUID()
      },
    ],
    [
      'missing revision prompt',
      (backup: ExploreBackup) => {
        backup.revisions[0].messageId = crypto.randomUUID()
      },
    ],
    [
      'cross-artifact revision',
      (backup: ExploreBackup) => {
        backup.revisions[0].artifactId = crypto.randomUUID()
      },
    ],
    [
      'missing current revision',
      (backup: ExploreBackup) => {
        backup.artifacts[0].revisionId = crypto.randomUUID()
      },
    ],
    [
      'mismatched current content',
      (backup: ExploreBackup) => {
        backup.artifacts[0].content = { ...backup.artifacts[0].content, title: 'Different' }
      },
    ],
    [
      'incomplete revision history',
      (backup: ExploreBackup) => {
        backup.artifacts[0].revision = 2
        backup.revisions[0].number = 2
      },
    ],
    [
      'restore points to itself',
      (backup: ExploreBackup) => {
        backup.revisions[0].restoredFrom = backup.revisions[0].id
      },
    ],
    [
      'missing restored revision',
      (backup: ExploreBackup) => {
        backup.revisions[0].restoredFrom = crypto.randomUUID()
      },
    ],
  ])('rejects %s before database writes', (_name, change) => {
    const backup = createExploreBackupFixture()
    change(backup)
    expect(ExploreBackupSchema.safeParse(backup).success).toBe(false)
  })

  it('leaves display-only source prompt copies out of the canonical backup', () => {
    const backup = createExploreBackupFixture()
    const input = {
      ...backup,
      revisions: [{ ...backup.revisions[0], sourcePrompt: 'Explain Hanoi' }],
    }
    expect(ExploreBackupSchema.parse(input)).toEqual(backup)
  })
})

describe('Explore authenticated backup RPCs', () => {
  const setup = () => {
    const backup = createExploreBackupFixture()
    const userId = crypto.randomUUID()
    const getUser = vi.fn(async () => ({ data: { user: { id: userId } }, error: null }))
    const rpc = vi.fn(async () => ({ data: backup, error: null }))
    return {
      backup,
      userId,
      getUser,
      rpc,
      client: { auth: { getUser }, rpc } as unknown as SupabaseClient,
    }
  }

  it('reads only the authenticated identity and never passes a caller-selected owner to the RPC', async () => {
    const { backup, userId, rpc, client } = setup()
    expect(await readExploreBackup(client, userId)).toEqual(backup)
    expect(rpc).toHaveBeenCalledWith('explore_export_backup')
  })

  it('restores transactionally and validates the returned merged snapshot', async () => {
    const { backup, userId, rpc, client } = setup()
    expect(await restoreExploreBackup(client, userId, backup)).toEqual(backup)
    expect(rpc).toHaveBeenCalledWith('explore_restore_backup', { p_backup: backup })
  })

  it('does not read or write another identity’s records', async () => {
    const { backup, rpc, client } = setup()
    await expect(readExploreBackup(client, crypto.randomUUID())).rejects.toThrow('Sign in again')
    await expect(restoreExploreBackup(client, crypto.randomUUID(), backup)).rejects.toThrow(
      'Sign in again',
    )
    expect(rpc).not.toHaveBeenCalled()
  })
})
