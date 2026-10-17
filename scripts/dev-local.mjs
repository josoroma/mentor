import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const directory = fileURLToPath(new URL('..', import.meta.url))
process.chdir(directory)

const children = new Map()
let stopping = false

const stop = async (code = 0) => {
  if (stopping) return
  stopping = true
  for (const child of children.values()) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    // Each spawned child owns a new process group. Existing services are never signaled.
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
  }
  await delay(1500)
  for (const child of children.values()) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }
  process.exit(code)
}

process.on('SIGINT', () => {
  void stop()
})
process.on('SIGTERM', () => {
  void stop()
})

const portInUse = (url) =>
  new Promise((resolve) => {
    const target = new URL(url)
    const socket = createConnection({
      host: target.hostname.replace(/^\[|\]$/g, ''),
      port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
    })
    const finish = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1000)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })

const healthy = async (service) => {
  try {
    const response = await fetch(service.url, { signal: AbortSignal.timeout(2000) })
    return response.ok && service.accept(await response.json())
  } catch {
    return false
  }
}

const start = async (service) => {
  if (await healthy(service)) {
    console.log(`[mentor] Reusing ${service.name} at ${service.url}`)
    return
  }
  if (await portInUse(service.url)) {
    throw new Error(
      `${service.name}'s port is occupied but its health check failed. Check the existing process; mentor will not stop it.`,
    )
  }
  console.log(`[mentor] Starting ${service.name}…`)
  const child = spawn(service.command, service.args, {
    cwd: directory,
    env: { ...process.env, ...service.env },
    stdio: 'inherit',
    detached: true,
  })
  children.set(service.name, child)
  child.on('error', (error) => {
    console.error(`[mentor] Could not start ${service.name}: ${error.message}`)
    void stop(1)
  })
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(
        `[mentor] ${service.name} exited (${signal ?? code}). Stopping processes started by this launcher.`,
      )
      void stop(code || 1)
    }
  })
  const deadline = Date.now() + 120_000
  while (!stopping && Date.now() < deadline) {
    if (await healthy(service)) {
      console.log(`[mentor] ${service.name} is ready.`)
      return
    }
    await delay(750)
  }
  throw new Error(
    `${service.name} did not become ready in two minutes. Check its startup messages above.`,
  )
}

if (existsSync('.env.local')) process.loadEnvFile('.env.local')

const coachBase = process.env.LOCAL_AI_BASE_URL ?? 'http://127.0.0.1:8000/v1'
const speechBase = process.env.LOCAL_SPEECH_URL ?? 'http://127.0.0.1:8765'
const appPort = process.env.PORT ?? '3000'
const services = [
  {
    name: 'local coach',
    url: `${coachBase.replace(/\/v1\/?$/, '')}/health`,
    command: 'bash',
    args: ['scripts/start-coach.sh'],
    env: { MENTOR_COACH_PORT: new URL(coachBase).port || '8000' },
    accept: (body) => (body.ok === true && typeof body.model === 'string') || body.status === 'ok',
  },
  {
    name: 'local speech',
    url: `${speechBase.replace(/\/$/, '')}/health`,
    command: 'bash',
    args: ['scripts/start-speech.sh'],
    env: { MENTOR_SPEECH_PORT: new URL(speechBase).port || '8765' },
    accept: (body) =>
      body.recognition === true &&
      (body.synthesis === true ||
        ['macos', 'kokoro', 'chatterbox'].some(
          (provider) => body.providers?.[provider]?.synthesis === true,
        )) &&
      body.provider === (process.env.MENTOR_TTS_PROVIDER ?? 'kokoro'),
  },
  {
    name: 'Next.js',
    url: `http://127.0.0.1:${appPort}/api/health`,
    command: process.execPath,
    args: ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', appPort],
    env: {},
    accept: (body) =>
      typeof body.coach?.available === 'boolean' && typeof body.speech?.available === 'boolean',
  },
]

try {
  // The database has its own Docker lifecycle and persists when the voice launcher stops.
  if (process.env.MENTOR_SKIP_DATABASE !== '1') {
    await new Promise((resolve, reject) => {
      const database = spawn(process.execPath, ['scripts/start-database.mjs'], {
        cwd: directory,
        stdio: 'inherit',
      })
      database.once('error', reject)
      database.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('Database setup failed.')),
      )
    })
  }
  if (existsSync('.env.local')) process.loadEnvFile('.env.local')
  // Validate every URL before probing or starting any service.
  for (const service of services) {
    const target = new URL(service.url)
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
      !['http:', 'https:'].includes(target.protocol)
    ) {
      throw new Error(
        `${service.name} must use a loopback HTTP endpoint. No remote service was contacted.`,
      )
    }
  }
  // Sequential startup keeps model loading from competing with Next compilation.
  for (const service of services) await start(service)
  console.log(`\n[mentor] Ready: http://127.0.0.1:${appPort}`)
  console.log(
    '[mentor] Ctrl-C stops only services started by this launcher. Reused services stay running.',
  )
} catch (error) {
  console.error(`[mentor] ${error.message}`)
  await stop(1)
}
