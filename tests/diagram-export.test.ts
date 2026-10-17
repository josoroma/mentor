import { describe, expect, it } from 'vitest'
import {
  buildDiagramExportHtml,
  buildDiagramExportSvg,
} from '@/app/_components/explore/_diagram-export'
import { ExploreArtifactContentSchema } from '@/lib/explore/schema'

const content = ExploreArtifactContentSchema.parse({
  kind: 'diagram',
  title: 'A request through the service',
  summary: 'Follow a request from a client to the service.',
  objectives: [],
  sections: [],
  steps: [
    { title: 'Send', body: 'The client sends a request.', focus: ['client'] },
    { title: 'Receive', body: 'The service receives the request.', focus: ['service'] },
  ],
  examples: [],
  nodes: [
    { id: 'client', label: 'Client', detail: 'Starts the request.' },
    { id: 'service', label: 'Service', detail: 'Handles the request.' },
  ],
  edges: [{ from: 'client', to: 'service', label: 'Request' }],
  questions: [],
  config: {
    size: 3,
    values: [],
    simulation: 'pendulum',
    pseudocode: '',
    complexity: '',
    diagram: { view: 'flow', layout: 'horizontal' },
  },
  assumptions: ['This is an illustrative request, not an inspected implementation.'],
})

describe('portable diagram exports', () => {
  it('escapes all model text and keeps embedded JSON inside its inert script element', () => {
    const payload = '</script><script>alert("model text")</script><img src=x onerror=alert(1)>'
    const hostile = structuredClone(content)
    hostile.title = payload
    hostile.summary = payload
    hostile.nodes[0].label = payload
    hostile.nodes[0].detail = payload
    hostile.steps[0].body = payload
    hostile.assumptions = [payload]
    hostile.edges[0].evidence = { kind: 'provided', quote: payload }

    const html = buildDiagramExportHtml(hostile)
    expect(html).not.toContain(payload)
    expect(html).not.toContain('<img ')
    expect(html.match(/<script[ >]/g)).toHaveLength(2)
    const data = html.match(
      /<script id="diagram-data" type="application\/json">([\s\S]*?)<\/script>/,
    )
    expect(data).not.toBeNull()
    expect(data![1]).not.toContain('<')
    expect(JSON.parse(data![1]).content.summary).toBe(payload)
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;')
  })

  it('exports SVG with explicit colors and only the supplied nodes and connections', () => {
    const svg = buildDiagramExportSvg(content)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg.match(/data-node-index=/g)).toHaveLength(2)
    expect(svg.match(/data-edge-index=/g)).toHaveLength(1)
    expect(svg).not.toContain('var(--')
    expect(svg).not.toMatch(/<script|<foreignObject|<image|href=/i)
    expect(svg).toContain(
      'Connections are structurally validated, not verified against a repository.',
    )
  })

  it('makes the sharing card exactly 1200 by 630 without omitting the supplied topology', () => {
    const svg = buildDiagramExportSvg(content, {}, true)
    expect(svg).toMatch(/^<svg[^>]*width="1200" height="630" viewBox="0 0 1200 630"/)
    expect(svg).toContain('MENTOR · EXPLORE')
    expect(svg).toContain('2 parts · 1 connection')
    expect(svg.match(/data-node-index=/g)).toHaveLength(2)
    expect(svg.match(/data-edge-index=/g)).toHaveLength(1)
  })

  it('contains no remote dependencies and preserves assumptions and source distinctions', () => {
    const html = buildDiagramExportHtml(content)
    expect(html).not.toMatch(/<(?:script|link|iframe|img)\b[^>]*(?:src|href)=/i)
    expect(html).not.toMatch(/fetch\(|eval\(|new Function\(/)
    expect(html).toContain('This is an illustrative request, not an inspected implementation.')
    expect(html).toContain('Illustrative connection; no source quotation supplied.')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain('Part separation')
    expect(html).toContain('Search parts')
    expect(html).toContain('Play chapters')
  })

  it('retains explicit self-connections without inventing other connections', () => {
    const selfConnection = structuredClone(content)
    selfConnection.edges = [{ from: 'client', to: 'client', label: 'Retry' }]
    const svg = buildDiagramExportSvg(selfConnection)
    expect(svg.match(/data-edge-index=/g)).toHaveLength(1)
    expect(svg).toContain('<title>Client → Client: Retry</title>')
    expect(svg).toMatch(/<path d="M[^\"]+ C/)
  })

  it('preserves message order and lifelines in sequence diagrams', () => {
    const sequence = structuredClone(content)
    sequence.config.diagram = { view: 'sequence', layout: 'horizontal' }
    sequence.edges.push({ from: 'service', to: 'client', label: 'Response' })
    const svg = buildDiagramExportSvg(sequence)
    expect(svg.match(/stroke-dasharray="5 6"/g)).toHaveLength(2)
    expect(svg).toContain('d="M140 145 L340 145"')
    expect(svg).toContain('d="M340 213 L140 213"')
  })

  it('removes XML control characters from rendered labels', () => {
    const invalidXmlText = structuredClone(content)
    invalidXmlText.nodes[0].label = 'Client\u0000part'
    const svg = buildDiagramExportSvg(invalidXmlText)
    expect(svg).not.toContain('\u0000')
    expect(svg).toContain('<title>Clientpart</title>')
  })

  it('rejects invalid structure and non-finite saved state at the export boundary', () => {
    const invalid = structuredClone(content)
    invalid.edges[0].to = 'invented-node'
    expect(() => buildDiagramExportHtml(invalid)).toThrow()
    expect(() => buildDiagramExportSvg(content, { diagramSeparation: Number.NaN })).toThrow()
  })

  it('derives separation from a bounded immutable state for exact repeated round-trips', () => {
    const assembled = buildDiagramExportSvg(content, { diagramSeparation: 0 })
    const separated = buildDiagramExportSvg(content, { diagramSeparation: 1 })
    expect(separated).not.toBe(assembled)
    expect(buildDiagramExportSvg(content, { diagramSeparation: 0 })).toBe(assembled)
    expect(buildDiagramExportSvg(content, { diagramSeparation: 1000 })).toBe(separated)
    expect(buildDiagramExportSvg(content, { diagramSeparation: -1000 })).toBe(assembled)
  })
})
