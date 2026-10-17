import { describe, expect, it } from 'vitest'
import { introducesConcreteClaim, parseFeedback } from '@/lib/ai/feedback'
import { boundConversation } from '@/lib/ai/prompts'

const draft = {
  summary: 'Clear technical context.',
  overallScore: 99,
  metrics: [
    { key: 'grammar', label: 'Grammar', score: 80, feedback: 'Use the past tense.' },
    { key: 'clarity', label: 'Clarity', score: 70, feedback: 'Lead with the outcome.' },
    { key: 'vocabulary', label: 'Vocabulary', score: 90, feedback: 'Name the constraint.' },
    { key: 'pronunciation', label: 'Pronunciation', score: 100, feedback: 'Unsupported claim.' },
  ],
  strengths: ['You named the blocker.'],
  improvements: ['State a next step.'],
  rewrites: [
    { original: 'I fixed the bug', improved: 'I resolved the issue', reason: 'More precise.' },
    { original: 'I deployed to Mars', improved: 'I shipped a release', reason: 'Invented quote.' },
  ],
  nextStep: 'Practice a concise standup.',
  source: 'local-model',
}

describe('grounded transcript feedback', () => {
  it('removes invented quotes and prevents audio-only scores', () => {
    const result = parseFeedback(JSON.stringify(draft), [
      { role: 'user', content: 'I fixed the bug yesterday.' },
    ])
    expect(result.rewrites).toHaveLength(1)
    expect(result.overallScore).toBeNull()
    expect(result.metrics.find((metric) => metric.key === 'pronunciation')?.score).toBeNull()
    expect(result.metrics.find((metric) => metric.key === 'pronunciation')?.feedback).not.toContain(
      'Unsupported',
    )
  })

  it('computes the overall estimate from supported metrics only', () => {
    const result = parseFeedback(JSON.stringify(draft), [
      {
        role: 'user',
        content:
          'I fixed the bug in our authentication service yesterday and added a regression test. Today I plan to deploy the patch to our staging environment, verify the login flow with our quality assurance team, and ask for a code review before production deployment.',
      },
    ])
    expect(result.overallScore).toBe(80)
  })

  it('does not treat the coach’s words as learner evidence', () => {
    const result = parseFeedback(JSON.stringify(draft), [
      { role: 'assistant', content: 'I fixed the bug' },
      { role: 'user', content: 'I need some help.' },
    ])
    expect(result.rewrites).toHaveLength(0)
  })

  it('rejects malformed model output', () => {
    expect(() => parseFeedback('not a JSON review', [])).toThrow()
  })

  it('assigns source metadata even when the model omits it', () => {
    const { source: _source, ...content } = draft
    expect(parseFeedback(JSON.stringify(content), []).source).toBe('local-model')
  })

  it('rejects the observed invented deadline while preserving grounded rewrites', () => {
    const original = 'I need help reviewing the database connection settings before we release.'
    const result = parseFeedback(
      JSON.stringify({
        ...draft,
        rewrites: [
          {
            original,
            improved:
              'Could you review the database connection settings by end of day so we can release?',
            reason: 'Polite request.',
          },
        ],
      }),
      [{ role: 'user', content: original }],
    )
    expect(result.rewrites).toEqual([])
    expect(
      introducesConcreteClaim(
        original,
        'Could you help review the database connection settings before we release?',
      ),
    ).toBe(false)
  })

  it('rejects introduced quantities and explicit or relative deadlines', () => {
    const original = 'The deployment needs a review.'
    for (const improved of [
      'The deployment needs a review by tomorrow.',
      'The deployment needs a review next week.',
      'The deployment needs a review on Friday.',
      'The deployment needs a review within two hours.',
      'The deployment needs 3 reviews.',
    ])
      expect(introducesConcreteClaim(original, improved)).toBe(true)
    expect(introducesConcreteClaim('I fixed 3 bugs today.', 'Today I resolved 3 bugs.')).toBe(false)
  })
})

describe('bounded conversation context', () => {
  it('preserves the most recent context in chronological order', () => {
    expect(
      boundConversation(
        [
          { role: 'user', content: 'old context' },
          { role: 'assistant', content: 'question' },
          { role: 'user', content: 'answer' },
        ],
        15,
      ),
    ).toEqual([
      { role: 'assistant', content: 'question' },
      { role: 'user', content: 'answer' },
    ])
  })
})
