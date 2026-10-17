import {
  ExploreArtifactContentSchema,
  ExploreLearningStateSchema,
  type ExploreArtifactContent,
  type ExploreLearningState,
} from '@/lib/explore/schema'
import { diagramProjection } from '@/app/_components/explore/_diagram-model'

export type DiagramExportFormat = 'svg' | 'png' | 'html' | 'card'

type DiagramExportOptions = {
  format: DiagramExportFormat
  content: ExploreArtifactContent
  state?: ExploreLearningState
  svg?: SVGSVGElement
  canvas?: HTMLCanvasElement | null
}

type Point = { x: number; y: number }

const escapeMarkup = (text: string) =>
  text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/[&<>"']/g, (character) => {
      const entities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }
      return entities[character]
    })

const safeJson = (value: unknown) =>
  JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    const escapes: Record<string, string> = {
      '<': '\\u003c',
      '>': '\\u003e',
      '&': '\\u0026',
      '\u2028': '\\u2028',
      '\u2029': '\\u2029',
    }
    return escapes[character]
  })

const splitLabel = (text: string, columns: number, limit: number) => {
  const chunks: string[] = []
  let remaining = text.trim()
  while (remaining && chunks.length < limit) {
    if (remaining.length <= columns) {
      chunks.push(remaining)
      break
    }
    if (chunks.length === limit - 1) {
      chunks.push(`${remaining.slice(0, columns - 1)}…`)
      break
    }
    const space = remaining.lastIndexOf(' ', columns)
    const end = space > columns / 2 ? space : columns
    chunks.push(remaining.slice(0, end))
    remaining = remaining.slice(end).trimStart()
  }
  return chunks
}

// This pure function is also embedded in the offline viewer. It has no external dependencies.
const exportEdgePath = (from: Point, to: Point, width: number, height: number) => {
  if (from.x === to.x && from.y === to.y)
    return `M${from.x + width / 4} ${from.y - height / 2} C${from.x + width} ${from.y - height * 2} ${from.x - width} ${from.y - height * 2} ${from.x - width / 4} ${from.y - height / 2}`
  const dx = to.x - from.x
  const dy = to.y - from.y
  const trim = Math.min(
    width / 2 / Math.max(Math.abs(dx), 0.001),
    height / 2 / Math.max(Math.abs(dy), 0.001),
    0.45,
  )
  return `M${from.x + dx * trim} ${from.y + dy * trim} L${to.x - dx * trim} ${to.y - dy * trim}`
}

const createSnapshot = (input: ExploreArtifactContent, rawState: ExploreLearningState) => {
  const content = ExploreArtifactContentSchema.parse(input)
  if (content.kind !== 'diagram') throw new Error('Only diagram explorations support this export.')
  const state = ExploreLearningStateSchema.parse(rawState)
  const separation = Math.max(
    0,
    Math.min(1, typeof state.diagramSeparation === 'number' ? state.diagramSeparation : 0),
  )
  const projection = diagramProjection(content, separation)
  const positions = new Map(projection.points.map((point) => [point.id, point]))
  const selected =
    content.nodes.find((node) => node.id === state.diagramNode)?.id ?? content.nodes[0]?.id ?? ''
  return {
    content,
    projection,
    separation,
    selected,
    nodes: content.nodes.map((node) => ({ ...node, ...positions.get(node.id)! })),
  }
}

type Snapshot = ReturnType<typeof createSnapshot>

const renderSnapshotSvg = (snapshot: Snapshot) => {
  const { content, projection, nodes, selected } = snapshot
  const { width, height, nodeWidth, nodeHeight } = projection
  const sequence = content.config.diagram?.view === 'sequence'
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const lifelines = sequence
    ? nodes
        .map(
          (node) =>
            `<line x1="${node.x}" x2="${node.x}" y1="${node.y + nodeHeight / 2}" y2="${height - 30}" stroke="#4b5c73" stroke-dasharray="5 6"/>`,
        )
        .join('')
    : ''
  const edges = content.edges
    .map((edge, index) => {
      const source = nodeMap.get(edge.from)!
      const target = nodeMap.get(edge.to)!
      const from = sequence ? { ...source, y: 145 + index * 68 } : source
      const to = sequence ? { ...target, y: 145 + index * 68 } : target
      const path = sequence
        ? edge.from === edge.to
          ? `M${from.x} ${from.y} h65 v28 h-65`
          : `M${from.x} ${from.y} L${to.x} ${to.y}`
        : exportEdgePath(from, to, nodeWidth, nodeHeight)
      const title = escapeMarkup(
        `${from.label} → ${to.label}${edge.label ? `: ${edge.label}` : ''}`,
      )
      return `<g data-edge-index="${index}"><title>${title}</title><path d="${path}" fill="none" stroke="#71849a" stroke-width="1.6" marker-end="url(#export-arrow)"/><text x="${(from.x + to.x) / 2}" y="${(from.y + to.y) / 2 - 10}" fill="#b5c4d5" font-size="11" text-anchor="middle" paint-order="stroke" stroke="#101722" stroke-width="5" stroke-linejoin="round">${escapeMarkup(splitLabel(edge.label, 28, 1).join(''))}</text></g>`
    })
    .join('')
  const nodeMarkup = nodes
    .map((node, index) => {
      const lines = splitLabel(node.label, Math.max(12, Math.floor(nodeWidth / 7.5)), 3)
      const label = lines
        .map(
          (line, lineIndex) =>
            `<tspan x="0" y="${(lineIndex - (lines.length - 1) / 2) * 15 + 4}">${escapeMarkup(line)}</tspan>`,
        )
        .join('')
      return `<g data-node-index="${index}" transform="translate(${node.x} ${node.y})" role="button" tabindex="0" aria-label="${escapeMarkup(`Inspect ${node.label}`)}" aria-pressed="${node.id === selected}"><title>${escapeMarkup(node.label)}</title><desc>${escapeMarkup(node.detail)}</desc><rect x="${-nodeWidth / 2}" y="${-nodeHeight / 2}" width="${nodeWidth}" height="${nodeHeight}" rx="10" fill="#1b2737" stroke="${node.id === selected ? '#75b2ff' : '#4b5c73'}" stroke-width="1.8"/><text fill="#edf3fb" font-size="12" text-anchor="middle">${label}</text></g>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="group" tabindex="0" aria-label="${escapeMarkup(content.title)}" font-family="Arial, sans-serif"><title>${escapeMarkup(content.title)}</title><desc>${escapeMarkup(`${content.summary} Portable conceptual schematic. Connections are structurally validated, not verified against a repository.`)}</desc><metadata>${escapeMarkup(JSON.stringify(content))}</metadata><rect width="${width}" height="${height}" fill="#101722"/><defs><marker id="export-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8Z" fill="#71849a"/></marker></defs><g data-diagram-world="true">${lifelines}${edges}${nodeMarkup}</g></svg>`
}

export const buildDiagramExportSvg = (
  content: ExploreArtifactContent,
  state: ExploreLearningState = {},
  sharingCard = false,
) => {
  const snapshot = createSnapshot(content, state)
  const schematic = renderSnapshotSvg(snapshot)
  if (!sharingCard) return schematic
  const title = splitLabel(snapshot.content.title, 66, 2)
    .map((line, index) => `<tspan x="48" y="${83 + index * 33}">${escapeMarkup(line)}</tspan>`)
    .join('')
  const minX = Math.min(...snapshot.nodes.map((node) => node.x)) - 140
  const minY = Math.min(...snapshot.nodes.map((node) => node.y)) - 130
  const maxX = Math.max(...snapshot.nodes.map((node) => node.x)) + 140
  const maxY =
    snapshot.content.config.diagram?.view === 'sequence'
      ? Math.max(180, 145 + snapshot.content.edges.length * 68)
      : Math.max(...snapshot.nodes.map((node) => node.y)) + 90
  const nested = schematic
    .replace('<svg ', '<svg x="48" y="145" ')
    .replace(`width="${snapshot.projection.width}"`, 'width="1104"')
    .replace(`height="${snapshot.projection.height}"`, 'height="409"')
    .replace(
      `viewBox="0 0 ${snapshot.projection.width} ${snapshot.projection.height}"`,
      `viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}"`,
    )
  const connectionLabel = snapshot.content.edges.length === 1 ? 'connection' : 'connections'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="Arial, sans-serif"><rect width="1200" height="630" fill="#101722"/><text x="48" y="35" fill="#75b2ff" font-size="13" letter-spacing="2">MENTOR · EXPLORE</text><text fill="#edf3fb" font-size="28" font-weight="600">${title}</text>${nested}<text x="48" y="592" fill="#9daec2" font-size="14">Conceptual schematic · ${snapshot.nodes.length} parts · ${snapshot.content.edges.length} ${connectionLabel}</text><text x="1152" y="592" fill="#9daec2" font-size="12" text-anchor="end">1200 × 630</text></svg>`
}

// Only this trusted runtime becomes executable in an export. All learner/model text is JSON or text.
const portableDiagramRuntime = () => {
  const source = document.getElementById('diagram-data')
  if (!source) return
  const data = JSON.parse(source.textContent ?? '{}') as Snapshot
  const svg = document.querySelector('svg')!
  const world = svg.querySelector<SVGGElement>('[data-diagram-world]')!
  const nodeElements = Array.from(svg.querySelectorAll<SVGGElement>('[data-node-index]'))
  const edgeElements = Array.from(svg.querySelectorAll<SVGGElement>('[data-edge-index]'))
  const search = document.getElementById('search') as HTMLInputElement
  const separationInput = document.getElementById('separation') as HTMLInputElement
  const stepInput = document.getElementById('chapter') as HTMLInputElement
  const playButton = document.getElementById('play') as HTMLButtonElement
  const details = document.getElementById('detail')!
  const detailTitle = document.getElementById('detail-title')!
  const status = document.getElementById('status')!
  let zoom = 1
  let pan = { x: 0, y: 0 }
  let separation = data.separation
  let selected = data.selected
  let timer: ReturnType<typeof setInterval> | null = null
  let chapter = 0
  let drag: { x: number; y: number; panX: number; panY: number } | null = null
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
  const paintCamera = () => {
    world.setAttribute('transform', `translate(${pan.x} ${pan.y}) scale(${zoom})`)
  }
  const stop = () => {
    if (timer !== null) clearInterval(timer)
    timer = null
    playButton.textContent = 'Play chapters'
  }
  const point = (node: Snapshot['nodes'][number]) => ({
    x: node.restX + node.separationX * separation,
    y: node.restY + node.separationY * separation,
  })
  const select = (index: number, focus = false) => {
    const node = data.nodes[index]
    if (!node) return
    selected = node.id
    detailTitle.textContent = node.label
    details.textContent = node.detail || 'No additional detail was supplied.'
    nodeElements.forEach((element, current) => {
      const active = current === index
      element.setAttribute('aria-pressed', String(active))
      element.querySelector('rect')!.setAttribute('stroke', active ? '#75b2ff' : '#4b5c73')
      element.querySelector('rect')!.setAttribute('stroke-width', active ? '3' : '1.8')
    })
    if (focus) {
      const position = point(node)
      const viewportWidth = Math.max(240, svg.getBoundingClientRect().width)
      zoom = Math.max(zoom, Math.min(4, (data.projection.width / viewportWidth) * 1.25))
      pan = {
        x: data.projection.width / 2 - position.x * zoom,
        y: data.projection.height / 2 - position.y * zoom,
      }
      paintCamera()
    }
  }
  const updateSeparation = () => {
    const positions = new Map(data.nodes.map((node) => [node.id, point(node)]))
    nodeElements.forEach((element, index) => {
      const position = point(data.nodes[index])
      element.setAttribute('transform', `translate(${position.x} ${position.y})`)
    })
    edgeElements.forEach((element, index) => {
      if (data.content.config.diagram?.view === 'sequence') return
      const edge = data.content.edges[index]
      const from = positions.get(edge.from)!
      const to = positions.get(edge.to)!
      // The export generator assigns this trusted helper before starting the runtime.
      const path = (
        window as Window & {
          diagramExportEdgePath?: (from: Point, to: Point, width: number, height: number) => string
        }
      ).diagramExportEdgePath!
      element
        .querySelector('path')!
        .setAttribute('d', path(from, to, data.projection.nodeWidth, data.projection.nodeHeight))
      element.querySelector('text')!.setAttribute('x', String((from.x + to.x) / 2))
      element.querySelector('text')!.setAttribute('y', String((from.y + to.y) / 2 - 10))
    })
    separationInput.value = String(separation)
    document.getElementById('separation-value')!.textContent = `${Math.round(separation * 100)}%`
  }
  const changeZoom = (factor: number) => {
    stop()
    const previous = zoom
    zoom = clamp(zoom * factor, 0.25, 4)
    const center = { x: data.projection.width / 2, y: data.projection.height / 2 }
    pan = {
      x: center.x - ((center.x - pan.x) * zoom) / previous,
      y: center.y - ((center.y - pan.y) * zoom) / previous,
    }
    paintCamera()
  }
  const reset = () => {
    stop()
    zoom = 1
    pan = { x: 0, y: 0 }
    separation = 0
    search.value = ''
    nodeElements.forEach((element) => element.removeAttribute('opacity'))
    status.textContent = 'View reset. All parts are assembled.'
    paintCamera()
    updateSeparation()
  }
  const setChapter = (value: number) => {
    chapter = clamp(value, 0, data.content.steps.length - 1)
    const step = data.content.steps[chapter]
    if (!step) return
    stepInput.value = String(chapter)
    document.getElementById('chapter-title')!.textContent = `${chapter + 1}. ${step.title}`
    document.getElementById('chapter-body')!.textContent = step.body
    const index = data.nodes.findIndex((node) => step.focus?.includes(node.id))
    if (index >= 0) select(index)
    nodeElements.forEach((element, index) => {
      element.setAttribute(
        'opacity',
        !step.focus?.length || step.focus.includes(data.nodes[index].id) ? '1' : '0.4',
      )
    })
  }
  nodeElements.forEach((element, index) => {
    element.addEventListener('click', () => {
      stop()
      select(index)
    })
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        stop()
        select(index)
      }
    })
  })
  document.getElementById('zoom-in')!.addEventListener('click', () => changeZoom(1.2))
  document.getElementById('zoom-out')!.addEventListener('click', () => changeZoom(1 / 1.2))
  document.getElementById('reset')!.addEventListener('click', reset)
  document.getElementById('focus')!.addEventListener('click', () => {
    stop()
    select(
      data.nodes.findIndex((node) => node.id === selected),
      true,
    )
  })
  search.addEventListener('input', () => {
    stop()
    const query = search.value.trim().toLocaleLowerCase()
    const matches = data.nodes.map((node) =>
      `${node.label} ${node.detail}`.toLocaleLowerCase().includes(query),
    )
    nodeElements.forEach((element, index) => {
      element.setAttribute('opacity', matches[index] ? '1' : '0.25')
    })
    status.textContent = `${matches.filter(Boolean).length} matching parts`
    const first = matches.indexOf(true)
    if (query && first >= 0) select(first, true)
  })
  separationInput.addEventListener('input', () => {
    stop()
    separation = clamp(Number(separationInput.value), 0, 1)
    updateSeparation()
  })
  stepInput.addEventListener('input', () => {
    stop()
    setChapter(Number(stepInput.value))
  })
  playButton.addEventListener('click', () => {
    if (timer !== null) return stop()
    if (!data.content.steps.length) return
    if (chapter >= data.content.steps.length - 1) setChapter(0)
    playButton.textContent = 'Pause chapters'
    timer = setInterval(() => {
      if (chapter >= data.content.steps.length - 1) return stop()
      setChapter(chapter + 1)
      if (chapter >= data.content.steps.length - 1) stop()
    }, 4000)
  })
  svg.addEventListener('keydown', (event) => {
    if (event.target !== svg) return
    if (
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home'].includes(
        event.key,
      )
    )
      return
    event.preventDefault()
    stop()
    if (event.key === 'Home') return reset()
    if (event.key === '+' || event.key === '=') return changeZoom(1.2)
    if (event.key === '-') return changeZoom(1 / 1.2)
    pan.x += event.key === 'ArrowLeft' ? -40 : event.key === 'ArrowRight' ? 40 : 0
    pan.y += event.key === 'ArrowUp' ? -40 : event.key === 'ArrowDown' ? 40 : 0
    paintCamera()
  })
  const localPoint = (event: PointerEvent) => {
    const local = svg.createSVGPoint()
    local.x = event.clientX
    local.y = event.clientY
    return local.matrixTransform(svg.getScreenCTM()!.inverse())
  }
  svg.addEventListener('pointerdown', (event) => {
    if ((event.target as Element).closest('[data-node-index]') || event.button !== 0) return
    stop()
    const position = localPoint(event)
    drag = { x: position.x, y: position.y, panX: pan.x, panY: pan.y }
    svg.setPointerCapture(event.pointerId)
  })
  svg.addEventListener('pointermove', (event) => {
    if (!drag) return
    const position = localPoint(event)
    pan = { x: drag.panX + position.x - drag.x, y: drag.panY + position.y - drag.y }
    paintCamera()
  })
  const endDrag = (event: PointerEvent) => {
    drag = null
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId)
  }
  svg.addEventListener('pointerup', endDrag)
  svg.addEventListener('pointercancel', endDrag)
  svg.addEventListener('lostpointercapture', () => {
    drag = null
  })
  svg.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      changeZoom(event.deltaY < 0 ? 1.1 : 1 / 1.1)
    },
    { passive: false },
  )
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop()
  })
  window.addEventListener('pagehide', stop)
  select(
    Math.max(
      0,
      data.nodes.findIndex((node) => node.id === selected),
    ),
  )
  separationInput.disabled = data.content.config.diagram?.view === 'sequence'
  updateSeparation()
  if (data.content.steps.length) setChapter(0)
}

export const buildDiagramExportHtml = (
  content: ExploreArtifactContent,
  state: ExploreLearningState = {},
) => {
  const snapshot = createSnapshot(content, state)
  const clean = snapshot.content
  const assumptions = clean.assumptions.length
    ? `<ul>${clean.assumptions.map((item) => `<li>${escapeMarkup(item)}</li>`).join('')}</ul>`
    : '<p>No additional assumptions were supplied.</p>'
  const evidence = clean.edges
    .map((edge) => {
      const from = clean.nodes.find((node) => node.id === edge.from)!
      const to = clean.nodes.find((node) => node.id === edge.to)!
      return `<li><strong>${escapeMarkup(from.label)} → ${escapeMarkup(to.label)}</strong>: ${escapeMarkup(edge.label || 'Connection')}. ${edge.evidence?.kind === 'provided' ? `Learner-supplied quotation: <q>${escapeMarkup(edge.evidence.quote)}</q>` : 'Illustrative connection; no source quotation supplied.'}</li>`
    })
    .join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeMarkup(clean.title)} · Mentor Explore</title><style>
*{box-sizing:border-box}body{margin:0;background:#0b111b;color:#edf3fb;font:16px/1.55 system-ui,sans-serif}main{max-width:1220px;padding:30px 22px;margin:auto}h1{font-size:clamp(25px,4vw,40px);line-height:1.15;margin:8px 0 14px}h2{font-size:18px;margin:0 0 8px}p{margin:8px 0;color:#b5c4d5}.eyebrow{color:#75b2ff;letter-spacing:.14em;font-size:12px}.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:20px 0 14px}button,input{font:inherit}button,input[type=search]{border:1px solid #4b5c73;background:#1b2737;color:#edf3fb;border-radius:8px;min-height:42px;padding:8px 12px}button{cursor:pointer}button:hover{border-color:#75b2ff}button:focus-visible,input:focus-visible,svg:focus-visible,[data-node-index]:focus-visible{outline:3px solid #75b2ff;outline-offset:3px}input[type=search]{width:min(100%,290px)}label{display:inline-flex;align-items:center;gap:9px}input[type=range]{accent-color:#75b2ff;max-width:40vw}.stage{overflow:hidden;border:1px solid #35465b;border-radius:12px;background:#101722}.stage svg{display:block;width:100%;height:auto;max-height:72vh;min-height:280px;touch-action:none;cursor:grab}.stage svg:active{cursor:grabbing}[data-node-index]{cursor:pointer}.panels{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}.panel{padding:20px;background:#111a28;border:1px solid #35465b;border-radius:12px;overflow-wrap:anywhere}.muted{font-size:13px;color:#9daec2}#detail,#chapter-body{white-space:pre-wrap}summary{cursor:pointer}li{margin:10px 0}q{white-space:pre-wrap}#chapter{flex:1;min-width:100px}#status{min-height:1.5em} @media(max-width:640px){main{padding:20px 14px}.panels{grid-template-columns:1fr}.toolbar{gap:8px}.stage svg{min-height:250px}input[type=search]{width:100%}}
</style></head><body><main><div class="eyebrow">MENTOR · EXPLORE · PORTABLE SCHEMATIC</div><h1>${escapeMarkup(clean.title)}</h1><p>${escapeMarkup(clean.summary)}</p><p class="muted">Conceptual 2D schematic. Connections are structurally validated; repository behavior and real-world dimensions are not verified by this export. This file works offline.</p>
<div class="toolbar"><input id="search" type="search" aria-label="Search parts" placeholder="Search parts…"><button id="zoom-out" aria-label="Zoom out">−</button><button id="zoom-in" aria-label="Zoom in">+</button><button id="focus">Focus selected</button><button id="reset">Reset view</button><label>Separate <input id="separation" aria-label="Part separation" type="range" min="0" max="1" step="0.01" value="${snapshot.separation}"><output id="separation-value">${Math.round(snapshot.separation * 100)}%</output></label></div>
<p class="muted">Drag to pan · scroll to zoom · select a part · arrow keys pan · + / − zoom · Home resets</p><div class="stage">${renderSnapshotSvg(snapshot)}</div><p id="status" class="muted" role="status" aria-live="polite"></p><div class="panels"><section class="panel"><h2 id="detail-title">Inspect a part</h2><p id="detail"></p></section><section class="panel"${clean.steps.length ? '' : ' hidden'}><h2 id="chapter-title">Chapters</h2><p id="chapter-body"></p><div class="toolbar"><button id="play">Play chapters</button><input id="chapter" aria-label="Chapter" type="range" min="0" max="${Math.max(0, clean.steps.length - 1)}" step="1" value="0"></div></section></div>
<details class="panel" style="margin-top:18px"><summary>Assumptions and connection sources</summary><h2 style="margin-top:16px">Assumptions</h2>${assumptions}<h2>Connection sources</h2>${evidence ? `<ul>${evidence}</ul>` : '<p>No connections were supplied.</p>'}<p class="muted">Structural checks confirm unique node identifiers, valid connection endpoints, and valid chapter focus. A source quotation records supplied evidence; it does not independently verify an implementation.</p></details></main><script id="diagram-data" type="application/json">${safeJson(snapshot)}</script><script>window.diagramExportEdgePath = ${exportEdgePath.toString()};(${portableDiagramRuntime.toString()})()</script></body></html>`
}

const canvasBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error('The browser could not export this image.')),
      'image/png',
    )
  })

const renderPng = async (markup: string, width: number, height: number) => {
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('The browser could not render this schematic.'))
      image.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image export needs a browser with canvas support.')
    context.drawImage(image, 0, 0, width, height)
    return await canvasBlob(canvas)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function downloadDiagramExport({
  format,
  content,
  state = {},
  canvas,
}: DiagramExportOptions) {
  // Revalidate before embedding or drawing any model/stored data into an exported file.
  const snapshot = createSnapshot(content, state)
  let blob: Blob
  if (format === 'html')
    blob = new Blob([buildDiagramExportHtml(content, state)], { type: 'text/html;charset=utf-8' })
  else if (format === 'svg')
    blob = new Blob([renderSnapshotSvg(snapshot)], { type: 'image/svg+xml;charset=utf-8' })
  else if (format === 'png' && canvas) blob = await canvasBlob(canvas)
  else {
    const card = format === 'card'
    blob = await renderPng(
      buildDiagramExportSvg(content, state, card),
      card ? 1200 : snapshot.projection.width,
      card ? 630 : snapshot.projection.height,
    )
  }
  const filename =
    content.title
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9 _-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'mentor-exploration'
  const extension = format === 'card' ? 'png' : format
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${filename}${format === 'card' ? '-sharing-card' : ''}.${extension}`
  document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
