import { Check, Cpu, LoaderCircle } from 'lucide-react'
import styles from '@/app/_components/model-usage-overview.module.css'

const capabilities = [
  {
    name: 'Conversations & homepage demos',
    description: 'Role-play, contextual replies, and exchanges between your AI partners.',
  },
  {
    name: 'Dynamic practice scenarios',
    description: 'Up to 9 scenarios tailored to your role or life-skills topic and English level.',
  },
  {
    name: 'Conversation plans & tips',
    description: 'Personal conversation outlines, clearer topics, and storytelling guidance.',
  },
  {
    name: 'Explore',
    description: 'Up to 12 ideas, interactive lesson content, and answers about your lesson.',
  },
  {
    name: 'Improved English & feedback',
    description: 'Clearer wording for your speech and writing, plus post-session feedback.',
  },
]

export const ModelUsageOverview = ({
  coach,
  checking,
}: {
  coach?: {
    available: boolean
    displayName?: string
    runtime?: string
    degraded?: boolean
    detail?: string
  }
  checking: boolean
}) => (
  <section className={styles.section} aria-labelledby="model-usage-title" aria-busy={checking}>
    <h3 id="model-usage-title">
      <Cpu size={17} /> Models behind Mentor
    </h3>
    <p className={styles.intro}>
      These features share one local language model. Your saved learning focus and English level
      shape its responses.
    </p>
    <div className={styles.card}>
      <div className={styles.heading}>
        <div className={styles.identity}>
          <span className={styles.label}>CONVERSATION & LEARNING</span>
          <strong>
            {coach?.displayName ??
              (checking ? 'Checking the local model…' : 'Model name not reported')}
          </strong>
          <p>{coach?.runtime ? `${coach.runtime} · ` : ''}Local inference</p>
        </div>
        <span
          className={
            checking
              ? 'service-neutral'
              : coach?.available && !coach.degraded
                ? 'service-ready'
                : 'service-offline'
          }
          role="status"
        >
          {checking ? (
            <>
              <LoaderCircle size={12} className="spin" /> Checking
            </>
          ) : coach?.degraded ? (
            'Needs attention'
          ) : coach?.available ? (
            <>
              <Check size={12} /> Ready
            </>
          ) : (
            'Not connected'
          )}
        </span>
      </div>
      <dl className={styles.capabilities}>
        {capabilities.map(({ name, description }) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{description}</dd>
          </div>
        ))}
      </dl>
      {coach?.detail && (
        <p className={styles.detail} role="status">
          {coach.detail}
        </p>
      )}
    </div>
  </section>
)
