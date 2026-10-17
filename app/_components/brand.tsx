import { AudioLines } from 'lucide-react'

export const Brand = ({ onHome }: { onHome?: () => void | Promise<void> }) => (
  <a
    className="brand"
    href="/#practice"
    aria-label="Mentor home"
    onClick={(event) => {
      if (
        !onHome ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return
      event.preventDefault()
      void onHome()
    }}
  >
    <span className="brand-symbol">
      <AudioLines size={25} strokeWidth={2.7} />
    </span>
    <span>
      mentor<span className="brand-dot">.</span>
    </span>
  </a>
)
