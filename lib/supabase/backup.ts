import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { ProfileSchema, ScenarioSchema, SessionRecordSchema } from '@/app/_schema'

export const RemoteLearningBackupSchema = z.object({
  profile: ProfileSchema.nullable(),
  sessions: SessionRecordSchema.array(),
  scenarios: ScenarioSchema.array(),
})
export type RemoteLearningBackup = z.infer<typeof RemoteLearningBackupSchema>

export const RemoteLearningResetSchema = z.object({
  deletedSessions: z.number().int().nonnegative(),
  deletedProfiles: z.number().int().min(0).max(1),
})
export type RemoteLearningReset = z.infer<typeof RemoteLearningResetSchema>

const SessionRowSchema = z
  .object({ id: z.string().min(1), session: SessionRecordSchema })
  .refine((row) => row.id === row.session.id, 'The session identifier does not match its record.')
const ScenarioRowSchema = z
  .object({ id: z.string().min(1), sort_order: z.number().int(), configuration: ScenarioSchema })
  .refine(
    (row) => row.id === row.configuration.id,
    'The scenario identifier does not match its configuration.',
  )
const ProfileRowSchema = z.object({ profile: ProfileSchema }).nullable()
const pageSize = 500

export async function readRemoteLearningBackup(
  client: SupabaseClient,
  userId: string,
): Promise<RemoteLearningBackup> {
  z.string().min(1).parse(userId)
  const { data, error } = await client
    .from('learning_profiles')
    .select('profile')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`Could not back up your database profile: ${error.message}`)
  const profile = ProfileRowSchema.safeParse(data)
  if (!profile.success)
    throw new Error('Your database profile contains invalid data. The backup was not created.')

  const sessions: RemoteLearningBackup['sessions'] = []
  const sessionIds = new Set<string>()
  let sessionCursor: string | undefined
  while (true) {
    let query = client
      .from('learning_sessions')
      .select('id,session')
      .eq('user_id', userId)
      .order('id', { ascending: true })
      .limit(pageSize)
    if (sessionCursor) query = query.gt('id', sessionCursor)
    const result = await query
    if (result.error)
      throw new Error(`Could not back up your database sessions: ${result.error.message}`)
    const page = SessionRowSchema.array().safeParse(result.data)
    if (!page.success)
      throw new Error('Your database contains an invalid session. The backup was not created.')
    if (page.data.length === 0) break
    for (const row of page.data) {
      if (sessionIds.has(row.id))
        throw new Error('The database returned overlapping session pages. Please retry the backup.')
      sessionIds.add(row.id)
      sessions.push(row.session)
    }
    sessionCursor = page.data.at(-1)!.id
  }

  const scenarioRows: z.infer<typeof ScenarioRowSchema>[] = []
  const scenarioIds = new Set<string>()
  let scenarioCursor: string | undefined
  while (true) {
    let query = client
      .from('scenario_configs')
      .select('id,sort_order,configuration')
      .order('id', { ascending: true })
      .limit(pageSize)
    if (scenarioCursor) query = query.gt('id', scenarioCursor)
    const result = await query
    if (result.error)
      throw new Error(`Could not back up your database scenarios: ${result.error.message}`)
    const page = ScenarioRowSchema.array().safeParse(result.data)
    if (!page.success)
      throw new Error('Your database contains an invalid scenario. The backup was not created.')
    if (page.data.length === 0) break
    for (const row of page.data) {
      if (scenarioIds.has(row.id))
        throw new Error(
          'The database returned overlapping scenario pages. Please retry the backup.',
        )
      scenarioIds.add(row.id)
      scenarioRows.push(row)
    }
    scenarioCursor = page.data.at(-1)!.id
  }

  return {
    profile: profile.data?.profile ?? null,
    sessions,
    scenarios: scenarioRows
      .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
      .map((row) => row.configuration),
  }
}

export async function resetRemoteLearningData(
  client: SupabaseClient,
): Promise<RemoteLearningReset> {
  const { data, error } = await client.rpc('reset_learning_data')
  if (error) throw new Error(`Could not reset your database learning data: ${error.message}`)
  const result = RemoteLearningResetSchema.safeParse(data)
  if (!result.success)
    throw new Error('The database did not confirm the reset. Your on-device records were retained.')
  return result.data
}
