import { describe, expect, it } from 'vitest'
import { ExploreArtifactContentSchema } from '@/lib/explore/schema'
import {
  buildDiagramParts,
  diagramBounds,
  diagramProjection,
  partPosition,
} from '@/app/_components/explore/_diagram-model'

const content = ExploreArtifactContentSchema.parse({
  kind: 'diagram',
  title: 'A conceptual assembly',
  summary: 'Inspect two connected components and an independent component.',
  objectives: [],
  sections: [],
  steps: [],
  examples: [],
  questions: [],
  assumptions: [],
  nodes: [
    { id: 'input', label: 'Input', detail: '' },
    { id: 'output', label: 'Output', detail: '' },
    { id: 'independent', label: 'Independent', detail: '' },
  ],
  edges: [{ from: 'input', to: 'output', label: 'Request' }],
  config: { size: 3, values: [], simulation: 'pendulum', pseudocode: '', complexity: '' },
})

describe('diagram layout and reversible transforms', () => {
  it('lays out disconnected components without adding relationships or mutating the model', () => {
    const before = structuredClone(content)
    const parts = buildDiagramParts(content)
    expect(parts).toHaveLength(3)
    expect(new Set(parts.map((part) => part.position.join(','))).size).toBe(3)
    expect(parts[1].position[0]).toBeGreaterThan(parts[0].position[0])
    expect(content).toEqual(before)
  })

  it('keeps cyclic graphs deterministic and finite', () => {
    const cyclic = structuredClone(content)
    cyclic.edges.push({ from: 'output', to: 'input', label: 'Response' })
    const first = buildDiagramParts(cyclic)
    expect(buildDiagramParts(cyclic)).toEqual(first)
    expect(first.flatMap((part) => part.position).every(Number.isFinite)).toBe(true)
    expect(new Set(first.map((part) => part.position.join(','))).size).toBe(3)
  })

  it('uses absolute authored transforms through repeated separation and exact reassembly', () => {
    const assembly = structuredClone(content)
    assembly.nodes[0].visual = {
      shape: 'box',
      position: [2, 3, 4],
      size: [1, 2, 3],
      separation: [-1, 2, 0],
    }
    const part = buildDiagramParts(assembly)[0]
    const rest = partPosition(part, 0)
    for (let cycle = 0; cycle < 50; cycle++) {
      expect(partPosition(part, 0.5)).toEqual([1.5, 4, 4])
      expect(partPosition(part, 1)).toEqual([1, 5, 4])
      expect(partPosition(part, 0)).toEqual(rest)
    }
    expect(partPosition(part, Infinity)).toEqual(rest)
    const bounds = diagramBounds([part], 1)
    expect(bounds.min).toEqual([0.5, 4, 2.5])
    expect(bounds.max).toEqual([1.5, 6, 5.5])
  })

  it('keeps both endpoints centered within a stable viewport and returns exactly to rest', () => {
    const assembly = structuredClone(content)
    assembly.config.diagram = { view: 'assembly', layout: 'vertical' }
    assembly.nodes.forEach((node, index) => {
      node.visual = {
        shape: 'box',
        position: [0, index, 0],
        size: [2, 0.5, 1],
        separation: [0, index * 2, 0],
      }
    })
    const rest = diagramProjection(assembly, 0)
    const apart = diagramProjection(assembly, 1)
    expect(apart.width).toBe(rest.width)
    expect(apart.height).toBe(rest.height)
    expect(apart.points).not.toEqual(rest.points)
    for (const projected of [rest, apart]) {
      const ys = projected.points.map((point) => point.y)
      expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(projected.height / 2)
      expect(Math.min(...ys)).toBeGreaterThan(30)
      expect(Math.max(...ys)).toBeLessThan(projected.height - 30)
    }
    expect(diagramProjection(assembly, 0)).toEqual(rest)
  })

  it('keeps sequence participants aligned and reserves height for every ordered message', () => {
    const sequence = structuredClone(content)
    sequence.config.diagram = { view: 'sequence', layout: 'horizontal' }
    sequence.edges = Array.from({ length: 12 }, (_, index) => ({
      from: 'input',
      to: 'output',
      label: `Message ${index + 1}`,
    }))
    const projected = diagramProjection(sequence, 1)
    expect(projected.points.every((point) => point.y === 65)).toBe(true)
    expect(projected.height).toBeGreaterThan(150 + 11 * 68)
    expect(diagramProjection(sequence, 0)).toEqual(projected)
  })
})
