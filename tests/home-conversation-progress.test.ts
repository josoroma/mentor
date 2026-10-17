import { describe, expect, it } from 'vitest'
import {
  analyzeHomeConversationProgress,
  inspectHomeConversationProgress,
  isExplicitConversationAgreement,
  isRepeatedConversationText,
  type HomeConversationProgressMessage,
} from '@/lib/ai/home-conversation-progress'

const turn = (
  id: string,
  speaker: HomeConversationProgressMessage['speaker'],
  text: string,
): HomeConversationProgressMessage => ({ id, speaker, text })

describe('homepage conversation progression', () => {
  it.each([
    'I agree. A short guide works.',
    'Yes, let’s do that.',
    'That works for me.',
    'Agreed, we can use screenshots.',
    'Sounds good.',
  ])('recognizes explicit assent: %s', (text) => {
    expect(isExplicitConversationAgreement(text)).toBe(true)
  })

  it.each([
    'I do not agree.',
    'I disagree.',
    'I don’t disagree, but we need more time.',
    'I agree if the customer approves.',
    'If we have time, I agree.',
    'I agree, but not with the Friday deadline.',
    'I agree only if we can test first.',
    'Maybe that works for me.',
    'Would you say “I agree” here?',
    'She said "I agree".',
    'The learner agrees with us.',
    'Let’s move on.',
  ])('does not turn qualified, quoted, or absent agreement into assent: %s', (text) => {
    expect(isExplicitConversationAgreement(text)).toBe(false)
  })

  it('uses explicit speaker evidence and never treats learner silence as consent', () => {
    const progress = analyzeHomeConversationProgress({
      history: [
        turn('proposal', 'alex', 'We could include screenshots in the guide.'),
        turn('assent', 'sam', 'I agree. A worked example would help.'),
      ],
    })
    expect(progress.agreementEvidence).toEqual([{ id: 'assent', speaker: 'sam' }])
    expect(progress.questionBudget).toBe(0)
    expect(progress.move).toBe('apply-agreement')
    expect(progress.guidance).toContain('learner silence never establish learner consent')
  })

  it('makes learner agreement a cue to apply the choice rather than ask again', () => {
    const progress = analyzeHomeConversationProgress({
      history: [
        turn('proposal', 'alex', 'Shall we use screenshots?'),
        turn('assent', 'user', 'Yes, let’s do that.'),
      ],
    })
    expect(progress.agreementEvidence).toEqual([{ id: 'assent', speaker: 'user' }])
    expect(progress.questionBudget).toBe(0)
    expect(progress.unansweredQuestionId).toBeUndefined()
  })

  it('gives a new learner correction priority over an older agreement', () => {
    const progress = analyzeHomeConversationProgress({
      earlierContext: [turn('old', 'user', 'I agree. Let’s use Friday.')],
      history: [turn('new', 'user', 'Actually, Friday will not work. Monday is better.')],
    })
    expect(progress.agreementEvidence).toEqual([])
    expect(progress.correctionEvidence).toEqual([{ id: 'new', speaker: 'user' }])
    expect(progress.move).toBe('follow-correction')
  })

  it('honors a request to move on without labelling it agreement', () => {
    const progress = analyzeHomeConversationProgress({
      history: [turn('change', 'user', 'Let’s move on. Can we discuss the delivery timeline?')],
    })
    expect(progress.moveOnRequestId).toBe('change')
    expect(progress.agreementEvidence).toEqual([])
    expect(progress.move).toBe('fresh-angle')
    expect(progress.questionBudget).toBe(0)
  })

  it('does not ask another question while the latest AI question has no reply', () => {
    const progress = analyzeHomeConversationProgress({
      history: [turn('question', 'sam', 'How could screenshots help new team members?')],
    })
    expect(progress.questionBudget).toBe(0)
    expect(progress.unansweredQuestionId).toBe('question')
    expect(progress.guidance).toContain('their own illustrative answer')
  })

  it('does not mistake a generic acknowledgement for an answer to the question', () => {
    const progress = analyzeHomeConversationProgress({
      history: [
        turn('question', 'alex', 'How could screenshots help new team members?'),
        turn('acknowledgement', 'sam', 'That is a good question.'),
      ],
    })
    expect(progress.questionBudget).toBe(0)
    expect(progress.unansweredQuestionId).toBe('question')
  })

  it('limits a normal batch to one question and backs off after a dense question sequence', () => {
    expect(analyzeHomeConversationProgress({ history: [] }).questionBudget).toBe(1)
    const history = [
      turn('1', 'alex', 'How should we organize the guide?'),
      turn('2', 'sam', 'We can put setup first.'),
      turn('3', 'alex', 'What should the setup cover?'),
      turn('4', 'sam', 'Start with account permissions.'),
    ]
    const progress = analyzeHomeConversationProgress({ history })
    expect(progress.questionBudget).toBe(0)
    expect(progress.unansweredQuestionId).toBeUndefined()
    expect(progress.questionReasons.join(' ')).toContain('several questions')
  })

  it('moves repeated agreement into a new relevant angle', () => {
    const progress = analyzeHomeConversationProgress({
      history: [
        turn('1', 'alex', 'I agree. Screenshots would help.'),
        turn('2', 'sam', 'Sounds good. Screenshots make the guide clearer.'),
      ],
    })
    expect(progress.move).toBe('fresh-angle')
  })

  it('does not keep treating old agreement as a fresh turn-level instruction', () => {
    const progress = analyzeHomeConversationProgress({
      history: [
        turn('1', 'user', 'I agree.'),
        turn('2', 'alex', 'A sample login screen could show the permissions.'),
        turn('3', 'sam', 'We can blur the customer details before capturing it.'),
        turn('4', 'alex', 'A small caption can explain each permission.'),
      ],
    })
    expect(progress.questionBudget).toBe(1)
    expect(progress.move).toBe('develop')
    expect(progress.agreementEvidence).toEqual([{ id: '1', speaker: 'user' }])
  })
})

describe('homepage repetition checks', () => {
  const previous = 'The handover guide should include screenshots for each setup step.'

  it('detects exact and strongly overlapping reordered wording', () => {
    expect(isRepeatedConversationText(previous.toUpperCase(), previous)).toBe(true)
    expect(
      isRepeatedConversationText(
        'We should include screenshots for each setup step in the handover guide.',
        previous,
      ),
    ).toBe(true)
  })

  it('does not reject a brief natural acknowledgement as a repeated argument', () => {
    expect(isRepeatedConversationText('I agree.', 'I agree.')).toBe(false)
    expect(isRepeatedConversationText('Sounds good.', 'Sounds good.')).toBe(false)
  })

  it.each([
    'The handover guide should include screenshots for each setup step and a five-minute video.',
    'The handover guide should not include screenshots for each setup step.',
    'The screenshots could hide sensitive data with a blur filter.',
    'The guide needs an owner who updates screenshots when setup steps change.',
  ])('allows meaningful new detail or changed meaning: %s', (next) => {
    expect(isRepeatedConversationText(next, previous)).toBe(false)
  })

  it('does not classify different quantities as repeating the same proposal', () => {
    expect(
      isRepeatedConversationText(
        'The handover guide should include 3 screenshots for each setup step.',
        'The handover guide should include 2 screenshots for each setup step.',
      ),
    ).toBe(false)
    expect(
      isRepeatedConversationText(
        'The handover guide should include three screenshots for each setup step.',
        'The handover guide should include two screenshots for each setup step.',
      ),
    ).toBe(false)
  })

  it('permits quoted language examples within a zero-question batch', () => {
    const context = { history: [turn('agreement', 'user', 'Agreed.')] }
    expect(
      inspectHomeConversationProgress(
        {
          turns: [
            { speaker: 'alex', text: 'For example, you could say “How can I access the guide?”' },
            { speaker: 'sam', text: 'That short sentence clearly explains what you need.' },
          ],
        },
        context,
      ),
    ).toEqual([])
  })

  it('treats an indirect request for another answer as using the question budget', () => {
    const context = { history: [turn('agreement', 'user', 'Agreed.')] }
    const issues = inspectHomeConversationProgress(
      {
        turns: [
          { speaker: 'alex', text: 'Tell me what you think about the guide.' },
          { speaker: 'sam', text: 'A checklist could make the first task clearer.' },
        ],
      },
      context,
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('at most 0 questions')
  })

  it('reports excessive questions and repeated displayed AI turns for a repair request', () => {
    const history = [turn('old', 'alex', previous)]
    const issues = inspectHomeConversationProgress(
      {
        turns: [
          { speaker: 'sam', text: previous },
          { speaker: 'alex', text: 'Would you agree? Should we make a guide?' },
        ],
      },
      { history },
    )
    expect(issues).toHaveLength(2)
    expect(issues[0]).toContain('at most 1 question')
    expect(issues[1]).toContain('old')
  })

  it('checks within-batch repetition but permits reflecting actual learner wording', () => {
    const conversation = {
      turns: [
        { speaker: 'alex' as const, text: previous },
        { speaker: 'sam' as const, text: 'Let’s add captions that explain what to click.' },
      ],
    }
    expect(
      inspectHomeConversationProgress(conversation, {
        history: [turn('user', 'user', previous)],
      }),
    ).toEqual([])
    expect(
      inspectHomeConversationProgress(
        { turns: [conversation.turns[0], { speaker: 'sam', text: previous }] },
        { history: [] },
      )[0],
    ).toContain('other draft turn')
  })
})
