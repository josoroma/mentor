import { RequestError } from '@/lib/ai/http'
import type { ExploreImprovementContext } from '@/lib/explore/improvement'
import type { ExplorePracticeImprovementRequest } from '@/lib/explore/practice-improvement-schema'
import type { ExploreArtifact } from '@/lib/explore/schema'

export {
  ExplorePracticeImprovementRequestSchema,
  ExplorePracticeImprovementResponseSchema,
  type ExplorePracticeImprovementRequest,
  type ExplorePracticeImprovementResponse,
} from '@/lib/explore/practice-improvement-schema'

export const buildExplorePracticeImprovementContext = (
  request: ExplorePracticeImprovementRequest,
  artifact: ExploreArtifact,
): ExploreImprovementContext => {
  if (artifact.revision !== request.expectedRevision)
    throw new RequestError(
      'This lesson has changed. Reopen the current revision before improving your practice.',
      409,
    )
  if (artifact.content.kind !== 'examples')
    throw new RequestError('Practice wording improvements are available for example lessons only.')
  const example = artifact.content.examples[request.exampleIndex]
  if (!example) throw new RequestError('This practice example is not part of the current lesson.')
  // The reference phrase is deliberately omitted: the learner's own wording is
  // the source to edit. These bounded exercise details are background only.
  return [
    {
      role: 'assistant',
      content: JSON.stringify({
        referenceOnly: true,
        ...(artifact.content.learningContext && {
          learningContext: artifact.content.learningContext,
        }),
        exerciseTopic: artifact.content.title.slice(0, 100),
        situation: example.context.slice(0, 200),
        exampleFormality: example.formality,
        exampleUrgency: example.urgency,
        channel: example.channel.slice(0, 60),
      }),
    },
  ]
}
