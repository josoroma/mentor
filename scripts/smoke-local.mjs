import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

const baseUrl = process.env.MENTOR_APP_URL ?? 'http://127.0.0.1:3000'
const timings = {}

const time = async (name, operation) => {
  const start = performance.now()
  const result = await operation()
  timings[name] = Math.round(performance.now() - start)
  return result
}

const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json())
assert.equal(health.coach.available, true, 'Start npm run coach:start')
assert.equal(health.speech.available, true, 'Start npm run speech:start')

const phrase = 'Yesterday I fixed the login bug and added a regression test. Today I will request a code review.'
const audio = await time('synthesisMs', async () => {
  const response = await fetch(`${baseUrl}/api/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: phrase }),
  })
  if (!response.ok) assert.fail(await response.text())
  assert.match(response.headers.get('content-type'), /audio\/wav/)
  return response.blob()
})

const transcript = await time('transcriptionMs', async () => {
  const form = new FormData()
  form.append('audio', audio, 'smoke.wav')
  const response = await fetch(`${baseUrl}/api/transcribe`, { method: 'POST', body: form })
  if (!response.ok) assert.fail(await response.text())
  return response.json()
})
assert.match(transcript.text.toLowerCase(), /login/)
assert.match(transcript.text.toLowerCase(), /code review/)

const context = {
  scenarioId: 'daily-standup',
  roleId: 'deployed-ai-developer',
  level: 'B2',
  messages: [{ role: 'user', content: transcript.text }],
}

const reply = await time('coachResponseMs', async () => {
  const start = performance.now()
  const response = await fetch(`${baseUrl}/api/coach`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(context),
  })
  if (!response.ok) assert.fail(await response.text())
  assert.match(response.headers.get('content-type'), /text\/plain/)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let chunks = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!chunks) timings.coachFirstChunkMs = Math.round(performance.now() - start)
    chunks += 1
    text += decoder.decode(value, { stream: true })
  }
  assert.ok(text.length > 10, 'Expected a substantive coach response')
  return text
})

const feedback = await time('feedbackMs', async () => {
  const response = await fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...context, durationSeconds: 60 }),
  })
  if (!response.ok) assert.fail(await response.text())
  return response.json()
})
assert.equal(feedback.source, 'local-model')
assert.equal(feedback.metrics.find((metric) => metric.key === 'pronunciation').score, null)
assert.ok(feedback.summary.length > 10)

const invalid = await fetch(`${baseUrl}/api/coach`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
})
assert.equal(invalid.status, 400)

console.log(JSON.stringify({
  passed: true,
  health,
  transcript: transcript.text,
  reply,
  feedback: { summary: feedback.summary, rewrites: feedback.rewrites },
  timings,
}, null, 2))
