import { describe, expect, it } from 'vitest'
import { ExploreArtifactContentSchema } from '@/lib/explore/schema'
import { createExploreBackupFixture } from '@/tests/fixtures/explore'

const legacyDiagram = {
  ...createExploreBackupFixture().artifacts[0].content,
  kind: 'diagram',
  title: 'Request flow',
  nodes: [
    { id: 'client', label: 'Client', detail: 'Starts a request.' },
    { id: 'api', label: 'API', detail: 'Processes the request.' },
  ],
  edges: [{ from: 'client', to: 'api', label: 'requests' }],
  steps: [{ title: 'Request', body: 'The client sends a request.' }],
}
const visual = {
  shape: 'box',
  position: [0, 0, 0],
  size: [1, 1, 1],
  separation: [0, 2, 0],
}

describe('Explore visual data contract', () => {
  it('preserves older diagrams without inserting new metadata into stored revisions', () => {
    expect(ExploreArtifactContentSchema.parse(legacyDiagram)).toEqual(legacyDiagram)
  })

  it('accepts bounded schematic geometry and focus with explicit nullable metadata', () => {
    const artifact = {
      ...legacyDiagram,
      nodes: [
        { ...legacyDiagram.nodes[0], visual },
        { ...legacyDiagram.nodes[1], visual: null },
      ],
      steps: [{ ...legacyDiagram.steps[0], focus: ['client', 'api'] }],
      edges: [{ ...legacyDiagram.edges[0], evidence: null }],
      config: { ...legacyDiagram.config, diagram: { view: 'assembly', layout: 'vertical' } },
    }
    expect(ExploreArtifactContentSchema.parse(artifact)).toEqual(artifact)
  })

  it.each([
    ['position', [13, 0, 0]],
    ['position', [-13, 0, 0]],
    ['size', [0, 1, 1]],
    ['size', [1, 7, 1]],
    ['separation', [0, 0, 9]],
    ['position', [NaN, 0, 0]],
    ['position', [Infinity, 0, 0]],
    ['size', [1, 1]],
    ['position', [0, 0, 0, 0]],
  ])('rejects invalid %s values %j', (field, values) => {
    expect(
      ExploreArtifactContentSchema.safeParse({
        ...legacyDiagram,
        nodes: [{ ...legacyDiagram.nodes[0], visual: { ...visual, [field]: values } }],
        edges: [],
      }).success,
    ).toBe(false)
  })

  it('rejects missing edge endpoints and duplicate node identifiers', () => {
    expect(
      ExploreArtifactContentSchema.safeParse({
        ...legacyDiagram,
        nodes: legacyDiagram.nodes.slice(0, 1),
      }).success,
    ).toBe(false)
    expect(
      ExploreArtifactContentSchema.safeParse({
        ...legacyDiagram,
        nodes: [...legacyDiagram.nodes, legacyDiagram.nodes[0]],
      }).success,
    ).toBe(false)
  })

  it('rejects duplicate relationships while allowing distinct exchanges between the same nodes', () => {
    expect(
      ExploreArtifactContentSchema.safeParse({
        ...legacyDiagram,
        edges: [legacyDiagram.edges[0], legacyDiagram.edges[0]],
      }).success,
    ).toBe(false)
    expect(
      ExploreArtifactContentSchema.safeParse({
        ...legacyDiagram,
        edges: [legacyDiagram.edges[0], { ...legacyDiagram.edges[0], label: 'retries' }],
      }).success,
    ).toBe(true)
  })

  it.each([['missing'], ['client', 'client']])('rejects invalid step focus %j', (...focus) => {
    expect(
      ExploreArtifactContentSchema.safeParse({
        ...legacyDiagram,
        steps: [{ ...legacyDiagram.steps[0], focus }],
      }).success,
    ).toBe(false)
  })

  it('rejects visual metadata attached to a different renderer kind', () => {
    expect(
      ExploreArtifactContentSchema.safeParse({
        ...legacyDiagram,
        kind: 'walkthrough',
        nodes: [{ ...legacyDiagram.nodes[0], visual }, legacyDiagram.nodes[1]],
      }).success,
    ).toBe(false)
  })

  it('requires a nonempty quotation for a provided relationship', () => {
    expect(
      ExploreArtifactContentSchema.safeParse({
        ...legacyDiagram,
        edges: [{ ...legacyDiagram.edges[0], evidence: { kind: 'provided', quote: ' ' } }],
      }).success,
    ).toBe(false)
  })
})
