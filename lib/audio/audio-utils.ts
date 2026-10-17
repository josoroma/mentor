export const calculateRms = (samples: Float32Array) => {
  if (samples.length === 0) return 0
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / samples.length)
}

export const combineSamples = (chunks: Float32Array[]) => {
  const samples = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    samples.set(chunk, offset)
    offset += chunk.length
  }
  return samples
}

/** A self-contained mono PCM WAV, including a header for every recognition request. */
export const encodeWav = (samples: Float32Array, sampleRate: number) => {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000) {
    throw new Error('Audio sample rate must be at least 8000 Hz')
  }
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      view.setUint8(offset + index, value.charCodeAt(index))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 32768 : sample * 32767, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

const normalizeWord = (word: string) => word.toLowerCase().replace(/[^a-z0-9']/g, '')

/** Joins overlapping recognition windows without repeating the shared words. */
export const mergeTranscript = (previous: string, incoming: string) => {
  if (!previous.trim()) return incoming.trim()
  if (!incoming.trim()) return previous.trim()
  const left = previous.trim().split(/\s+/)
  const right = incoming.trim().split(/\s+/)
  for (let count = Math.min(left.length, right.length, 32); count > 0; count--) {
    if (
      left.slice(-count).every((word, index) => normalizeWord(word) === normalizeWord(right[index]))
    ) {
      return [...left, ...right.slice(count)].join(' ')
    }
  }
  return `${previous.trim()} ${incoming.trim()}`
}

// Small requests keep local neural synthesis responsive within the proxy timeout.
export const SPEECH_CHUNK_LIMIT = 100

/** Preserves every character in trimmed text while preferring sentence and word boundaries. */
export const splitSpeechText = (text: string, limit = SPEECH_CHUNK_LIMIT) => {
  if (!Number.isInteger(limit) || limit < 2)
    throw new RangeError('Speech chunks need at least two characters.')
  const chunks: string[] = []
  let remaining = text.trim()
  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit)
    const sentences = [...candidate.matchAll(/[.!?](?:["'\)\]]+)?\s+|\n+/g)]
    const lastSentence = sentences.at(-1)
    const whitespace = [...candidate.matchAll(/\s+/g)].at(-1)
    let boundary = lastSentence
      ? lastSentence.index! + lastSentence[0].length
      : whitespace
        ? whitespace.index! + whitespace[0].length
        : limit
    // A UTF-16 pair is one spoken character. Never split it across requests.
    const previous = remaining.charCodeAt(boundary - 1)
    const next = remaining.charCodeAt(boundary)
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) boundary -= 1
    chunks.push(remaining.slice(0, boundary))
    remaining = remaining.slice(boundary)
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

/** Keeps unfinished streamed words out of the queue and bounds every spoken segment. */
export const extractSpeechChunks = (text: string, final = false) => {
  const chunks: string[] = []
  let remainder = text
  const enqueue = (complete: string) => {
    chunks.push(
      ...splitSpeechText(complete)
        .map((chunk) => chunk.trim())
        .filter(Boolean),
    )
  }
  while (remainder.length > 0) {
    const match = /[.!?](?:["')\]]*)\s/.exec(remainder)
    if (match) {
      const end = match.index + match[0].length
      enqueue(remainder.slice(0, end))
      remainder = remainder.slice(end)
    } else if (remainder.length > SPEECH_CHUNK_LIMIT) {
      const boundary = [...remainder.slice(0, SPEECH_CHUNK_LIMIT).matchAll(/\s+/g)].at(-1)
      if (!boundary) break
      const end = boundary.index + boundary[0].length
      enqueue(remainder.slice(0, end))
      remainder = remainder.slice(end)
    } else {
      break
    }
  }
  if (final) {
    enqueue(remainder)
    remainder = ''
  }
  return { chunks, remainder }
}

type VoiceActivityOptions = {
  sampleRate: number
  startThreshold?: number
  endThreshold?: number
  silenceMs?: number
  maxDurationMs?: number
  minSpeechMs?: number
}

export type VoiceActivityUpdate = {
  started: boolean
  complete: boolean
  active: boolean
  durationMs: number
  level: number
}

/** Audio time, rather than browser timers, controls turn boundaries. */
export class VoiceActivityBuffer {
  private chunks: Float32Array[] = []
  private preRoll: Float32Array[] = []
  private sampleCount = 0
  private speechSamples = 0
  private silentSamples = 0
  private preRollSamples = 0
  private active = false
  private readonly options: Required<VoiceActivityOptions>

  constructor(options: VoiceActivityOptions) {
    this.options = {
      startThreshold: 0.012,
      endThreshold: 0.008,
      silenceMs: 1100,
      maxDurationMs: 45000,
      minSpeechMs: 220,
      ...options,
    }
  }

  push(samples: Float32Array): VoiceActivityUpdate {
    const level = calculateRms(samples)
    let started = false
    if (!this.active && level >= this.options.startThreshold) {
      this.active = true
      started = true
      this.chunks = [...this.preRoll]
      this.sampleCount = this.preRollSamples
      this.preRoll = []
      this.preRollSamples = 0
    }
    if (!this.active) {
      this.preRoll.push(samples.slice())
      this.preRollSamples += samples.length
      while (this.preRollSamples > this.options.sampleRate * 0.3 && this.preRoll.length > 1) {
        this.preRollSamples -= this.preRoll.shift()!.length
      }
      return { started, complete: false, active: false, durationMs: 0, level }
    }
    this.chunks.push(samples.slice())
    this.sampleCount += samples.length
    if (level >= this.options.endThreshold) {
      this.speechSamples += samples.length
      this.silentSamples = 0
    } else {
      this.silentSamples += samples.length
    }
    const durationMs = (this.sampleCount / this.options.sampleRate) * 1000
    const complete =
      (this.silentSamples / this.options.sampleRate) * 1000 >= this.options.silenceMs ||
      durationMs >= this.options.maxDurationMs
    return { started, complete, active: this.active, durationMs, level }
  }

  snapshot(lastSeconds?: number) {
    const samples = combineSamples(this.chunks)
    return lastSeconds ? samples.slice(-Math.round(this.options.sampleRate * lastSeconds)) : samples
  }

  hasSpeech() {
    return (this.speechSamples / this.options.sampleRate) * 1000 >= this.options.minSpeechMs
  }

  reset() {
    this.chunks = []
    this.preRoll = []
    this.sampleCount = 0
    this.speechSamples = 0
    this.silentSamples = 0
    this.preRollSamples = 0
    this.active = false
  }
}
