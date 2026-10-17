'use client'

import { type RendererProps } from '@/app/_components/explore/_types'
import styles from '@/app/_components/explore/artifact-viewer.module.css'

export const PracticeQuestions = ({ content, state, update }: RendererProps) => {
  if (!content.questions.length) return null
  return (
    <section className={styles.questions} aria-label="Check your understanding">
      <h3>Check your understanding</h3>
      {content.questions.map((question, index) => {
        const selected =
          typeof state[`answer${index}`] === 'number' ? state[`answer${index}`] : null
        return (
          <fieldset key={index}>
            <legend>
              {index + 1}. {question.question}
            </legend>
            <div className={styles.answers}>
              {question.options.map((option, optionIndex) => (
                <button
                  key={optionIndex}
                  type="button"
                  aria-pressed={selected === optionIndex}
                  onClick={() => update({ [`answer${index}`]: optionIndex })}
                >
                  {option}
                </button>
              ))}
            </div>
            {selected !== null && (
              <p className={styles.answerFeedback} aria-live="polite">
                <strong>
                  {selected === question.answer ? 'That’s right.' : 'Try another perspective.'}
                </strong>{' '}
                {question.explanation}
              </p>
            )}
          </fieldset>
        )
      })}
    </section>
  )
}
