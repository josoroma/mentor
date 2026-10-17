import { type CSSProperties } from 'react'
import { cn } from '@/lib/utils'

export const Waveform = ({
  active = false,
  level = 0,
  variant = 'coach',
  decorative = false,
}: {
  active?: boolean
  level?: number
  variant?: 'coach' | 'user'
  decorative?: boolean
}) => (
  <div
    className={cn('waveform', `waveform-${variant}`, active && 'waveform-active')}
    aria-hidden="true"
  >
    {Array.from({ length: 35 }, (_, index) => {
      const shape = 0.15 + Math.sin(index * 1.7) ** 2 * (1 - Math.abs(index - 17) / 20)
      return (
        <span
          key={index}
          style={
            {
              height: `${Math.round(decorative ? 5 + shape * 34 : 3 + shape * Math.min(level * 160, 48))}px`,
              '--bar-delay': `${index * -0.08}s`,
            } as CSSProperties
          }
        />
      )
    })}
  </div>
)
