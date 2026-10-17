import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExploreArtifact } from '@/lib/explore/schema'

const database = vi.hoisted(() => ({
  local: true,
  localOnly: true,
  authenticate: vi.fn(),
  session: vi.fn(),
}))
vi.mock('@/lib/supabase/client', () => ({
  getAuthenticatedClient: database.authenticate,
  isLocalSupabaseConfigured: () => database.local,
}))
vi.mock('@/lib/learning/storage', () => ({
  readLearningData: () => ({ profile: { localOnly: database.localOnly } }),
}))

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const artifactId = randomUUID()
const artifact = (id = artifactId): ExploreArtifact => ({
  id,
  sessionId: randomUUID(),
  sourceMessageId: randomUUID(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  revision: 1,
  revisionId: randomUUID(),
  state: {},
  content: {
    kind: 'hanoi',
    title: 'Hanoi',
    summary: 'Explore recursive moves.',
    objectives: [],
    sections: [],
    steps: [],
    examples: [],
    nodes: [],
    edges: [],
    questions: [],
    config: { size: 3, values: [], simulation: 'pendulum', pseudocode: '', complexity: '' },
    assumptions: [],
  },
})
const state = (step: number) => ({ state: { step }, expectedRevision: 1 })

describe('tracked Explore interaction writes', () => {
  let client: typeof import('@/lib/explore/client')
  let maintenance: typeof import('@/lib/learning/maintenance')
  let requests: Array<{
    url: string
    init: RequestInit
    response: ReturnType<typeof deferred<Response>>
  }>
  let values: Map<string, string>
  let fetchMock: ReturnType<typeof vi.fn>
  const finish = (index: number, id = artifactId) => {
    requests[index].response.resolve(
      Response.json({
        ...artifact(id),
        state: JSON.parse(String(requests[index].init.body)).state,
      }),
    )
  }

  beforeEach(async () => {
    vi.resetModules()
    database.local = true
    database.localOnly = true
    database.session
      .mockReset()
      .mockResolvedValue({ data: { session: { access_token: 'test-only-token' } }, error: null })
    database.authenticate.mockReset().mockResolvedValue({
      client: { auth: { getSession: database.session } },
      userId: randomUUID(),
    })
    values = new Map()
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), {
        localStorage: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => values.set(key, value),
          removeItem: (key: string) => values.delete(key),
        },
      }),
    )
    vi.stubGlobal('navigator', {})
    requests = []
    fetchMock = vi.fn((url: string, init: RequestInit) => {
      const response = deferred<Response>()
      requests.push({ url, init, response })
      return response.promise
    })
    vi.stubGlobal('fetch', fetchMock)
    maintenance = await import('@/lib/learning/maintenance')
    client = await import('@/lib/explore/client')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('serializes writes, coalesces unsent snapshots, and shares one exact promise', async () => {
    const tracked = vi.spyOn(maintenance, 'runLearningOperation')
    const first = client.saveExploreState(artifactId, state(1))
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    const second = client.saveExploreState(artifactId, state(2))
    const latest = state(3)
    const third = client.saveExploreState(artifactId, latest)
    latest.state.step = 999
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(tracked).toHaveBeenCalledTimes(1)
    expect(requests).toHaveLength(1)
    finish(0)
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(JSON.parse(String(requests[1].init.body))).toEqual(state(3))
    expect(requests[1].init.keepalive).toBe(true)
    finish(1)
    await first
    const next = client.saveExploreState(artifactId, state(4))
    expect(next).not.toBe(first)
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    finish(2)
    await next
  })

  it('allows separate artifacts to save concurrently without mixing snapshots', async () => {
    const otherId = randomUUID()
    const first = client.saveExploreState(artifactId, state(1))
    const second = client.saveExploreState(otherId, state(7))
    expect(second).not.toBe(first)
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[0].url).toContain(artifactId)
    expect(requests[1].url).toContain(otherId)
    finish(1, otherId)
    await second
    finish(0)
    await first
  })

  it('makes maintenance wait for the entire accepted queue while rejecting later interactions', async () => {
    const saving = client.saveExploreState(artifactId, state(1))
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(client.saveExploreState(artifactId, state(2))).toBe(saving)
    const exportAction = vi.fn(async () => 'backup complete')
    const exporting = maintenance.runLearningMaintenance(exportAction, { changesData: false })
    let rejected!: Promise<void>
    expect(() => {
      rejected = client.saveExploreState(artifactId, state(3))
    }).not.toThrow()
    await expect(rejected).rejects.toThrow('maintenance is in progress')
    finish(0)
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(JSON.parse(String(requests[1].init.body))).toEqual(state(2))
    expect(exportAction).not.toHaveBeenCalled()
    finish(1)
    await saving
    expect(await exporting).toBe('backup complete')
    expect(exportAction).toHaveBeenCalledOnce()
  })

  it('registers a state operation before authentication completes so immediate backup cannot overtake it', async () => {
    const auth = deferred<{
      client: { auth: { getSession: typeof database.session } }
      userId: string
    }>()
    database.authenticate.mockReturnValue(auth.promise)
    const saving = client.saveExploreState(artifactId, state(1))
    const exportAction = vi.fn(async () => true)
    const exporting = maintenance.runLearningMaintenance(exportAction, { changesData: false })
    await Promise.resolve()
    expect(exportAction).not.toHaveBeenCalled()
    auth.resolve({ client: { auth: { getSession: database.session } }, userId: randomUUID() })
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    finish(0)
    await saving
    await exporting
    expect(exportAction).toHaveBeenCalledOnce()
  })

  it('rejects the shared queue on a failed write and lets the caller retry its latest snapshot', async () => {
    const saving = client.saveExploreState(artifactId, state(1))
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(client.saveExploreState(artifactId, state(2))).toBe(saving)
    const failure = expect(saving).rejects.toThrow('Connection lost')
    requests[0].response.reject(new Error('Connection lost'))
    await failure
    expect(requests).toHaveLength(1)
    const retry = client.saveExploreState(artifactId, state(2))
    expect(retry).not.toBe(saving)
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(JSON.parse(String(requests[1].init.body))).toEqual(state(2))
    finish(1)
    await retry
  })

  it('surfaces revision conflicts without draining an obsolete queued snapshot', async () => {
    const saving = client.saveExploreState(artifactId, state(1))
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    client.saveExploreState(artifactId, state(2))
    const failure = expect(saving).rejects.toMatchObject({ status: 409 })
    requests[0].response.resolve(Response.json({ error: 'Artifact changed.' }, { status: 409 }))
    await failure
    expect(requests).toHaveLength(1)
  })

  it('does not authenticate or write to hosted Supabase without opt-in', async () => {
    database.local = false
    let saving!: Promise<void>
    expect(() => {
      saving = client.saveExploreState(artifactId, state(1))
    }).not.toThrow()
    await expect(saving).rejects.toThrow('enable Supabase sync')
    expect(database.authenticate).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rechecks privacy before sending a queued snapshot after the learner revokes hosted sync', async () => {
    database.local = false
    database.localOnly = false
    const saving = client.saveExploreState(artifactId, state(1))
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    client.saveExploreState(artifactId, state(2))
    database.localOnly = true
    const failure = expect(saving).rejects.toThrow('enable Supabase sync')
    finish(0)
    await failure
    expect(requests).toHaveLength(1)
  })

  it('rechecks privacy after authentication and before the actual fetch', async () => {
    database.local = false
    database.localOnly = false
    const auth = deferred<{
      client: { auth: { getSession: typeof database.session } }
      userId: string
    }>()
    database.authenticate.mockReturnValue(auth.promise)
    const saving = client.saveExploreState(artifactId, state(1))
    database.localOnly = true
    const failure = expect(saving).rejects.toThrow('enable Supabase sync')
    auth.resolve({ client: { auth: { getSession: database.session } }, userId: randomUUID() })
    await failure
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('validates artifact identity and interaction data before queueing a request', async () => {
    await expect(client.saveExploreState('../other-artifact', state(1))).rejects.toThrow()
    await expect(
      client.saveExploreState(artifactId, { state: { invalid: Number.NaN }, expectedRevision: 1 }),
    ).rejects.toThrow()
    await expect(
      client.saveExploreState(artifactId, { state: {}, expectedRevision: 0 }),
    ).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('disables keepalive for snapshots larger than its browser payload budget', async () => {
    const saving = client.saveExploreState(artifactId, {
      state: { first: Array(100).fill('a'.repeat(400)), second: Array(100).fill('b'.repeat(400)) },
      expectedRevision: 1,
    })
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0].init.keepalive).toBe(false)
    finish(0)
    await saving
  })
})
