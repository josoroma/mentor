import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { ProficiencyLevelSchema, ScenarioSchema } from '@/app/_schema'
import { ScenarioBookmarkSchema, type ScenarioBookmark } from '@/lib/learning/bookmarks'

const BookmarkRowSchema = z
  .object({
    scenario_id: z.string().min(1),
    scenario: ScenarioSchema,
    level: ProficiencyLevelSchema,
    saved_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
    saved: z.boolean(),
  })
  .refine((row) => row.scenario_id === row.scenario.id)
  .transform((row) => ({
    scenario: row.scenario,
    level: row.level,
    savedAt: new Date(row.saved_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    saved: row.saved,
  }))
  .pipe(ScenarioBookmarkSchema)

const selectedColumns = 'scenario_id,scenario,level,saved_at,updated_at,saved'
const pageSize = 500

export async function readRemoteScenarioBookmarks(
  client: SupabaseClient,
  userId: string,
): Promise<ScenarioBookmark[]> {
  z.string().min(1).parse(userId)
  const records: ScenarioBookmark[] = []
  const identifiers = new Set<string>()
  let cursor: string | undefined
  while (true) {
    let query = client
      .from('scenario_bookmarks')
      .select(selectedColumns)
      .eq('user_id', userId)
      .order('scenario_id', { ascending: true })
      .limit(pageSize)
    if (cursor) query = query.gt('scenario_id', cursor)
    const result = await query
    if (result.error)
      throw new Error(`Could not load saved scenarios from the database: ${result.error.message}`)
    const page = BookmarkRowSchema.array().safeParse(result.data)
    if (!page.success)
      throw new Error(
        'The database contains an invalid saved scenario. Your device copy was retained.',
      )
    if (page.data.length === 0) break
    for (const record of page.data) {
      if (identifiers.has(record.scenario.id))
        throw new Error('The database returned overlapping bookmark pages. Please retry.')
      identifiers.add(record.scenario.id)
      records.push(record)
    }
    cursor = page.data.at(-1)!.scenario.id
  }
  return records
}

export async function writeRemoteScenarioBookmarks(
  client: SupabaseClient,
  userId: string,
  records: ScenarioBookmark[],
): Promise<ScenarioBookmark[]> {
  z.string().min(1).parse(userId)
  const validated = ScenarioBookmarkSchema.array().parse(records)
  const persisted: ScenarioBookmark[] = []
  for (let offset = 0; offset < validated.length; offset += pageSize) {
    const rows = validated.slice(offset, offset + pageSize).map((record) => ({
      user_id: userId,
      scenario_id: record.scenario.id,
      scenario: record.scenario,
      level: record.level,
      saved_at: record.savedAt,
      updated_at: record.updatedAt,
      saved: record.saved,
    }))
    const { data, error } = await client
      .from('scenario_bookmarks')
      .upsert(rows, { onConflict: 'user_id,scenario_id' })
      .select(selectedColumns)
    if (error) throw new Error(`Could not sync saved scenarios to the database: ${error.message}`)
    const parsed = BookmarkRowSchema.array().safeParse(data)
    const expectedIds = new Set(rows.map((row) => row.scenario_id))
    if (
      !parsed.success ||
      parsed.data.length !== rows.length ||
      parsed.data.some((record) => !expectedIds.delete(record.scenario.id))
    )
      throw new Error('The database did not confirm every saved scenario. Please retry sync.')
    persisted.push(...parsed.data)
  }
  return persisted
}
