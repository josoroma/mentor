'use client'

import { useState } from 'react'
import {
  ArrowUpRight,
  AudioLines,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Flame,
  Heart,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
} from 'lucide-react'
import { isToday } from 'date-fns'
import type { Profile, Scenario, SessionRecord } from '@/app/_types'
import { Button } from '@/app/_components/ui/button'
import { ScenarioCard } from '@/app/_components/scenario-card'
import { FreeConversationCard } from '@/app/_components/free-conversation-card'
import { HomeConversationDemo } from '@/app/_components/home-conversation-demo'
import { LearningPathPicker } from '@/app/_components/learning-path-picker'
import { LearningPathTrail } from '@/app/_components/learning-path-trail'
import { cn } from '@/lib/utils'
import {
  LearningSelectionSchema,
  resolveLearningSelection,
  type LearningSelection,
} from '@/lib/learning/paths'
import styles from '@/app/_components/practice-dashboard.module.css'

const scenarioCategories = [
  { value: 'All scenarios', label: 'All scenarios' },
  { value: 'Daily communication', label: 'Day-to-day' },
  { value: 'Technical discussions', label: 'Technical' },
  { value: 'Presentations', label: 'Presentations' },
  { value: 'Collaboration', label: 'Collaboration' },
  { value: 'Saved', label: 'Saved' },
]
const savedPageSize = 9

export const PracticeDashboard = ({
  profile,
  scenarios,
  sessions,
  onSelect,
  onProfile,
  onFreeConversation,
  voiceEnabled,
  selection,
  onLearningSelectionChange,
  onStartLearning,
  scenariosLoading,
  scenariosError,
  onRegenerateScenarios,
  bookmarkedScenarios,
  bookmarkedIds,
  bookmarkPendingIds,
  bookmarksLoading,
  bookmarksError,
  onToggleBookmark,
  onRetryBookmarks,
}: {
  profile: Profile
  scenarios: Scenario[]
  sessions: SessionRecord[]
  onSelect: (scenario: Scenario) => void
  onProfile: () => void
  onFreeConversation: (topic?: string) => void
  voiceEnabled: boolean
  selection: LearningSelection | null
  onLearningSelectionChange: (selection: LearningSelection) => void
  onStartLearning: () => void
  scenariosLoading: boolean
  scenariosError: string | null
  onRegenerateScenarios: () => void
  bookmarkedScenarios: Scenario[]
  bookmarkedIds: string[]
  bookmarkPendingIds: string[]
  bookmarksLoading: boolean
  bookmarksError: string | null
  onToggleBookmark: (scenario: Scenario) => void
  onRetryBookmarks: () => void
}) => {
  const parsedSelection = LearningSelectionSchema.safeParse(selection)
  const context = parsedSelection.success ? resolveLearningSelection(parsedSelection.data) : null
  const selectionReady = !!context
  const available = scenariosLoading || scenariosError ? [] : scenarios
  const filterScope = `${JSON.stringify(selection)}:${profile.level}:${available.map(({ id }) => id).join('|')}`
  const [filters, setFilters] = useState({ scope: '', category: 'All scenarios', search: '' })
  const [savedActive, setSavedActive] = useState(false)
  const [savedFilters, setSavedFilters] = useState({ search: '', page: 0 })
  const category = savedActive
    ? 'Saved'
    : filters.scope === filterScope
      ? filters.category
      : 'All scenarios'
  const search = savedActive
    ? savedFilters.search
    : filters.scope === filterScope
      ? filters.search
      : ''
  const setCategory = (nextCategory: string) => {
    setSavedActive(nextCategory === 'Saved')
    if (nextCategory !== 'Saved') {
      setFilters({ scope: filterScope, category: nextCategory, search: savedActive ? '' : search })
    }
  }
  const setSearch = (nextSearch: string) => {
    if (savedActive) setSavedFilters({ search: nextSearch, page: 0 })
    else setFilters({ scope: filterScope, category, search: nextSearch })
  }
  const filtered = available.filter(
    (scenario) =>
      (category === 'All scenarios' || scenario.category === category) &&
      `${scenario.title} ${scenario.description}`.toLowerCase().includes(search.toLowerCase()),
  )
  const filteredSaved = bookmarkedScenarios.filter((scenario) =>
    `${scenario.title} ${scenario.description}`
      .toLowerCase()
      .includes(savedFilters.search.toLowerCase()),
  )
  const savedPageCount = Math.max(1, Math.ceil(filteredSaved.length / savedPageSize))
  const savedPage = Math.min(savedFilters.page, savedPageCount - 1)
  const visibleScenarios = savedActive
    ? filteredSaved.slice(savedPage * savedPageSize, (savedPage + 1) * savedPageSize)
    : filtered
  const savedIds = new Set(bookmarkedIds)
  const pendingIds = new Set(bookmarkPendingIds)
  const scenarioCards = (
    <div className="scenario-grid">
      {visibleScenarios.map((scenario, index) => (
        <ScenarioCard
          key={scenario.id}
          scenario={scenario}
          onSelect={onSelect}
          index={index}
          bookmarked={savedIds.has(scenario.id)}
          bookmarkPending={bookmarksLoading || pendingIds.has(scenario.id)}
          onToggleBookmark={onToggleBookmark}
        />
      ))}
    </div>
  )
  const todayMinutes = Math.floor(
    sessions
      .filter((session) => isToday(new Date(session.startedAt)))
      .reduce((sum, session) => sum + session.durationSeconds, 0) / 60,
  )
  const goal = profile.dailyGoalMinutes
  const goalPercent = Math.min(100, (todayMinutes / goal) * 100)
  const totalMinutes = Math.floor(
    sessions.reduce((sum, session) => sum + session.durationSeconds, 0) / 60,
  )

  return (
    <div className="dashboard page-enter">
      {selection && <LearningPathTrail selection={selection} label="Practice learning path" />}
      <div className="page-intro">
        <div>
          <div className="eyebrow">
            <span />
            ROLEPLAY AI · IMMERSIVE VOICE PRACTICE
          </div>
          <h1>Your voice. Your next opportunity.</h1>
          <p>Practice the conversations that matter to you. Show up as your most confident self.</p>
        </div>
        <button className="level-pill" onClick={onProfile}>
          <span className="level-bars">
            <i />
            <i />
            <i />
            <i />
          </span>
          {profile.level} ·{' '}
          {profile.level === 'C2'
            ? 'Proficient'
            : profile.level === 'C1'
              ? 'Advanced'
              : profile.level === 'A2'
                ? 'Elementary'
                : 'Intermediate'}
          <ChevronRight size={14} />
        </button>
      </div>
      <LearningPathPicker
        selection={selection}
        onChange={onLearningSelectionChange}
        onStart={onStartLearning}
        disabledStart={scenariosLoading || !!scenariosError || !available.length}
        creatingScenarios={scenariosLoading}
      />
      <section className="hero-grid" aria-label="Recommended practice">
        <HomeConversationDemo
          key={`${JSON.stringify(selection)}:${profile.level}`}
          profile={profile}
          selection={selection}
          enabled={voiceEnabled && selectionReady}
          scenarioStatus={scenariosError ? 'error' : available.length ? 'ready' : 'loading'}
        />
        <div className="daily-card">
          <div className="daily-card-heading">
            <span className="daily-icon">
              <Flame size={17} />
            </span>
            <span>A little, every day</span>
            <button onClick={onProfile} aria-label="Edit daily practice goal">
              <ArrowUpRight size={16} />
            </button>
          </div>
          <div
            className="goal-ring"
            style={{ '--goal-progress': `${goalPercent * 3.6}deg` } as React.CSSProperties}
          >
            <div>
              <span>
                {todayMinutes}
                <small> / {goal}</small>
              </span>
              <p>minutes today</p>
            </div>
          </div>
          <h3>{todayMinutes >= goal ? 'You showed up today.' : 'Your next step starts here.'}</h3>
          <p>
            {todayMinutes >= goal
              ? 'Goal reached. Every conversation counts.'
              : 'Make room for a more confident you.'}
          </p>
          <div className="daily-card-bottom">
            <Target size={15} />
            <span>
              {todayMinutes >= goal
                ? 'Daily goal complete'
                : `${Math.max(0, goal - todayMinutes)} minutes to your daily goal`}
            </span>
            {todayMinutes >= goal && <Check size={14} />}
          </div>
        </div>
      </section>
      <FreeConversationCard onStart={() => onFreeConversation()} />
      <div className="practice-stats">
        <div>
          <span className="stat-mini-icon">
            <AudioLines size={17} />
          </span>
          <strong>{sessions.filter((session) => session.status !== 'in-progress').length}</strong>
          <span>sessions completed</span>
        </div>
        <span className="stat-divider" />
        <div>
          <span className="stat-mini-icon">
            <Clock3 size={16} />
          </span>
          <strong>{totalMinutes}</strong>
          <span>minutes of practice</span>
        </div>
        <span className="stat-divider" />
        <div className="stats-note">
          <span className="tiny-spark">
            <Sparkles size={14} />
          </span>
          Progress happens one conversation at a time.
        </div>
      </div>
      <section
        className="scenario-section"
        aria-labelledby="scenario-heading"
        aria-busy={savedActive ? bookmarksLoading : scenariosLoading}
      >
        <div className={cn('section-heading', styles.heading)}>
          <div>
            <div className="section-eyebrow">
              {savedActive
                ? 'KEEP THE CONVERSATIONS THAT MATTER'
                : 'CREATED FOR YOUR LEARNING FOCUS'}
            </div>
            <h2 id="scenario-heading">
              {savedActive ? 'Your saved scenarios' : 'Find your next conversation'}
            </h2>
            <p className={styles.focus}>
              {savedActive
                ? 'Ready to revisit, from every learning focus.'
                : (context?.label ?? 'Choose your learning focus to begin.')}
            </p>
          </div>
          <div className={styles.actions}>
            {(savedActive || !!available.length) && (
              <span className="scenario-count">
                {savedActive ? bookmarkedScenarios.length : available.length} scenarios{' '}
                <span>{savedActive ? 'saved for later' : 'created for you'}</span>
              </span>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={onRegenerateScenarios}
              disabled={!selectionReady || scenariosLoading}
            >
              <RefreshCw size={14} /> Regenerate scenarios
            </Button>
          </div>
        </div>
        <div className="scenario-toolbar">
          <div
            className={cn('filter-tabs', styles.filters)}
            role="group"
            aria-label="Filter scenarios"
          >
            {scenarioCategories.map((item) => (
              <button
                key={item.value}
                aria-pressed={category === item.value}
                onClick={() => setCategory(item.value)}
                className={cn(
                  category === item.value && 'filter-active',
                  item.value === 'Saved' && styles.savedFilter,
                )}
              >
                {item.value === 'Saved' && <Heart size={12} aria-hidden="true" />}
                {item.label}
              </button>
            ))}
          </div>
          <label className="scenario-search">
            <Search size={15} />
            <input
              aria-label={savedActive ? 'Search saved scenarios' : 'Search scenarios'}
              placeholder={savedActive ? 'Search saved…' : 'Find a scenario…'}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <kbd>⌕</kbd>
          </label>
        </div>
        {bookmarksError && (
          <div className={styles.bookmarkError} role="alert">
            <p>{bookmarksError}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={onRetryBookmarks}
              disabled={bookmarksLoading}
            >
              <RefreshCw size={14} /> Retry saved scenarios
            </Button>
          </div>
        )}
        {savedActive ? (
          <>
            {bookmarksLoading && (
              <p className={styles.status} role="status">
                <LoaderCircle size={16} className="spin" /> Loading your saved scenarios…
              </p>
            )}
            {!!visibleScenarios.length && scenarioCards}
            {!bookmarksLoading && !bookmarksError && !bookmarkedScenarios.length && (
              <div className="empty-search">
                <Heart size={26} />
                <h3>Keep a conversation for later</h3>
                <p>
                  Save any scenario with its heart. Find it here whenever you want to practice
                  again.
                </p>
                <Button variant="secondary" onClick={() => setCategory('All scenarios')}>
                  Explore scenarios
                </Button>
              </div>
            )}
            {!!bookmarkedScenarios.length && !filteredSaved.length && (
              <div className="empty-search">
                <Search size={26} />
                <h3>No matching saved scenarios</h3>
                <p>Try another search to find a conversation you saved.</p>
                <Button
                  variant="secondary"
                  onClick={() => setSavedFilters({ search: '', page: 0 })}
                >
                  Clear search
                </Button>
              </div>
            )}
            {!!filteredSaved.length && (
              <nav className={styles.pagination} aria-label="Saved scenario pages">
                <p role="status">
                  {savedPage * savedPageSize + 1}–
                  {Math.min((savedPage + 1) * savedPageSize, filteredSaved.length)} of{' '}
                  {filteredSaved.length} saved scenarios
                </p>
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={savedPage === 0}
                    onClick={() =>
                      setSavedFilters((current) => ({ ...current, page: savedPage - 1 }))
                    }
                  >
                    <ChevronLeft size={14} /> Previous
                  </Button>
                  <span>
                    Page {savedPage + 1} of {savedPageCount}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={savedPage + 1 >= savedPageCount}
                    onClick={() =>
                      setSavedFilters((current) => ({ ...current, page: savedPage + 1 }))
                    }
                  >
                    Next <ChevronRight size={14} />
                  </Button>
                </div>
              </nav>
            )}
          </>
        ) : scenariosLoading ? (
          <div className={styles.pending}>
            <p role="status" className={styles.status}>
              <LoaderCircle size={16} className="spin" />
              Creating scenarios for {context?.label ?? 'your learning focus'} with local AI…
            </p>
            <div className="scenario-grid" aria-hidden="true">
              {Array.from({ length: 9 }, (_, index) => (
                <div className={styles.skeleton} key={index}>
                  <span className={styles.skeletonIcon} />
                  <span className={styles.skeletonTitle} />
                  <span />
                  <span />
                  <span className={styles.skeletonFooter} />
                </div>
              ))}
            </div>
          </div>
        ) : scenariosError ? (
          <div className={styles.error} role="alert">
            <h3>Your scenarios couldn’t be created</h3>
            <p>{scenariosError}</p>
            <Button variant="secondary" onClick={onRegenerateScenarios}>
              <RefreshCw size={15} /> Try again
            </Button>
          </div>
        ) : available.length ? (
          <>
            {scenarioCards}
            {!filtered.length && (
              <div className="empty-search">
                <Search size={26} />
                <h3>No matching conversations</h3>
                <p>Try a different search or explore another category.</p>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setFilters({ scope: filterScope, category: 'All scenarios', search: '' })
                  }}
                >
                  Clear filters
                </Button>
              </div>
            )}
          </>
        ) : (
          <p className={styles.status} role="status">
            {selectionReady
              ? 'Create fresh scenarios for your selected focus to begin.'
              : 'Choose a position or topic to create your practice scenarios.'}
          </p>
        )}
      </section>
      <div className="dashboard-footer">
        <span>
          <ShieldCheck size={13} />
          Your voice is yours. Audio stays on this device.
        </span>
        <span>Everyday moments. More confident conversations.</span>
      </div>
    </div>
  )
}
