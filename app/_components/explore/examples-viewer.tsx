'use client'

import { useState } from 'react'
import { readString, type RendererProps } from '@/app/_components/explore/_types'
import { ExamplePractice } from '@/app/_components/explore/example-practice'
import { useExplorePracticeImprovements } from '@/app/_hooks/use-explore-practice-improvements'
import styles from '@/app/_components/explore/artifact-viewer.module.css'

type ExamplesViewerProps = RendererProps & {
  artifactId: string
  revision: number
  enabled: boolean
  playbackEnabled?: boolean
}

export const ExamplesViewer = ({
  content,
  state,
  update,
  artifactId,
  revision,
  enabled,
  playbackEnabled = true,
}: ExamplesViewerProps) => {
  const [expanded, setExpanded] = useState(new Set<number>())
  const formality = readString(state, 'exampleFormality', 'all')
  const urgency = readString(state, 'exampleUrgency', 'all')
  const channel = readString(state, 'exampleChannel', 'all')
  const filtered = content.examples
    .map((example, index) => ({ ...example, index }))
    .filter(
      (example) =>
        (formality === 'all' || example.formality === formality) &&
        (urgency === 'all' || example.urgency === urgency) &&
        (channel === 'all' || example.channel === channel),
    )
  const improvements = useExplorePracticeImprovements({
    artifactId,
    revision,
    enabled,
    scope: JSON.stringify([formality, urgency, channel]),
    activeIndices: filtered
      .filter((example) => expanded.has(example.index))
      .map(({ index }) => index),
    state,
    update,
  })
  return (
    <section className={styles.interactive} aria-label="Communication examples">
      <div className={styles.row}>
        <h3>Find the right words for the situation</h3>
        <span className={styles.meta}>
          {filtered.length} / {content.examples.length} examples
        </span>
      </div>
      <div className={styles.filters}>
        <label className={styles.field}>
          Formality
          <select
            aria-label="Formality"
            value={formality}
            onChange={(event) => update({ exampleFormality: event.target.value })}
          >
            <option value="all">All styles</option>
            {['casual', 'neutral', 'formal'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          Urgency
          <select
            aria-label="Urgency"
            value={urgency}
            onChange={(event) => update({ exampleUrgency: event.target.value })}
          >
            <option value="all">Any urgency</option>
            {['low', 'normal', 'high'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          Channel
          <select
            aria-label="Channel"
            value={channel}
            onChange={(event) => update({ exampleChannel: event.target.value })}
          >
            <option value="all">All channels</option>
            {[...new Set(content.examples.map((example) => example.channel))].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>
      {!filtered.length && (
        <p className={styles.note}>
          No examples match these filters. Choose another style or channel.
        </p>
      )}
      <div className={styles.exampleList}>
        {filtered.map((example) => (
          <article key={example.index} className={styles.example}>
            <div className={styles.tags}>
              <span>{String(example.index + 1).padStart(2, '0')}</span>
              <span>{example.formality}</span>
              <span>{example.urgency} urgency</span>
              <span>{example.channel}</span>
            </div>
            <blockquote>{example.phrase}</blockquote>
            <p>
              <strong>Situation:</strong> {example.context}
            </p>
            {example.note && <p className={styles.note}>{example.note}</p>}
            <ExamplePractice
              index={example.index}
              draft={readString(state, `examplePractice${example.index}`)}
              improvement={readString(state, `examplePracticeImproved${example.index}`)}
              improving={improvements.pendingIndex === example.index}
              error={improvements.errorFor(example.index)}
              enabled={enabled}
              playbackEnabled={playbackEnabled}
              open={expanded.has(example.index)}
              onChange={(text) => improvements.change(example.index, text)}
              onOpenChange={(open) =>
                setExpanded((previous) => {
                  const next = new Set(previous)
                  if (open) next.add(example.index)
                  else next.delete(example.index)
                  return next
                })
              }
              onRetry={() => improvements.retry(example.index)}
            />
          </article>
        ))}
      </div>
    </section>
  )
}
