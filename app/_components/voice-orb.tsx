import { type CSSProperties } from 'react'
import { cn } from '@/lib/utils'

export const VoiceOrb = ({
  active = false,
  level = 0,
  variant = 'coach',
  small = false,
}: {
  active?: boolean
  level?: number
  variant?: 'coach' | 'user'
  small?: boolean
}) => {
  const audioLevel = active && Number.isFinite(level) ? Math.max(0, Math.min(level * 5, 1)) : 0

  return (
    <div
      className={cn('orb-scene', `orb-${variant}`, active && 'orb-active', small && 'orb-small')}
      style={
        {
          '--audio-level': audioLevel,
          '--orb-scale': 1 + audioLevel * 0.18,
        } as CSSProperties
      }
      aria-hidden="true"
    >
      <div className="orb-orbit orbit-one" />
      <div className="orb-orbit orbit-two" />
      <div className="orb-orbit orbit-three" />
      <div className="orb-halo" />
      <div className="orb-ripple ripple-one" />
      <div className="orb-ripple ripple-two" />
      <div className="voice-orb">
        <div className="orb-shine" />
        <div className="orb-voice-bars">
          {Array.from({ length: 7 }, (_, index) => (
            <span key={index} style={{ '--bar-index': index } as CSSProperties} />
          ))}
        </div>
      </div>
      <div className="orb-spark spark-one" />
      <div className="orb-spark spark-two" />
    </div>
  )
}
