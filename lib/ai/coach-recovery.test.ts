import { afterEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/coach/route'

const request = () =>
  new Request('http://localhost:3000/api/coach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scenarioId: 'daily-standup',
      roleId: 'deployed-ai-developer',
      level: 'B2',
      messages: [
        { role: 'user', content: 'I fixed the login bug. I need a review before deploying.' },
      ],
    }),
  })

const sseResponse = (error: boolean) => {
  const base = { id: 'chatcmpl-test', model: 'mtplx', created: 1, object: 'chat.completion.chunk' }
  const event = error
    ? {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
        error: {
          message: 'insufficient memory: compressor full',
          code: 'insufficient_memory',
          type: 'server_error',
        },
      }
    : {
        ...base,
        choices: [
          {
            index: 0,
            delta: { content: 'Who can review the change today?' },
            finish_reason: 'stop',
          },
        ],
      }
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('coach recovery before speech begins', () => {
  it('retries a real MTPLX error frame once with a smaller prompt and returns only the successful reply', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, init) => {
        calls.push(String(init?.body))
        return sseResponse(calls.length === 1)
      }),
    )
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('X-Mentor-Context')).toBe('reduced')
    expect(await response.text()).toBe('Who can review the change today?')
    expect(calls).toHaveLength(2)
    expect(calls[1].length).toBeLessThan(calls[0].length)
  })

  it('stops after the second resource failure with an actionable error', async () => {
    const fetchMock = vi.fn(async () => sseResponse(true))
    vi.stubGlobal('fetch', fetchMock)
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect((await response.json()).error).toContain('more free memory')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry unrelated connection errors', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('Connection refused')
    })
    vi.stubGlobal('fetch', fetchMock)
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
