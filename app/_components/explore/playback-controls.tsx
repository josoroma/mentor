'use client'

import { useEffect, useRef } from 'react'
import { Pause, Play, RotateCcw, SkipBack, SkipForward } from 'lucide-react'
import { Button } from '@/app/_components/ui/button'
import styles from '@/app/_components/explore/artifact-viewer.module.css'

export const usePlayback = ({
  playing,
  speed,
  onAdvance,
}: {
  playing: boolean
  speed: number
  onAdvance: () => void
}) => {
  const callback = useRef(onAdvance)
  callback.current = onAdvance
  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      if (!document.hidden) callback.current()
    }, 1000 / speed)
    return () => window.clearInterval(timer)
  }, [playing, speed])
}

export const PlaybackControls = ({
  step,
  total,
  playing,
  speed,
  onStep,
  onPlaying,
  onSpeed,
  onReset,
}: {
  step: number
  total: number
  playing: boolean
  speed: number
  onStep: (step: number) => void
  onPlaying: (playing: boolean) => void
  onSpeed: (speed: number) => void
  onReset: () => void
}) => (
  <div className={styles.playback}>
    <div className={styles.controls}>
      <Button
        variant="secondary"
        size="icon"
        aria-label="Previous step"
        disabled={step <= 0}
        onClick={() => {
          onPlaying(false)
          onStep(step - 1)
        }}
      >
        <SkipBack size={17} />
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onPlaying(!playing)}
        disabled={step >= total && !playing}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
        {playing ? 'Pause' : 'Play'}
      </Button>
      <Button
        variant="secondary"
        size="icon"
        aria-label="Next step"
        disabled={step >= total}
        onClick={() => {
          onPlaying(false)
          onStep(step + 1)
        }}
      >
        <SkipForward size={17} />
      </Button>
      <Button variant="ghost" size="icon" aria-label="Reset playback" onClick={onReset}>
        <RotateCcw size={17} />
      </Button>
      <label className={styles.inlineLabel}>
        Speed
        <select
          aria-label="Playback speed"
          value={speed}
          onChange={(event) => onSpeed(Number(event.target.value))}
        >
          <option value={0.5}>0.5×</option>
          <option value={1}>1×</option>
          <option value={2}>2×</option>
        </select>
      </label>
      <span className={styles.meta}>
        Step {step} / {total}
      </span>
    </div>
    <label className={styles.timeline}>
      Seek through steps
      <input
        type="range"
        min={0}
        max={total}
        value={step}
        onChange={(event) => {
          onPlaying(false)
          onStep(Number(event.target.value))
        }}
      />
    </label>
  </div>
)
