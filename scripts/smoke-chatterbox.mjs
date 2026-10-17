import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const baseUrl = process.env.MENTOR_APP_URL ?? 'http://127.0.0.1:3000'
const target = new URL(baseUrl)
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname),
  'Use a local Mentor app URL',
)
const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json())
assert.equal(health.speech.provider, 'chatterbox', 'Start the Chatterbox speech service')
assert.equal(health.speech.recognition, true)
assert.equal(health.speech.synthesis, true)
assert.equal(health.speech.conversationSynthesis, true)
assert.ok(health.speech.languages.includes('es'))
assert.notEqual(health.speech.voices.coach, health.speech.voices.partner)

const inspectWave = (bytes) => {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE')
  let format
  let samples
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    assert.ok(start + size <= bytes.length, 'Complete WAV chunk')
    if (name === 'fmt ') {
      format = {
        encoding: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
        bits: bytes.readUInt16LE(start + 14),
      }
    }
    if (name === 'data') samples = bytes.subarray(start, start + size)
    offset = start + size + (size % 2)
  }
  assert.deepEqual(format, { encoding: 1, channels: 1, sampleRate: 24000, bits: 16 })
  assert.ok(samples?.length > 24000, 'At least half a second of speech')
  let energy = 0
  for (let offset = 0; offset < samples.length; offset += 2) {
    energy += (samples.readInt16LE(offset) / 32768) ** 2
  }
  const rms = Math.sqrt(energy / (samples.length / 2))
  assert.ok(rms > 0.001, 'Speech must not be silent')
  return { durationSeconds: samples.length / 48000, rms }
}

const results = []
const voices = []
for (const payload of [
  { text: 'Could you please review my code?', voice: 'coach', language: 'en' },
  { text: 'Could you please review my code?', voice: 'partner', language: 'en' },
  { text: 'Hola. Vamos a practicar una conversación.', voice: 'coach', language: 'es' },
]) {
  const started = performance.now()
  const response = await fetch(`${baseUrl}/api/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(55_000),
  })
  if (!response.ok) assert.fail(await response.text())
  assert.match(response.headers.get('content-type'), /audio\/wav/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const bytes = Buffer.from(await response.arrayBuffer())
  results.push({
    voice: payload.voice,
    language: payload.language,
    synthesisMs: Math.round(performance.now() - started),
    ...inspectWave(bytes),
  })
  if (payload.language === 'en') voices.push(bytes)
}
assert.notEqual(
  createHash('sha256').update(voices[0]).digest('hex'),
  createHash('sha256').update(voices[1]).digest('hex'),
)

const form = new FormData()
form.append('audio', new Blob([voices[0]], { type: 'audio/wav' }), 'chatterbox-smoke.wav')
const response = await fetch(`${baseUrl}/api/transcribe`, { method: 'POST', body: form })
if (!response.ok) assert.fail(await response.text())
const transcript = await response.json()
assert.match(transcript.text.toLowerCase(), /review my code/)

console.log(
  JSON.stringify(
    { passed: true, device: health.speech.device, results, transcript: transcript.text },
    null,
    2,
  ),
)
