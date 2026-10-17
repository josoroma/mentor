import type { Role } from '@/app/_types'
import { getDemoConversationSubjects } from '@/lib/ai/demo-topics'
import {
  HomeConversationSchema,
  type HomeConversation,
  type HomeConversationRequest,
} from '@/lib/ai/home-conversation'
import { lifeSkillCategories } from '@/lib/learning/path-catalog'
import { resolveLearningSelection } from '@/lib/learning/paths'

type ConversationAngle = {
  title: string
  subject: string
  detail: string
}

// These are communication examples, never claims about what the learner did,
// agreed to, or needs. The same language is safe for wellness practice: it does
// not explain a condition, recommend a treatment, or invent personal symptoms.
const conversationAngles: readonly ConversationAngle[] = [
  {
    title: 'A clear opening',
    subject: 'making the opening clear',
    detail:
      'A useful opening names one purpose before adding background. That gives the other person a clear starting point without a long introduction.',
  },
  {
    title: 'Concrete examples',
    subject: 'choosing a concrete example',
    detail:
      'An example can describe one situation and one action. Keeping it small makes the idea easier to discuss without inventing a whole story.',
  },
  {
    title: 'Clear terminology',
    subject: 'explaining unfamiliar words',
    detail:
      'A short definition can come before a more detailed explanation. If a term is unclear, naming that uncertainty is more useful than guessing.',
  },
  {
    title: 'Different perspectives',
    subject: 'making room for another perspective',
    detail:
      'Two people can describe the same situation differently. Separating their observations from their interpretations gives each view room without assuming either person agrees.',
  },
  {
    title: 'Useful context',
    subject: 'choosing the background that matters',
    detail:
      'The useful background explains why the subject matters now. A long list of earlier events can wait until a particular detail becomes relevant.',
  },
  {
    title: 'Respectful disagreement',
    subject: 'expressing a different view respectfully',
    detail:
      'A different view can focus on one idea and give a reason. Keeping the wording about the idea avoids making a judgment about the person.',
  },
  {
    title: 'Plain language',
    subject: 'making an explanation easier to follow',
    detail:
      'A short sentence can carry the main point. A second sentence can explain it, so the listener does not have to untangle several ideas at once.',
  },
  {
    title: 'Known and unknown',
    subject: 'separating facts from uncertainty',
    detail:
      'An explanation can name what is known and what still needs checking. Leaving an unknown open is clearer than filling it with an assumption.',
  },
  {
    title: 'A manageable request',
    subject: 'making a request specific',
    detail:
      'A specific request names one action and its purpose. It also leaves the other person free to explain a limit or suggest an alternative.',
  },
  {
    title: 'Repairing misunderstandings',
    subject: 'repairing a misunderstanding',
    detail:
      'A repair can name the word or idea that caused confusion, then offer a clearer version. There is no need to assign blame.',
  },
  {
    title: 'Privacy and boundaries',
    subject: 'choosing what to share',
    detail:
      'An example can explain the relevant issue without names or private details. A person can also state that a detail is something they prefer to keep private.',
  },
  {
    title: 'An alternative approach',
    subject: 'describing an alternative',
    detail:
      'An alternative can be presented as a possibility, with one reason it might help. That keeps the suggestion open instead of treating it as a decision.',
  },
  {
    title: 'Listening for meaning',
    subject: 'reflecting the main point accurately',
    detail:
      'A short reflection can use the speaker’s own meaning without copying every word. It should leave out motives or feelings that the speaker never expressed.',
  },
  {
    title: 'Choosing the right detail',
    subject: 'matching the detail to the listener',
    detail:
      'Someone new to a subject may need the basic idea first. A person who knows the background may find one precise detail more useful.',
  },
  {
    title: 'A thoughtful pause',
    subject: 'leaving space to think',
    detail:
      'A speaker can take a brief pause before explaining a difficult point. Silence can be thinking time; it does not mean agreement or refusal.',
  },
  {
    title: 'A useful follow-up',
    subject: 'making a follow-up useful',
    detail:
      'A follow-up can state the point that remains open and one possible way to clarify it. It should distinguish a suggestion from something already agreed.',
  },
]

type TransitionCandidate = {
  topic: string
  subject: string
  texts: readonly [string, string]
}

const normalizeText = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

const commonWords = new Set([
  'about',
  'after',
  'another',
  'before',
  'being',
  'could',
  'discuss',
  'discussing',
  'explain',
  'explaining',
  'from',
  'have',
  'into',
  'more',
  'other',
  'should',
  'some',
  'that',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'through',
  'turn',
  'useful',
  'when',
  'which',
  'with',
  'without',
  'would',
  'your',
])

const contentWords = (text: string) =>
  new Set(
    normalizeText(text)
      .split(' ')
      .filter((word) => word.length > 3 && !commonWords.has(word)),
  )

const overlap = (first: Set<string>, second: Set<string>) => {
  if (!first.size || !second.size) return 0
  let shared = 0
  for (const word of first) if (second.has(word)) shared++
  return shared / Math.min(first.size, second.size)
}

const shortenTitle = (text: string, maxLength: number) => {
  if (text.length <= maxLength) return text
  const shortened = text.slice(0, maxLength - 1)
  return `${shortened.slice(0, shortened.lastIndexOf(' '))}…`
}

const buildCandidates = (request: HomeConversationRequest, role: Role): TransitionCandidate[] => {
  const selection = request.selection ?? { path: 'professional', roleId: role.id }
  // Validate the selected catalog entry before using it, including callers that
  // are not route handlers. An old saved profession must not replace life skills.
  resolveLearningSelection(selection)
  if (selection.path === 'life-skills') {
    const category = lifeSkillCategories.find(({ id }) => id === selection.categoryId)!
    const topic = category.topics.find(({ id }) => id === selection.topicId)!
    return conversationAngles.map((angle) => ({
      topic: `${topic.name}: ${angle.title}`,
      // Rank the new angle, not the shared focus, so the exact selected life topic
      // stays constant while its communication situations change.
      subject: angle.subject,
      texts: [
        `Another angle on ${topic.name.toLowerCase()} is ${angle.subject}. Let's look at that in a simple conversation.`,
        angle.detail,
      ],
    }))
  }

  return getDemoConversationSubjects(selection.roleId).flatMap((subject) =>
    conversationAngles.map((angle) => ({
      topic: `${angle.title}: ${shortenTitle(subject, 98 - angle.title.length)}`,
      subject,
      texts: [`Let's turn to ${subject}. One useful angle is ${angle.subject}.`, angle.detail],
    })),
  )
}

/** A safe spoken bridge when valid local drafts cannot escape a discussion loop. */
export const selectHomeConversationTransition = (
  request: HomeConversationRequest,
  role: Role,
): HomeConversation => {
  const currentIds = new Set(request.history.map(({ id }) => id))
  const actualTurns = [
    ...request.earlierContext.filter(({ id }) => !currentIds.has(id)),
    ...request.history,
  ]
  const context = [
    ...actualTurns.map(({ text }, index) => ({
      text: normalizeText(text),
      words: contentWords(text),
      weight: 1 + (index + 1) / Math.max(1, actualTurns.length),
    })),
    ...request.recentTopics.map((topic) => ({
      text: normalizeText(topic),
      words: contentWords(topic),
      weight: 2,
    })),
    ...(request.topic
      ? [{ text: normalizeText(request.topic), words: contentWords(request.topic), weight: 4 }]
      : []),
  ]

  const score = (candidate: TransitionCandidate) => {
    const title = normalizeText(candidate.topic)
    const subject = normalizeText(candidate.subject)
    const subjectWords = contentWords(candidate.subject)
    const texts = candidate.texts.map(normalizeText)
    let cost = 0
    for (const previous of context) {
      // Prefer a different actual subject before another wording of that subject.
      // Exact speech has a larger penalty so repeated pivots also vary their detail.
      if (previous.text === title) cost += 10_000 * previous.weight
      if (texts.includes(previous.text)) cost += 10_000 * previous.weight
      if (previous.text.includes(subject)) cost += 2_000 * previous.weight
      cost += overlap(subjectWords, previous.words) * previous.weight * 100
    }
    return cost
  }

  const candidates = buildCandidates(request, role)
  const selected = candidates
    .map((candidate, index) => ({ candidate, index, score: score(candidate) }))
    .sort((first, second) => first.score - second.score || first.index - second.index)[0].candidate

  return HomeConversationSchema.parse({
    topic: selected.topic,
    turns: selected.texts.map((text, index) => ({
      speaker: index === 0 ? request.nextSpeaker : request.nextSpeaker === 'alex' ? 'sam' : 'alex',
      text,
    })),
  })
}
