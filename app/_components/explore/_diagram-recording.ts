const drawSvg = async (svg: SVGSVGElement, context: CanvasRenderingContext2D) => {
  const snapshot = svg.cloneNode(true) as SVGSVGElement
  const originals = [svg, ...svg.querySelectorAll('*')]
  const copies = [snapshot, ...snapshot.querySelectorAll('*')]
  originals.forEach((element, index) => {
    for (const attribute of ['fill', 'stroke', 'stop-color', 'flood-color']) {
      if (element.getAttribute(attribute)?.includes('var(')) {
        copies[index].setAttribute(attribute, getComputedStyle(element).getPropertyValue(attribute))
      }
    }
  })
  snapshot.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  snapshot.setAttribute('width', String(context.canvas.width))
  snapshot.setAttribute('height', String(context.canvas.height))
  snapshot.style.fontFamily = 'system-ui, sans-serif'
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(snapshot)], { type: 'image/svg+xml' }),
  )
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    context.drawImage(image, 0, 0, context.canvas.width, context.canvas.height)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export const recordDiagramVideo = async ({
  svg,
  canvas,
  title,
  signal,
}: {
  svg: SVGSVGElement
  canvas?: HTMLCanvasElement
  title: string
  signal: AbortSignal
}) => {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
    throw new Error(
      'This browser cannot record WebM. You can download interactive HTML or a PNG instead.',
    )
  }
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) =>
    MediaRecorder.isTypeSupported(type),
  )
  if (!mimeType)
    throw new Error(
      'WebM recording is unavailable in this browser. Try Chrome or download interactive HTML.',
    )
  const output = document.createElement('canvas')
  output.width = 1280
  output.height = 720
  const staging = document.createElement('canvas')
  staging.width = output.width
  staging.height = output.height
  const context = staging.getContext('2d')
  const captured = output.getContext('2d')
  if (!context || !captured) throw new Error('Video rendering is unavailable.')
  const draw = async () => {
    signal.throwIfAborted()
    context.fillStyle = getComputedStyle(svg).getPropertyValue('--background').trim() || '#17191e'
    context.fillRect(0, 0, output.width, output.height)
    if (canvas) {
      const scale = Math.min(output.width / canvas.width, output.height / canvas.height)
      context.drawImage(
        canvas,
        (output.width - canvas.width * scale) / 2,
        (output.height - canvas.height * scale) / 2,
        canvas.width * scale,
        canvas.height * scale,
      )
    } else await drawSvg(svg, context)
    // Commit complete frames: SVG decoding must not expose a cleared canvas to captureStream.
    captured.drawImage(staging, 0, 0)
  }
  await draw()
  const stream = output.captureStream(12)
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 })
  const chunks: Blob[] = []
  let frame: ReturnType<typeof setTimeout> | undefined
  let end: ReturnType<typeof setTimeout> | undefined
  let stop: () => void = () => {}
  const hide = () => {
    if (document.hidden) stop()
  }
  const cancel = () => stop()
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(frame)
        clearTimeout(end)
        if (recorder.state !== 'inactive') recorder.stop()
        if (error) reject(error)
      }
      stop = () => finish()
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data)
      }
      recorder.onstop = () => resolve()
      recorder.onerror = () => {
        finish(new Error('Video recording failed. Try a PNG export instead.'))
      }
      const render = async () => {
        if (settled) return
        try {
          await draw()
          if (!settled) frame = setTimeout(() => void render(), 1000 / 12)
        } catch (error) {
          finish(error)
        }
      }
      recorder.start()
      signal.addEventListener('abort', cancel, { once: true })
      document.addEventListener('visibilitychange', hide)
      if (signal.aborted) stop()
      else {
        end = setTimeout(stop, 8000)
        void render()
      }
    })
    signal.throwIfAborted()
    if (document.hidden)
      throw new Error(
        'Recording stopped when the tab became hidden. Keep the scene visible and try again.',
      )
    if (!chunks.length) throw new Error('No video frames were captured. Try again.')
    const url = URL.createObjectURL(new Blob(chunks, { type: mimeType }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 80) || 'exploration'
    }.webm`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } finally {
    clearTimeout(frame)
    clearTimeout(end)
    signal.removeEventListener('abort', cancel)
    document.removeEventListener('visibilitychange', hide)
    if (recorder.state !== 'inactive') recorder.stop()
    stream.getTracks().forEach((track) => track.stop())
  }
}
