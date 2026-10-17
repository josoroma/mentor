import { describe, expect, it } from 'vitest'
import { isMemoryPressureError, normalizeLocalEventLine } from '@/lib/ai/local-stream'
import { compactConversation } from '@/lib/ai/prompts'

describe('MTPLX streaming errors', () => {
  it('preserves the memory error instead of letting the SDK discard it as an empty choice', () => {
    const line = `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'error' }],
      error: { message: 'insufficient memory', code: 'insufficient_memory', status_code: 507 },
    })}`
    const result = JSON.parse(normalizeLocalEventLine(line).slice(5))
    expect(result.choices).toBeUndefined()
    expect(result.error.code).toBe('insufficient_memory')
  })

  it('leaves ordinary output and stream termination untouched', () => {
    const line = 'data: {"choices":[{"delta":{"content":"Hello"}}]}'
    expect(normalizeLocalEventLine(line)).toBe(line)
    expect(normalizeLocalEventLine('data: [DONE]')).toBe('data: [DONE]')
  })

  it('only classifies explicit resource errors for adaptive retry', () => {
    expect(isMemoryPressureError({ statusCode: 507 })).toBe(true)
    expect(isMemoryPressureError(new Error('insufficient memory: compressor full'))).toBe(true)
    expect(isMemoryPressureError(new Error('Connection refused'))).toBe(false)
  })

  it('keeps the newest learner turn even when it exceeds the retry context budget', () => {
    const context = compactConversation([
      { role: 'assistant', content: 'Tell me about the blocker.' },
      { role: 'user', content: `${'context '.repeat(800)}The blocker is missing API access.` },
    ])
    expect(context.at(-1)?.content).toContain('The blocker is missing API access.')
    expect(context.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(
      4500,
    )
  })
})
