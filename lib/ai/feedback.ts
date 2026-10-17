import { FeedbackSchema } from '@/app/_schema'
import type { Feedback, FeedbackMetric } from '@/app/_types'
import type { CoachMessage } from '@/lib/ai/contracts'

const transcriptOnlyMetrics: FeedbackMetric[] = [
  {
    key: 'pronunciation',
    label: 'Pronunciation',
    score: null,
    feedback:
      'Not scored: the review receives a transcript, not phonetic audio evidence. Practice difficult words with the coach and listen to its example.',
  },
  {
    key: 'fluency',
    label: 'Fluency',
    score: null,
    feedback:
      'Not scored: a transcript cannot reliably measure pauses or speaking rhythm. Try one uninterrupted 45-second explanation in your next session.',
  },
  {
    key: 'confidence',
    label: 'Confidence',
    score: null,
    feedback:
      'Not scored: vocal confidence cannot be measured from this transcript. Practice opening with your recommendation, then give one supporting reason.',
  },
]

const normalizeText = (value: string) => value.toLocaleLowerCase('en').replace(/\s+/g, ' ').trim()

export const introducesConcreteClaim = (original: string, improved: string) => {
  const source = normalizeText(original)
  const rewrite = normalizeText(improved)
  const originalNumbers = new Set(source.match(/\b\d+(?:[.,]\d+)?%?/g) ?? [])
  const newNumbers = rewrite.match(/\b\d+(?:[.,]\d+)?%?/g) ?? []
  if (newNumbers.some((number) => !originalNumbers.has(number))) return true

  // Reject common concrete promises that a language rewrite must not introduce.
  const timing =
    /\b(?:end of (?:the )?(?:day|week|month|quarter|year)|eod|eow|today|tomorrow|tonight|yesterday|(?:this|next|last) (?:morning|afternoon|evening|week|month|quarter|year)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|(?:by|in|before|after|on) may|june|july|august|september|october|november|december|(?:one|two|three|four|five|six|seven|eight|nine|ten|a|an) (?:minute|hour|day|week|month|year)s?)\b/g
  const originalTiming = new Set(source.match(timing) ?? [])
  return (rewrite.match(timing) ?? []).some((claim) => !originalTiming.has(claim))
}

const metricLabels: Record<string, string> = {
  grammar: 'Grammar',
  vocabulary: 'Vocabulary',
  clarity: 'Clarity',
  conciseness: 'Conciseness',
  professionalism: 'Professionalism',
  pronunciation: 'Pronunciation',
  confidence: 'Confidence',
  fluency: 'Fluency',
}

export const parseFeedback = (text: string, messages: CoachMessage[]): Feedback => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Feedback was not valid JSON')
  // Provenance and aggregate scores belong to the application, never the model.
  const content = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  const parsed = FeedbackSchema.parse({
    ...content,
    metrics: Array.isArray(content.metrics)
      ? content.metrics.map((metric: unknown) => {
          if (!metric || typeof metric !== 'object') return metric
          const item = metric as Record<string, unknown>
          return {
            ...item,
            label: typeof item.key === 'string' ? metricLabels[item.key] : undefined,
          }
        })
      : content.metrics,
    source: 'local-model',
    overallScore: null,
  })
  const learnerMessages = messages.filter((message) => message.role === 'user')
  const wordCount = learnerMessages.reduce(
    (sum, message) => sum + message.content.split(/\s+/).length,
    0,
  )
  const audioMetricKeys = new Set(['pronunciation', 'fluency', 'confidence'])
  const seen = new Set<string>()
  const metrics = parsed.metrics
    .filter((metric) => {
      if (audioMetricKeys.has(metric.key) || seen.has(metric.key)) return false
      seen.add(metric.key)
      return true
    })
    .map((metric) => ({ ...metric, score: wordCount < 20 ? null : metric.score }))
  const scored = metrics.filter(
    (metric): metric is FeedbackMetric & { score: number } => metric.score !== null,
  )

  return {
    ...parsed,
    source: 'local-model',
    // Scores are informal text-based estimates. Small samples are deliberately unscored.
    overallScore:
      wordCount < 40 || scored.length < 3
        ? null
        : Math.round(scored.reduce((sum, metric) => sum + metric.score, 0) / scored.length),
    metrics: [...metrics, ...transcriptOnlyMetrics],
    rewrites: parsed.rewrites
      .filter((rewrite) => {
        const original = normalizeText(rewrite.original)
        return (
          original.length > 0 &&
          learnerMessages.some((message) => normalizeText(message.content).includes(original)) &&
          !introducesConcreteClaim(rewrite.original, rewrite.improved)
        )
      })
      .slice(0, 3),
  }
}
