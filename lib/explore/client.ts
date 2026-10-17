'use client'

import { z } from 'zod'
import { getAuthenticatedClient, isLocalSupabaseConfigured } from '@/lib/supabase/client'
import { readLearningData } from '@/lib/learning/storage'
import { assertLearningWriteAllowed, runLearningOperation } from '@/lib/learning/maintenance'
import {
  ExploreArtifactSchema,
  ExploreLearningStateSchema,
  type ExploreLearningState,
} from '@/lib/explore/schema'

const allowDatabase = () => {
  if (!isLocalSupabaseConfigured() && readLearningData().profile.localOnly)
    throw new Error(
      'Explore needs your learning database. Start local Supabase, or enable Supabase sync in your learning profile.',
    )
}

export class ExploreRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
  }
}

type RequestOptions = {
  method?: string
  body?: unknown
  signal?: AbortSignal
  keepalive?: boolean
}

// This inner request is also used by a state queue that already owns one tracked
// maintenance operation. Re-entering the write guard mid-drain would reject
// snapshots accepted before maintenance began.
const requestExploreDatabase = async <T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions,
): Promise<T> => {
  allowDatabase()
  const { client } = await getAuthenticatedClient()
  const { data, error } = await client.auth.getSession()
  if (error || !data.session)
    throw new Error('Your learning database session could not be verified. Please retry.')
  allowDatabase()
  const response = await fetch(`/api/explore${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${data.session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal ?? AbortSignal.timeout(190_000),
    keepalive: options.keepalive,
    cache: 'no-store',
  })
  const body: unknown = await response.json()
  if (!response.ok) {
    const failure = z.object({ error: z.string() }).safeParse(body)
    throw new ExploreRequestError(
      failure.success
        ? failure.data.error
        : 'Explore could not complete that request. Please retry.',
      response.status,
    )
  }
  return schema.parse(body)
}

export const exploreRequest = async <T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> => runLearningOperation(() => requestExploreDatabase(path, schema, options))

const StateUpdateSchema = z.object({
  state: ExploreLearningStateSchema,
  expectedRevision: z.number().int().positive(),
})
type StateUpdate = { state: ExploreLearningState; expectedRevision: number }
type StateQueue = {
  next: { body: StateUpdate | null }
  promise: Promise<void>
}
const stateQueues = new Map<string, StateQueue>()

// One serial queue per artifact, registered synchronously with maintenance. A
// newer interaction replaces only the unsent snapshot, never an in-flight write.
// Returning the exact same promise lets the UI observe the entire queue once.
export const saveExploreState = (artifactId: string, body: StateUpdate): Promise<void> => {
  let snapshot: StateUpdate
  try {
    assertLearningWriteAllowed()
    allowDatabase()
    z.uuid().parse(artifactId)
    // Parsing also detaches mutable arrays from their caller before they queue.
    snapshot = StateUpdateSchema.parse(body)
  } catch (error) {
    return Promise.reject(error)
  }

  const active = stateQueues.get(artifactId)
  if (active) {
    active.next.body = snapshot
    return active.promise
  }
  const next = { body: snapshot as StateUpdate | null }
  const operation = runLearningOperation(async () => {
    try {
      while (next.body) {
        const current = next.body
        next.body = null
        await requestExploreDatabase(`/artifacts/${artifactId}/state`, ExploreArtifactSchema, {
          method: 'PATCH',
          body: current,
          // A small tracked request can finish when a page closes. It is never
          // resubmitted from pagehide, which would race newer snapshots.
          keepalive: new TextEncoder().encode(JSON.stringify(current)).byteLength < 60_000,
        })
      }
    } finally {
      // Close synchronously with the drain, before promise settlement callbacks
      // can enqueue into an operation whose loop has already finished.
      if (stateQueues.get(artifactId)?.next === next) stateQueues.delete(artifactId)
    }
  })
  const queue: StateQueue = {
    next,
    promise: operation.finally(() => {
      if (stateQueues.get(artifactId) === queue) stateQueues.delete(artifactId)
    }),
  }
  stateQueues.set(artifactId, queue)
  return queue.promise
}
