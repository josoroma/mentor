'use client'

import { useEffect, useId, useMemo, useRef, type RefObject } from 'react'
import type { ExploreArtifactContent } from '@/lib/explore/schema'
import { clamp } from '@/lib/explore/models'
import { diagramEdgePath, diagramProjection } from '@/app/_components/explore/_diagram-model'
import styles from '@/app/_components/explore/diagram-viewer.module.css'

export const DiagramSurface = ({
  content,
  separation,
  selectedId,
  activeIds,
  zoom,
  panX,
  panY,
  light,
  shadows,
  svgRef,
  onView,
  onSelect,
  onIntent,
}: {
  content: ExploreArtifactContent
  separation: number
  selectedId: string
  activeIds: string[]
  zoom: number
  panX: number
  panY: number
  light: number
  shadows: boolean
  svgRef: RefObject<SVGSVGElement | null>
  onView: (view: { zoom: number; x: number; y: number }) => void
  onSelect: (id: string) => void
  onIntent: () => void
}) => {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const projection = useMemo(() => diagramProjection(content, separation), [content, separation])
  const { width, height } = projection
  const points = new Map(projection.points.map((point) => [point.id, point]))
  const sequence = content.config.diagram?.view === 'sequence'
  const current = useRef({ zoom, panX, panY, onView, onIntent })
  current.current = { zoom, panX, panY, onView, onIntent }
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const drag = useRef({
    x: 0,
    y: 0,
    panX: 0,
    panY: 0,
    zoom: 1,
    distance: 0,
    moved: false,
    nodeId: '',
  })

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const wheel = (event: WheelEvent) => {
      if (document.activeElement !== svg) return
      event.preventDefault()
      const view = current.current
      view.onIntent()
      view.onView({
        zoom: clamp(view.zoom * Math.exp(-event.deltaY * 0.002), 0.25, 4),
        x: view.panX,
        y: view.panY,
      })
    }
    svg.addEventListener('wheel', wheel, { passive: false })
    return () => svg.removeEventListener('wheel', wheel)
  }, [svgRef])

  const release = (pointerId: number) => {
    pointers.current.delete(pointerId)
    if (svgRef.current?.hasPointerCapture(pointerId))
      svgRef.current.releasePointerCapture(pointerId)
    const remaining = [...pointers.current.values()][0]
    if (remaining)
      drag.current = {
        ...drag.current,
        ...remaining,
        panX: current.current.panX,
        panY: current.current.panY,
        zoom: current.current.zoom,
        distance: 0,
      }
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      className={styles.svg}
      role="group"
      tabIndex={0}
      aria-label="Interactive diagram. Drag to pan, pinch to zoom. Focus and scroll to zoom. Arrow keys pan; plus and minus zoom; Home resets."
      onKeyDown={(event) => {
        if (
          event.target !== event.currentTarget ||
          !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home'].includes(
            event.key,
          )
        )
          return
        event.preventDefault()
        onIntent()
        if (event.key === 'Home') onView({ zoom: 1, x: 0, y: 0 })
        else if (event.key === '+' || event.key === '=')
          onView({ zoom: clamp(zoom * 1.2, 0.25, 4), x: panX, y: panY })
        else if (event.key === '-') onView({ zoom: clamp(zoom / 1.2, 0.25, 4), x: panX, y: panY })
        else
          onView({
            zoom,
            x: panX + (event.key === 'ArrowLeft' ? -50 : event.key === 'ArrowRight' ? 50 : 0),
            y: panY + (event.key === 'ArrowUp' ? -50 : event.key === 'ArrowDown' ? 50 : 0),
          })
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        onIntent()
        event.currentTarget.focus({ preventScroll: true })
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
        const pair = [...pointers.current.values()]
        drag.current = {
          x: event.clientX,
          y: event.clientY,
          panX,
          panY,
          zoom,
          distance:
            pair.length === 2 ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0,
          moved: false,
          nodeId:
            pair.length === 1
              ? ((event.target as Element)
                  .closest('[data-node-id]')
                  ?.getAttribute('data-node-id') ?? '')
              : '',
        }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!pointers.current.has(event.pointerId)) return
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
        const pair = [...pointers.current.values()]
        const origin = drag.current
        if (pair.length === 2 && origin.distance) {
          origin.moved = true
          onView({
            zoom: clamp(
              (origin.zoom * Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y)) /
                origin.distance,
              0.25,
              4,
            ),
            x: origin.panX,
            y: origin.panY,
          })
          return
        }
        const dx = event.clientX - origin.x
        const dy = event.clientY - origin.y
        if (Math.hypot(dx, dy) < 4 && !origin.moved) return
        origin.moved = true
        const scale = event.currentTarget.getScreenCTM()?.a || 1
        onView({
          zoom,
          x: clamp(origin.panX + dx / scale, -width * 3, width * 3),
          y: clamp(origin.panY + dy / scale, -height * 3, height * 3),
        })
      }}
      onPointerUp={(event) => {
        if (!drag.current.moved && drag.current.nodeId) onSelect(drag.current.nodeId)
        release(event.pointerId)
      }}
      onPointerCancel={(event) => {
        drag.current.moved = true
        release(event.pointerId)
      }}
    >
      <defs>
        <pattern id={`${id}-grid`} width="28" height="28" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.7" fill="var(--muted-foreground)" opacity="0.2" />
        </pattern>
        <linearGradient id={`${id}-surface`} x1="0" x2="0.4" y1="0" y2="1">
          <stop offset="0" stopColor="var(--muted)" />
          <stop offset="1" stopColor="var(--card)" />
        </linearGradient>
        <filter id={`${id}-shadow`} x="-40%" y="-60%" width="180%" height="240%">
          <feDropShadow dx="0" dy="7" stdDeviation="7" floodOpacity={0.1 + light * 0.09} />
        </filter>
        <marker
          id={`${id}-arrow`}
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto-start-reverse"
        >
          <path d="M0 0L8 4L0 8Z" fill="context-stroke" />
        </marker>
      </defs>
      <rect width={width} height={height} fill="var(--background)" />
      <rect width={width} height={height} fill={`url(#${id}-grid)`} />
      <g
        data-diagram-world
        transform={`translate(${panX} ${panY}) translate(${width / 2} ${height / 2}) scale(${zoom}) translate(${-width / 2} ${-height / 2})`}
      >
        {sequence &&
          projection.points.map((point) => (
            <line
              key={point.id}
              x1={point.x}
              y1="95"
              x2={point.x}
              y2={height - 40}
              stroke="var(--muted-foreground)"
              strokeDasharray="5 7"
              opacity="0.35"
            />
          ))}
        {content.edges.map((edge, index) => {
          const from = points.get(edge.from)!
          const to = points.get(edge.to)!
          const active = activeIds.length
            ? activeIds.includes(edge.from) && activeIds.includes(edge.to)
            : edge.from === selectedId || edge.to === selectedId
          const y = 150 + index * 68
          const path = sequence
            ? from.id === to.id
              ? `M${from.x} ${y}h70v26h-70`
              : `M${from.x} ${y}H${to.x}`
            : diagramEdgePath(from, to, index)
          return (
            <g
              key={`${edge.from}:${edge.to}:${index}`}
              opacity={activeIds.length && !active ? 0.35 : 1}
            >
              <path
                data-edge-index={index}
                data-from={edge.from}
                data-to={edge.to}
                d={path}
                fill="none"
                stroke={active ? 'var(--brand)' : 'var(--muted-foreground)'}
                strokeWidth={active ? 2.5 : 1.5}
                markerEnd={`url(#${id}-arrow)`}
              />
              {edge.label && (
                <text
                  x={(from.x + to.x) / 2}
                  y={sequence ? y - 12 : (from.y + to.y) / 2 - 14}
                  fill="var(--foreground)"
                  fontSize="11"
                  textAnchor="middle"
                  paintOrder="stroke"
                  stroke="var(--background)"
                  strokeWidth="5"
                >
                  <title>{edge.label}</title>
                  {edge.label.length > 32 ? `${edge.label.slice(0, 31)}…` : edge.label}
                </text>
              )}
            </g>
          )
        })}
        {content.nodes.map((node, index) => {
          const point = points.get(node.id)!
          const selected = node.id === selectedId
          const active = activeIds.includes(node.id)
          const words = node.label.match(/.{1,22}(?:\s|$)|\S{1,22}/g) ?? [node.label]
          return (
            <g
              key={node.id}
              data-node-id={node.id}
              data-x={point.restX}
              data-y={point.restY}
              data-separation-x={point.separationX}
              data-separation-y={point.separationY}
              transform={`translate(${point.x} ${point.y})`}
              role="button"
              tabIndex={0}
              aria-label={`Inspect ${node.label}`}
              aria-pressed={selected}
              className={styles.node}
              onClick={(event) => {
                if (event.detail === 0) onSelect(node.id)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onIntent()
                  onSelect(node.id)
                }
              }}
            >
              <title>{node.label}</title>
              <rect
                x="-80"
                y="-30"
                width="160"
                height="60"
                rx="9"
                fill={`url(#${id}-surface)`}
                filter={shadows ? `url(#${id}-shadow)` : undefined}
                stroke={selected || active ? 'var(--brand)' : 'var(--border)'}
                strokeWidth={selected || active ? 2.5 : 1.5}
              />
              <path d="M-69 -24H69" stroke="var(--foreground)" opacity={light * 0.08} />
              <circle
                cx="-69"
                cy="-19"
                r="2"
                fill={selected || active ? 'var(--brand)' : 'var(--muted-foreground)'}
              />
              <text x="68" y="-16" fill="var(--muted-foreground)" fontSize="8" textAnchor="end">
                {String(index + 1).padStart(2, '0')}
              </text>
              <text fill="var(--foreground)" fontSize="12" textAnchor="middle">
                {words.slice(0, 2).map((line, lineIndex) => (
                  <tspan key={lineIndex} x="0" y={words.length > 1 ? 1 + lineIndex * 16 : 8}>
                    {line.trim()}
                    {lineIndex === 1 && words.length > 2 ? '…' : ''}
                  </tspan>
                ))}
              </text>
            </g>
          )
        })}
      </g>
    </svg>
  )
}
