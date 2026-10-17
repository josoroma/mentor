import { describe, expect, it } from 'vitest'
import {
  calculateRms,
  encodeWav,
  extractSpeechChunks,
  mergeTranscript,
  SPEECH_CHUNK_LIMIT,
  splitSpeechText,
  VoiceActivityBuffer,
} from '@/lib/audio/audio-utils'

describe('local microphone audio', () => {
  it('encodes independent PCM WAV files with the real input sample rate and clamps clipping', async () => {
    const wav = await encodeWav(new Float32Array([-2, -0.5, 0, 0.5, 2]), 48000).arrayBuffer()
    const view = new DataView(wav)
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe('WAVE')
    expect(view.getUint32(24, true)).toBe(48000)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(10)
    expect(view.getInt16(44, true)).toBe(-32768)
    expect(view.getInt16(48, true)).toBe(0)
    expect(view.getInt16(52, true)).toBe(32767)
  })

  it('measures actual RMS without generating activity for silence', () => {
    expect(calculateRms(new Float32Array(100))).toBe(0)
    expect(calculateRms(new Float32Array([0.5, -0.5]))).toBe(0.5)
    expect(calculateRms(new Float32Array())).toBe(0)
  })

  it('retains pre-roll, tolerates brief pauses, and completes after sustained silence', () => {
    const buffer = new VoiceActivityBuffer({ sampleRate: 10000, silenceMs: 1000 })
    const silence = new Float32Array(1000)
    const voice = new Float32Array(1000).fill(0.05)
    expect(buffer.push(silence).active).toBe(false)
    expect(buffer.push(voice).started).toBe(true)
    buffer.push(voice)
    buffer.push(voice)
    expect(buffer.hasSpeech()).toBe(true)
    for (let index = 0; index < 4; index++) expect(buffer.push(silence).complete).toBe(false)
    expect(buffer.push(voice).complete).toBe(false)
    for (let index = 0; index < 9; index++) expect(buffer.push(silence).complete).toBe(false)
    expect(buffer.push(silence).complete).toBe(true)
    expect(buffer.snapshot().length).toBe(19000)
    expect(buffer.snapshot(0.5).length).toBe(5000)
  })

  it('rejects short microphone bumps and isolates audio between turns', () => {
    const buffer = new VoiceActivityBuffer({ sampleRate: 10000 })
    buffer.push(new Float32Array(1000).fill(0.8))
    expect(buffer.hasSpeech()).toBe(false)
    buffer.reset()
    expect(buffer.snapshot().length).toBe(0)
    expect(buffer.push(new Float32Array(1000)).active).toBe(false)
    expect(buffer.hasSpeech()).toBe(false)
  })

  it('bounds turns even without a silence gap', () => {
    const buffer = new VoiceActivityBuffer({ sampleRate: 10000, maxDurationMs: 300 })
    const voice = new Float32Array(1000).fill(0.05)
    expect(buffer.push(voice).complete).toBe(false)
    expect(buffer.push(voice).complete).toBe(false)
    expect(buffer.push(voice).complete).toBe(true)
  })
})

describe('incremental conversation text', () => {
  it('merges overlapping speech windows without duplicating shared words', () => {
    expect(mergeTranscript('I shipped the new API', 'the new API, and fixed the bug.')).toBe(
      'I shipped the new API and fixed the bug.',
    )
    expect(mergeTranscript('', 'Hello')).toBe('Hello')
    expect(mergeTranscript('Hello', '')).toBe('Hello')
  })

  it('speaks complete sentences immediately and holds partial streamed words', () => {
    expect(extractSpeechChunks('Thanks for the update. What is blo')).toEqual({
      chunks: ['Thanks for the update.'],
      remainder: 'What is blo',
    })
    expect(extractSpeechChunks('What is blocking you?', true)).toEqual({
      chunks: ['What is blocking you?'],
      remainder: '',
    })
    expect(extractSpeechChunks('One. Two! Three? ', true)).toEqual({
      chunks: ['One.', 'Two!', 'Three?'],
      remainder: '',
    })
  })

  it('bounds long complete sentences and final unpunctuated text without losing any words', () => {
    for (const text of [
      `${'I can explain each implementation detail clearly '.repeat(30)}today.`,
      'Discuss the tradeoffs and customer constraints '.repeat(30).trim(),
    ]) {
      const { chunks, remainder } = extractSpeechChunks(text, true)
      expect(chunks.length).toBeGreaterThan(2)
      expect(chunks.every((chunk) => chunk.length <= SPEECH_CHUNK_LIMIT)).toBe(true)
      expect(chunks.join(' ')).toBe(text)
      expect(remainder).toBe('')
    }
  })

  it('splits a single workplace sentence into smaller neural synthesis requests', () => {
    const text =
      'I reviewed the deployment plan with the customer and clarified the rollout risks, acceptance criteria, and monitoring needed before we move to production.'
    const { chunks, remainder } = extractSpeechChunks(text, true)
    expect(chunks).toHaveLength(2)
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true)
    expect(chunks.join(' ')).toBe(text)
    expect(remainder).toBe('')
  })

  it('keeps unfinished streamed words until a boundary arrives across many partial updates', () => {
    const text = `${'Our first milestone is a reliable customer workflow '.repeat(20)}done.`
    let pending = ''
    const spoken: string[] = []
    for (let index = 0; index < text.length; index += 7) {
      const result = extractSpeechChunks(pending + text.slice(index, index + 7))
      spoken.push(...result.chunks)
      pending = result.remainder
    }
    spoken.push(...extractSpeechChunks(pending, true).chunks)
    expect(spoken.every((chunk) => chunk.length <= SPEECH_CHUNK_LIMIT)).toBe(true)
    expect(spoken.join(' ')).toBe(text)
  })

  it('preserves long unbroken multilingual text and every Unicode code point', () => {
    const text = `${'a'.repeat(SPEECH_CHUNK_LIMIT - 1)}🌍${'您好'.repeat(200)}🎯`
    expect(extractSpeechChunks(text).chunks).toEqual([])
    const { chunks } = extractSpeechChunks(text, true)
    expect(chunks.join('')).toBe(text)
    expect(
      chunks.every((chunk) => chunk.length <= SPEECH_CHUNK_LIMIT && chunk.isWellFormed()),
    ).toBe(true)
    expect(splitSpeechText(`  ${text}  `).join('')).toBe(text)
  })
})
