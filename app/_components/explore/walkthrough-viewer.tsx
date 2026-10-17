'use client'

import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/app/_components/ui/button'
import { readNumber, readString, type RendererProps } from '@/app/_components/explore/_types'
import styles from '@/app/_components/explore/artifact-viewer.module.css'

export const WalkthroughViewer = ({ content, state, update }: RendererProps) => {
  const index = Math.round(readNumber(state, 'walkthroughStep', 0, 0, content.steps.length - 1))
  const step = content.steps[index]
  if (!step) return null
  const completed = Array.isArray(state.walkthroughCompleted)
    ? state.walkthroughCompleted.filter((value): value is number => typeof value === 'number')
    : []
  return (
    <section className={styles.interactive} aria-label="Guided walkthrough">
      <div className={styles.row}>
        <h3>Learn one step at a time</h3>
        <span className={styles.meta}>
          {completed.length} / {content.steps.length} practiced
        </span>
      </div>
      <div className={styles.stepRail} role="group" aria-label="Walkthrough steps">
        {content.steps.map((item, stepIndex) => (
          <button
            key={stepIndex}
            type="button"
            aria-current={index === stepIndex ? 'step' : undefined}
            onClick={() => update({ walkthroughStep: stepIndex })}
            title={item.title}
          >
            {completed.includes(stepIndex) ? <Check size={14} /> : stepIndex + 1}
          </button>
        ))}
      </div>
      <div className={styles.callout}>
        <span className={styles.eyebrow}>Step {index + 1}</span>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
      </div>
      <label className={styles.field}>
        Make it practical
        <textarea
          aria-label="Make it practical"
          rows={4}
          maxLength={2000}
          value={readString(state, `walkthroughNote${index}`)}
          onChange={(event) => update({ [`walkthroughNote${index}`]: event.target.value })}
          placeholder="Try this step in your own context. What would you say or do? Capture one action and how you will know it worked."
        />
      </label>
      <div className={styles.controls}>
        <Button
          size="sm"
          variant="secondary"
          disabled={!index}
          onClick={() => update({ walkthroughStep: index - 1 })}
        >
          <ChevronLeft size={16} />
          Back
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            update({
              walkthroughCompleted: completed.includes(index)
                ? completed.filter((value) => value !== index)
                : [...completed, index],
            })
          }
        >
          <Check size={16} />
          {completed.includes(index) ? 'Practiced' : 'Mark practiced'}
        </Button>
        <Button
          size="sm"
          disabled={index === content.steps.length - 1}
          onClick={() => update({ walkthroughStep: index + 1 })}
        >
          Next
          <ChevronRight size={16} />
        </Button>
      </div>
    </section>
  )
}
