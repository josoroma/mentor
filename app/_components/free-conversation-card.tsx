import { ArrowUpRight, AudioLines, MessageCircle, Sparkles } from 'lucide-react'
import { Button } from '@/app/_components/ui/button'
import styles from '@/app/_components/free-conversation.module.css'

export const FreeConversationCard = ({ onStart }: { onStart: () => void }) => (
  <section className={styles.card} aria-labelledby="free-conversation-heading">
    <div className={styles.cardIcon} aria-hidden="true">
      <MessageCircle size={24} />
      <AudioLines size={16} />
    </div>
    <div className={styles.cardCopy}>
      <span className={styles.eyebrow}>YOUR TOPIC. YOUR CONVERSATION.</span>
      <h2 id="free-conversation-heading">What’s on your mind?</h2>
      <p>
        A project, an interview, your next trip. Bring a topic and we’ll shape a conversation around
        you.
      </p>
      <span className={styles.cardNote}>
        <Sparkles size={13} /> A clearer topic. A personal plan. A real conversation.
      </span>
    </div>
    <Button id="free-conversation-trigger" variant="secondary" onClick={onStart}>
      Free conversation <ArrowUpRight size={17} />
    </Button>
  </section>
)
