'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { subscribeLearningMaintenance } from '@/lib/learning/maintenance'
import { ExploreRequestError, exploreRequest, saveExploreState } from '@/lib/explore/client'
import {
  ExploreArtifactSchema,
  ExploreDetailSchema,
  ExploreLibrarySchema,
  ExploreMessagePageSchema,
  ExploreRevisionSchema,
  ExploreSessionSchema,
  type ExploreDetail,
  type ExploreLearningContext,
  type ExploreLearningState,
  type ExploreRevision,
  type ExploreTurnRequest,
} from '@/lib/explore/schema'

const readLocation = () => {
  if (typeof window === 'undefined') return { sessionId: null, artifactId: null }
  const [, session, artifact] = window.location.hash.slice(1).split('/')
  return {
    sessionId: z.uuid().safeParse(session).success ? session : null,
    artifactId: z.uuid().safeParse(artifact).success ? artifact : null,
  }
}

export const useExplore = (enabled: boolean, learningContext?: ExploreLearningContext) => {
  const [location, setLocation] = useState(readLocation)
  const [library, setLibrary] = useState<z.infer<typeof ExploreLibrarySchema>>({
    sessions: [],
    total: 0,
    page: 0,
    pageSize: 12,
  })
  const [query, setQuery] = useState({ search: '', kind: 'all', page: 0 })
  const [detail, setDetail] = useState<ExploreDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stateError, setStateError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [retryTurn, setRetryTurn] = useState<ExploreTurnRequest | null>(null)
  const [revisions, setRevisions] = useState<ExploreRevision[]>([])
  const [revisionCursor, setRevisionCursor] = useState<number | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const requestRef = useRef<AbortController | null>(null)
  const turnRef = useRef<AbortController | null>(null)
  const turnSessionRef = useRef<string | null>(null)
  const detailRef = useRef(detail)
  const enabledRef = useRef(enabled)
  const learningContextRef = useRef(learningContext)
  detailRef.current = detail
  enabledRef.current = enabled
  learningContextRef.current = learningContext
  const states = useRef(
    new Map<string, { state: ExploreLearningState; expectedRevision: number }>(),
  )
  const activeWrites = useRef(new Map<string, Promise<void>>())
  const stateFailures = useRef(new Map<string, string>())
  const mounted = useRef(true)

  const navigate = useCallback((sessionId: string | null, artifactId?: string | null) => {
    window.location.hash = sessionId
      ? `explore/${sessionId}${artifactId ? `/${artifactId}` : ''}`
      : 'explore'
  }, [])

  const queueState = useCallback(
    (id: string, body: { state: ExploreLearningState; expectedRevision: number }) => {
      const write = saveExploreState(id, body)
      if (activeWrites.current.get(id) === write) return write
      activeWrites.current.set(id, write)
      stateFailures.current.delete(id)
      if (mounted.current) {
        setSaving(true)
        setStateError(stateFailures.current.values().next().value ?? null)
      }
      void write.then(
        () => {
          if (activeWrites.current.get(id) !== write) return
          states.current.delete(id)
          activeWrites.current.delete(id)
          stateFailures.current.delete(id)
          if (mounted.current) {
            setSaving(activeWrites.current.size > 0)
            setStateError(stateFailures.current.values().next().value ?? null)
          }
        },
        (cause: unknown) => {
          if (activeWrites.current.get(id) !== write) return
          activeWrites.current.delete(id)
          if (
            cause instanceof ExploreRequestError &&
            (cause.status === 409 || cause.status === 404)
          ) {
            const pending = states.current.get(id)
            const currentRevision = detailRef.current?.artifacts.find(
              (item) => item.id === id,
            )?.revision
            const newerSnapshot =
              cause.status === 409 &&
              pending &&
              pending.expectedRevision !== body.expectedRevision &&
              pending.expectedRevision === currentRevision
            if (!newerSnapshot) {
              states.current.delete(id)
              if (mounted.current) setRefreshVersion((value) => value + 1)
            }
          }
          if (mounted.current) {
            setSaving(activeWrites.current.size > 0)
            stateFailures.current.set(
              id,
              cause instanceof Error
                ? cause.message
                : 'Your interaction could not be saved. Please retry.',
            )
            setStateError(stateFailures.current.values().next().value ?? null)
          }
        },
      )
      return write
    },
    [],
  )

  const flushStates = useCallback(async () => {
    if (!enabledRef.current) return
    const pending = [...states.current].map(([id, body]) => queueState(id, body))
    await Promise.all(pending)
  }, [queueState])

  useEffect(() => {
    mounted.current = true
    const leaving = (event: BeforeUnloadEvent) => {
      if (!states.current.size) return
      event.preventDefault()
      event.returnValue = ''
    }
    const unsubscribe = subscribeLearningMaintenance((event) => {
      if (event.phase === 'complete' && event.changed) {
        states.current.clear()
        stateFailures.current.clear()
        setStateError(null)
        setRefreshVersion((value) => value + 1)
      }
    })
    window.addEventListener('beforeunload', leaving)
    return () => {
      mounted.current = false
      unsubscribe()
      window.removeEventListener('beforeunload', leaving)
      requestRef.current?.abort()
      turnRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    const change = () => {
      const next = readLocation()
      if (turnRef.current && turnSessionRef.current !== next.sessionId) turnRef.current.abort()
      setLocation(next)
      setError(null)
    }
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [])

  useEffect(() => {
    if (!enabled) {
      requestRef.current?.abort()
      turnRef.current?.abort()
      return
    }
    const controller = new AbortController()
    requestRef.current?.abort()
    requestRef.current = controller
    setLoading(true)
    setError(null)
    if (detailRef.current?.session.id !== location.sessionId) setDetail(null)
    const timer = setTimeout(
      async () => {
        try {
          if (location.sessionId) {
            const result = await exploreRequest(
              `/sessions/${location.sessionId}`,
              ExploreDetailSchema,
              { signal: controller.signal },
            )
            if (controller.signal.aborted) return
            setDetail(result)
            const failed = result.messages.findLast(
              (message) => message.role === 'user' && message.status !== 'complete',
            )
            setRetryTurn(
              failed
                ? {
                    sessionId: result.session.id,
                    requestId: failed.requestId,
                    prompt: failed.content,
                    artifactId:
                      typeof failed.metadata.artifactId === 'string' &&
                      z.uuid().safeParse(failed.metadata.artifactId).success
                        ? failed.metadata.artifactId
                        : null,
                    expectedVersion: result.session.version,
                    learningContext: failed.metadata.learningContext,
                  }
                : null,
            )
          } else {
            const params = new URLSearchParams({
              page: String(query.page),
              pageSize: '12',
              q: query.search,
            })
            if (query.kind !== 'all') params.set('kind', query.kind)
            const result = await exploreRequest(`/sessions?${params}`, ExploreLibrarySchema, {
              signal: controller.signal,
            })
            if (!controller.signal.aborted) setLibrary(result)
          }
        } catch (cause) {
          if (!controller.signal.aborted)
            setError(cause instanceof Error ? cause.message : 'Explore could not be loaded.')
        } finally {
          if (!controller.signal.aborted) setLoading(false)
        }
      },
      location.sessionId ? 0 : 220,
    )
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [enabled, location.sessionId, query, refreshVersion])

  const artifact =
    detail?.artifacts.find((item) => item.id === location.artifactId) ??
    detail?.artifacts.at(-1) ??
    null
  const artifactRef = useRef(artifact)
  artifactRef.current = artifact
  useEffect(() => {
    setRevisions([])
    setRevisionCursor(null)
  }, [artifact?.id])

  const send = useCallback(
    async (prompt: string, retry?: ExploreTurnRequest) => {
      if (!enabled || turnRef.current || !prompt.trim()) return false
      const initialSessionId = readLocation().sessionId
      if (initialSessionId && detailRef.current?.session.id !== initialSessionId) {
        setError('Wait for this exploration to finish opening before sending a question.')
        return false
      }
      // Capture before any persistence await: another tab may change the global
      // focus while we create the session or flush an earlier interaction.
      const submittedContext =
        retry?.learningContext ??
        artifactRef.current?.content.learningContext ??
        detailRef.current?.session.learningContext ??
        learningContextRef.current
      const controller = new AbortController()
      turnRef.current = controller
      turnSessionRef.current = initialSessionId
      setBusy(true)
      setError(null)
      let turn: ExploreTurnRequest | undefined
      try {
        await flushStates()
        if (controller.signal.aborted || readLocation().sessionId !== initialSessionId) return false
        let current = initialSessionId ? detailRef.current : null
        if (!current) {
          const session = await exploreRequest('/sessions', ExploreSessionSchema, {
            method: 'POST',
            body: { id: crypto.randomUUID(), title: prompt.trim().slice(0, 120) },
            signal: controller.signal,
          })
          if (controller.signal.aborted) return false
          current = { session, artifacts: [], messages: [], nextCursor: null }
          detailRef.current = current
          setDetail(current)
          turnSessionRef.current = session.id
          navigate(session.id)
        }
        turnSessionRef.current = current.session.id
        turn = retry
          ? { ...retry, expectedVersion: current.session.version }
          : {
              sessionId: current.session.id,
              requestId: crypto.randomUUID(),
              prompt: prompt.trim(),
              artifactId: current.artifacts.some((item) => item.id === artifact?.id)
                ? artifact!.id
                : null,
              expectedVersion: current.session.version,
            }
        // Snapshot the chosen focus when this request starts. Retries in this
        // view retain it; existing lessons keep their original saved context.
        turn.learningContext ??= submittedContext
        setRetryTurn(turn)
        const provisional = {
          id: crypto.randomUUID(),
          sessionId: current.session.id,
          role: 'user' as const,
          content: turn.prompt,
          createdAt: new Date().toISOString(),
          sequence: Number.MAX_SAFE_INTEGER,
          status: 'pending' as const,
          requestId: turn.requestId,
          metadata: { learningContext: turn.learningContext },
        }
        setDetail((previous) =>
          previous
            ? {
                ...previous,
                messages: [
                  ...previous.messages.filter((message) => message.requestId !== turn!.requestId),
                  provisional,
                ],
              }
            : previous,
        )
        const result = await exploreRequest('/turn', ExploreDetailSchema, {
          method: 'POST',
          body: turn,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(185_000)]),
        })
        if (!controller.signal.aborted && readLocation().sessionId === result.session.id) {
          setDetail(result)
          detailRef.current = result
          setRetryTurn(null)
          const selected =
            result.artifacts.find((item) => item.id === readLocation().artifactId) ??
            result.artifacts.find((item) => item.id === turn?.artifactId) ??
            result.artifacts.at(-1)
          navigate(result.session.id, selected?.id)
          return true
        }
        return false
      } catch (cause) {
        if (!turn || readLocation().sessionId === turn.sessionId)
          setError(
            controller.signal.aborted
              ? 'Response stopped. You can retry your question.'
              : cause instanceof Error
                ? cause.message
                : 'The local coach could not complete that exploration.',
          )
        if (turn) {
          try {
            const saved = await exploreRequest(`/sessions/${turn.sessionId}`, ExploreDetailSchema)
            if (enabledRef.current && readLocation().sessionId === turn.sessionId) {
              setDetail(saved)
              detailRef.current = saved
            }
          } catch {
            /* Keep the prompt available for a recoverable retry. */
          }
        }
        return false
      } finally {
        if (turnRef.current === controller) {
          turnRef.current = null
          turnSessionRef.current = null
          setBusy(false)
        }
      }
    },
    [enabled, artifact?.id, flushStates, navigate],
  )

  const loadOlder = async () => {
    if (!detail || detail.nextCursor === null || loading) return
    setLoading(true)
    try {
      const page = await exploreRequest(
        `/sessions/${detail.session.id}/messages?before=${detail.nextCursor}`,
        ExploreMessagePageSchema,
      )
      setDetail((current) =>
        current?.session.id === detail.session.id
          ? {
              ...current,
              messages: [
                ...new Map(
                  [...page.messages, ...current.messages].map((message) => [message.id, message]),
                ).values(),
              ].sort((a, b) => a.sequence - b.sequence),
              nextCursor: page.nextCursor,
            }
          : current,
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Earlier messages could not be loaded.')
    } finally {
      setLoading(false)
    }
  }

  const rename = async (id: string, title: string) => {
    const session = await exploreRequest(`/sessions/${id}`, ExploreSessionSchema, {
      method: 'PATCH',
      body: { title },
    })
    setDetail((current) => (current?.session.id === id ? { ...current, session } : current))
    setLibrary((current) => ({
      ...current,
      sessions: current.sessions.map((item) => (item.id === id ? session : item)),
    }))
  }
  const remove = async (id: string) => {
    await exploreRequest(`/sessions/${id}`, z.object({ deleted: z.literal(true) }), {
      method: 'DELETE',
    })
    if (location.sessionId === id) {
      setDetail(null)
      navigate(null)
    }
    setQuery((value) => ({ ...value, page: 0 }))
    setRefreshVersion((value) => value + 1)
  }
  const loadRevisions = async (older = false) => {
    if (!artifact) return
    const targetId = artifact.id
    const result = await exploreRequest(
      `/artifacts/${artifact.id}/revisions${older && revisionCursor ? `?before=${revisionCursor}` : ''}`,
      z.object({ revisions: z.array(ExploreRevisionSchema), nextCursor: z.number().nullable() }),
    )
    if (artifactRef.current?.id !== targetId) return
    setRevisions((current) => (older ? [...current, ...result.revisions] : result.revisions))
    setRevisionCursor(result.nextCursor)
  }
  const restore = async (revisionId: string) => {
    if (!artifact) return
    await flushStates()
    const restored = await exploreRequest(
      `/artifacts/${artifact.id}/restore`,
      ExploreArtifactSchema,
      { method: 'POST', body: { revisionId, expectedRevision: artifact.revision } },
    )
    setDetail((current) =>
      current
        ? {
            ...current,
            artifacts: current.artifacts.map((item) => (item.id === restored.id ? restored : item)),
          }
        : current,
    )
    setRefreshVersion((value) => value + 1)
  }
  const updateState = useCallback(
    (state: ExploreLearningState) => {
      if (!artifact || !enabledRef.current) return
      const body = { state, expectedRevision: artifact.revision }
      states.current.set(artifact.id, body)
      setSaving(true)
      setDetail((current) =>
        current
          ? {
              ...current,
              artifacts: current.artifacts.map((item) =>
                item.id === artifact.id ? { ...item, state } : item,
              ),
            }
          : current,
      )
      void queueState(artifact.id, body).catch(() => {})
    },
    [artifact?.id, artifact?.revision, queueState],
  )

  return {
    location,
    library,
    query,
    setQuery,
    detail,
    artifact,
    loading,
    busy,
    error,
    stateError,
    saving,
    retryTurn,
    revisions,
    revisionCursor,
    navigate,
    send,
    cancel: () => turnRef.current?.abort(),
    loadOlder,
    rename,
    remove,
    loadRevisions,
    restore,
    updateState,
    retryState: async () => {
      try {
        await flushStates()
        for (const id of stateFailures.current.keys()) {
          if (!states.current.has(id)) stateFailures.current.delete(id)
        }
        setStateError(stateFailures.current.values().next().value ?? null)
      } catch {
        /* Keep failed snapshots available for another retry. */
      }
    },
    refresh: () => setRefreshVersion((value) => value + 1),
    selectArtifact: (id: string) => detail && navigate(detail.session.id, id),
  }
}
