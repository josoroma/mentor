import { Check, CircleHelp, Database, Mic, RefreshCw, ShieldCheck, Volume2 } from 'lucide-react'
import { Modal } from '@/app/_components/ui/modal'
import { Button } from '@/app/_components/ui/button'
import { SpeechProviderPicker } from '@/app/_components/speech-provider-picker'
import { LearningFocusSettings } from '@/app/_components/learning-focus-settings'
import { ModelUsageOverview } from '@/app/_components/model-usage-overview'
import type { LearningSelection } from '@/lib/learning/paths'
import type { SpeechPersona } from '@/lib/audio/personas'
import {
  resolveSpeechProviderStatus,
  type SpeechProvider,
  type SpeechProviderStatus,
} from '@/lib/audio/speech-provider'

export interface ServiceHealth {
  coach: {
    available: boolean
    displayName?: string
    runtime?: string
    degraded?: boolean
    detail?: string
    [key: string]: unknown
  }
  speech: {
    available: boolean
    recognition?: boolean
    synthesis?: boolean
    model?: string
    provider?: string
    synthesisModel?: string
    device?: string
    languages?: string[]
    voices?: { coach?: string; partner?: string }
    conversationSynthesis?: boolean
    personas?: SpeechPersona[]
    detail?: string
    providers?: Partial<Record<SpeechProvider, SpeechProviderStatus>>
    [key: string]: unknown
  }
  storage: { configured: boolean; local?: boolean }
}

export const SettingsDialog = ({
  open,
  onOpenChange,
  health,
  checking,
  onCheck,
  help = false,
  speechProvider,
  onSpeechProviderChange,
  learningSelection,
  onLearningSelectionChange,
  preferredRoleId,
  learningReady,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  health: ServiceHealth | null
  checking: boolean
  onCheck: () => void
  help?: boolean
  speechProvider?: SpeechProvider
  onSpeechProviderChange: (provider: SpeechProvider) => Promise<void>
  learningSelection: LearningSelection
  onLearningSelectionChange: (selection: LearningSelection) => Promise<void>
  preferredRoleId: string
  learningReady: boolean
}) => {
  const speech = health?.speech
  const synthesis = resolveSpeechProviderStatus(speech, speechProvider)
  const recognitionReady = speech?.recognition ?? speech?.available
  const synthesisReady = synthesis?.synthesis === true
  const providerName =
    synthesis?.provider === 'chatterbox'
      ? 'Chatterbox'
      : synthesis?.provider === 'macos'
        ? 'macOS speech'
        : synthesis?.provider === 'kokoro'
          ? 'Kokoro 82M'
          : (speechProvider ?? 'Local speech')
  const voiceDetails = [
    synthesis?.provider ? providerName : null,
    synthesis?.languages?.length
      ? `${synthesis.languages.length} ${synthesis.languages.length === 1 ? 'language' : 'languages'}`
      : null,
    synthesis?.voices?.coach ? `Coach: ${synthesis.voices.coach}` : null,
    synthesis?.voices?.partner ? `Partner: ${synthesis.voices.partner}` : null,
  ].filter(Boolean)

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={help ? 'Your first conversation starts here' : 'Your private practice studio'}
      description={
        help
          ? 'Choose a scenario, meet your colleague, and speak freely.'
          : 'Local intelligence. Your voice stays on your machine.'
      }
    >
      <div className="settings-body">
        {help && (
          <div className="help-steps">
            <p>
              <span>01</span>
              <strong>Pick a real situation.</strong> Choose your role and a conversation you want
              to feel more confident having.
            </p>
            <p>
              <span>02</span>
              <strong>Just start talking.</strong> Allow microphone access. Your coach listens,
              responds, and asks follow-up questions.
            </p>
            <p>
              <span>03</span>
              <strong>Take something with you.</strong> End your session to get focused feedback and
              clearer ways to express your ideas.
            </p>
          </div>
        )}
        {!help && (
          <>
            <LearningFocusSettings
              selection={learningSelection}
              preferredRoleId={preferredRoleId}
              onSave={onLearningSelectionChange}
              ready={learningReady}
            />
            <SpeechProviderPicker
              speech={speech}
              value={speechProvider}
              onChange={onSpeechProviderChange}
            />
          </>
        )}
        <ModelUsageOverview coach={health?.coach} checking={checking} />
        <div className="service-row">
          <span className="service-icon">
            <Mic size={20} />
          </span>
          <div className="min-w-0 break-words">
            <strong>Speech recognition</strong>
            <p>{speech?.model ?? 'Model not reported'} · Voice-to-text</p>
            <p>Live transcripts, spoken topics, and voice questions in Explore.</p>
          </div>
          <span className={recognitionReady ? 'service-ready' : 'service-offline'}>
            {recognitionReady ? (
              <>
                <Check size={12} />
                Ready
              </>
            ) : (
              'Not connected'
            )}
          </span>
        </div>
        <div className="service-row">
          <span className="service-icon">
            <Volume2 size={20} />
          </span>
          <div className="min-w-0 break-words">
            <strong>Voice playback</strong>
            <p>
              {synthesis?.synthesisModel ?? providerName} ·{' '}
              {synthesis?.device?.toUpperCase() ?? 'On-device synthesis'}
            </p>
            <p>AI partners, spoken prompts, and every improved-English Play button.</p>
          </div>
          <span className={synthesisReady ? 'service-ready' : 'service-offline'}>
            {synthesisReady ? 'Ready' : 'Not connected'}
          </span>
        </div>
        {voiceDetails.length > 0 && <p className="service-detail">{voiceDetails.join(' · ')}</p>}
        {synthesisReady && synthesis?.conversationSynthesis === false && (
          <p className="service-detail" role="status">
            The partner voice is unavailable. Two-voice conversations need both local voices.
          </p>
        )}
        {!synthesisReady && synthesis?.detail && (
          <p className="service-detail" role="status">
            {synthesis.detail}
          </p>
        )}
        <div className="service-row">
          <span className="service-icon">
            <Database size={20} />
          </span>
          <div>
            <strong>Learning history</strong>
            <p>
              {health?.storage.local
                ? 'Supabase · Automatic saves to your local database'
                : health?.storage.configured
                  ? 'Supabase available · Enable sync in your profile'
                  : 'On-device database · Automatic session saves'}
            </p>
          </div>
          <span className="service-neutral">
            {health?.storage.configured ? 'Available' : 'Local'}
          </span>
        </div>
        {(!health?.coach.available || !recognitionReady || !synthesisReady) && (
          <div className="setup-instructions">
            <CircleHelp size={17} />
            <div>
              <strong>Start your local voice services</strong>
              <p>From the mentor folder, run each command in its own terminal.</p>
              <code>npm run coach:start</code>
              <code>npm run speech:start</code>
              <p>
                First-time speech setup: <code className="inline-code">npm run speech:setup</code>
              </p>
            </div>
          </div>
        )}
        <div className="settings-privacy">
          <ShieldCheck size={17} />
          <p>
            Audio is processed on this Mac and discarded after transcription. Original and improved
            transcripts save automatically to your on-device database
            {health?.storage.local ? ' and local Supabase instance' : ''}. Hosted Supabase sync
            requires enabling it in your learning profile.
          </p>
        </div>
        <Button variant="secondary" onClick={onCheck} disabled={checking}>
          <RefreshCw size={15} className={checking ? 'spin' : ''} />
          {checking ? 'Checking services…' : 'Check connections'}
        </Button>
      </div>
    </Modal>
  )
}
