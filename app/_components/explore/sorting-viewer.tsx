'use client'

import { useMemo, useState } from 'react'
import { createBubbleSortFrames } from '@/lib/explore/models'
import { readNumber, type RendererProps } from '@/app/_components/explore/_types'
import { PlaybackControls, usePlayback } from '@/app/_components/explore/playback-controls'
import styles from '@/app/_components/explore/artifact-viewer.module.css'

const defaultValues = [7, 3, 8, 2, 6, 4]

export const SortingViewer = ({ content, state, update }: RendererProps) => {
  const source = content.config.values.length > 1 ? content.config.values : defaultValues
  const frames = useMemo(() => createBubbleSortFrames(source), [source])
  const step = Math.round(readNumber(state, 'sortStep', 0, 0, frames.length - 1))
  const speed = readNumber(state, 'sortSpeed', 1, 0.5, 2)
  const [playing, setPlaying] = useState(false)
  const frame = frames[step]
  const max = Math.max(...source)
  usePlayback({
    playing,
    speed,
    onAdvance: () => {
      if (step >= frames.length - 1) {
        setPlaying(false)
        return
      }
      update({ sortStep: step + 1 })
      if (step + 1 >= frames.length - 1) setPlaying(false)
    },
  })
  return (
    <section className={styles.interactive} aria-label="Bubble sort explorer">
      <div className={styles.row}>
        <h3>Bubble sort · neighboring comparisons</h3>
        <span className={styles.meta}>
          {frame.comparisons} comparisons · {frame.swaps} swaps
        </span>
      </div>
      <div className={styles.scene}>
        <svg
          viewBox="0 0 640 280"
          role="img"
          aria-label={`Values: ${frame.items.map((item) => item.value).join(', ')}. ${frame.caption}`}
        >
          {frame.items.map((item, index) => {
            const barWidth = 560 / frame.items.length
            const height = (item.value / max) * 195
            return (
              <g
                key={item.id}
                className={styles.disk}
                style={{ transform: `translate(${40 + index * barWidth}px, 240px)` }}
              >
                <rect
                  x="3"
                  y={-height}
                  width={barWidth - 6}
                  height={height}
                  rx="4"
                  fill={
                    frame.active.includes(index)
                      ? frame.action === 'swap'
                        ? '#a78bfa'
                        : '#60a5fa'
                      : index >= frame.sortedFrom
                        ? '#2563eb'
                        : '#64748b'
                  }
                />
                <text
                  x={barWidth / 2}
                  y={-height - 9}
                  textAnchor="middle"
                  fill="currentColor"
                  fontSize="14"
                >
                  {item.value}
                </text>
                <text
                  x={barWidth / 2}
                  y="20"
                  textAnchor="middle"
                  fill="var(--muted-foreground)"
                  fontSize="11"
                >
                  {index}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <p className={styles.caption} aria-live="polite">
        {frame.caption}
      </p>
      <PlaybackControls
        step={step}
        total={frames.length - 1}
        playing={playing}
        speed={speed}
        onStep={(sortStep) => update({ sortStep })}
        onPlaying={setPlaying}
        onSpeed={(sortSpeed) => update({ sortSpeed })}
        onReset={() => {
          setPlaying(false)
          update({ sortStep: 0 })
        }}
      />
      <pre>{`for end from n - 1 down to 1:
  changed = false
  for i from 0 to end - 1:
    if values[i] > values[i + 1]:
      swap(values[i], values[i + 1])
      changed = true
  if not changed: break`}</pre>
      <p className={styles.note}>
        Blue highlights a comparison; violet marks a swap. This stable implementation takes O(n²)
        time in the worst case, O(n) on an already sorted input, and O(1) auxiliary sorting space.
        Playback snapshots use additional storage.
      </p>
    </section>
  )
}
