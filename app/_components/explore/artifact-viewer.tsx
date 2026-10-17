'use client'

import { useCallback, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import type { ExploreArtifact, ExploreLearningState } from '@/lib/explore/schema'
import { HanoiViewer } from '@/app/_components/explore/hanoi-viewer'
import { FibonacciViewer } from '@/app/_components/explore/fibonacci-viewer'
import { SortingViewer } from '@/app/_components/explore/sorting-viewer'
import { DiagramViewer } from '@/app/_components/explore/diagram-viewer'
import { ExamplesViewer } from '@/app/_components/explore/examples-viewer'
import { WalkthroughViewer } from '@/app/_components/explore/walkthrough-viewer'
import { PracticeQuestions } from '@/app/_components/explore/practice-questions'
import styles from '@/app/_components/explore/artifact-viewer.module.css'

const SimulationViewer = dynamic(
  () =>
    import('@/app/_components/explore/simulation-viewer').then((module) => module.SimulationViewer),
  { loading: () => <p className={styles.sceneLoading}>Preparing the simulation…</p> },
)
type ViewerProps = {
  artifact: ExploreArtifact
  onStateChange: (state: ExploreLearningState) => void
  improvementsEnabled?: boolean
  playbackEnabled?: boolean
}

const ArtifactContentViewer = ({
  artifact,
  onStateChange,
  improvementsEnabled = true,
  playbackEnabled = true,
}: ViewerProps) => {
  const [state, setState] = useState(artifact.state)
  const stateRef = useRef(state)
  const callbackRef = useRef(onStateChange)
  callbackRef.current = onStateChange
  const update = useCallback((patch: ExploreLearningState) => {
    const next = { ...stateRef.current, ...patch }
    stateRef.current = next
    setState(next)
    callbackRef.current(next)
  }, [])
  const { content } = artifact
  const props = { content, state, update }
  return (
    <article className={styles.viewer}>
      <header className={styles.header}>
        <span className={styles.eyebrow}>
          {content.kind === 'hanoi' || content.kind === 'sorting'
            ? 'Algorithm explorer'
            : content.kind === 'fibonacci'
              ? 'Mathematics meets practice'
              : content.kind === 'simulation'
                ? 'Interactive model'
                : 'Learn by exploring'}
        </span>
        <h2>{content.title}</h2>
        <p>{content.summary}</p>
      </header>
      {content.objectives.length > 0 && (
        <details className={styles.objectives}>
          <summary>What you’ll explore</summary>
          <ul>
            {content.objectives.map((objective, index) => (
              <li key={index}>{objective}</li>
            ))}
          </ul>
        </details>
      )}
      {content.kind === 'hanoi' && <HanoiViewer {...props} />}
      {content.kind === 'fibonacci' && <FibonacciViewer {...props} />}
      {content.kind === 'sorting' && <SortingViewer {...props} />}
      {content.kind === 'diagram' && <DiagramViewer {...props} />}
      {content.kind === 'examples' && (
        <ExamplesViewer
          {...props}
          artifactId={artifact.id}
          revision={artifact.revision}
          enabled={improvementsEnabled}
          playbackEnabled={playbackEnabled}
        />
      )}
      {content.kind === 'walkthrough' && <WalkthroughViewer {...props} />}
      {content.kind === 'simulation' && <SimulationViewer {...props} />}
      {content.sections.length > 0 && (
        <div className={styles.sections}>
          {content.sections.map((section, index) => (
            <section key={index}>
              <h3>{section.heading}</h3>
              <p>{section.body}</p>
            </section>
          ))}
        </div>
      )}
      {content.steps.length > 0 &&
        !['walkthrough', 'fibonacci', 'diagram'].includes(content.kind) && (
          <details className={styles.objectives}>
            <summary>Follow the explanation</summary>
            <ol>
              {content.steps.map((step, index) => (
                <li key={index}>
                  <strong>{step.title}</strong>
                  <p>{step.body}</p>
                </li>
              ))}
            </ol>
          </details>
        )}
      <PracticeQuestions {...props} />
      {content.assumptions.length > 0 && (
        <details className={styles.objectives}>
          <summary>Model scope and assumptions</summary>
          <ul>
            {content.assumptions.map((assumption, index) => (
              <li key={index}>{assumption}</li>
            ))}
          </ul>
        </details>
      )}
    </article>
  )
}

export const ArtifactViewer = ({
  artifact,
  onStateChange,
  improvementsEnabled,
  playbackEnabled,
}: ViewerProps) => (
  <ArtifactContentViewer
    key={`${artifact.id}:${artifact.revisionId}`}
    artifact={artifact}
    onStateChange={onStateChange}
    improvementsEnabled={improvementsEnabled}
    playbackEnabled={playbackEnabled}
  />
)
