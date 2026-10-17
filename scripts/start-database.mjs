import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const directory = fileURLToPath(new URL('..', import.meta.url))
process.chdir(directory)

try {
  console.log('[mentor] Starting the local Supabase database (Docker must be running)…')
  await mkdir('.local', { recursive: true })
  await writeFile('.local/supabase-start.log', '', { flag: 'a', mode: 0o600 })
  await chmod('.local/supabase-start.log', 0o600)
  try {
    const result = await run('supabase', ['start'], { maxBuffer: 8 * 1024 * 1024 })
    // CLI output contains local credentials. Keep it out of shared application logs.
    await writeFile('.local/supabase-start.log', result.stdout + result.stderr, { mode: 0o600 })
  } catch (error) {
    await writeFile(
      '.local/supabase-start.log',
      `${error.stdout ?? ''}\n${error.stderr ?? error.message}`,
      { mode: 0o600 },
    )
    throw new Error(
      'Local Supabase could not start. Check Docker and .local/supabase-start.log, then retry npm run db:start.',
    )
  }
  try {
    const migration = await run('supabase', ['migration', 'up', '--local'], {
      maxBuffer: 8 * 1024 * 1024,
    })
    await appendFile('.local/supabase-start.log', migration.stdout + migration.stderr)
  } catch (error) {
    await appendFile(
      '.local/supabase-start.log',
      `${error.stdout ?? ''}\n${error.stderr ?? error.message}`,
    )
    throw new Error(
      'Local Supabase migrations could not be applied. Check .local/supabase-start.log, then retry npm run db:start. Your existing database was retained.',
    )
  }
  const result = await run('supabase', ['status', '-o', 'json'])
  const status = JSON.parse(result.stdout)
  const url = new URL(status.API_URL)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !status.ANON_KEY) {
    throw new Error('Supabase did not return a local endpoint and public key.')
  }
  const existing = await readFile('.env.local', 'utf8').catch(() => '')
  const configured = existing
    .match(/^NEXT_PUBLIC_SUPABASE_URL=(.*)$/m)?.[1]
    ?.replace(/^['"]|['"]$/g, '')
  if (configured && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(configured).hostname)) {
    console.log(
      '[mentor] Local database is ready. Your existing hosted Supabase configuration was preserved.',
    )
  } else {
    const values = {
      NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
    }
    const lines = existing
      .split('\n')
      .filter((line) => !Object.keys(values).some((key) => line.startsWith(`${key}=`)))
    while (lines.at(-1) === '') lines.pop()
    await writeFile(
      '.env.local',
      [...lines, ...Object.entries(values).map(([key, value]) => `${key}=${value}`), ''].join('\n'),
      { mode: 0o600 },
    )
    await chmod('.env.local', 0o600)
    console.log(`[mentor] Local database ready: ${status.API_URL}`)
  }
  console.log(`[mentor] Database Studio: ${status.STUDIO_URL}`)
} catch (error) {
  console.error(`[mentor] ${error.message}`)
  process.exitCode = 1
}
