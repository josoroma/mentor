'use client'

import { useEffect, useMemo, useRef } from 'react'
import {
  AudioLines,
  CornerDownLeft,
  LoaderCircle,
  Mic,
  MicOff,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import type { Profile } from '@/app/_types'
import { getSpeechPersonaName } from '@/lib/audio/personas'
import {
  LearningSelectionSchema,
  getLearningSelectionLabel,
  type LearningSelection,
} from '@/lib/learning/paths'
import { useHomeConversation } from '@/app/_hooks/use-home-conversation'
import { useHomeConversationPersistence } from '@/app/_hooks/use-home-conversation-persistence'
import { useSpeakingActivity } from '@/app/_hooks/use-speaking-activity'
import { useReplySuggestionsState } from '@/app/_hooks/use-reply-suggestions'
import { createHomeConversationRepliesContext } from '@/app/_home-conversation-replies'
import { ConversationEntrySuggestions } from '@/app/_components/conversation-entry-suggestions'
import { VoiceOrb } from '@/app/_components/voice-orb'
import { Waveform } from '@/app/_components/waveform'
import { Button } from '@/app/_components/ui/button'
import { cn } from '@/lib/utils'
import styles from '@/app/_components/home-conversation.module.css'

export const HomeConversationDemo = ({
  profile,
  selection,
  enabled,
  scenarioStatus,
}: {
  profile: Profile
  selection: LearningSelection | null
  enabled: boolean
  scenarioStatus: 'loading' | 'ready' | 'error'
}) => {
  const selectionReady = LearningSelectionSchema.safeParse(selection).success
  const waitingForScenarios = selectionReady && scenarioStatus === 'loading'
  const scenariosFailed = selectionReady && scenarioStatus === 'error'
  const voiceEnabled = enabled && selectionReady && scenarioStatus === 'ready'
  const home = useHomeConversation({ profile, selection, enabled: voiceEnabled })
  const { voice } = home
  const selectionLabel = selectionReady && selection ? getLearningSelectionLabel(selection) : null
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const userSpeaking = useSpeakingActivity(voice.userLevel, voiceEnabled && voice.microphoneEnabled)
  const generating = home.phase === 'generating' || home.phase === 'preparing'
  const stopped = home.phase === 'paused' || home.phase === 'error' || home.phase === 'idle'
  const coachBusy = generating || userSpeaking || voice.state === 'transcribing'
  const persistence = useHomeConversationPersistence({
    id: home.id,
    topic: home.topic,
    turns: home.turns,
    profile,
    selection,
    personas: home.personas,
    enabled: selectionReady,
    coachBusy: coachBusy || !voiceEnabled || stopped,
  })
  const replyContext = useMemo(
    () =>
      createHomeConversationRepliesContext({
        conversation: home.id
          ? { id: home.id, topic: home.topic, personas: home.personas, turns: home.turns }
          : null,
        startedTurnCount: home.turns.length,
        profile: { roleId: profile.roleId, level: profile.level },
        selection,
      }),
    [home.id, home.topic, home.personas, home.turns, profile.roleId, profile.level, selection],
  )
  const entrySuggestions = useReplySuggestionsState({
    context: replyContext,
    enabled: voiceEnabled,
    busy: coachBusy,
    mode: 'join',
  })
  useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
  }, [home.turns.length, persistence.improvements.length])
  const speakers = (['alex', 'sam'] as const).map((id) => ({
    id,
    name: getSpeechPersonaName(home.personas[id]),
  }))
  const speakerNames = `${speakers[0].name} and ${speakers[1].name}`
  const activeName = speakers.find((speaker) => speaker.id === voice.activeSpeaker)?.name
  const joined = home.turns.some((turn) => turn.speaker === 'user')
  const micDisabled = !voiceEnabled || home.phase === 'preparing' || !home.id
  const status = !selectionReady
    ? 'Choose a learning focus to begin'
    : waitingForScenarios
      ? 'Loading your practice scenarios…'
      : scenariosFailed
        ? 'Retry scenario generation below to start the conversation'
        : voice.state === 'needs-gesture'
          ? `One tap to hear ${speakerNames}`
          : home.phase === 'paused'
            ? 'Conversation paused · microphone off'
            : home.phase === 'error'
              ? 'Ready to reconnect when you are'
              : voice.state === 'transcribing'
                ? 'Listening back to your words…'
                : generating
                  ? home.turns.length
                    ? 'Thinking about the next turn…'
                    : 'Starting the conversation…'
                  : voice.state === 'speaking' && activeName
                    ? `${activeName} is speaking${voice.microphoneEnabled ? ' · you can jump in' : ''}`
                    : voice.state === 'listening'
                      ? 'Your mic is on · join in whenever you’re ready'
                      : 'The conversation continues · microphone off'
  const shownTurns = home.turns.slice(-100)

  return (
    <section className={styles.hero} aria-label="An ongoing conversation with two AI partners">
      <div className={styles.copy}>
        <div className={styles.kicker}>
          <Sparkles size={14} /> TWO VOICES. ROOM FOR YOURS.
        </div>
        <p className={styles.roleContext}>
          {selectionLabel ? `Practice: ${selectionLabel}` : 'Choose your learning focus'}
        </p>
        <h2>{home.topic || 'Your focus. An ongoing exchange.'}</h2>
        <p className={styles.invitation}>
          {speakerNames} keep the conversation going. Turn on your mic to join them here, or listen
          with your mic off.
        </p>
        <div className={styles.caption}>
          <span>
            <AudioLines size={13} /> LIVE CONVERSATION{' '}
            <small>{joined ? 'YOU + TWO AI PARTNERS' : 'TWO AI PARTNERS'}</small>
          </span>
          <div
            ref={transcriptRef}
            className={styles.transcript}
            role="log"
            aria-label="Conversation transcript"
            aria-live="off"
            tabIndex={0}
          >
            {shownTurns.length ? (
              shownTurns.map((turn) => {
                const improved = persistence.improvements.find((item) => item.messageId === turn.id)
                return (
                  <div
                    key={turn.id}
                    className={cn(
                      styles.turn,
                      turn.speaker === 'sam' && styles.samTurn,
                      turn.speaker === 'user' && styles.learnerTurn,
                      home.activeTurnId === turn.id && styles.activeTurn,
                    )}
                    data-speaker={turn.speaker}
                  >
                    <strong>
                      {turn.speaker === 'user'
                        ? 'You'
                        : getSpeechPersonaName(home.personas[turn.speaker])}
                      {turn.speaker !== 'user' && <span>AI</span>}
                      {home.activeTurnId === turn.id && <AudioLines size={11} />}
                    </strong>
                    <p>{turn.text}</p>
                    {improved && (
                      <div className={styles.improvement}>
                        <span>IMPROVED ENGLISH</span>
                        <p>{improved.improved}</p>
                      </div>
                    )}
                  </div>
                )
              })
            ) : (
              <p className={styles.emptyTranscript}>
                {waitingForScenarios
                  ? 'Your AI partners will start automatically once all practice scenarios are ready.'
                  : scenariosFailed
                    ? 'Your AI partners will start after your practice scenarios load. Retry below.'
                    : selectionReady
                      ? 'Your partners are getting an exchange started…'
                      : 'Choose a topic above to begin.'}
              </p>
            )}
          </div>
        </div>
        {voice.interimTranscript && (
          <div className={styles.heard}>
            <span>YOU · LIVE</span>
            <p>{voice.interimTranscript}</p>
          </div>
        )}
        <div className={styles.controls}>
          {voice.state === 'needs-gesture' ? (
            <Button onClick={() => void voice.enable()} disabled={!voiceEnabled}>
              <Play size={16} /> Enable voice
            </Button>
          ) : stopped ? (
            <Button onClick={home.resume} disabled={!voiceEnabled}>
              <Play size={16} />{' '}
              {home.phase === 'error' ? 'Retry conversation' : 'Continue conversation'}
            </Button>
          ) : (
            <Button onClick={home.pause} disabled={!voiceEnabled}>
              <Pause size={16} /> Pause conversation
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={home.newExchange}
            disabled={!voiceEnabled || voice.state === 'transcribing'}
          >
            <RefreshCw size={14} /> New conversation
          </Button>
        </div>
        {voice.state === 'needs-gesture' && (
          <p className={styles.note}>
            Enable the AI voices to listen. Your microphone stays off until you turn it on.
          </p>
        )}
        {(home.error || voice.error) && (
          <p className={styles.error} role="alert">
            {home.error || voice.error}
          </p>
        )}
        {joined && (
          <p className={styles.saveStatus} role="status">
            {persistence.error ? (
              <>
                {persistence.error} <button onClick={persistence.retry}>Retry saving</button>
              </>
            ) : persistence.status === 'saving' ? (
              'Saving your conversation…'
            ) : persistence.status === 'saved' ? (
              `Conversation saved ${persistence.destination === 'supabase' ? 'to your learning database' : 'on this device'}.`
            ) : (
              'Your words save automatically.'
            )}
          </p>
        )}
      </div>
      <div className={styles.visual}>
        <span className={styles.orbLabel}>
          <span className="status-dot" /> YOUR AI CONVERSATION PARTNERS
        </span>
        <div className={styles.participants}>
          {speakers.map((speaker) => {
            const speaking =
              voiceEnabled && voice.state === 'speaking' && voice.activeSpeaker === speaker.id
            return (
              <div
                className={cn(styles.participant, speaker.id === 'sam' && styles.samParticipant)}
                key={speaker.id}
                data-participant={speaker.id}
              >
                <VoiceOrb
                  variant={speaker.id === 'alex' ? 'coach' : 'user'}
                  active={speaking}
                  level={speaking ? voice.coachLevel : 0}
                />
                <strong>{speaker.name}</strong>
                <span>AI PARTNER</span>
                <Waveform
                  active={speaking}
                  level={speaking ? voice.coachLevel : 0}
                  variant={speaker.id === 'alex' ? 'coach' : 'user'}
                />
              </div>
            )
          })}
        </div>
        <div className={styles.state} role="status">
          {(waitingForScenarios ||
            generating ||
            voice.state === 'preparing' ||
            voice.state === 'transcribing') && <LoaderCircle size={13} className="spin" />}
          {status}
        </div>
        <button
          className={styles.userWave}
          type="button"
          aria-label={
            voice.microphoneEnabled ? 'Turn off your microphone' : 'Turn on your microphone'
          }
          aria-pressed={voice.microphoneEnabled}
          disabled={micDisabled}
          onClick={() => home.setMicrophone(!voice.microphoneEnabled)}
        >
          <span>YOUR MIC · {voice.microphoneEnabled ? 'ON' : 'OFF'}</span>
          <Waveform
            active={userSpeaking}
            level={voice.microphoneEnabled ? voice.userLevel : 0}
            variant="user"
          />
          {voice.microphoneEnabled ? <Mic size={15} /> : <MicOff size={15} />}
        </button>
        {voice.state === 'listening' && voice.microphoneEnabled && (
          <button className={styles.send} onClick={() => void voice.finishTurn()}>
            <CornerDownLeft size={13} /> Done speaking
          </button>
        )}
        <ConversationEntrySuggestions
          key={replyContext?.turnId ?? 'starters'}
          suggestions={entrySuggestions.replies}
          isLoading={entrySuggestions.isLoading}
          error={entrySuggestions.error}
          isGenerated={entrySuggestions.isGenerated}
          disabled={micDisabled || voice.state === 'transcribing'}
          listening={voice.microphoneEnabled}
          onRetry={entrySuggestions.retry}
          onListen={() => home.setMicrophone(true)}
        />
        <p className={styles.privacy}>
          <ShieldCheck size={12} /> Mic off until you choose. Private, local practice.
        </p>
      </div>
    </section>
  )
}
