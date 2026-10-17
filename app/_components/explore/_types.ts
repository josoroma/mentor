import type { ExploreArtifactContent, ExploreLearningState } from '@/lib/explore/schema'
import { clamp } from '@/lib/explore/models'

export type RendererProps = {
  content: ExploreArtifactContent
  state: ExploreLearningState
  update: (patch: ExploreLearningState) => void
}

export const readNumber = (
  state: ExploreLearningState,
  key: string,
  fallback: number,
  min: number,
  max: number,
) => clamp(typeof state[key] === 'number' ? state[key] : fallback, min, max)

export const readString = (state: ExploreLearningState, key: string, fallback = '') =>
  typeof state[key] === 'string' ? state[key] : fallback
