import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const baseUrl = process.env.MENTOR_APP_URL ?? 'http://127.0.0.1:3000'
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname))
const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json())
assert.equal(health.speech.recognition, true, 'Whisper must be ready')
const phrase = 'Could you please review my code?'
const results = []
const testPersonas = process.env.MENTOR_TEST_PERSONAS === '1'

const inspectWave = (bytes) => {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE')
  let rate
  let samples
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    assert.ok(start + size <= bytes.length, 'Complete WAV chunk')
    if (name === 'fmt ') {
      assert.equal(bytes.readUInt16LE(start), 1, 'PCM encoding')
      assert.equal(bytes.readUInt16LE(start + 2), 1, 'Mono audio')
      assert.equal(bytes.readUInt16LE(start + 14), 16, '16-bit samples')
      rate = bytes.readUInt32LE(start + 4)
    }
    if (name === 'data') samples = bytes.subarray(start, start + size)
    offset = start + size + (size % 2)
  }
  assert.ok([22050, 24000].includes(rate))
  assert.ok(samples?.length > rate, 'At least half a second of audio')
  let energy = 0
  for (let offset = 0; offset < samples.length; offset += 2) {
    energy += (samples.readInt16LE(offset) / 32768) ** 2
  }
  assert.ok(Math.sqrt(energy / (samples.length / 2)) > 0.001, 'Audio is not silent')
  return samples.length / (2 * rate)
}

for (const provider of ['macos', 'kokoro', 'chatterbox']) {
  assert.equal(health.speech.providers?.[provider]?.synthesis, true, `${provider} must be ready`)
  const hashes = []
  const identities = testPersonas
    ? health.speech.providers[provider].personas
        .filter((persona) => persona.languages.includes('en'))
        .map((persona) => ({ persona: persona.id }))
    : [{ voice: 'coach' }, { voice: 'partner' }]
  assert.ok(identities.length >= 2, `${provider} must have two English conversation voices`)
  for (const identity of identities) {
    const start = performance.now()
    const response = await fetch(`${baseUrl}/api/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: phrase, provider, ...identity, language: 'en' }),
      signal: AbortSignal.timeout(55_000),
    })
    if (!response.ok) assert.fail(await response.text())
    assert.equal(response.headers.get('x-mentor-speech-provider'), provider)
    if (identity.persona)
      assert.equal(response.headers.get('x-mentor-speech-persona'), identity.persona)
    assert.match(response.headers.get('content-type'), /audio\/wav/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const bytes = Buffer.from(await response.arrayBuffer())
    const synthesisMs = Math.round(performance.now() - start)
    const durationSeconds = inspectWave(bytes)
    hashes.push(createHash('sha256').update(bytes).digest('hex'))
    const form = new FormData()
    form.append('audio', new Blob([bytes], { type: 'audio/wav' }), 'provider-smoke.wav')
    const recognized = await fetch(`${baseUrl}/api/transcribe`, { method: 'POST', body: form })
    if (!recognized.ok) assert.fail(await recognized.text())
    const transcript = await recognized.json()
    assert.match(transcript.text.toLowerCase(), /review my code/)
    results.push({
      provider,
      ...identity,
      synthesisMs,
      durationSeconds,
      transcript: transcript.text,
    })
  }
  assert.equal(new Set(hashes).size, identities.length, `${provider} must use distinct voices`)
}

console.log(JSON.stringify({ passed: true, phrase, results }, null, 2))
