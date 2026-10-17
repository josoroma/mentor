'use client'

import { useMemo, useState } from 'react'
import { createHanoiFrames } from '@/lib/explore/models'
import { readNumber, type RendererProps } from '@/app/_components/explore/_types'
import { PlaybackControls, usePlayback } from '@/app/_components/explore/playback-controls'
import styles from '@/app/_components/explore/artifact-viewer.module.css'

const pseudocode = `hanoi(n, from, to, spare):
  if n == 0: return
  hanoi(n - 1, from, spare, to)
  move top disk from "from" to "to"
  hanoi(n - 1, spare, to, from)`

export const HanoiViewer = ({ content, state, update }: RendererProps) => {
  const size = Math.round(readNumber(state, 'hanoiSize', content.config.size, 3, 7))
  const frames = useMemo(() => createHanoiFrames(size), [size])
  const step = Math.round(readNumber(state, 'hanoiStep', 0, 0, frames.length - 1))
  const speed = readNumber(state, 'hanoiSpeed', 1, 0.5, 2)
  const [playing, setPlaying] = useState(false)
  const frame = frames[step]
  usePlayback({
    playing,
    speed,
    onAdvance: () => {
      if (step >= frames.length - 1) {
        setPlaying(false)
        return
      }
      update({ hanoiStep: step + 1 })
      if (step + 1 >= frames.length - 1) setPlaying(false)
    },
  })
  const caption = frame.move
    ? `Move disk ${frame.move.disk} from ${'ABC'[frame.move.from]} to ${'ABC'[frame.move.to]}.`
    : 'Move all disks from A to C. A larger disk must never sit on a smaller disk.'

  return (
    <section className={styles.interactive} aria-label="Towers of Hanoi explorer">
      <div className={styles.row}>
        <h3>One move reveals the recursion</h3>
        <label className={styles.inlineLabel}>
          Disks
          <select
            aria-label="Disks"
            value={size}
            onChange={(event) => {
              setPlaying(false)
              update({ hanoiSize: Number(event.target.value), hanoiStep: 0 })
            }}
          >
            {[3, 4, 5, 6, 7].map((count) => (
              <option key={count}>{count}</option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.scene}>
        <svg
          viewBox="0 0 640 260"
          role="img"
          aria-label={`Hanoi after ${step} moves. ${frame.pegs.map((peg, index) => `Peg ${'ABC'[index]}: ${peg.join(', ') || 'empty'}`).join('. ')}`}
        >
          {[0, 1, 2].map((peg) => (
            <g key={peg}>
              <path
                d={`M ${105 + peg * 215} 46 V 215 M ${24 + peg * 215} 217 H ${186 + peg * 215}`}
                fill="none"
                stroke="var(--muted-foreground)"
                strokeWidth="5"
                strokeLinecap="round"
                opacity="0.5"
              />
              <text
                x={105 + peg * 215}
                y="245"
                textAnchor="middle"
                fill="currentColor"
                fontSize="15"
              >
                {'ABC'[peg]}
                {peg === 2 ? ' · destination' : ''}
              </text>
            </g>
          ))}
          {Array.from({ length: size }, (_, index) => index + 1).map((disk) => {
            const pegIndex = frame.pegs.findIndex((peg) => peg.includes(disk))
            const diskIndex = frame.pegs[pegIndex].indexOf(disk)
            const width = 38 + disk * 17
            return (
              <g
                key={disk}
                className={styles.disk}
                style={{
                  transform: `translate(${105 + pegIndex * 215}px, ${202 - diskIndex * 22}px)`,
                }}
              >
                <rect
                  x={-width / 2}
                  y={-16}
                  width={width}
                  height={20}
                  rx="5"
                  fill={`hsl(${217 + disk * 7} 78% ${64 - disk * 3}%)`}
                  stroke={frame.move?.disk === disk ? '#dbeafe' : 'transparent'}
                  strokeWidth="2"
                />
                <text textAnchor="middle" y="-2" fill="#fff" fontSize="12">
                  {disk}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <div className={styles.pegReadout} aria-hidden="true">
        {frame.pegs.map((peg, index) => (
          <div key={index}>
            <strong>Peg {'ABC'[index]}</strong>
            <span>{peg.join(', ') || 'Empty'}</span>
          </div>
        ))}
      </div>
      <p className={styles.caption} aria-live="polite">
        {caption}
      </p>
      <PlaybackControls
        step={step}
        total={frames.length - 1}
        playing={playing}
        speed={speed}
        onStep={(hanoiStep) => update({ hanoiStep })}
        onPlaying={setPlaying}
        onSpeed={(hanoiSpeed) => update({ hanoiSpeed })}
        onReset={() => {
          setPlaying(false)
          update({ hanoiStep: 0 })
        }}
      />
      <div className={styles.twoColumns}>
        <div>
          <h4>Recursive call stack at this move</h4>
          <ol className={styles.stack}>
            {(frame.move?.stack ?? [`hanoi(${size}, A, C, B)`]).map((call, index) => (
              <li key={index}>
                <code>{call}</code>
              </li>
            ))}
          </ol>
        </div>
        <div>
          <h4>Executable strategy</h4>
          <pre>{pseudocode}</pre>
        </div>
      </div>
      <p className={styles.note}>
        T(n) = 2T(n − 1) + 1, T(0) = 0. Exactly{' '}
        <strong>
          2<sup>{size}</sup> − 1 = {frames.length - 1} moves
        </strong>
        ; time O(2ⁿ), call-stack space O(n).{' '}
        <a
          href="https://introcs.cs.princeton.edu/java/23recursion/"
          target="_blank"
          rel="noreferrer"
        >
          Princeton: recursion
        </a>
      </p>
    </section>
  )
}
