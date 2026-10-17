'use client'

import { useId, useState } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import {
  defaultSpeechProvider,
  resolveSpeechProviderStatus,
  type SpeechProvider,
  type SpeechServiceStatus,
} from '@/lib/audio/speech-provider'

const choices: Array<{
  provider: SpeechProvider
  label: string
  name: string
  description: string
  setup?: string
}> = [
  {
    provider: 'macos',
    label: 'Fast',
    name: 'macOS voices',
    description: 'Quick replies using Apple’s built-in voices. Local, proprietary speech.',
  },
  {
    provider: 'kokoro',
    label: 'Balanced',
    name: 'Kokoro 82M',
    description: 'A smaller open-source model with natural preset voices. No voice cloning.',
    setup: 'npm run speech:setup:kokoro',
  },
  {
    provider: 'chatterbox',
    label: 'Expressive',
    name: 'Chatterbox',
    description: 'Open-source multilingual speech and voice cloning. Longer response times.',
    setup: 'npm run speech:setup:chatterbox',
  },
]

export const SpeechProviderPicker = ({
  speech,
  value,
  onChange,
}: {
  speech?: SpeechServiceStatus
  value?: SpeechProvider
  onChange: (provider: SpeechProvider) => Promise<void>
}) => {
  const id = useId()
  const [pending, setPending] = useState<SpeechProvider | null>(null)
  const [error, setError] = useState<string | null>(null)
  const selected = pending ?? value ?? defaultSpeechProvider
  const saveChoice = async (provider: SpeechProvider) => {
    if (pending || value === provider) return
    setPending(provider)
    setError(null)
    try {
      await onChange(provider)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Your voice choice could not be saved.')
    } finally {
      setPending(null)
    }
  }

  return (
    <fieldset className="speech-provider-picker" disabled={pending !== null}>
      <legend>Choose your voice engine</legend>
      <p className="speech-provider-intro" id={`${id}-description`}>
        Applies to conversations and every Play button. Your choice saves with your learning
        profile.
        {!value && ' Balanced (Kokoro) is the default until you choose another engine.'}
      </p>
      <div className="speech-provider-options" aria-describedby={`${id}-description`}>
        {choices.map((choice) => {
          const status = resolveSpeechProviderStatus(speech, choice.provider)
          const ready = status?.synthesis === true
          const checked = selected === choice.provider
          const personas =
            status?.personas?.filter((persona) => persona.languages.includes('en')) ?? []
          return (
            <label
              key={choice.provider}
              className={`speech-provider-option${checked ? ' is-selected' : ''}${ready ? '' : ' is-unavailable'}`}
            >
              <input
                type="radio"
                name={`${id}-voice-engine`}
                value={choice.provider}
                checked={checked}
                disabled={!ready}
                onChange={() => void saveChoice(choice.provider)}
                aria-label={`${choice.label} · ${choice.name}`}
                aria-describedby={`${id}-${choice.provider}`}
              />
              <span className="speech-provider-copy">
                <span className="speech-provider-title">
                  <strong>{choice.label}</strong>
                  <span>{choice.name}</span>
                  {pending === choice.provider ? (
                    <LoaderCircle className="spin" size={14} aria-label="Saving voice choice" />
                  ) : checked ? (
                    <Check size={14} aria-hidden="true" />
                  ) : null}
                </span>
                <span id={`${id}-${choice.provider}`} className="speech-provider-description">
                  {choice.description}
                </span>
                {ready && personas.length > 0 && (
                  <span className="speech-provider-description">
                    Conversation personas: {personas.map((persona) => persona.name).join(', ')}.
                  </span>
                )}
                {!ready && (
                  <span className="speech-provider-unavailable">
                    {status?.detail ?? 'This voice engine is not connected.'}
                    {choice.setup && <code>{choice.setup}</code>}
                  </span>
                )}
              </span>
            </label>
          )
        })}
      </div>
      <p className="speech-provider-note">
        New conversations choose personas at random and keep their names and voices throughout.
        Changing engines stops current audio. No restart needed.
      </p>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </fieldset>
  )
}
