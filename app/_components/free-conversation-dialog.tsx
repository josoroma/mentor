'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import {
  ArrowRight,
  Check,
  Clock3,
  LoaderCircle,
  Mic,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Volume2,
} from 'lucide-react'
import type { Profile, Role } from '@/app/_types'
import { getLearningSelectionLabel } from '@/lib/learning/paths'
import {
  ConversationPlanRequestSchema,
  ConversationPlanSchema,
  type ConversationPlan,
} from '@/lib/ai/conversation-plan'
import { useVoiceConcierge } from '@/app/_hooks/use-voice-concierge'
import { useSpeakingActivity } from '@/app/_hooks/use-speaking-activity'
import { Modal } from '@/app/_components/ui/modal'
import { Button } from '@/app/_components/ui/button'
import { VoiceOrb } from '@/app/_components/voice-orb'
import { ImprovedSpeechButton } from '@/app/_components/improved-speech-button'
import playbackStyles from '@/app/_components/improvement-playback.module.css'
import styles from '@/app/_components/free-conversation.module.css'

const topicPrompt =
  'What would you like to talk about? Tell me a topic or something you’d like to practice.'

export const FreeConversationDialog = ({
  profile,
  roles,
  initialTopic,
  onClose,
  onStart,
}: {
  profile: Profile
  roles: Role[]
  initialTopic?: string
  onClose: () => void
  onStart: (plan: ConversationPlan) => void
}) => {
  const [plan, setPlan] = useState<ConversationPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [heardTopic, setHeardTopic] = useState(initialTopic ?? '')
  const [minutes, setMinutes] = useState(10)
  const [promptRequest, setPromptRequest] = useState(0)
  const controllerRef = useRef<AbortController | null>(null)
  const planHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const focusLabel = profile.learningSelection
    ? getLearningSelectionLabel(profile.learningSelection)
    : (roles.find((role) => role.id === profile.roleId)?.name ?? 'Software engineer')

  const createPlan = useCallback(
    async (topic: string) => {
      if (controllerRef.current) return
      setHeardTopic(topic)
      const request = ConversationPlanRequestSchema.safeParse({
        topic,
        minutes,
        roleId: profile.roleId,
        level: profile.level,
        selection: profile.learningSelection,
      })
      if (!request.success) {
        setError(
          topic.trim().length > 1_000
            ? 'Try describing your topic in one or two sentences.'
            : 'Say a little more about what you’d like to talk about.',
        )
        return
      }
      const controller = new AbortController()
      controllerRef.current = controller
      setPlanning(true)
      setError(null)
      try {
        const response = await fetch('/api/conversation-plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.data),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
        })
        const data: unknown = await response.json()
        if (!response.ok) {
          const failure = z.object({ error: z.string() }).safeParse(data)
          throw new Error(
            failure.success
              ? failure.data.error
              : 'Your conversation could not be planned. Please try again.',
          )
        }
        const nextPlan = ConversationPlanSchema.parse(data)
        if (!controller.signal.aborted) setPlan(nextPlan)
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : 'Your local coach could not create a plan. Please try again.',
          )
      } finally {
        if (!controller.signal.aborted) setPlanning(false)
        if (controllerRef.current === controller) controllerRef.current = null
      }
    },
    [minutes, profile.level, profile.roleId, profile.learningSelection],
  )
  const createPlanRef = useRef(createPlan)
  createPlanRef.current = createPlan
  const voice = useVoiceConcierge({
    enabled: !planning && !plan,
    onTranscript: (text) => void createPlan(text),
  })
  const { begin, cancel } = voice
  const listening = voice.state === 'listening'
  const speaking = voice.state === 'speaking'
  const userSpeaking = useSpeakingActivity(voice.userLevel, !planning && (listening || speaking))
  const busy = planning || voice.state === 'transcribing'
  const transcript = voice.interimTranscript || heardTopic
  const status = planning
    ? 'Shaping your conversation'
    : voice.state === 'preparing'
      ? 'Your coach is getting ready'
      : speaking
        ? 'Alex is asking about your topic'
        : listening
          ? 'Your turn. Tell me what’s on your mind.'
          : voice.state === 'transcribing'
            ? 'Listening back to your topic'
            : voice.state === 'needs-gesture'
              ? 'Enable voice to meet your coach'
              : voice.state === 'paused'
                ? 'Voice is paused'
                : voice.state === 'error'
                  ? 'Let’s reconnect your voice'
                  : 'Your coach is ready'

  useEffect(() => {
    const timer = setTimeout(() => {
      if (promptRequest === 0 && initialTopic?.trim()) {
        void createPlanRef.current(initialTopic)
      } else {
        void begin(topicPrompt)
      }
    }, 0)
    return () => clearTimeout(timer)
  }, [begin, initialTopic, promptRequest])

  useEffect(
    () => () => {
      controllerRef.current?.abort()
      cancel()
    },
    [cancel],
  )

  useEffect(() => {
    if (!plan) return
    const frame = requestAnimationFrame(() => {
      planHeadingRef.current?.closest('[role="dialog"]')?.scrollTo({ top: 0 })
      planHeadingRef.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [plan])

  const sayAnotherTopic = () => {
    controllerRef.current?.abort()
    controllerRef.current = null
    cancel()
    setPlan(null)
    setPlanning(false)
    setError(null)
    setHeardTopic('')
    setPromptRequest((request) => request + 1)
  }

  const close = () => {
    controllerRef.current?.abort()
    cancel()
    onClose()
  }

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
      title="A conversation that’s yours"
      description="Bring your curiosity. Tell your coach what you’d like to talk about."
      className={styles.modal}
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        document.getElementById('free-conversation-trigger')?.focus()
      }}
    >
      <div className={styles.personalization}>
        <span>
          <Sparkles size={13} /> {profile.level} English
        </span>
        <span>{focusLabel}</span>
        {plan && (
          <span>
            <Clock3 size={13} /> {plan.scenario.minutes} minutes
          </span>
        )}
      </div>
      {plan ? (
        <div className={styles.plan}>
          <div className={styles.refinedTopic}>
            <span className={styles.eyebrow}>
              <Check size={13} /> YOUR TOPIC, A LITTLE CLEARER
            </span>
            <h3 ref={planHeadingRef} tabIndex={-1}>
              {plan.improvedTopic}
            </h3>
            {plan.improvedTopic.trim() && (
              <div className={playbackStyles.control}>
                <ImprovedSpeechButton text={plan.improvedTopic} label="improved topic" />
              </div>
            )}
            <p>
              <span>You said:</span> “{plan.originalTopic}”
            </p>
          </div>
          <div className={styles.planIntro}>
            <h3>Here’s where we’ll go</h3>
            <p>A starting point, with room to follow your curiosity.</p>
          </div>
          <ol className={styles.stages}>
            {plan.stages.map((stage, index) => (
              <li key={`${index}-${stage.title}`}>
                <span className={styles.step}>{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <h4>{stage.title}</h4>
                  <p>{stage.focus}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className={styles.phrases}>
            <h4>A few phrases to try</h4>
            <div>
              {plan.usefulPhrases.map((phrase, index) => (
                <span key={index}>{phrase}</span>
              ))}
            </div>
          </div>
          <div className={styles.actions}>
            <Button variant="ghost" onClick={sayAnotherTopic}>
              <RotateCcw size={15} /> Say another topic
            </Button>
            <Button
              onClick={() => {
                cancel()
                onStart(plan)
              }}
            >
              <Mic size={16} /> Start conversation <ArrowRight size={16} />
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.voiceSetup}>
          <div className={styles.voiceVisuals} aria-hidden="true">
            <div className={styles.voiceParticipant}>
              <VoiceOrb small active={speaking && !planning} level={voice.coachLevel} />
              <span>
                Alex <span>YOUR COACH</span>
              </span>
            </div>
            <div className={styles.voiceLink} />
            <div className={styles.voiceParticipant}>
              <VoiceOrb small variant="user" active={userSpeaking} level={voice.userLevel} />
              <span>
                You <span>YOUR VOICE</span>
              </span>
            </div>
          </div>
          <p className={styles.voiceStatus} role="status">
            {busy || voice.state === 'preparing' ? (
              <LoaderCircle size={14} className="spin" />
            ) : speaking ? (
              <Volume2 size={14} />
            ) : (
              <Mic size={14} />
            )}
            {status}
          </p>
          {(!initialTopic?.trim() || promptRequest > 0) && (
            <div className={styles.spokenPrompt}>
              <span>Alex</span>
              <p>{topicPrompt}</p>
            </div>
          )}
          <div className={styles.heardTopic} aria-live="polite" aria-atomic="true">
            <span>{transcript ? 'You said' : 'Your topic'}</span>
            <p className={transcript ? undefined : styles.placeholder}>
              {transcript ||
                (listening
                  ? 'Go ahead. Say it in your own words.'
                  : 'Your words will appear here as you speak.')}
            </p>
          </div>
          {planning ? (
            <div className={styles.planning} role="status">
              <Sparkles size={16} />
              <p>Refining your topic and choosing questions for your English level…</p>
            </div>
          ) : (
            <div className={styles.voiceControls}>
              {voice.state === 'needs-gesture' ? (
                <Button onClick={() => void voice.enable()}>
                  <Volume2 size={16} /> Enable voice
                </Button>
              ) : voice.state === 'paused' ? (
                <Button onClick={() => void voice.listen()}>
                  <Play size={15} /> Resume listening
                </Button>
              ) : voice.state === 'error' ? (
                <Button onClick={sayAnotherTopic}>
                  <RotateCcw size={15} /> Try voice again
                </Button>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    disabled={busy || voice.state === 'preparing'}
                    onClick={() => {
                      if (listening) void voice.finishTurn()
                      else void voice.listen()
                    }}
                  >
                    {busy ? <LoaderCircle size={15} className="spin" /> : <Mic size={15} />}
                    {listening ? 'Done speaking' : busy ? 'Listening back…' : 'Tell my topic'}
                  </Button>
                  {(speaking || listening || voice.state === 'preparing') && (
                    <Button variant="ghost" onClick={voice.pause}>
                      <Pause size={15} /> Pause
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
          <p className={styles.voiceHint}>
            {voice.state === 'needs-gesture'
              ? 'Your browser needs a click to play audio and use your microphone.'
              : planning
                ? 'Your conversation plan will appear automatically.'
                : 'Speak naturally. When you finish, your coach will create the plan.'}
          </p>
          {(error || voice.error) && (
            <div className={styles.error} role="alert">
              <p>{error || voice.error}</p>
              {error && heardTopic && (
                <div className={styles.errorActions}>
                  <Button size="sm" variant="secondary" onClick={() => void createPlan(heardTopic)}>
                    <RotateCcw size={13} /> Retry this topic
                  </Button>
                  <Button size="sm" variant="ghost" onClick={sayAnotherTopic}>
                    <Mic size={13} /> Say another topic
                  </Button>
                </div>
              )}
            </div>
          )}
          <div className={styles.duration}>
            <label htmlFor="conversation-minutes">
              <Clock3 size={15} /> Time for a conversation
            </label>
            <select
              id="conversation-minutes"
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value))}
              disabled={busy}
            >
              {[5, 10, 15, 20, 30].map((duration) => (
                <option key={duration} value={duration}>
                  {duration} minutes
                </option>
              ))}
            </select>
          </div>
          {planning && (
            <Button variant="ghost" className={styles.changeTopic} onClick={sayAnotherTopic}>
              <Mic size={14} /> Say another topic
            </Button>
          )}
        </div>
      )}
      <p className={styles.privacy}>
        <ShieldCheck size={13} /> Local AI. Your plan and transcripts save automatically when you
        practice.
      </p>
    </Modal>
  )
}
