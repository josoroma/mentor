'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createTopicDictation, type TopicDictationState } from '@/lib/audio/topic-dictation'
import { stopCorrectionPlayback } from '@/lib/audio/correction-playback'

export const useTopicDictation = ({ onTranscript }: { onTranscript: (text: string) => void }) => {
  const [state, setState] = useState<TopicDictationState>('idle')
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const transcriptRef = useRef(onTranscript)
  const dictationRef = useRef<ReturnType<typeof createTopicDictation> | null>(null)
  transcriptRef.current = onTranscript

  useEffect(() => {
    const dictation = createTopicDictation({
      onState: setState,
      onLevel: setLevel,
      onError: setError,
      onTranscript: (text) => transcriptRef.current(text),
    })
    dictationRef.current = dictation
    return () => {
      dictationRef.current = null
      dictation.dispose()
    }
  }, [])

  const start = useCallback(async () => {
    stopCorrectionPlayback()
    await dictationRef.current?.start()
  }, [])
  const stop = useCallback(async () => {
    await dictationRef.current?.stop()
  }, [])
  const cancel = useCallback(() => dictationRef.current?.cancel(), [])

  return { state, level, error, start, stop, cancel }
}
