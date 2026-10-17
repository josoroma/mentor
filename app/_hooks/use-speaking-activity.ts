'use client'

import { useEffect, useState } from 'react'

// Match the microphone's speech threshold and bridge short gaps between syllables.
export const useSpeakingActivity = (level: number, enabled: boolean) => {
  const [recentSpeech, setRecentSpeech] = useState(false)
  const audible = enabled && level >= 0.012
  useEffect(() => {
    if (audible) {
      setRecentSpeech(true)
      return
    }
    if (!enabled) {
      setRecentSpeech(false)
      return
    }
    const timer = setTimeout(() => setRecentSpeech(false), 220)
    return () => clearTimeout(timer)
  }, [audible, enabled])
  return enabled && (audible || recentSpeech)
}
