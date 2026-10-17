'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Box,
  CheckCircle2,
  Download,
  Focus,
  Layers3,
  Lightbulb,
  LoaderCircle,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  SkipBack,
  SkipForward,
  Video,
} from 'lucide-react'
import { Button } from '@/app/_components/ui/button'
import { clamp } from '@/lib/explore/models'
import { readNumber, readString, type RendererProps } from '@/app/_components/explore/_types'
import { buildDiagramParts, diagramProjection } from '@/app/_components/explore/_diagram-model'
import { DiagramSurface } from '@/app/_components/explore/diagram-surface'
import { downloadDiagramExport } from '@/app/_components/explore/_diagram-export'
import { recordDiagramVideo } from '@/app/_components/explore/_diagram-recording'
import styles from '@/app/_components/explore/diagram-viewer.module.css'

const DiagramScene = dynamic(
  () => import('@/app/_components/explore/diagram-scene').then((module) => module.DiagramScene),
  { ssr: false, loading: () => <p className={styles.loading}>Preparing the spatial view…</p> },
)
const initialCamera = [10, 8, 12, 0, 0, 0, 1]
type CameraAction =
  | 'overview'
  | 'focus'
  | 'front'
  | 'top'
  | 'isometric'
  | 'zoom-in'
  | 'zoom-out'
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'orbit-left'
  | 'orbit-right'
type ExportFormat = 'svg' | 'png' | 'html' | 'card'

export const DiagramViewer = ({ content, state, update }: RendererProps) => {
  const parts = useMemo(() => buildDiagramParts(content), [content])
  const [search, setSearch] = useState('')
  const [playing, setPlaying] = useState(false)
  const [fallback, setFallback] = useState(false)
  const [command, setCommand] = useState<{ id: number; action: CameraAction } | null>(null)
  const [exportFormat, setExportFormat] = useState<ExportFormat>('html')
  const [exporting, setExporting] = useState(false)
  const [recording, setRecording] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportMessage, setExportMessage] = useState('')
  const svg = useRef<SVGSVGElement>(null)
  const scene = useRef<HTMLDivElement>(null)
  const recordingController = useRef<AbortController | null>(null)
  const nextCommand = useRef(0)
  const selectedId = readString(state, 'diagramNode', content.nodes[0]?.id)
  const selected = content.nodes.find((node) => node.id === selectedId) ?? content.nodes[0]
  const separation = readNumber(state, 'diagramSeparation', 0, 0, 1)
  const light = readNumber(state, 'diagramLight', 1, 0.3, 2)
  const shadows = state.diagramShadows !== false
  const requestedView = readString(
    state,
    'diagramView',
    content.config.diagram?.view === 'assembly' ? '3d' : '2d',
  )
  const view = fallback ? '2d' : requestedView === '3d' ? '3d' : '2d'
  const step = Math.floor(readNumber(state, 'diagramStep', 0, 0, content.steps.length))
  const speed = readNumber(state, 'diagramSpeed', 1, 0.5, 2)
  const chapter = step > 0 ? content.steps[step - 1] : null
  const activeIds = useMemo(() => chapter?.focus ?? [], [chapter])
  const projection = useMemo(() => diagramProjection(content, separation), [content, separation])
  const zoom = readNumber(state, 'diagramZoom', 1, 0.25, 4)
  const panX = readNumber(state, 'diagramX', 0, -projection.width * 3, projection.width * 3)
  const panY = readNumber(state, 'diagramY', 0, -projection.height * 3, projection.height * 3)
  const savedCamera = Array.isArray(state.diagramCamera) ? state.diagramCamera.join(',') : ''
  const cameraPose = useMemo(() => {
    const values = savedCamera.split(',').map(Number)
    if (values.length !== 7 || !values.every(Number.isFinite)) return initialCamera
    if (Math.hypot(values[0] - values[3], values[1] - values[4], values[2] - values[5]) < 0.1)
      return initialCamera
    return values.map((value, index) =>
      index === 6 ? clamp(value, 0.2, 5) : clamp(value, -200, 200),
    )
  }, [savedCamera])
  const latest = useRef({ step, update })
  latest.current = { step, update }
  const pause = useCallback(() => setPlaying(false), [])
  const onFailure = useCallback(() => setFallback(true), [])
  const onCameraChange = useCallback(
    (pose: number[]) => latest.current.update({ diagramCamera: pose }),
    [],
  )

  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      if (document.hidden) return
      const next = Math.min(content.steps.length, latest.current.step + 1)
      latest.current.update({ diagramStep: next })
      if (next >= content.steps.length) setPlaying(false)
    }, 3000 / speed)
    return () => window.clearInterval(timer)
  }, [playing, speed, content.steps.length])
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const stop = () => {
      if (media.matches) setPlaying(false)
    }
    media.addEventListener('change', stop)
    return () => {
      media.removeEventListener('change', stop)
      recordingController.current?.abort()
    }
  }, [])

  const changeView = (next: '2d' | '3d') => {
    pause()
    recordingController.current?.abort()
    if (next === '3d') setFallback(false)
    update({ diagramView: next })
  }
  const selectPart = (id: string) => {
    pause()
    update({ diagramNode: id })
  }
  const onView = ({ zoom: amount, x, y }: { zoom: number; x: number; y: number }) =>
    update({ diagramZoom: amount, diagramX: x, diagramY: y })
  const camera = (action: CameraAction) => {
    pause()
    if (view === '3d') {
      setCommand({ id: ++nextCommand.current, action })
      return
    }
    if (action === 'overview') onView({ zoom: 1, x: 0, y: 0 })
    else if (action === 'focus') {
      const point = projection.points.find((point) => point.id === selected.id)!
      const bounds = svg.current?.getBoundingClientRect()
      const fit = bounds
        ? Math.min(bounds.width / projection.width, bounds.height / projection.height)
        : 1
      const focusedZoom = clamp(220 / (160 * Math.max(0.1, fit)), 1.4, 4)
      onView({
        zoom: focusedZoom,
        x: (projection.width / 2 - point.x) * focusedZoom,
        y: (projection.height / 2 - point.y) * focusedZoom,
      })
    } else if (action === 'zoom-in' || action === 'zoom-out')
      onView({
        zoom: clamp(zoom * (action === 'zoom-in' ? 1.2 : 1 / 1.2), 0.25, 4),
        x: panX,
        y: panY,
      })
    else
      onView({
        zoom,
        x: panX + (action === 'left' ? -60 : action === 'right' ? 60 : 0),
        y: panY + (action === 'up' ? -60 : action === 'down' ? 60 : 0),
      })
  }
  const seek = (next: number) => {
    pause()
    update({ diagramStep: clamp(next, 0, content.steps.length) })
  }
  const exportDiagram = async () => {
    if (!svg.current) return
    setExporting(true)
    setExportError(null)
    setExportMessage('')
    try {
      await downloadDiagramExport({
        format: exportFormat,
        content,
        state,
        svg: svg.current,
        canvas: view === '3d' ? (scene.current?.querySelector('canvas') ?? undefined) : undefined,
      })
      setExportMessage(
        exportFormat === 'html'
          ? 'Interactive HTML downloaded. Open it in any browser.'
          : 'Diagram downloaded.',
      )
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : 'The export could not be created. Please retry.',
      )
    } finally {
      setExporting(false)
    }
  }
  const record = async () => {
    if (recording) {
      recordingController.current?.abort()
      return
    }
    if (!svg.current) return
    const controller = new AbortController()
    recordingController.current = controller
    setRecording(true)
    setExportError(null)
    setExportMessage('')
    if (content.steps.length) {
      update({ diagramStep: 0 })
      setPlaying(true)
    }
    try {
      await recordDiagramVideo({
        svg: svg.current,
        canvas: view === '3d' ? (scene.current?.querySelector('canvas') ?? undefined) : undefined,
        title: content.title,
        signal: controller.signal,
      })
      if (!controller.signal.aborted) setExportMessage('Eight-second WebM clip downloaded.')
    } catch (error) {
      if (!controller.signal.aborted)
        setExportError(error instanceof Error ? error.message : 'Video recording is unavailable.')
    } finally {
      recordingController.current = null
      setRecording(false)
      setPlaying(false)
    }
  }
  const matches = content.nodes.filter((node) =>
    `${node.label} ${node.detail}`.toLowerCase().includes(search.toLowerCase()),
  )
  const connections = content.edges.filter(
    (edge) => edge.from === selected.id || edge.to === selected.id,
  )

  return (
    <section className={styles.explorer} aria-label="Interactive diagram studio">
      <header className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>INSPECT · CONNECT · UNDERSTAND</span>
          <h3>A closer look.</h3>
        </div>
        <div className={styles.viewSwitch} role="group" aria-label="Diagram view">
          <button type="button" aria-pressed={view === '2d'} onClick={() => changeView('2d')}>
            2D diagram
          </button>
          <button type="button" aria-pressed={view === '3d'} onClick={() => changeView('3d')}>
            <Box size={14} />
            3D inspect
          </button>
        </div>
      </header>
      <div
        className={styles.stage}
        ref={scene}
        onPointerDownCapture={pause}
        onWheelCapture={pause}
        onKeyDownCapture={pause}
      >
        <div className={styles.figureLabel}>
          <span>FIG. 01</span>
          <span>
            {content.config.diagram?.view === 'sequence'
              ? 'SEQUENCE'
              : view === '3d'
                ? 'SPATIAL SCHEMATIC'
                : 'CONNECTION MAP'}
          </span>
        </div>
        <div
          className={view === '3d' ? styles.exportSurface : styles.surface}
          aria-hidden={view === '3d' ? true : undefined}
          inert={view === '3d' ? true : undefined}
        >
          <DiagramSurface
            content={content}
            separation={separation}
            selectedId={selected.id}
            activeIds={activeIds}
            zoom={zoom}
            panX={panX}
            panY={panY}
            light={light}
            shadows={shadows}
            svgRef={svg}
            onView={onView}
            onSelect={selectPart}
            onIntent={pause}
          />
        </div>
        {view === '3d' && (
          <DiagramScene
            parts={parts}
            edges={content.edges}
            separation={separation}
            selectedId={selected.id}
            activeIds={activeIds}
            cameraPose={cameraPose}
            light={light}
            shadows={shadows}
            command={command}
            onSelect={selectPart}
            onCameraChange={onCameraChange}
            onFailure={onFailure}
          />
        )}
        <div className={styles.stageFoot}>
          <span>
            {view === '3d'
              ? 'Drag to turn · Shift-drag to pan · scroll to zoom'
              : 'Drag to pan · pinch to zoom · click a component'}
          </span>
          <span>
            {parts.length} components / {content.edges.length} connections
          </span>
        </div>
      </div>
      {fallback && (
        <p className={styles.status} role="status">
          3D is unavailable in this browser. The interactive 2D diagram uses the same parts and
          connections.
        </p>
      )}
      <div className={styles.toolbar} role="group" aria-label="Camera controls">
        <Button
          variant="secondary"
          size="icon"
          aria-label="Zoom in"
          onClick={() => camera('zoom-in')}
        >
          <Plus size={16} />
        </Button>
        <Button
          variant="secondary"
          size="icon"
          aria-label="Zoom out"
          onClick={() => camera('zoom-out')}
        >
          <Minus size={16} />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Pan left" onClick={() => camera('left')}>
          <ArrowLeft size={16} />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Pan right" onClick={() => camera('right')}>
          <ArrowRight size={16} />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Pan up" onClick={() => camera('up')}>
          <ArrowUp size={16} />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Pan down" onClick={() => camera('down')}>
          <ArrowDown size={16} />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => camera('focus')}>
          <Focus size={15} />
          Focus
        </Button>
        <Button variant="ghost" size="sm" onClick={() => camera('overview')}>
          <RotateCcw size={15} />
          Overview
        </Button>
        {view === '3d' && (
          <select
            aria-label="Camera angle"
            value=""
            onChange={(event) => camera(event.target.value as CameraAction)}
          >
            <option value="" disabled>
              Camera angle
            </option>
            <option value="isometric">Isometric</option>
            <option value="front">Front</option>
            <option value="top">Top</option>
            <option value="orbit-left">Turn left</option>
            <option value="orbit-right">Turn right</option>
          </select>
        )}
      </div>
      <div className={styles.adjustments}>
        <label>
          <span>
            <Layers3 size={14} />
            Separate components<output>{Math.round(separation * 100)}%</output>
          </span>
          <input
            aria-label="Component separation"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={separation}
            disabled={content.config.diagram?.view === 'sequence' && view === '2d'}
            onChange={(event) => {
              pause()
              update({ diagramSeparation: Number(event.target.value) })
            }}
          />
        </label>
        <button
          type="button"
          disabled={content.config.diagram?.view === 'sequence' && view === '2d'}
          onClick={() => {
            pause()
            update({ diagramSeparation: separation > 0 ? 0 : 1 })
          }}
        >
          {separation > 0 ? 'Reassemble' : 'Separate'}
        </button>
        <label>
          <span>
            <Lightbulb size={14} />
            Light<output>{Math.round(light * 100)}%</output>
          </span>
          <input
            aria-label="Scene light"
            type="range"
            min="0.3"
            max="2"
            step="0.1"
            value={light}
            onChange={(event) => {
              pause()
              update({ diagramLight: Number(event.target.value) })
            }}
          />
        </label>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={shadows}
            onChange={(event) => {
              pause()
              update({ diagramShadows: event.target.checked })
            }}
          />
          Shadows
        </label>
      </div>
      {content.steps.length > 0 && (
        <div className={styles.timeline}>
          <div className={styles.transport}>
            <button
              type="button"
              aria-label="Previous chapter"
              disabled={step === 0}
              onClick={() => seek(step - 1)}
            >
              <SkipBack size={15} />
            </button>
            <button
              type="button"
              onClick={() => {
                if (!playing && step >= content.steps.length) update({ diagramStep: 0 })
                setPlaying(!playing)
              }}
            >
              {playing ? <Pause size={15} /> : <Play size={15} />}
              {playing
                ? 'Pause explanation'
                : step >= content.steps.length
                  ? 'Replay explanation'
                  : 'Play explanation'}
            </button>
            <button
              type="button"
              aria-label="Next chapter"
              disabled={step >= content.steps.length}
              onClick={() => seek(step + 1)}
            >
              <SkipForward size={15} />
            </button>
            <select
              aria-label="Explanation speed"
              value={speed}
              onChange={(event) => update({ diagramSpeed: Number(event.target.value) })}
            >
              <option value={0.5}>0.5×</option>
              <option value={1}>1×</option>
              <option value={2}>2×</option>
            </select>
            <span>{step === 0 ? 'Overview' : `${step} / ${content.steps.length}`}</span>
          </div>
          <input
            aria-label="Explanation chapter"
            type="range"
            min="0"
            max={content.steps.length}
            value={step}
            onChange={(event) => seek(Number(event.target.value))}
          />
          <div className={styles.caption} aria-live="polite">
            <strong>{chapter?.title ?? 'Start with the whole picture.'}</strong>
            <p>
              {chapter?.body ??
                'Inspect a component or play the explanation to follow its steps. You can pause and move backward at any time.'}
            </p>
          </div>
          <div className={styles.chapters}>
            {content.steps.map((entry, index) => (
              <button
                key={index}
                type="button"
                aria-current={step === index + 1 ? 'step' : undefined}
                onClick={() => seek(index + 1)}
              >
                <span>{String(index + 1).padStart(2, '0')}</span>
                {entry.title}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className={styles.inspection}>
        <div className={styles.parts}>
          <label className={styles.search}>
            <Search size={15} />
            <input
              type="search"
              aria-label="Search components"
              placeholder="Find a component…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className={styles.partList} aria-label="Components">
            {matches.map((node) => (
              <button
                type="button"
                key={node.id}
                aria-pressed={selected.id === node.id}
                onClick={() => selectPart(node.id)}
              >
                <span>{String(content.nodes.indexOf(node) + 1).padStart(2, '0')}</span>
                {node.label}
                <ArrowRight size={13} />
              </button>
            ))}
            {!matches.length && <p>No matching components. Try another name.</p>}
          </div>
        </div>
        <div className={styles.detail} aria-live="polite">
          <span className={styles.eyebrow}>SELECTED COMPONENT</span>
          <h4>{selected.label}</h4>
          <p>{selected.detail || 'Inspect its connections in the diagram.'}</p>
          <button type="button" className={styles.focusButton} onClick={() => camera('focus')}>
            <Focus size={14} />
            Frame this component
          </button>
          <ul>
            {connections.map((edge, index) => (
              <li key={index}>
                <span>
                  {content.nodes.find((node) => node.id === edge.from)?.label} →{' '}
                  {content.nodes.find((node) => node.id === edge.to)?.label}
                </span>
                {edge.label && <p>{edge.label}</p>}
                {edge.evidence?.kind === 'provided' ? (
                  <blockquote>Supplied excerpt: “{edge.evidence.quote}”</blockquote>
                ) : (
                  <small>Illustrative relationship</small>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <details className={styles.audit}>
        <summary>
          <CheckCircle2 size={14} />
          Structure checked · {parts.length} unique components
        </summary>
        <p>
          Connections and chapter references point to existing components. Only the relationships
          included in this model are drawn. These checks validate structure, not the truth of a
          claim or the contents of an uninspected repository.
        </p>
        <p>
          3D shapes and separation are schematic viewing aids, not manufacturing geometry or a
          physical disassembly simulation.
        </p>
      </details>
      <div className={styles.exports}>
        <label>
          Take it with you
          <select
            aria-label="Diagram export format"
            value={exportFormat}
            onChange={(event) => setExportFormat(event.target.value as ExportFormat)}
          >
            <option value="html">Interactive HTML · offline</option>
            <option value="svg">SVG · 2D schematic</option>
            <option value="png">PNG · {view === '3d' ? 'current view' : '2D schematic'}</option>
            <option value="card">Sharing card · 1200 × 630</option>
          </select>
        </label>
        <Button
          variant="secondary"
          size="sm"
          disabled={exporting || recording}
          onClick={() => void exportDiagram()}
        >
          {exporting ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
          {exporting ? 'Exporting…' : 'Download'}
        </Button>
        <Button variant="ghost" size="sm" disabled={exporting} onClick={() => void record()}>
          <Video size={15} />
          {recording ? 'Cancel recording' : 'Record 8s · WebM'}
        </Button>
      </div>
      <p className={styles.exportNote}>
        HTML and SVG use a portable 2D schematic with the same components and connections.
      </p>
      {(exportError || exportMessage || recording) && (
        <p className={styles.status} role="status">
          {exportError ||
            (recording
              ? 'Recording the scene for eight seconds. Inspect or play the explanation while it records.'
              : exportMessage)}
        </p>
      )}
    </section>
  )
}
