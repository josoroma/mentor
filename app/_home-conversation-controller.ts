import { z } from 'zod'
import { HomeConversationSchema, type HomeConversationRequest } from '@/lib/ai/home-conversation'
import { isExplicitConversationAgreement } from '@/lib/ai/home-conversation-progress'
import type { Profile } from '@/app/_types'
import type { LearningSelection } from '@/lib/learning/paths'
import { defaultPersonaPair, type SpeechPersonaPair } from '@/lib/audio/persona-selection'
import type { SpeechProvider } from '@/lib/audio/speech-provider'
import type {
  ConciergeConversationTurn,
  ConciergePlayback,
  VoiceConciergeState,
} from '@/lib/audio/voice-concierge'

export type HomeConversationEntry = {
  id: string
  speaker: 'alex' | 'sam' | 'user'
  text: string
  timestamp: number
}
type Phase = 'idle' | 'preparing' | 'generating' | 'playing' | 'listening' | 'paused' | 'error'
export type HomeConversationSnapshot = {
  id: string | null
  topic: string
  turns: HomeConversationEntry[]
  personas: SpeechPersonaPair
  provider?: SpeechProvider
  phase: Phase
  activeTurnId: string | null
  error: string | null
}
export const createHomeConversationSnapshot = (): HomeConversationSnapshot => ({
  id: null,
  topic: '',
  turns: [],
  personas: defaultPersonaPair,
  phase: 'idle',
  activeTurnId: null,
  error: null,
})

// Keep exact excerpts, preserving who said them. Newer dialogue overrides older context.
export const selectHomeConversationContext = (turns: HomeConversationEntry[]) => {
  const excerpts = turns.flatMap((turn) => {
    if (turn.speaker !== 'user' || turn.text.length <= 2000) return [turn]
    // The request contract bounds each excerpt, not the learner's whole utterance.
    const parts: HomeConversationEntry[] = []
    for (let start = 0; start < turn.text.length;) {
      let end = Math.min(start + 2000, turn.text.length)
      if (end < turn.text.length) {
        const space = turn.text.lastIndexOf(' ', end - 1)
        if (space > start + 1000) end = space + 1
      }
      parts.push({
        ...turn,
        id: `${turn.id}:part-${parts.length + 1}`,
        text: turn.text.slice(start, end),
      })
      start = end
    }
    return parts
  })
  const history = excerpts.slice(-20)
  const older = excerpts.slice(0, -20)
  const learners = older.filter((turn) => turn.speaker === 'user')
  const retained = new Set([...learners.slice(0, 1), ...learners.slice(-7)].map((turn) => turn.id))
  // An isolated "Agreed" loses what the speaker accepted. Keep the actual
  // neighboring turns together, without turning either into a synthetic fact.
  // Include the recent-history boundary so its first turn keeps its context.
  for (let index = older.length; index > 0; index--) {
    if (!isExplicitConversationAgreement(excerpts[index].text)) continue
    const pair = excerpts.slice(index - 1, Math.min(index + 1, older.length))
    const missing = pair.filter((turn) => !retained.has(turn.id))
    if (retained.size + missing.length > 12) continue
    for (const turn of missing) retained.add(turn.id)
  }
  for (const turn of older.filter((turn) => turn.speaker !== 'user').reverse()) {
    if (retained.size >= 12) break
    retained.add(turn.id)
  }
  const excerpt = (turn: HomeConversationEntry) => ({
    id: turn.id,
    speaker: turn.speaker,
    text: turn.text,
  })
  return {
    history: history.map(excerpt),
    earlierContext: older.filter((turn) => retained.has(turn.id)).map(excerpt),
  }
}

const requestHomeConversation = async (body: HomeConversationRequest, signal: AbortSignal) => {
  const response = await fetch('/api/home-conversation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const value: unknown = await response.json()
  if (!response.ok) {
    const failure = z.object({ error: z.string() }).safeParse(value)
    throw new Error(
      failure.success ? failure.data.error : 'The local partners could not continue. Try again.',
    )
  }
  return HomeConversationSchema.parse(value)
}

type Dependencies = {
  profile: Pick<Profile, 'roleId' | 'level'>
  selection: LearningSelection
  prepare: (
    signal: AbortSignal,
  ) => Promise<{ personas: SpeechPersonaPair; provider?: SpeechProvider }>
  play: (turns: ConciergeConversationTurn[], provider?: SpeechProvider) => Promise<void>
  pauseVoice: () => void
  cancelVoice: () => void
  setMicrophone: (enabled: boolean) => Promise<void>
  onChange: (snapshot: HomeConversationSnapshot) => void
  recentTopics?: () => string[]
  rememberTopic?: (topic: string) => void
  request?: typeof requestHomeConversation
}

export class HomeConversationController {
  private snapshot = createHomeConversationSnapshot()
  private running = false
  private disposed = false
  private prepared = false
  private request: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private batch: HomeConversationEntry[] = []
  private batchTopic: string | null = null
  private epoch = 0
  private voiceState: VoiceConciergeState = 'idle'
  constructor(private readonly dependencies: Dependencies) {}

  private publish(patch: Partial<HomeConversationSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    if (!this.disposed) this.dependencies.onChange(this.snapshot)
  }
  private cancelRequest() {
    this.epoch++
    this.request?.abort()
    this.request = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
  private fail(error: unknown) {
    this.running = false
    this.cancelRequest()
    this.dependencies.pauseVoice()
    this.publish({
      phase: 'error',
      activeTurnId: null,
      error:
        error instanceof Error ? error.message : 'The conversation could not continue. Try again.',
    })
  }
  async startNew() {
    if (this.disposed) return
    this.running = false
    this.cancelRequest()
    this.dependencies.cancelVoice()
    this.batch = []
    this.batchTopic = null
    this.prepared = false
    this.snapshot = createHomeConversationSnapshot()
    this.publish({ id: crypto.randomUUID(), phase: 'preparing' })
    this.running = true
    await this.continue()
  }
  async resume() {
    if (this.disposed) return
    if (!this.snapshot.id) return this.startNew()
    this.running = true
    await this.continue()
  }
  pause(stopVoice = true) {
    this.running = false
    this.cancelRequest()
    this.batch = []
    this.batchTopic = null
    this.publish({ phase: 'paused', activeTurnId: null })
    if (stopVoice) this.dependencies.pauseVoice()
  }
  async toggleMicrophone(enabled: boolean) {
    if (this.disposed || !this.snapshot.id || !this.prepared) return
    if (enabled) {
      this.running = true
      this.cancelRequest()
      this.batch = []
      this.batchTopic = null
      this.publish({ phase: 'listening', error: null, activeTurnId: null })
    }
    await this.dependencies.setMicrophone(enabled)
    if (
      !enabled &&
      this.running &&
      this.voiceState !== 'transcribing' &&
      this.snapshot.phase === 'listening'
    ) {
      await this.continue()
    }
  }
  onVoiceState(state: VoiceConciergeState) {
    this.voiceState = state
    if (this.disposed) return
    if (state === 'paused' && this.running) this.pause(false)
    else if (state === 'error' && this.running) {
      this.running = false
      this.cancelRequest()
      this.batch = []
      this.batchTopic = null
      this.publish({ phase: 'error', activeTurnId: null })
    } else if ((state === 'listening' || state === 'transcribing') && this.running) {
      this.cancelRequest()
      this.batch = []
      this.batchTopic = null
      this.publish({ phase: 'listening', activeTurnId: null })
    }
  }
  onPlayback(playback: ConciergePlayback) {
    if (!this.running || this.disposed) return
    const known = new Set(this.snapshot.turns.map((turn) => turn.id))
    const shown = this.batch
      .slice(0, playback.startedTurnCount)
      .filter((turn) => !known.has(turn.id))
      .map((turn) => ({ ...turn, timestamp: Date.now() }))
    // A generated transition only belongs to this discussion once it is shown.
    // Interrupted drafts must not replace the active topic or its recent history.
    const topic = shown.length && this.batchTopic ? this.batchTopic : this.snapshot.topic
    if (topic && topic !== this.snapshot.topic) this.dependencies.rememberTopic?.(topic)
    this.publish({
      topic,
      ...(shown.length ? { turns: [...this.snapshot.turns, ...shown], phase: 'playing' } : {}),
      activeTurnId:
        playback.activeTurnIndex === null
          ? null
          : (this.batch[playback.activeTurnIndex]?.id ?? null),
    })
  }
  onTranscript(text: string) {
    if (!this.running || this.disposed || !text.trim()) return
    this.cancelRequest()
    this.batch = []
    this.batchTopic = null
    this.publish({
      turns: [
        ...this.snapshot.turns,
        { id: crypto.randomUUID(), speaker: 'user', text: text.trim(), timestamp: Date.now() },
      ],
      activeTurnId: null,
    })
    void this.continue()
  }
  onComplete() {
    if (!this.running || this.disposed) return
    this.batch = []
    this.batchTopic = null
    this.publish({ activeTurnId: null, phase: 'generating' })
    // Leave a short breath between exchanges; never spin on an empty playback batch.
    this.timer = setTimeout(() => {
      this.timer = null
      void this.continue()
    }, 800)
  }
  onListeningQuiet() {
    if (this.running && this.snapshot.phase === 'listening') void this.continue()
  }
  private async continue() {
    if (!this.running || this.disposed || this.request) return
    this.cancelRequest()
    const epoch = this.epoch
    const controller = new AbortController()
    this.request = controller
    const valid = () =>
      !this.disposed && this.running && this.epoch === epoch && !controller.signal.aborted
    const timeout = setTimeout(() => {
      if (valid()) this.fail(new Error('The local partners took too long to respond. Try again.'))
    }, 75_000)
    try {
      if (!this.prepared) {
        this.publish({ phase: 'preparing', error: null })
        const voice = await this.dependencies.prepare(controller.signal)
        if (!valid()) return
        this.prepared = true
        this.publish({ personas: voice.personas, provider: voice.provider })
      }
      this.publish({ phase: 'generating', error: null })
      const last = this.snapshot.turns.findLast((turn) => turn.speaker !== 'user')
      const nextSpeaker = last?.speaker === 'alex' ? 'sam' : 'alex'
      const response = await (this.dependencies.request ?? requestHomeConversation)(
        {
          roleId: this.dependencies.profile.roleId,
          level: this.dependencies.profile.level,
          selection: this.dependencies.selection,
          personas: this.snapshot.personas,
          speechProvider: this.snapshot.provider,
          ...(this.snapshot.topic ? { topic: this.snapshot.topic } : {}),
          recentTopics: this.dependencies.recentTopics?.() ?? [],
          ...selectHomeConversationContext(this.snapshot.turns),
          nextSpeaker,
        },
        controller.signal,
      )
      if (!valid()) return
      const conversation = HomeConversationSchema.parse(response)
      if (
        conversation.turns[0].speaker !== nextSpeaker ||
        conversation.turns[1].speaker === nextSpeaker
      )
        throw new Error('The conversation partners returned out of order. Try again.')
      this.batch = conversation.turns.map((turn) => ({
        ...turn,
        id: crypto.randomUUID(),
        timestamp: Date.now(),
      }))
      this.batchTopic = conversation.topic
      this.publish({ phase: 'playing' })
      clearTimeout(timeout)
      this.request = null
      await this.dependencies.play(
        this.batch.map((turn) => ({
          speaker: turn.speaker as 'alex' | 'sam',
          text: turn.text,
          persona: this.snapshot.personas[turn.speaker as 'alex' | 'sam'],
        })),
        this.snapshot.provider,
      )
    } catch (error) {
      if (valid()) this.fail(error)
    } finally {
      clearTimeout(timeout)
      if (this.request === controller) this.request = null
    }
  }
  dispose() {
    this.disposed = true
    this.running = false
    this.cancelRequest()
    this.dependencies.cancelVoice()
  }
}
