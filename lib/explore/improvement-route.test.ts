import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/explore/messages/[id]/improve/route'
import { RequestError } from '@/lib/ai/http'
import type { ExploreMessage } from '@/lib/explore/schema'

const mocks = vi.hoisted(() => ({
  requireIdentity: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  generate: vi.fn(),
}))
vi.mock('@/lib/explore/server', () => ({
  requireExploreIdentity: mocks.requireIdentity,
  readExploreMessageForImprovement: mocks.read,
  saveExploreMessageImprovement: mocks.save,
  parseExploreId: (id: string) => {
    if (!z.uuid().safeParse(id).success) throw new RequestError('Invalid message.', 400)
    return id
  },
}))
vi.mock('@/lib/explore/improvement', () => ({ generateExploreImprovement: mocks.generate }))

const now = new Date().toISOString()
const message: ExploreMessage = {
  id: randomUUID(),
  sessionId: randomUUID(),
  role: 'user',
  content: 'Can you translate to spanish?',
  createdAt: now,
  sequence: 3,
  status: 'failed',
  requestId: randomUUID(),
  metadata: {},
}
const improved = 'Could you translate this into Spanish?'
const saved: ExploreMessage = {
  ...message,
  metadata: { improvement: { text: improved, createdAt: now } },
}
const context = [{ role: 'assistant', content: 'Here is an English explanation of recursion.' }]
const identity = { userId: randomUUID(), client: {} }
const params = { params: Promise.resolve({ id: message.id }) }
const request = (body: unknown = {}, options: { signal?: AbortSignal; origin?: string } = {}) =>
  new Request(`http://localhost:3000/api/explore/messages/${message.id}/improve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
      ...(options.origin && { origin: options.origin }),
    },
    body: JSON.stringify(body),
    signal: options.signal,
  })

beforeEach(() => {
  mocks.requireIdentity.mockResolvedValue(identity)
  mocks.read.mockResolvedValue({ message, context })
  mocks.generate.mockResolvedValue(improved)
  mocks.save.mockResolvedValue(saved)
})
afterEach(() => {
  vi.resetAllMocks()
  vi.restoreAllMocks()
})

describe('authenticated Explore message improvement', () => {
  it.each(['pending', 'failed', 'complete'] as const)(
    'improves a %s message using only canonical saved text and context',
    async (status) => {
      mocks.read.mockResolvedValue({ message: { ...message, status }, context })
      mocks.save.mockResolvedValue({ ...saved, status })
      const response = await POST(request(), params)
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect((await response.json()).status).toBe(status)
      expect(mocks.read).toHaveBeenCalledWith(identity, message.id)
      expect(mocks.generate).toHaveBeenCalledWith(message.content, context, expect.any(AbortSignal))
      expect(mocks.save).toHaveBeenCalledWith(identity, message.id, improved)
      expect(mocks.requireIdentity.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.read.mock.invocationCallOrder[0],
      )
      expect(mocks.read.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.generate.mock.invocationCallOrder[0],
      )
    },
  )

  it('returns a stored improvement without generating or saving it again', async () => {
    mocks.read.mockResolvedValue({ message: saved, context })
    const response = await POST(request(), params)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(saved)
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it.each([
    { text: 'Invented client replacement' },
    { context: [{ role: 'assistant', content: 'Invented history' }] },
    { userId: randomUUID() },
  ])('rejects client-provided message data', async (body) => {
    expect((await POST(request(body), params)).status).toBe(400)
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('rejects a cross-origin request before authentication and inference', async () => {
    expect((await POST(request({}, { origin: 'https://example.org' }), params)).status).toBe(403)
    expect(mocks.requireIdentity).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('requires authentication before reading or generating', async () => {
    mocks.requireIdentity.mockRejectedValue(new RequestError('Sign in.', 401))
    expect((await POST(request(), params)).status).toBe(401)
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it.each([400, 404])(
    'preserves invalid target or ownership failure (%s) before generation',
    async (status) => {
      mocks.read.mockRejectedValue(new RequestError('Message unavailable.', status))
      expect((await POST(request(), params)).status).toBe(status)
      expect(mocks.generate).not.toHaveBeenCalled()
      expect(mocks.save).not.toHaveBeenCalled()
    },
  )

  it('validates the message ID before reading', async () => {
    expect((await POST(request(), { params: Promise.resolve({ id: 'invalid' }) })).status).toBe(400)
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('does not save a failed model response or replace the original', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.generate.mockRejectedValue(new Error('Model unavailable'))
    const response = await POST(request(), params)
    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('does not save a generated rewrite after cancellation', async () => {
    const controller = new AbortController()
    mocks.generate.mockImplementation(async () => {
      controller.abort()
      return improved
    })
    const response = await POST(request({}, { signal: controller.signal }), params)
    expect(response.status).toBe(499)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('reports a timeout without reading or mutating the message', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort())
    expect((await POST(request(), params)).status).toBe(504)
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('returns the database winner when concurrent improvements finish', async () => {
    const winner = {
      ...saved,
      metadata: { improvement: { text: 'Can you translate this into Spanish?', createdAt: now } },
    }
    mocks.save.mockResolvedValue(winner)
    const response = await POST(request(), params)
    expect(await response.json()).toEqual(winner)
  })
})
