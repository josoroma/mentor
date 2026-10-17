'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Clock3,
  CornerDownLeft,
  LoaderCircle,
  Mic,
  MicOff,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Square,
  Volume2,
  X,
} from 'lucide-react'
import type { ConversationOutline, Profile, Role, Scenario, SessionRecord } from '@/app/_types'
import { useVoiceSession } from '@/app/_hooks/use-voice-session'
import { useLiveImprovements } from '@/app/_hooks/use-live-improvements'
import { useReplySuggestions } from '@/app/_hooks/use-reply-suggestions'
import { useSessionAutosave } from '@/app/_hooks/use-session-autosave'
import { useSpeakingActivity } from '@/app/_hooks/use-speaking-activity'
import { LiveTranscriptPanels } from '@/app/_components/live-transcript-panels'
import { ReplySuggestions } from '@/app/_components/reply-suggestions'
import { VoiceOrb } from '@/app/_components/voice-orb'
import { Waveform } from '@/app/_components/waveform'
import { Brand } from '@/app/_components/brand'
import { LearningPathTrail } from '@/app/_components/learning-path-trail'
import { Button } from '@/app/_components/ui/button'
import { cn } from '@/lib/utils'
import { getLearningSelectionLabel, getProfileLearningSelection } from '@/lib/learning/paths'
import { saveLearningSession } from '@/lib/learning/persistence'

export const SessionStudio = ({
  scenario: configuredScenario,
  conversation,
  profile,
  roles,
  onComplete,
  onExit,
  onHome,
}: {
  scenario: Scenario
  conversation?: ConversationOutline
  profile: Profile
  roles: Role[]
  onComplete: (session: SessionRecord) => void
  onExit: () => void
  onHome: () => void
}) => {
  const voice = useVoiceSession({
    scenario: configuredScenario,
    roleId: profile.roleId,
    level: profile.level,
  })
  const scenario = voice.scenario ?? configuredScenario
  const userSpeaking = useSpeakingActivity(
    voice.userLevel,
    voice.state === 'listening' && !voice.isMuted,
  )
  const [ending, setEnding] = useState(false)
  const finishingRef = useRef(false)
  const finishDestinationRef = useRef<'review' | 'home'>('review')
  const corrections = useLiveImprovements({
    sessionId: voice.sessionIdentity?.id ?? null,
    scenario,
    roleId: profile.roleId,
    level: profile.level,
    messages: voice.messages,
    pendingMessage: voice.pendingMessage,
    coachBusy: voice.state === 'thinking' || voice.isGeneratingCoach,
  })
  const replySuggestions = useReplySuggestions({
    sessionId: voice.sessionIdentity?.id ?? null,
    scenario,
    roleId: profile.roleId,
    level: profile.level,
    messages: voice.messages,
    enabled: !ending,
    busy:
      !['listening', 'paused'].includes(voice.state) ||
      userSpeaking ||
      !!voice.pendingMessage ||
      (!!corrections.pending && corrections.pending.status !== 'error'),
  })
  const snapshot = useMemo<SessionRecord | null>(() => {
    if (!voice.sessionIdentity || (!voice.messages.length && !voice.pendingMessage)) return null
    const partial =
      corrections.pending?.status === 'streaming' && corrections.pending.text.trim()
        ? {
            messageId: corrections.pending.messageId,
            original: corrections.pending.original,
            improved: corrections.pending.text,
            updatedAt: new Date().toISOString(),
            isFinal: false,
          }
        : null
    return {
      ...voice.sessionIdentity,
      scenarioId: scenario.id,
      scenario,
      conversation,
      roleId: profile.roleId,
      level: profile.level,
      durationSeconds: Math.round(voice.elapsedSeconds),
      messages: voice.messages,
      improvements: partial
        ? [
            ...corrections.improvements.filter((item) => item.messageId !== partial.messageId),
            partial,
          ]
        : corrections.improvements,
      ...(voice.pendingMessage
        ? { pendingTranscript: { ...voice.pendingMessage, role: 'user' as const } }
        : {}),
      status: 'in-progress',
      updatedAt: new Date().toISOString(),
    }
  }, [
    voice.sessionIdentity,
    voice.messages,
    voice.pendingMessage,
    voice.elapsedSeconds,
    corrections.improvements,
    corrections.pending,
    scenario,
    conversation,
    profile.roleId,
    profile.level,
  ])
  const autosave = useSessionAutosave(snapshot)
  const [stopError, setStopError] = useState<string | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => void voice.start(), 0)
    return () => clearTimeout(timer)
  }, [voice.start])
  const finish = async (destination = finishDestinationRef.current) => {
    if (finishingRef.current) return
    finishDestinationRef.current = destination
    finishingRef.current = true
    setEnding(true)
    try {
      const result = await voice.stop()
      if (result.transcriptionError) {
        setStopError(result.transcriptionError)
        setEnding(false)
        return
      }
      setStopError(null)
      if (!result.messages.some((message) => message.role === 'user')) {
        if (destination === 'home') onHome()
        else onExit()
        return
      }
      const record: SessionRecord = {
        id: result.id,
        scenarioId: scenario.id,
        scenario: result.scenario,
        conversation,
        roleId: profile.roleId,
        level: profile.level,
        startedAt: result.startedAt,
        durationSeconds: Math.round(result.elapsedSeconds),
        messages: result.messages.filter((message) => message.content.trim()),
        improvements: corrections.improvements,
        status: 'in-progress',
        updatedAt: new Date().toISOString(),
      }
      // Save authoritative recognition before waiting for optional wording improvements.
      await autosave.flush(record)
      const improvements = await corrections.finish(record.messages)
      const completed: SessionRecord = {
        ...record,
        improvements,
        status: 'completed',
        updatedAt: new Date().toISOString(),
      }
      let saved = await autosave.flush(completed)
      if (!saved && destination === 'home') {
        // A sync outage must not block Home once the full turn is durable on this device.
        const local = await saveLearningSession(completed, { sync: false }).catch(() => null)
        saved = local?.syncStatus === 'local'
      }
      if (!saved) {
        setStopError(
          'Your conversation is still open. Automatic saving failed. Try again to save both transcripts before leaving.',
        )
        return
      }
      if (destination === 'home') onHome()
      else onComplete(completed)
    } finally {
      finishingRef.current = false
      setEnding(false)
    }
  }
  const status =
    voice.state === 'listening'
      ? 'Your turn. Take your time.'
      : voice.state === 'thinking'
        ? 'Thinking it through…'
        : voice.state === 'speaking'
          ? `${scenario.persona.name} is speaking`
          : voice.state === 'paused'
            ? 'Take a breath. We’ll be here.'
            : voice.state === 'error'
              ? 'Let’s get you connected'
              : 'Getting your conversation ready…'
  const hasStarted = voice.state !== 'idle' && voice.state !== 'error'
  return (
    <div className="session-studio page-enter">
      <header className="studio-header">
        <Brand onHome={() => finish('home')} />
        <div className="studio-title">
          <span className="live-tag">
            <i />
            ROLEPLAY AI
          </span>
          <span>{scenario.title}</span>
        </div>
        <button className="studio-back" onClick={() => void finish('review')}>
          <X size={19} />
          <span>Leave session</span>
        </button>
      </header>
      <div className="studio-layout">
        <main className="conversation-space">
          <div className="studio-context">
            <button onClick={() => void finish('review')}>
              <ArrowLeft size={16} />
              Practice studio
            </button>
            <span>
              <Clock3 size={14} />
              {String(Math.floor(voice.elapsedSeconds / 60)).padStart(2, '0')}:
              {String(voice.elapsedSeconds % 60).padStart(2, '0')}
              <span className="timer-separator">/</span>
              {scenario.minutes}:00 target
            </span>
          </div>
          <div className="studio-learning-path">
            <LearningPathTrail
              selection={
                scenario.learningSelection ??
                getProfileLearningSelection({ roleId: profile.roleId })
              }
              label="Practice learning path"
            />
          </div>
          <div className="studio-session-info">
            <div className="eyebrow">
              <span />
              {scenario.learningSelection
                ? getLearningSelectionLabel(scenario.learningSelection)
                : conversation
                  ? 'YOUR FREE CONVERSATION'
                  : roles.find((role) => role.id === profile.roleId)?.name.toUpperCase()}
            </div>
            <h1>{scenario.title}</h1>
            <p>
              You’re speaking with {scenario.persona.name},{' '}
              {scenario.persona.role
                .toLowerCase()
                .replace(/^your /, 'your ')
                .replace(/^a /, 'a ')}
              .
            </p>
          </div>
          <ReplySuggestions
            suggestions={replySuggestions}
            canPlay={!ending && ['paused', 'idle', 'error'].includes(voice.state)}
          />
          <div className="studio-voices">
            <div
              className={cn(
                'voice-participant coach-participant',
                voice.state === 'speaking' && 'participant-active',
              )}
            >
              <VoiceOrb active={voice.state === 'speaking'} level={voice.coachLevel} />
              <div className="participant-name">
                {scenario.persona.name}
                <span>AI COACH</span>
              </div>
              <Waveform active={voice.state === 'speaking'} level={voice.coachLevel} />
              <span className="participant-state">
                {voice.state === 'speaking'
                  ? 'Speaking'
                  : voice.state === 'thinking'
                    ? 'Thinking'
                    : voice.state === 'paused'
                      ? 'Paused'
                      : voice.state === 'listening'
                        ? 'Listening to you'
                        : voice.state === 'error'
                          ? 'Connection needs attention'
                          : 'Getting ready'}
              </span>
            </div>
            <div className="voice-connection">
              <i />
              <span />
              <i />
            </div>
            <div
              className={cn(
                'voice-participant user-participant',
                userSpeaking && 'participant-active',
              )}
            >
              <VoiceOrb variant="user" small active={userSpeaking} level={voice.userLevel} />
              <div className="participant-name">
                {profile.name || 'You'}
                <span>YOUR VOICE</span>
              </div>
              <Waveform
                active={voice.state === 'listening' && !voice.isMuted}
                level={voice.userLevel}
                variant="user"
              />
              <span className="participant-state">
                {voice.isMuted
                  ? 'Microphone muted'
                  : voice.state === 'listening'
                    ? userSpeaking
                      ? 'Speaking · you’re heard'
                      : 'Go ahead, you’re heard'
                    : 'A moment to listen'}
              </span>
            </div>
          </div>
          <div className="conversation-status" aria-live="polite">
            {voice.state === 'thinking' || voice.state === 'idle' ? (
              <LoaderCircle size={16} className="spin" />
            ) : voice.state === 'listening' ? (
              <span className="status-dot" />
            ) : voice.state === 'speaking' ? (
              <Volume2 size={16} />
            ) : null}
            <span>{status}</span>
          </div>
          {(voice.error || stopError) && (
            <div className="voice-error" role="alert">
              <p>{voice.error || stopError}</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  if (stopError) void finish()
                  else void voice.retry()
                }}
              >
                <RotateCcw size={14} />
                Try again
              </Button>
            </div>
          )}
          <div className="session-controls">
            <button
              className={cn('round-control', voice.isMuted && 'muted')}
              onClick={voice.toggleMute}
              disabled={!hasStarted}
              aria-label={voice.isMuted ? 'Unmute microphone' : 'Mute microphone'}
            >
              {voice.isMuted ? <MicOff size={20} /> : <Mic size={20} />}
            </button>
            <button
              className="round-control"
              onClick={() => (voice.state === 'paused' ? void voice.resume() : voice.pause())}
              disabled={!hasStarted}
              aria-label={voice.state === 'paused' ? 'Resume conversation' : 'Pause conversation'}
            >
              {voice.state === 'paused' ? <Play size={19} /> : <Pause size={19} />}
            </button>
            <Button variant="destructive" onClick={() => void finish('review')} disabled={ending}>
              <Square size={13} fill="currentColor" />
              {ending ? 'Finishing…' : 'End & reflect'}
            </Button>
          </div>
          <div className="turn-action">
            {voice.state === 'listening' && (
              <button onClick={() => void voice.finishTurn()}>
                <CornerDownLeft size={13} />
                Done speaking? Send your turn
              </button>
            )}
            {voice.state === 'speaking' && (
              <button onClick={voice.interrupt}>
                <Mic size={13} />
                Jump into the conversation
              </button>
            )}
          </div>
          <div className="studio-privacy">
            <ShieldCheck size={13} />
            Local audio. Space to be yourself.
          </div>
        </main>
        <LiveTranscriptPanels
          messages={voice.messages}
          interimMessage={voice.pendingMessage}
          improvements={corrections.improvements}
          pendingImprovement={corrections.pending}
          failedImprovements={corrections.failures}
          canPlayImprovements={!ending && ['paused', 'idle', 'error'].includes(voice.state)}
          onRetryImprovement={corrections.retry}
          coachName={scenario.persona.name}
          userName={profile.name || 'You'}
          objectives={scenario.objectives}
          saveState={autosave}
          onRetrySave={autosave.retry}
        />
      </div>
    </div>
  )
}
