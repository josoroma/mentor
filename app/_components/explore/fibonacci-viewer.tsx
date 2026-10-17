'use client'

import { fibonacciSequence } from '@/lib/explore/models'
import { Button } from '@/app/_components/ui/button'
import { readNumber, readString, type RendererProps } from '@/app/_components/explore/_types'
import styles from '@/app/_components/explore/artifact-viewer.module.css'

const sampleStories = [
  {
    title: 'Add password reset',
    body: 'As an account holder, I want to reset my password using our existing identity provider. Include expired links, rate limits, accessibility, and tests.',
  },
  {
    title: 'Deliver reliable webhooks',
    body: 'As an integration partner, I need signed order events with retries and duplicate handling. The external API is new to the team.',
  },
  {
    title: 'Filter a project list',
    body: 'As a project owner, I want to filter projects by status using an existing API and design-system control. Remember the selected filter.',
  },
]
const cards = [1, 2, 3, 5, 8, 13, 21]

export const FibonacciViewer = ({ content, state, update }: RendererProps) => {
  const count = Math.round(readNumber(state, 'fibonacciCount', 10, 3, 12))
  const sequence = fibonacciSequence(count)
  const stories = content.steps.length ? content.steps : sampleStories
  const storyIndex = Math.round(readNumber(state, 'pokerStory', 0, 0, stories.length - 1))
  const estimate = readNumber(state, 'pokerEstimate', 0, 0, 21)
  const revealed = state.pokerRevealed === true
  const story = stories[storyIndex]
  return (
    <section className={styles.interactive} aria-label="Fibonacci and Planning Poker explorer">
      <h3>Each term builds on the previous two</h3>
      <div className={styles.sequence} aria-label={`Fibonacci sequence: ${sequence.join(', ')}`}>
        {sequence.map((value, index) => (
          <div key={index} data-active={index >= sequence.length - 3}>
            <small>F({index})</small>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <p className={styles.caption}>
        {sequence.at(-3)} + {sequence.at(-2)} = <strong>{sequence.at(-1)}</strong> · F(0) = 0, F(1)
        = 1; F(n) = F(n − 1) + F(n − 2).
      </p>
      <label className={styles.timeline}>
        Show {count} terms
        <input
          type="range"
          min={3}
          max={12}
          value={count}
          onChange={(event) => update({ fibonacciCount: Number(event.target.value) })}
        />
      </label>
      <div className={styles.divider} />
      <div className={styles.row}>
        <h3>Try Planning Poker</h3>
        <span className={styles.meta}>Illustrative team exercise</span>
      </div>
      <p className={styles.note}>
        Estimate relative effort, complexity, and uncertainty using a shared reference story. Points
        are not hours, and there is no universal correct number. Many teams use a Fibonacci-like
        deck; Scrum does not prescribe one.{' '}
        <a
          href="https://www.scrum.org/resources/blog/myth-9-story-points-are-required-scrum"
          target="_blank"
          rel="noreferrer"
        >
          Scrum.org: relative estimation
        </a>
      </p>
      <label className={styles.field}>
        User story
        <select
          aria-label="User story"
          value={storyIndex}
          onChange={(event) =>
            update({
              pokerStory: Number(event.target.value),
              pokerEstimate: 0,
              pokerRevealed: false,
            })
          }
        >
          {stories.map((item, index) => (
            <option key={index} value={index}>
              {item.title}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.callout}>
        <h4>{story.title}</h4>
        <p>{story.body}</p>
      </div>
      <p>Choose an estimate privately, then reveal and discuss.</p>
      <div className={styles.pokerCards} role="group" aria-label="Choose your story point estimate">
        {cards.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={estimate === value}
            onClick={() => update({ pokerEstimate: value, pokerRevealed: false })}
          >
            {value}
          </button>
        ))}
      </div>
      <Button
        variant="secondary"
        size="sm"
        disabled={!estimate}
        onClick={() => update({ pokerRevealed: !revealed })}
      >
        {revealed ? 'Estimate again' : 'Reveal and discuss'}
      </Button>
      {revealed && (
        <div className={styles.callout} aria-live="polite">
          <h4>Your estimate: {estimate} points</h4>
          <p>
            <strong>Sample teammate Alex:</strong> “I would go lower if our existing components
            cover this. Which work can we reuse?”
          </p>
          <p>
            <strong>Sample teammate Sam:</strong> “I would go higher until we understand the edge
            cases. What would make this estimate less uncertain?”
          </p>
          <p>
            Compare assumptions, clarify acceptance criteria, and estimate again. If the story feels
            too large, discuss splitting it into useful outcomes.
          </p>
        </div>
      )}
      <label className={styles.field}>
        Your assumptions and discussion notes
        <textarea
          aria-label="Your assumptions and discussion notes"
          maxLength={2000}
          rows={3}
          placeholder="What is known? What needs discovery? What would change your estimate?"
          value={readString(state, `pokerNote${storyIndex}`)}
          onChange={(event) => update({ [`pokerNote${storyIndex}`]: event.target.value })}
        />
      </label>
    </section>
  )
}
