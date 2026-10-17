import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { ExploreBackupSchema, type ExploreBackup } from '@/lib/explore/schema'

export async function readExploreBackup(
  client: SupabaseClient,
  userId: string,
): Promise<ExploreBackup> {
  z.uuid().parse(userId)
  const { data: identity, error: authError } = await client.auth.getUser()
  if (authError || identity.user?.id !== userId)
    throw new Error('Sign in again before backing up your explorations.')
  const { data, error } = await client.rpc('explore_export_backup')
  if (error) throw new Error(`Could not back up your explorations: ${error.message}`)
  return ExploreBackupSchema.parse(data)
}

export async function restoreExploreBackup(
  client: SupabaseClient,
  userId: string,
  input: ExploreBackup,
): Promise<ExploreBackup> {
  z.uuid().parse(userId)
  const backup = ExploreBackupSchema.parse(input)
  if (!backup.sessions.length) return backup
  const { data: identity, error: authError } = await client.auth.getUser()
  if (authError || identity.user?.id !== userId)
    throw new Error('Sign in again before restoring your explorations.')
  const { data, error } = await client.rpc('explore_restore_backup', { p_backup: backup })
  if (error) throw new Error(`Could not restore your explorations: ${error.message}`)
  return ExploreBackupSchema.parse(data)
}
