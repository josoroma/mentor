'use client'

import dynamic from 'next/dynamic'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Minus, Pause, Play, Plus, RotateCcw } from 'lucide-react'
import { Button } from '@/app/_components/ui/button'
import {
  clamp,
  normalizeSimulationParameters,
  orbitAt,
  pendulumAt,
  simulationSources,
  waveAt,
  type SimulationParameters,
} from '@/lib/explore/models'
import { readNumber, type RendererProps } from '@/app/_components/explore/_types'
import styles from '@/app/_components/explore/artifact-viewer.module.css'

const ThreeScene = dynamic(
  () => import('@/app/_components/explore/three-scene').then((module) => module.ThreeScene),
  { ssr: false, loading: () => <p className={styles.sceneLoading}>Preparing the spatial view…</p> },
)
const initialCamera = [5, 3.5, 7, 0, 0, 0]
const parameterControls: Record<
  string,
  { key: keyof SimulationParameters; label: string; min: number; max: number; step: number }[]
> = {
  pendulum: [
    { key: 'length', label: 'Length (m)', min: 0.5, max: 3, step: 0.1 },
    { key: 'gravity', label: 'Gravity (m/s²)', min: 1, max: 20, step: 0.1 },
    { key: 'amplitude', label: 'Release angle (°)', min: 1, max: 12, step: 1 },
  ],
  wave: [
    { key: 'amplitude', label: 'Amplitude (m)', min: 0.1, max: 1.5, step: 0.1 },
    { key: 'frequency', label: 'Frequency (Hz)', min: 0.2, max: 2, step: 0.1 },
    { key: 'wavelength', label: 'Wavelength (m)', min: 1, max: 5, step: 0.1 },
  ],
  orbit: [
    { key: 'radius', label: 'Radius (length units)', min: 1, max: 4, step: 0.1 },
    { key: 'mu', label: 'μ = GM (length³ / time²)', min: 1, max: 20, step: 0.5 },
  ],
}

export const SimulationViewer = ({ content, state, update }: RendererProps) => {
  const kind = content.config.simulation
  const initialTime = readNumber(state, 'simulationTime', 0, 0, 120)
  const [time, setTime] = useState(initialTime)
  const [playing, setPlaying] = useState(false)
  const [fallback, setFallback] = useState(false)
  const speed = readNumber(state, 'simulationSpeed', 1, 0.25, 2)
  const timeRef = useRef(time)
  timeRef.current = time
  const updateRef = useRef(update)
  updateRef.current = update
  const parameterKey = parameterControls[kind]
    .map(({ key }) => state[`simulation_${key}`])
    .join(',')
  const parameters = useMemo(
    () =>
      normalizeSimulationParameters(
        Object.fromEntries(
          parameterControls[kind]
            .filter(({ key }) => typeof state[`simulation_${key}`] === 'number')
            .map(({ key }) => [key, state[`simulation_${key}`]]),
        ),
        kind,
      ),
    [kind, parameterKey],
  )
  const cameraKey = Array.isArray(state.simulationCamera) ? state.simulationCamera.join(',') : ''
  const cameraPose = useMemo(() => {
    const saved = state.simulationCamera
    return Array.isArray(saved) &&
      saved.length === 6 &&
      saved.every((value) => typeof value === 'number' && Number.isFinite(value))
      ? (() => {
          const pose = (saved as number[]).map((value) => clamp(value, -18, 18))
          return Math.hypot(pose[0] - pose[3], pose[1] - pose[4], pose[2] - pose[5]) > 0.1
            ? pose
            : initialCamera
        })()
      : initialCamera
  }, [cameraKey])

  useEffect(() => {
    if (!playing) return
    let frame = 0
    let previous = 0
    let published = 0
    let drawn = 0
    const animate = (now: number) => {
      frame = requestAnimationFrame(animate)
      if (document.hidden) {
        previous = 0
        return
      }
      const delta = previous ? Math.min((now - previous) / 1000, 0.1) : 0
      previous = now
      timeRef.current = Math.min(120, timeRef.current + delta * speed)
      if (now - drawn > 32) {
        setTime(timeRef.current)
        drawn = now
      }
      if (now - published > 1000 || timeRef.current >= 120) {
        updateRef.current({ simulationTime: timeRef.current })
        published = now
      }
      if (timeRef.current >= 120) setPlaying(false)
    }
    frame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frame)
  }, [playing, speed])

  const seek = (value: number) => {
    setPlaying(false)
    setTime(value)
    timeRef.current = value
    update({ simulationTime: value })
  }
  const rotateCamera = (angle: number) => {
    const [x, y, z, tx, ty, tz] = cameraPose
    update({
      simulationCamera: [
        tx + (x - tx) * Math.cos(angle) + (z - tz) * Math.sin(angle),
        y,
        tz - (x - tx) * Math.sin(angle) + (z - tz) * Math.cos(angle),
        tx,
        ty,
        tz,
      ],
    })
  }
  const zoomCamera = (factor: number) => {
    const [x, y, z, tx, ty, tz] = cameraPose
    const distance = Math.hypot(x - tx, y - ty, z - tz)
    const scale = clamp(distance * factor, 4, 18) / Math.max(distance, 0.01)
    update({
      simulationCamera: [
        tx + (x - tx) * scale,
        ty + (y - ty) * scale,
        tz + (z - tz) * scale,
        tx,
        ty,
        tz,
      ],
    })
  }
  const pendulum = pendulumAt(time, parameters)
  const orbit = orbitAt(time, parameters)
  const source = simulationSources[kind]
  const title =
    kind === 'pendulum'
      ? 'An ideal small-angle pendulum'
      : kind === 'orbit'
        ? 'A circular Newtonian orbit'
        : 'A traveling sinusoidal wave'
  return (
    <section className={styles.interactive} aria-label={`${kind} simulation`}>
      <div className={styles.row}>
        <h3>{title}</h3>
        <span className={styles.meta}>
          {time.toFixed(1)} {kind === 'orbit' ? 'time units' : 's'}
        </span>
      </div>
      <div className={styles.scene}>
        {!fallback ? (
          <ThreeScene
            kind={kind}
            time={time}
            parameters={parameters}
            cameraPose={cameraPose}
            onCameraChange={(simulationCamera) => update({ simulationCamera })}
            onFailure={() => setFallback(true)}
          />
        ) : (
          <svg
            viewBox="0 0 640 330"
            role="img"
            aria-label={`${title}, 2D view at ${time.toFixed(1)}`}
          >
            <path
              d="M40 285H600 M320 30V300"
              stroke="#475569"
              strokeWidth="1"
              strokeDasharray="4 5"
            />
            {kind === 'pendulum' && (
              <g>
                <line
                  x1="320"
                  y1="35"
                  x2={320 + pendulum.x * 75}
                  y2={35 - pendulum.y * 75}
                  stroke="#60a5fa"
                  strokeWidth="3"
                />
                <circle cx="320" cy="35" r="5" fill="#a78bfa" />
                <circle
                  cx={320 + pendulum.x * 75}
                  cy={35 - pendulum.y * 75}
                  r="12"
                  fill="#60a5fa"
                />
              </g>
            )}
            {kind === 'orbit' && (
              <g>
                <ellipse
                  cx="320"
                  cy="165"
                  rx={parameters.radius * 55}
                  ry={parameters.radius * 33}
                  fill="none"
                  stroke="#64748b"
                />
                <circle cx="320" cy="165" r="20" fill="#a78bfa" />
                <circle cx={320 + orbit.x * 55} cy={165 + orbit.z * 33} r="10" fill="#60a5fa" />
              </g>
            )}
            {kind === 'wave' && (
              <g>
                <polyline
                  points={Array.from({ length: 129 }, (_, index) => {
                    const x = -4 + (index / 128) * 8
                    return `${40 + (index / 128) * 560},${165 - waveAt(x, time, parameters) * 70}`
                  }).join(' ')}
                  fill="none"
                  stroke="#60a5fa"
                  strokeWidth="3"
                />
                <circle cx="320" cy={165 - waveAt(0, time, parameters) * 70} r="7" fill="#a78bfa" />
              </g>
            )}
          </svg>
        )}
      </div>
      <p className={styles.note}>
        {fallback
          ? 'WebGL is unavailable. This 2D view uses the same model and controls.'
          : 'Drag to orbit; Shift-drag to pan; scroll over the scene to zoom. Camera movement changes your view, not the model.'}
      </p>
      <div className={styles.controls}>
        <Button
          size="sm"
          variant="secondary"
          disabled={time >= 120 && !playing}
          onClick={() => {
            if (playing) update({ simulationTime: timeRef.current })
            setPlaying(!playing)
          }}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
          {playing ? 'Pause' : 'Play'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => seek(0)}>
          <RotateCcw size={16} />
          Reset time
        </Button>
        <label className={styles.inlineLabel}>
          Speed
          <select
            aria-label="Simulation speed"
            value={speed}
            onChange={(event) => update({ simulationSpeed: Number(event.target.value) })}
          >
            <option value={0.25}>0.25×</option>
            <option value={0.5}>0.5×</option>
            <option value={1}>1×</option>
            <option value={2}>2×</option>
          </select>
        </label>
      </div>
      <label className={styles.timeline}>
        Simulation time
        <input
          type="range"
          min="0"
          max="120"
          step="0.1"
          value={time}
          onChange={(event) => seek(Number(event.target.value))}
        />
      </label>
      {!fallback && (
        <div className={styles.controls}>
          <Button
            size="icon"
            variant="secondary"
            aria-label="Orbit camera left"
            onClick={() => rotateCamera(-Math.PI / 8)}
          >
            <ArrowLeft size={16} />
          </Button>
          <Button
            size="icon"
            variant="secondary"
            aria-label="Orbit camera right"
            onClick={() => rotateCamera(Math.PI / 8)}
          >
            <ArrowRight size={16} />
          </Button>
          <Button
            size="icon"
            variant="secondary"
            aria-label="Zoom camera in"
            onClick={() => zoomCamera(0.85)}
          >
            <Plus size={16} />
          </Button>
          <Button
            size="icon"
            variant="secondary"
            aria-label="Zoom camera out"
            onClick={() => zoomCamera(1.15)}
          >
            <Minus size={16} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => update({ simulationCamera: initialCamera })}
          >
            Reset camera
          </Button>
        </div>
      )}
      <div className={styles.parameters}>
        {parameterControls[kind].map((control) => (
          <label key={control.key} className={styles.field}>
            {control.label}
            <output>{parameters[control.key].toFixed(control.step < 1 ? 1 : 0)}</output>
            <input
              type="range"
              aria-label={control.label}
              min={control.min}
              max={control.max}
              step={control.step}
              value={parameters[control.key]}
              onChange={(event) => {
                seek(0)
                update({
                  [`simulation_${control.key}`]: Number(event.target.value),
                  simulationTime: 0,
                })
              }}
            />
          </label>
        ))}
      </div>
      <div className={styles.callout}>
        {kind === 'pendulum' && (
          <>
            <h4>Longer length → longer period</h4>
            <p>
              T ≈ 2π√(L/g) = <strong>{pendulum.period.toFixed(2)} seconds</strong>. θ(t) = θ₀
              cos(√(g/L)t).
            </p>
            <p className={styles.note}>
              Small-angle approximation, released from rest, with a point mass and massless
              rigid-length support. No damping; angle limited to 12°. The bob is enlarged for
              visibility.
            </p>
          </>
        )}
        {kind === 'orbit' && (
          <>
            <h4>Larger radius → slower orbital motion</h4>
            <p>
              v = √(μ/r) = <strong>{orbit.speed.toFixed(2)}</strong> length/time; T = 2π√(r³/μ) ={' '}
              <strong>{orbit.period.toFixed(2)}</strong> time units.
            </p>
            <p className={styles.note}>
              Ideal circular orbit around a fixed dominant mass. Normalized units; μ = GM. Body
              sizes are schematic. Changing radius selects a new circular orbit, not a rocket
              maneuver.
            </p>
          </>
        )}
        {kind === 'wave' && (
          <>
            <h4>The pattern travels; the marker oscillates</h4>
            <p>
              y(x,t) = A sin(2π(x/λ − ft)). Pattern speed v = fλ ={' '}
              <strong>{(parameters.frequency * parameters.wavelength).toFixed(2)} m/s</strong>.
            </p>
            <p className={styles.note}>
              Ideal transverse sinusoid with no damping or boundaries. The marker stays at x = 0.
              Frequency and wavelength are independently adjustable; together they select the wave
              speed.
            </p>
          </>
        )}
        <a href={source.url} target="_blank" rel="noreferrer">
          {source.label}
        </a>
      </div>
    </section>
  )
}
