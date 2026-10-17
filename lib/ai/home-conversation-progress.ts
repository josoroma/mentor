export type HomeConversationProgressMessage = {
  id: string
  speaker: 'alex' | 'sam' | 'user'
  text: string
}

type ProgressContext = {
  history: readonly HomeConversationProgressMessage[]
  earlierContext?: readonly HomeConversationProgressMessage[]
}

type Evidence = Pick<HomeConversationProgressMessage, 'id' | 'speaker'>

export type HomeConversationProgress = {
  questionBudget: 0 | 1
  questionReasons: string[]
  move: 'develop' | 'apply-agreement' | 'fresh-angle' | 'follow-correction'
  guidance: string
  agreementEvidence: Evidence[]
  correctionEvidence: Evidence[]
  moveOnRequestId?: string
  unansweredQuestionId?: string
}

const normalize = (text: string) => text.toLowerCase().replace(/[’‘]/g, "'")

const withoutQuotations = (text: string) =>
  normalize(text)
    .replace(/[“"][^”"]*[”"]/g, '')
    .replace(/(?:^|\s)'[^']*'(?=\s|[.,!?]|$)/g, ' ')

const requestsNewDirection = (text: string) => {
  const value = withoutQuotations(text)
  if (/\b(?:not|don't|do not|never)\b[^.!?]{0,35}\b(?:move on|change the topic)\b/.test(value)) {
    return false
  }
  return (
    /\b(?:let'?s|let us|can we|could we|we should|i want to|i would like to|please)\b[^.!?]{0,35}\b(?:move on|move forward|change (?:the )?(?:topic|subject)|discuss something else|talk about something else|stop (?:asking|repeating))\b/.test(
      value,
    ) ||
    /^(?:please )?(?:move on|change (?:the )?(?:topic|subject)|stop (?:asking|repeating))\b/.test(
      value,
    ) ||
    /\b(?:let'?s|let us|can we|could we)\b[^.!?]{0,60}\b(?:instead|different topic|different subject)\b/.test(
      value,
    )
  )
}

const correctsEarlierDirection = (text: string) => {
  const value = withoutQuotations(text)
  return (
    /^(?:no[,.!\s]|actually\b|on second thought\b)/.test(value) ||
    /\b(?:i|we) (?:disagree|(?:have )?changed? (?:my|our) mind|don't agree|do not agree|can't agree|cannot agree)\b/.test(
      value,
    ) ||
    /\b(?:that's not what i (?:mean|meant)|that is not what i (?:mean|meant)|i meant|not quite|not exactly|rather than|instead of)\b/.test(
      value,
    ) ||
    /\b(?:(?:i|we) agree|agreed|sounds good|that works for (?:me|us))\b[^.!?]*\b(?:but|however|except|only if|unless)\b/.test(
      value,
    ) ||
    /\b(?:that|this|it) (?:doesn't|does not|won't|will not|can't|cannot) work\b/.test(value)
  )
}

/** Evidence of a speaker's explicit assent, never a claim about other participants. */
export const isExplicitConversationAgreement = (text: string): boolean => {
  const value = withoutQuotations(text).trim()
  if (
    requestsNewDirection(value) ||
    correctsEarlierDirection(value) ||
    /\b(?:not|don't|do not|doesn't|never|disagree|can't|cannot|won't|wouldn't|if|unless|provided|but|however|although|except|maybe|perhaps)\b/.test(
      value,
    ) ||
    value.includes('?')
  ) {
    return false
  }
  return (
    /(?:^|[.!]\s*)(?:(?:yes|yeah|okay|ok|sure|right|great)[,\s]+)?(?:i (?:fully |completely )?agree|we (?:all )?agree|agreed|sounds good|that (?:sounds good|works for me|works for us)|that'?s agreed|we'?re agreed|let'?s (?:do that|go with that)|let us (?:do that|go with that))\b/.test(
      value,
    ) || /^(?:yes|yeah|yep|exactly|absolutely)[.!]*$/.test(value)
  )
}

const countQuestions = (text: string) => {
  const value = withoutQuotations(text)
  const marks = value.match(/\?/g)?.length ?? 0
  if (marks > 0) return marks
  // Models occasionally omit punctuation. Avoid treating "What matters is ..."
  // and quoted example sentences as requests for a participant's answer.
  return value
    .split(/[.!]\s*/)
    .filter(
      (sentence) =>
        /^(?:what|which|how|why|when|where|who)\s+(?:do|does|did|would|could|should|can|will|is|are|was|were|have|has)\b/.test(
          sentence.trim(),
        ) ||
        /^(?:do|does|did|can|could|would|will|should|have|has|are|is)\s+(?:you|we|they|he|she|it|this|that)\b/.test(
          sentence.trim(),
        ) ||
        /^(?:please )?(?:(?:tell|show|give) (?:me|us)|(?:describe|explain|share) (?:your|how|what)|let (?:me|us) know)\b/.test(
          sentence.trim(),
        ),
    ).length
}

const stopWords = new Set(
  'a an the and or but to of in on at by for from with as is are was were be been being have has had do does did i we you they he she it our your their its my this that these those there here can could would should will may might must let lets us so then also just really very more some any each all'.split(
    ' ',
  ),
)

const words = (text: string) => normalize(text).match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []
const contentWords = (text: string) =>
  new Set(
    words(text)
      .filter((word) => !stopWords.has(word))
      .map((word) => (word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word)),
  )

/** Deliberately lexical and conservative: shared subject words alone are insufficient. */
export const isRepeatedConversationText = (next: string, previous: string): boolean => {
  const nextWords = words(next)
  const previousWords = words(previous)
  if (!nextWords.length || !previousWords.length) return false
  if (nextWords.join(' ') === previousWords.join(' ')) {
    // A brief natural acknowledgement is not a repeated substantive argument.
    return !isExplicitConversationAgreement(next) || contentWords(next).size > 2
  }

  // New quantities or changed polarity can change a proposal's meaning entirely.
  const significant = (text: string) =>
    words(text)
      .filter(
        (word) =>
          /^\d/.test(word) ||
          /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|not|no|never|without|except|don't|can't|cannot|won't)$/.test(
            word,
          ),
      )
      .sort()
      .join(' ')
  if (significant(next) !== significant(previous)) return false

  const a = contentWords(next)
  const b = contentWords(previous)
  const overlap = [...a].filter((word) => b.has(word)).length
  const minimum = countQuestions(next) > 0 && countQuestions(previous) > 0 ? 4 : 6
  return (
    overlap >= minimum &&
    overlap / Math.max(a.size, b.size) >= 0.85 &&
    overlap / Math.min(a.size, b.size) >= 0.9
  )
}

const mergeContext = ({ history, earlierContext = [] }: ProgressContext) => {
  const currentIds = new Set(history.map((turn) => turn.id))
  return [...earlierContext.filter((turn) => !currentIds.has(turn.id)), ...history]
}

const reference = ({ id, speaker }: HomeConversationProgressMessage): Evidence => ({ id, speaker })

export const analyzeHomeConversationProgress = (
  context: ProgressContext,
): HomeConversationProgress => {
  const turns = mergeContext(context)
  const recent = turns.slice(-8)
  const recentAi = recent.filter((turn) => turn.speaker !== 'user')
  const latestCorrectionIndex = turns.findLastIndex(
    (turn) => turn.speaker === 'user' && correctsEarlierDirection(turn.text),
  )
  const agreements = turns.filter(
    (turn, index) => index > latestCorrectionIndex && isExplicitConversationAgreement(turn.text),
  )
  const freshAgreement = turns.slice(-2).some((turn) => agreements.includes(turn))
  const moveOnRequest = recent.findLast(
    (turn) => turn.speaker === 'user' && requestsNewDirection(turn.text),
  )
  const latestQuestionIndex = turns.findLastIndex(
    (turn) => turn.speaker !== 'user' && countQuestions(turn.text) > 0,
  )
  const hasQuestionReply = turns
    .slice(latestQuestionIndex + 1)
    .some(
      (turn) =>
        turn.speaker === 'user' ||
        isExplicitConversationAgreement(turn.text) ||
        contentWords(turn.text).size >= 3,
    )
  const unansweredQuestion =
    latestQuestionIndex >= 0 && !hasQuestionReply ? turns[latestQuestionIndex] : undefined
  const denseQuestions =
    recentAi.slice(-4).reduce((total, turn) => total + countQuestions(turn.text), 0) >= 2
  const repeatedAi = recentAi.some((turn, index) =>
    recentAi
      .slice(0, index)
      .some((previous) => isRepeatedConversationText(turn.text, previous.text)),
  )
  const repeatedAgreement =
    recentAi.slice(-4).filter((turn) => isExplicitConversationAgreement(turn.text)).length >= 2
  const freshCorrection = latestCorrectionIndex >= Math.max(0, turns.length - 2)
  const questionReasons = [
    ...(unansweredQuestion ? ['The latest AI question has no subsequent reply.'] : []),
    ...(denseQuestions ? ['Recent AI turns already contain several questions.'] : []),
    ...(freshAgreement ? ['A speaker has explicitly agreed; do not ask for agreement again.'] : []),
    ...(moveOnRequest ? ['The learner explicitly requested a change of direction.'] : []),
  ]
  const move: HomeConversationProgress['move'] = freshCorrection
    ? 'follow-correction'
    : moveOnRequest || repeatedAi || repeatedAgreement
      ? 'fresh-angle'
      : freshAgreement
        ? 'apply-agreement'
        : 'develop'
  const advice = {
    'follow-correction':
      'Address the learner’s latest correction. Earlier agreement does not override changed preferences or new constraints. Develop the corrected direction with a concrete detail.',
    'fresh-angle':
      'Stop circling this point. Briefly connect it to a different relevant angle and develop a new example, consequence, or next step. Honor a learner-requested topic change.',
    'apply-agreement':
      'Acknowledge explicit agreement at most once, then apply that point in a concrete example or practical next step. Do not ask whether everyone agrees or reconfirm the same choice.',
    develop:
      'Advance one point with a new concrete detail, example, trade-off, or practical next step. The second speaker adds something different instead of paraphrasing the first.',
  }
  return {
    questionBudget: questionReasons.length ? 0 : 1,
    questionReasons,
    move,
    guidance: `${advice[move]} Agreement references belong only to their named speaker and the surrounding proposal; AI assent and learner silence never establish learner consent. ${unansweredQuestion ? 'The partners can offer their own illustrative answer without speaking for the learner.' : 'Keep questions occasional rather than ending every turn with one.'}`,
    agreementEvidence: agreements.slice(-3).map(reference),
    correctionEvidence: latestCorrectionIndex >= 0 ? [reference(turns[latestCorrectionIndex])] : [],
    ...(moveOnRequest ? { moveOnRequestId: moveOnRequest.id } : {}),
    ...(unansweredQuestion ? { unansweredQuestionId: unansweredQuestion.id } : {}),
  }
}

export const inspectHomeConversationProgress = (
  conversation: { turns: readonly { speaker: 'alex' | 'sam'; text: string }[] },
  context: ProgressContext,
  progress = analyzeHomeConversationProgress(context),
): string[] => {
  const issues: string[] = []
  const questionCount = conversation.turns.reduce(
    (total, turn) => total + countQuestions(turn.text),
    0,
  )
  if (questionCount > progress.questionBudget) {
    issues.push(
      `Use at most ${progress.questionBudget} question${progress.questionBudget === 1 ? '' : 's'} across both turns; the draft contains ${questionCount}. Add useful statements instead of another question.`,
    )
  }
  const recentAi = mergeContext(context)
    .filter((turn) => turn.speaker !== 'user')
    .slice(-10)
  conversation.turns.forEach((turn, index) => {
    const duplicate = recentAi.find((previous) =>
      isRepeatedConversationText(turn.text, previous.text),
    )
    if (duplicate) {
      issues.push(
        `Turn ${index + 1} closely repeats displayed AI turn ${duplicate.id}. Supply a new concrete detail, example, consequence, or relevant angle.`,
      )
    } else if (
      conversation.turns
        .slice(0, index)
        .some((previous) => isRepeatedConversationText(turn.text, previous.text))
    ) {
      issues.push(
        `Turn ${index + 1} closely repeats the other draft turn. Give the second speaker a distinct contribution.`,
      )
    }
  })
  return issues
}
