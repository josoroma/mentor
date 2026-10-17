import type { ExploreArtifactContent } from '@/lib/explore/schema'
import { clamp } from '@/lib/explore/models'

export type DiagramVector = [number, number, number]
export type DiagramPart = {
  id: string
  label: string
  detail: string
  shape: 'box' | 'cylinder' | 'sphere' | 'ring'
  position: DiagramVector
  size: DiagramVector
  separation: DiagramVector
}

// Layout is a viewing aid. Only the supplied edges create relationships.
export const buildDiagramParts = (content: ExploreArtifactContent): DiagramPart[] => {
  const incoming = new Map(content.nodes.map(({ id }) => [id, 0]))
  const ranks = new Map(content.nodes.map(({ id }) => [id, 0]))
  for (const edge of content.edges) {
    if (edge.from !== edge.to) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
  }
  const queue = content.nodes.filter(({ id }) => incoming.get(id) === 0).map(({ id }) => id)
  const visited = new Set<string>()
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]
    visited.add(id)
    for (const edge of content.edges.filter((edge) => edge.from === id && edge.to !== id)) {
      ranks.set(edge.to, Math.max(ranks.get(edge.to) ?? 0, (ranks.get(id) ?? 0) + 1))
      incoming.set(edge.to, (incoming.get(edge.to) ?? 1) - 1)
      if (incoming.get(edge.to) === 0) queue.push(edge.to)
    }
  }
  let cyclic = 0
  for (const node of content.nodes) {
    if (!visited.has(node.id)) ranks.set(node.id, Math.floor(cyclic++ / 3))
  }
  const lanes = new Map<number, number>()
  const counts = new Map<number, number>()
  for (const rank of ranks.values()) counts.set(rank, (counts.get(rank) ?? 0) + 1)
  const maxRank = Math.max(0, ...ranks.values())
  return content.nodes.map((node, index) => {
    const rank = ranks.get(node.id) ?? 0
    const lane = lanes.get(rank) ?? 0
    lanes.set(rank, lane + 1)
    const along = (rank - maxRank / 2) * 3.4
    const across = (lane - ((counts.get(rank) ?? 1) - 1) / 2) * 2.8
    const vertical = content.config.diagram?.layout === 'vertical'
    const position: DiagramVector = vertical ? [across, 0, along] : [along, 0, across]
    const visual = node.visual
    return {
      id: node.id,
      label: node.label,
      detail: node.detail,
      shape: visual?.shape ?? 'box',
      position: visual ? [...visual.position] : position,
      size: visual ? [...visual.size] : [2.2, 0.75, 1.3],
      separation: visual
        ? [...visual.separation]
        : [position[0] * 0.35, index % 2 === 0 ? 0.8 : 0, position[2] * 0.35],
    }
  })
}

export const partPosition = (part: DiagramPart, separation: number): DiagramVector => {
  const amount = clamp(Number.isFinite(separation) ? separation : 0, 0, 1)
  return part.position.map(
    (value, index) => value + part.separation[index] * amount,
  ) as DiagramVector
}

export const diagramBounds = (parts: DiagramPart[], separation: number) => {
  const min: DiagramVector = [Infinity, Infinity, Infinity]
  const max: DiagramVector = [-Infinity, -Infinity, -Infinity]
  for (const part of parts) {
    const position = partPosition(part, separation)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], position[axis] - part.size[axis] / 2)
      max[axis] = Math.max(max[axis], position[axis] + part.size[axis] / 2)
    }
  }
  if (!parts.length)
    return {
      min: [-1, -1, -1] as DiagramVector,
      max: [1, 1, 1] as DiagramVector,
      center: [0, 0, 0] as DiagramVector,
      radius: 1,
    }
  const center = min.map((value, index) => (value + max[index]) / 2) as DiagramVector
  const radius = Math.max(1, Math.hypot(...max.map((value, index) => (value - min[index]) / 2)))
  return { min, max, center, radius }
}

export const diagramProjection = (content: ExploreArtifactContent, separation: number) => {
  const parts = buildDiagramParts(content)
  const assembly = content.config.diagram?.view === 'assembly'
  const sequence = content.config.diagram?.view === 'sequence'
  const project = ([x, y, z]: DiagramVector) => (assembly ? [x - z * 0.55, z * 0.5 - y] : [x, z])
  const rest = parts.map((part) => project(part.position))
  const apart = parts.map((part) => project(partPosition(part, 1)))
  const extent = (points: number[][], axis: number) => {
    const values = points.map((point) => point[axis])
    const min = Math.min(...values)
    const max = Math.max(...values)
    return { center: (min + max) / 2, span: max - min }
  }
  const restX = extent(rest, 0)
  const restY = extent(rest, 1)
  const apartX = extent(apart, 0)
  const apartY = extent(apart, 1)
  const spanX = Math.max(1, restX.span, apartX.span)
  const spanY = Math.max(1, restY.span, apartY.span)
  const scaleX = 70
  const scaleY = assembly ? 110 : 70
  const width = sequence
    ? Math.max(760, parts.length * 200 + 80)
    : Math.max(760, spanX * scaleX + 240)
  const height = sequence
    ? Math.max(460, content.edges.length * 68 + 180)
    : Math.max(460, spanY * scaleY + 180)
  return {
    width,
    height,
    nodeWidth: 160,
    nodeHeight: 60,
    points: parts.map((part, index) => {
      const x = sequence ? 140 + index * 200 : width / 2 + (rest[index][0] - restX.center) * scaleX
      const y = sequence ? 65 : height / 2 + (rest[index][1] - restY.center) * scaleY
      const separationX = sequence
        ? 0
        : (apart[index][0] - apartX.center - rest[index][0] + restX.center) * scaleX
      const separationY = sequence
        ? 0
        : (apart[index][1] - apartY.center - rest[index][1] + restY.center) * scaleY
      return {
        id: part.id,
        restX: x,
        restY: y,
        separationX,
        separationY,
        x: x + separationX * clamp(separation, 0, 1),
        y: y + separationY * clamp(separation, 0, 1),
      }
    }),
  }
}

export const diagramEdgePath = (
  from: { x: number; y: number },
  to: { x: number; y: number },
  index = 0,
) => {
  if (from.x === to.x && from.y === to.y) {
    return `M ${from.x + 45} ${from.y - 30} C ${from.x + 150} ${from.y - 115}, ${from.x - 150} ${from.y - 115}, ${from.x - 45} ${from.y - 30}`
  }
  const dx = to.x - from.x
  const dy = to.y - from.y
  const ratio = Math.min(80 / Math.max(Math.abs(dx), 0.01), 30 / Math.max(Math.abs(dy), 0.01), 0.45)
  const x1 = from.x + dx * ratio
  const y1 = from.y + dy * ratio
  const x2 = to.x - dx * ratio
  const y2 = to.y - dy * ratio
  const bend = (index % 2 ? -1 : 1) * Math.min(45, Math.hypot(dx, dy) * 0.12)
  return `M ${x1} ${y1} Q ${(x1 + x2) / 2 - (dy / Math.hypot(dx, dy)) * bend} ${(y1 + y2) / 2 + (dx / Math.hypot(dx, dy)) * bend} ${x2} ${y2}`
}
