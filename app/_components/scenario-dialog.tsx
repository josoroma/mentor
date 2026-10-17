import { ArrowRight, Check, Clock3, Headphones, Mic, ShieldCheck, Sparkles } from 'lucide-react'
import type { Profile, Role, Scenario } from '@/app/_types'
import { Modal } from '@/app/_components/ui/modal'
import { Button } from '@/app/_components/ui/button'
import { getLearningSelectionLabel } from '@/lib/learning/paths'

export const ScenarioDialog = ({
  scenario,
  onClose,
  onStart,
  profile,
  roles,
}: {
  scenario: Scenario | null
  onClose: () => void
  onStart: (scenario: Scenario) => void
  profile: Profile
  roles: Role[]
}) => (
  <Modal
    open={!!scenario}
    onOpenChange={(open) => {
      if (!open) onClose()
    }}
    title={scenario?.title ?? 'Your next conversation'}
    description="A little preparation. A much more natural conversation."
  >
    {scenario && (
      <div className="scenario-brief">
        <div className="brief-meta">
          <span className="tag">
            <Clock3 size={13} />
            {scenario.minutes} minutes
          </span>
          <span className="tag">{profile.level} · Adaptive</span>
          <span className="tag">{scenario.difficulty}</span>
        </div>
        <div className="persona-card">
          <span className="persona-avatar">{scenario.persona.name.slice(0, 1)}</span>
          <div>
            <strong>
              Meet {scenario.persona.name}, {scenario.persona.role.toLowerCase()}
            </strong>
            <p>
              AI role-play partner ·{' '}
              {scenario.learningSelection
                ? getLearningSelectionLabel(scenario.learningSelection)
                : roles.find((role) => role.id === profile.roleId)?.name}
            </p>
          </div>
          <Sparkles className="persona-spark" size={18} />
        </div>
        <h3>The situation</h3>
        <p className="brief-description">{scenario.brief}</p>
        <h3>Your practice goals</h3>
        <ul className="objectives-list">
          {scenario.objectives.map((objective) => (
            <li key={objective}>
              <Check size={15} />
              {objective}
            </li>
          ))}
        </ul>
        <div className="brief-tip">
          <Headphones size={18} />
          <p>
            Headphones help keep the conversation clear. Speak naturally—your coach gives you space
            to finish.
          </p>
        </div>
        <Button size="lg" onClick={() => onStart(scenario)}>
          <Mic size={17} />
          Start conversation
          <ArrowRight size={17} />
        </Button>
        <div className="brief-privacy">
          <ShieldCheck size={13} />
          Local audio · Live transcript · Feedback after practice
        </div>
      </div>
    )}
  </Modal>
)
