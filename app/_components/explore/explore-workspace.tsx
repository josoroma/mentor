'use client'

import dynamic from 'next/dynamic'
import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { formatDistanceToNow } from 'date-fns'
import {
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  ChevronLeft,
  ChevronRight,
  Compass,
  History,
  Layers,
  LoaderCircle,
  MessageSquare,
  Mic,
  Plus,
  RefreshCw,
  Search,
  Square,
  Trash2,
  Pencil,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/app/_components/ui/button'
import { Modal } from '@/app/_components/ui/modal'
import { ExploreMessageCard } from '@/app/_components/explore/explore-message'
import { ExploreLearningPath } from '@/app/_components/explore/explore-learning-path'
import { LearningPathTrail } from '@/app/_components/learning-path-trail'
import { ExploreSuggestions } from '@/app/_components/explore/explore-suggestions'
import { PromptRefinements } from '@/app/_components/explore/prompt-refinements'
import { useExplorePromptRefinement } from '@/app/_hooks/use-explore-prompt-refinement'
import { useExploreSuggestions } from '@/app/_hooks/use-explore-suggestions'
import type { ProficiencyLevel } from '@/app/_types'
import type { LearningSelection } from '@/lib/learning/paths'
import { useExplore } from '@/app/_hooks/use-explore'
import { useExploreMessageImprovements } from '@/app/_hooks/use-explore-message-improvements'
import { useTopicDictation } from '@/app/_hooks/use-topic-dictation'
import { stopCorrectionPlayback } from '@/lib/audio/correction-playback'
import {
  ExploreArtifactKindSchema,
  type ExploreArtifactKind,
  type ExploreSession,
} from '@/lib/explore/schema'
import { cn } from '@/lib/utils'
import styles from '@/app/_components/explore/explore-workspace.module.css'

const ArtifactViewer = dynamic(
  () => import('@/app/_components/explore/artifact-viewer').then((module) => module.ArtifactViewer),
  {
    ssr: false,
    loading: () => (
      <p className={styles.status}>
        <LoaderCircle size={16} className="spin" /> Opening your interactive lesson…
      </p>
    ),
  },
)
const PromptSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1, 'Describe what you would like to explore.')
    .max(4000, 'Keep your question under 4,000 characters.'),
})
const RenameSchema = z.object({
  title: z.string().trim().min(1, 'Give this exploration a name.').max(160),
})
const kindLabels: Record<ExploreArtifactKind, string> = {
  walkthrough: 'Walkthrough',
  diagram: 'Diagram',
  hanoi: 'Hanoi',
  fibonacci: 'Fibonacci & estimation',
  sorting: 'Sorting',
  examples: 'Language practice',
  simulation: 'Simulation',
}
export const ExploreWorkspace = ({
  enabled,
  selection,
  level,
  onLearningSelectionChange,
}: {
  enabled: boolean
  selection: LearningSelection | null
  level: ProficiencyLevel
  onLearningSelectionChange: (selection: LearningSelection) => void
}) => {
  const explore = useExplore(enabled, selection ? { selection, level } : undefined)
  const { detail, artifact, location, busy, loading } = explore
  const [renameSession, setRenameSession] = useState<ExploreSession | null>(null)
  const [deleteSession, setDeleteSession] = useState<ExploreSession | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [mobilePanel, setMobilePanel] = useState<'conversation' | 'artifact'>('artifact')
  const chatEnd = useRef<HTMLDivElement>(null)
  const promptChoicesRef = useRef<HTMLDivElement>(null)
  const followConversation = useRef(true)
  const form = useForm<z.infer<typeof PromptSchema>>({
    resolver: zodResolver(PromptSchema),
    defaultValues: { prompt: '' },
  })
  const renameForm = useForm<z.infer<typeof RenameSchema>>({
    resolver: zodResolver(RenameSchema),
    defaultValues: { title: '' },
  })
  const dictation = useTopicDictation({
    onTranscript: (text) => form.setValue('prompt', text, { shouldValidate: true }),
  })
  const listening = dictation.state === 'recording' || dictation.state === 'transcribing'
  const draft = form.watch('prompt')
  const readyForPrompt =
    enabled &&
    !busy &&
    !listening &&
    !dialogBusy &&
    !renameSession &&
    !deleteSession &&
    !historyOpen &&
    (!location.sessionId || detail?.session.id === location.sessionId)
  const refinement = useExplorePromptRefinement({
    prompt: draft,
    learningContext:
      artifact?.content.learningContext ??
      detail?.session.learningContext ??
      (selection ? { selection, level } : undefined),
    lesson: artifact
      ? {
          title: artifact.content.title,
          kind: artifact.content.kind,
          summary: artifact.content.summary,
        }
      : undefined,
    conversation: detail?.messages
      .filter((message) => message.status === 'complete')
      .slice(-6)
      .map(({ role, content }) => ({ role, content: content.slice(0, 4000) })),
    contextKey: JSON.stringify([
      location.sessionId,
      location.artifactId,
      artifact?.id,
      artifact?.revision,
      detail?.session.version,
    ]),
    enabled: readyForPrompt,
  })
  const suggestionsEnabled = enabled && !location.sessionId && !busy && !draft.trim() && !listening
  const suggestions = useExploreSuggestions({ selection, level, enabled: suggestionsEnabled })
  const messageImprovements = useExploreMessageImprovements(
    detail,
    enabled && !busy && !draft.trim() && !listening,
  )
  useEffect(() => {
    if (refinement.status === 'ready')
      promptChoicesRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  }, [refinement.status])
  useEffect(() => {
    stopCorrectionPlayback()
  }, [mobilePanel, historyOpen, renameSession?.id, deleteSession?.id])
  useEffect(() => {
    if (!enabled) dictation.cancel()
  }, [enabled, dictation.cancel])
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  }, [detail?.messages.at(-1)?.id, busy])
  useEffect(() => {
    if (followConversation.current)
      chatEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  }, [messageImprovements.improvements, messageImprovements.pendingId])
  useEffect(() => {
    setHistoryOpen(false)
    setDialogError(null)
  }, [artifact?.id])

  const submit = form.handleSubmit(async () => {
    if (!readyForPrompt || refinement.status === 'loading') return
    stopCorrectionPlayback()
    await refinement.refine()
  })
  const choosePrompt = async (id: string) => {
    const prompt = refinement.choose(id)
    if (!prompt) return
    dictation.cancel()
    stopCorrectionPlayback()
    form.setValue('prompt', prompt, { shouldValidate: true })
    setMobilePanel('conversation')
    if (await explore.send(prompt)) form.reset()
  }
  const ask = (prompt: string) => {
    refinement.clear()
    dictation.cancel()
    form.setValue('prompt', prompt)
    form.setFocus('prompt')
  }
  const openRename = (session: ExploreSession) => {
    setDialogError(null)
    renameForm.reset({ title: session.title })
    setRenameSession(session)
  }
  const action = async (callback: () => Promise<void>) => {
    setDialogBusy(true)
    setDialogError(null)
    try {
      await callback()
    } catch (cause) {
      setDialogError(cause instanceof Error ? cause.message : 'This change could not be saved.')
    } finally {
      setDialogBusy(false)
    }
  }

  const composer = (
    <form onSubmit={submit} className={cn(styles.composer, !detail && styles.largeComposer)}>
      <label className={styles.srOnly} htmlFor="explore-prompt">
        {artifact ? 'Ask about this lesson' : 'What would you like to explore?'}
      </label>
      <textarea
        id="explore-prompt"
        {...form.register('prompt')}
        placeholder={
          artifact
            ? 'Ask about this lesson, a step, or an example…'
            : 'How does this work? Can you show me?'
        }
        rows={3}
        disabled={!enabled || busy || Boolean(location.sessionId && !detail)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void submit()
          }
        }}
      />
      <div className={styles.composerFooter}>
        <div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={!enabled || busy || dictation.state === 'transcribing'}
            aria-label={listening ? 'Finish voice prompt' : 'Speak your question'}
            aria-pressed={listening}
            onClick={() => void (listening ? dictation.stop() : dictation.start())}
          >
            {listening ? <Square size={17} /> : <Mic size={18} />}
          </Button>
          <span>
            {listening
              ? 'Listening to your question…'
              : artifact
                ? 'Refine your question, then choose one to send.'
                : 'Local AI · Review three prompts before exploring'}
          </span>
        </div>
        {busy ? (
          <Button
            key="stop-exploration"
            type="button"
            variant="secondary"
            onClick={(event) => {
              event.preventDefault()
              explore.cancel()
            }}
          >
            <Square size={14} /> Stop
          </Button>
        ) : refinement.status === 'loading' ? (
          <Button
            key="stop-refinement"
            type="button"
            variant="secondary"
            onClick={(event) => {
              event.preventDefault()
              refinement.cancel()
            }}
          >
            <Square size={14} /> Stop refining
          </Button>
        ) : (
          <Button key="refine" type="submit" disabled={!readyForPrompt}>
            <Sparkles size={15} />
            <span>{refinement.status === 'ready' ? 'Refine again' : 'Refine prompt'}</span>
          </Button>
        )}
      </div>
      {form.formState.errors.prompt && (
        <p className={styles.fieldError} role="alert">
          {form.formState.errors.prompt.message}
        </p>
      )}
      {dictation.error && (
        <p className={styles.fieldError} role="alert">
          {dictation.error}
        </p>
      )}
    </form>
  )
  const promptChoices = (
    <PromptRefinements
      options={refinement.options}
      status={refinement.status}
      error={refinement.error}
      discussion={!!artifact}
      enabled={readyForPrompt}
      onChoose={(id) => void choosePrompt(id)}
      onRetry={() => void submit()}
    />
  )
  const error = explore.error && (
    <div className={styles.error} role="alert">
      <p>{explore.error}</p>
      <Button
        variant="secondary"
        size="sm"
        disabled={busy}
        onClick={() =>
          explore.retryTurn
            ? void explore.send(explore.retryTurn.prompt, explore.retryTurn)
            : explore.refresh()
        }
      >
        <RefreshCw size={14} /> {explore.retryTurn ? 'Retry question' : 'Retry loading'}
      </Button>
    </div>
  )

  return (
    <div className={cn(styles.root, 'page-enter')}>
      {location.sessionId ? (
        <LearningPathTrail
          selection={
            (artifact ? artifact.content.learningContext : detail?.session.learningContext)
              ?.selection ?? null
          }
          label="Exploration learning path"
        />
      ) : (
        <ExploreLearningPath
          selection={selection}
          onChange={onLearningSelectionChange}
          disabled={!enabled}
        />
      )}
      {!location.sessionId ? (
        <>
          <div className={styles.intro}>
            <div className="eyebrow">
              <span /> EXPLORE · FOLLOW YOUR CURIOSITY
            </div>
            <h1>Learn by exploring.</h1>
            <p>Turn a question into something you can see, try, and understand.</p>
          </div>
          <section className={styles.hero} aria-label="Start an exploration">
            <div className={styles.heroCopy}>
              <div className={styles.heroIcon}>
                <Compass size={28} />
              </div>
              <h2>What are you curious about?</h2>
              <p>
                Start with your idea. Your AI guide will refine it into three prompts for diagrams,
                animations, or an interactive lesson. You choose the direction.
              </p>
            </div>
            {composer}
            {refinement.status !== 'idle' && (
              <div ref={promptChoicesRef} className={styles.heroRefinements}>
                {promptChoices}
              </div>
            )}
          </section>
          {!draft.trim() && !listening && (
            <ExploreSuggestions
              ideas={suggestions.ideas}
              loading={suggestions.loading}
              error={suggestions.error}
              enabled={suggestionsEnabled && !!selection}
              onRegenerate={() => void suggestions.regenerate()}
              onChoose={ask}
            />
          )}
          <section aria-labelledby="explore-library-heading" className={styles.library}>
            <div className={styles.libraryHeading}>
              <div>
                <div className="section-eyebrow">YOUR EXPLORATION LIBRARY</div>
                <h2 id="explore-library-heading">Pick up a thread.</h2>
              </div>
              <span>{explore.library.total} explorations</span>
            </div>
            <div className={styles.libraryFilters}>
              <label>
                <Search size={16} />
                <input
                  aria-label="Search explorations"
                  placeholder="Search your explorations…"
                  value={explore.query.search}
                  onChange={(event) =>
                    explore.setQuery((value) => ({ ...value, search: event.target.value, page: 0 }))
                  }
                />
              </label>
              <select
                aria-label="Filter explorations by format"
                value={explore.query.kind}
                onChange={(event) =>
                  explore.setQuery((value) => ({ ...value, kind: event.target.value, page: 0 }))
                }
              >
                <option value="all">Every format</option>
                {ExploreArtifactKindSchema.options.map((kind) => (
                  <option key={kind} value={kind}>
                    {kindLabels[kind]}
                  </option>
                ))}
              </select>
            </div>
            {error}
            {loading ? (
              <p className={styles.status} role="status">
                <LoaderCircle className="spin" size={16} /> Opening your library…
              </p>
            ) : explore.library.sessions.length ? (
              <div className={styles.libraryGrid}>
                {explore.library.sessions.map((session) => (
                  <article key={session.id} className={styles.libraryCard}>
                    <div className={styles.libraryPath}>
                      <LearningPathTrail
                        selection={session.learningContext?.selection ?? null}
                        compact
                        label={`Learning path for ${session.title}`}
                      />
                    </div>
                    <button
                      className={styles.libraryOpen}
                      onClick={() => explore.navigate(session.id)}
                      aria-label={`Open ${session.title}`}
                    >
                      <div>
                        <span>
                          <Layers size={18} />
                        </span>
                        <ArrowRight size={16} />
                      </div>
                      <small>
                        {session.artifactKind ? kindLabels[session.artifactKind] : 'Conversation'}
                      </small>
                      <h3>{session.title}</h3>
                    </button>
                    <div className={styles.libraryCardFooter}>
                      <span>
                        {formatDistanceToNow(new Date(session.updatedAt), { addSuffix: true })}
                      </span>
                      <button
                        aria-label={`Rename ${session.title}`}
                        onClick={() => openRename(session)}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        aria-label={`Delete ${session.title}`}
                        onClick={() => {
                          setDialogError(null)
                          setDeleteSession(session)
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              !explore.error && (
                <div className={styles.empty}>
                  <Compass size={28} />
                  <h3>
                    {explore.query.search || explore.query.kind !== 'all'
                      ? 'No matching explorations'
                      : 'Your next discovery starts with a question.'}
                  </h3>
                  <p>
                    {explore.query.search || explore.query.kind !== 'all'
                      ? 'Try a different search or format.'
                      : 'Ask above. Every conversation and interactive lesson will be saved here.'}
                  </p>
                </div>
              )
            )}
            {explore.library.total > 0 && (
              <nav className={styles.pagination} aria-label="Exploration library pages">
                <span>
                  Page {explore.query.page + 1} of{' '}
                  {Math.max(1, Math.ceil(explore.library.total / 12))}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loading || explore.query.page === 0}
                  onClick={() => explore.setQuery((value) => ({ ...value, page: value.page - 1 }))}
                >
                  <ChevronLeft size={14} /> Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loading || (explore.query.page + 1) * 12 >= explore.library.total}
                  onClick={() => explore.setQuery((value) => ({ ...value, page: value.page + 1 }))}
                >
                  Next <ChevronRight size={14} />
                </Button>
              </nav>
            )}
          </section>
        </>
      ) : (
        <>
          <div className={styles.workspaceHeading}>
            <Button variant="ghost" size="sm" onClick={() => explore.navigate(null)}>
              <ArrowLeft size={16} /> Library
            </Button>
            <div>
              <h1>{detail?.session.title ?? 'Opening exploration…'}</h1>
              <span>
                <Check size={12} />{' '}
                {explore.stateError
                  ? 'Interaction needs saving'
                  : explore.saving
                    ? 'Saving your interaction…'
                    : detail
                      ? 'Saved in your learning database'
                      : 'Opening your saved exploration'}
              </span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              aria-label="New exploration"
              onClick={() => explore.navigate(null)}
            >
              <Plus size={15} /> New
            </Button>
            {detail && (
              <button
                className={styles.iconButton}
                aria-label="Rename exploration"
                onClick={() => openRename(detail.session)}
              >
                <Pencil size={16} />
              </button>
            )}
            {detail && (
              <button
                className={styles.iconButton}
                aria-label="Delete exploration"
                disabled={busy}
                onClick={() => {
                  setDialogError(null)
                  setDeleteSession(detail.session)
                }}
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
          <div className={styles.mobileTabs}>
            <button
              aria-pressed={mobilePanel === 'conversation'}
              onClick={() => setMobilePanel('conversation')}
            >
              <MessageSquare size={15} /> Conversation
            </button>
            <button
              aria-pressed={mobilePanel === 'artifact'}
              onClick={() => setMobilePanel('artifact')}
            >
              <Box size={15} /> Interactive lesson
            </button>
          </div>
          {loading && !detail && (
            <p role="status" className={styles.status}>
              <LoaderCircle className="spin" size={16} /> Restoring your conversation and
              interactive lessons…
            </p>
          )}
          {!detail && error}
          {detail && (
            <div className={styles.workspace}>
              <section
                className={cn(
                  styles.conversation,
                  mobilePanel !== 'conversation' && styles.mobileHidden,
                )}
                aria-label="Explore conversation"
              >
                <div className={styles.panelHeading}>
                  <span>
                    <Sparkles size={16} /> Your AI guide
                  </span>
                  <small>LOCAL AI</small>
                </div>
                <div
                  className={styles.messages}
                  onScroll={(event) => {
                    const container = event.currentTarget
                    followConversation.current =
                      container.scrollHeight - container.scrollTop - container.clientHeight < 80
                  }}
                >
                  {detail.nextCursor !== null && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={loading}
                      onClick={() => void explore.loadOlder()}
                    >
                      Load earlier messages
                    </Button>
                  )}
                  {!detail.messages.length && (
                    <div className={styles.chatWelcome}>
                      <Compass size={26} />
                      <p>
                        {artifact
                          ? 'Ask your guide about the current lesson.'
                          : 'Ask a question. We’ll build an explanation you can explore together.'}
                      </p>
                    </div>
                  )}
                  {detail.messages.map((message) => (
                    <ExploreMessageCard
                      key={message.id}
                      message={message}
                      improvement={messageImprovements.improvements.get(message.id)}
                      improving={messageImprovements.pendingId === message.id}
                      error={messageImprovements.errors.get(message.id)}
                      onRetry={() => messageImprovements.retry(message.id)}
                      playbackEnabled={enabled && !listening}
                    />
                  ))}
                  {busy && (
                    <p className={styles.status} role="status">
                      <LoaderCircle className="spin" size={15} />
                      {artifact
                        ? 'Thinking about your question…'
                        : 'Building an explanation you can explore…'}
                    </p>
                  )}
                  {error}
                  <div ref={chatEnd} />
                </div>
                <div className={styles.chatFooter}>
                  {artifact && (
                    <p className={styles.artifactContext}>
                      <Layers size={12} /> Discussing: {artifact.content.title}
                    </p>
                  )}
                  {composer}
                  {refinement.status !== 'idle' && (
                    <div ref={promptChoicesRef} className={styles.chatRefinements}>
                      {promptChoices}
                    </div>
                  )}
                  <div className={styles.followups}>
                    {['Explain this step', 'Why does this work?', 'Can we practice this?'].map(
                      (prompt) => (
                        <button disabled={busy} key={prompt} onClick={() => ask(prompt)}>
                          {prompt}
                        </button>
                      ),
                    )}
                  </div>
                </div>
              </section>
              <section
                className={cn(
                  styles.artifactPanel,
                  mobilePanel !== 'artifact' && styles.mobileHidden,
                )}
                aria-label="Interactive exploration artifacts"
              >
                <div className={styles.panelHeading}>
                  <span>
                    <Box size={16} /> Interactive lesson
                  </span>
                  {artifact && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label="Revision history"
                      onClick={() => {
                        setHistoryOpen(true)
                        void action(() => explore.loadRevisions())
                      }}
                    >
                      <History size={14} /> Revision {artifact.revision}
                    </Button>
                  )}
                </div>
                {detail.artifacts.length > 0 && (
                  <nav className={styles.artifactTabs} aria-label="Exploration artifacts">
                    {detail.artifacts.map((item) => (
                      <button
                        key={item.id}
                        aria-pressed={item.id === artifact?.id}
                        onClick={() => explore.selectArtifact(item.id)}
                      >
                        {item.content.title}
                      </button>
                    ))}
                  </nav>
                )}
                {explore.stateError && (
                  <div className={styles.error} role="alert">
                    <p>{explore.stateError}</p>
                    <Button variant="secondary" size="sm" onClick={() => void explore.retryState()}>
                      Retry saving
                    </Button>
                  </div>
                )}
                <div className={styles.viewer}>
                  {!enabled ? (
                    <p className={styles.status}>
                      Your lesson is paused while your learning data is open.
                    </p>
                  ) : artifact ? (
                    <ArtifactViewer
                      key={`${artifact.id}:${artifact.revision}`}
                      artifact={artifact}
                      onStateChange={explore.updateState}
                      improvementsEnabled={
                        enabled &&
                        !busy &&
                        !draft.trim() &&
                        !listening &&
                        !messageImprovements.pendingId
                      }
                      playbackEnabled={enabled && !listening}
                    />
                  ) : (
                    <div className={styles.artifactEmpty}>
                      <div className={styles.emptyDiagram}>
                        <i />
                        <span />
                        <i />
                        <span />
                        <i />
                      </div>
                      <h2>A new way to understand.</h2>
                      <p>
                        Your question becomes a walkthrough, a diagram, an experiment, or a chance
                        to practice.
                      </p>
                      {busy && <LoaderCircle size={23} className="spin" />}
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}
        </>
      )}
      <Modal
        open={!!renameSession}
        onOpenChange={(open) => {
          if (!open && !dialogBusy) setRenameSession(null)
        }}
        title="Rename exploration"
        description="Give this thread a name you’ll recognize later."
      >
        <form
          className={styles.modalForm}
          onSubmit={renameForm.handleSubmit(({ title }) =>
            action(async () => {
              if (renameSession) await explore.rename(renameSession.id, title)
              setRenameSession(null)
            }),
          )}
        >
          <label>
            Exploration name
            <input {...renameForm.register('title')} autoFocus maxLength={160} />
          </label>
          {renameForm.formState.errors.title && (
            <p role="alert">{renameForm.formState.errors.title.message}</p>
          )}
          {dialogError && <p role="alert">{dialogError}</p>}
          <Button disabled={dialogBusy} type="submit">
            {dialogBusy ? 'Saving…' : 'Save name'}
          </Button>
        </form>
      </Modal>
      <Modal
        open={!!deleteSession}
        onOpenChange={(open) => {
          if (!open && !dialogBusy) setDeleteSession(null)
        }}
        title="Delete exploration?"
        description="This removes its conversation, interactive artifacts, and revision history from your database."
      >
        <div className={styles.modalForm}>
          <p>{deleteSession?.title}</p>
          {dialogError && <p role="alert">{dialogError}</p>}
          <div>
            <Button
              variant="secondary"
              disabled={dialogBusy}
              onClick={() => setDeleteSession(null)}
            >
              Keep exploration
            </Button>
            <Button
              variant="destructive"
              disabled={dialogBusy}
              onClick={() =>
                void action(async () => {
                  if (deleteSession) await explore.remove(deleteSession.id)
                  setDeleteSession(null)
                })
              }
            >
              <Trash2 size={15} /> {dialogBusy ? 'Deleting…' : 'Delete exploration'}
            </Button>
          </div>
        </div>
      </Modal>
      <Modal
        open={historyOpen}
        onOpenChange={(open) => {
          if (!dialogBusy) setHistoryOpen(open)
        }}
        title="Artifact revision history"
        description="Each revision stays linked to the question that created it. Restoring makes a new revision."
      >
        <div className={styles.revisions}>
          {dialogBusy && <p role="status">Loading revision…</p>}
          {dialogError && <p role="alert">{dialogError}</p>}
          {explore.revisions.map((revision) => (
            <article key={revision.id}>
              <div>
                <strong>
                  Revision {revision.number}
                  {revision.number === artifact?.revision ? ' · Current' : ''}
                </strong>
                <small>
                  {formatDistanceToNow(new Date(revision.createdAt), { addSuffix: true })}
                </small>
              </div>
              <h3>{revision.content.title}</h3>
              <p>{revision.content.summary}</p>
              {revision.restoredFrom && <small>Restored from an earlier revision</small>}
              <details>
                <summary>View revision details</summary>
                <p>
                  {revision.content.sections
                    .map((section) => `${section.heading}: ${section.body}`)
                    .join('\n\n') ||
                    revision.content.steps
                      .map((step) => `${step.title}: ${step.body}`)
                      .join('\n\n')}
                </p>
                <p>
                  <strong>Source prompt: </strong>
                  {revision.sourcePrompt ??
                    detail?.messages.find((message) => message.id === revision.messageId)
                      ?.content ??
                    'Source prompt is unavailable.'}
                </p>
              </details>
              {revision.number !== artifact?.revision && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={dialogBusy || busy}
                  onClick={() =>
                    void action(async () => {
                      await explore.restore(revision.id)
                      setHistoryOpen(false)
                    })
                  }
                >
                  <History size={14} /> Restore this revision
                </Button>
              )}
            </article>
          ))}
          {explore.revisionCursor !== null && (
            <Button
              variant="secondary"
              disabled={dialogBusy}
              onClick={() => void action(() => explore.loadRevisions(true))}
            >
              Load earlier revisions
            </Button>
          )}
        </div>
      </Modal>
    </div>
  )
}
