import {
  AudioLines,
  ChartNoAxesCombined,
  History,
  SlidersHorizontal,
  CircleHelp,
  ArrowUpRight,
  ShieldCheck,
  PanelLeftClose,
  BookOpen,
  Sparkles,
  HardDriveDownload,
  Compass,
} from 'lucide-react'
import { Brand } from '@/app/_components/brand'
import { cn } from '@/lib/utils'

export type NavigationTab = 'practice' | 'explore' | 'progress' | 'history'

export const Sidebar = ({
  activeTab,
  onNavigate,
  onHome,
  onProfile,
  onSettings,
  onBackup,
  onHelp,
  open,
  onClose,
  localOnly,
}: {
  activeTab: NavigationTab
  onNavigate: (tab: NavigationTab) => void
  onHome: () => void
  onProfile: () => void
  onSettings: () => void
  onBackup: () => void
  onHelp: () => void
  open: boolean
  onClose: () => void
  localOnly: boolean
}) => (
  <>
    {open && <button className="sidebar-scrim" onClick={onClose} aria-label="Close navigation" />}
    <aside className={cn('sidebar', open && 'sidebar-open')}>
      <div className="sidebar-brand">
        <Brand onHome={onHome} />
        <button onClick={onClose} className="mobile-close" aria-label="Close navigation">
          <PanelLeftClose size={20} />
        </button>
      </div>
      <div className="workspace-label">
        <span className="workspace-mark">m</span>
        <div>
          Personal workspace<small>Your space to grow</small>
        </div>
        <span className="workspace-chevron">⌄</span>
      </div>
      <div className="nav-caption">WORKSPACE</div>
      <nav aria-label="Main navigation">
        {(
          [
            { id: 'practice', label: 'Practice', icon: AudioLines },
            { id: 'explore', label: 'Explore', icon: Compass },
            { id: 'progress', label: 'My progress', icon: ChartNoAxesCombined },
            { id: 'history', label: 'Session history', icon: History },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            aria-current={activeTab === id ? 'page' : undefined}
            className={cn('nav-item', activeTab === id && 'nav-active')}
            onClick={() => {
              onNavigate(id)
              onClose()
            }}
          >
            <Icon size={19} />
            <span>{label}</span>
            {activeTab === id && <span className="nav-active-dot" />}
          </button>
        ))}
      </nav>
      <div className="nav-caption second-caption">PERSONALIZE</div>
      <button className="nav-item" onClick={onProfile}>
        <BookOpen size={18} />
        <span>Learning profile</span>
      </button>
      <button className="nav-item" onClick={onSettings}>
        <SlidersHorizontal size={18} />
        <span>Settings</span>
      </button>
      <button
        id="backup-reset-trigger"
        className="nav-item"
        onClick={() => {
          onClose()
          onBackup()
        }}
      >
        <HardDriveDownload size={18} />
        <span>Backup &amp; reset</span>
      </button>
      <div className="sidebar-bottom">
        <div className="sidebar-note">
          <span className="note-icon">
            <Sparkles size={18} />
          </span>
          <h3>
            Small practice.
            <br />
            Big confidence.
          </h3>
          <p>
            A few minutes today.
            <br />A clearer voice tomorrow.
          </p>
          <button onClick={onProfile}>
            Make it a daily habit <ArrowUpRight size={14} />
          </button>
        </div>
        <button className="nav-item help-button" onClick={onHelp}>
          <CircleHelp size={18} />
          <span>Help & getting started</span>
        </button>
        <div className="privacy-note">
          <ShieldCheck size={13} />
          <span>
            {localOnly
              ? 'Private by design. Local by default.'
              : 'Local voice · Supabase sync requested'}
          </span>
        </div>
      </div>
    </aside>
  </>
)
