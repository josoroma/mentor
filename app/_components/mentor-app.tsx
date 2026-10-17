'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { useAtom, useAtomValue } from 'jotai'
import { AudioLines, ChevronDown, ChevronRight, Menu, ShieldCheck, Sparkles, X } from 'lucide-react'
import { learningSelectionAtom, profileAtom, sessionHistoryAtom } from '@/app/_atoms'
import { defaultProfile, roles, scenarios as defaultScenarios } from '@/app/_constants'
import { FeedbackSchema } from '@/app/_schema'
import type { ConversationOutline, Profile, Scenario, SessionRecord } from '@/app/_types'
import {
  loadLearningData,
  saveLearningProfile,
  saveLearningSession,
  syncLearningData,
} from '@/lib/learning/persistence'
import { readLearningData, type LearningData } from '@/lib/learning/storage'
import {
  acknowledgeLearningRevision,
  assertLearningWriteAllowed,
  subscribeLearningMaintenance,
} from '@/lib/learning/maintenance'
import { isLocalSupabaseConfigured } from '@/lib/supabase/client'
import { stopCorrectionPlayback } from '@/lib/audio/correction-playback'
import { notifySpeechProviderChange } from '@/lib/audio/speech-preference'
import { resolveSpeechProviderStatus } from '@/lib/audio/speech-provider'
import {
  LearningSelectionSchema,
  applyProfileLearningSelection,
  getProfileLearningSelection,
  type LearningSelection,
} from '@/lib/learning/paths'
import { useGeneratedScenarios } from '@/app/_hooks/use-generated-scenarios'
import { useScenarioBookmarks } from '@/app/_hooks/use-scenario-bookmarks'
import { Sidebar, type NavigationTab } from '@/app/_components/sidebar'
import { PracticeDashboard } from '@/app/_components/practice-dashboard'
import { ProgressView } from '@/app/_components/progress-view'
import { HistoryView } from '@/app/_components/history-view'
import { ProfileDialog } from '@/app/_components/profile-dialog'
import { ScenarioDialog } from '@/app/_components/scenario-dialog'
import { SettingsDialog, type ServiceHealth } from '@/app/_components/settings-dialog'
import { SessionStudio } from '@/app/_components/session-studio'
import { FeedbackDialog } from '@/app/_components/feedback-dialog'
import { ThemeToggle } from '@/app/_components/theme-toggle'
import { FreeConversationDialog } from '@/app/_components/free-conversation-dialog'
import { BackupResetDialog } from '@/app/_components/backup-reset-dialog'

const ExploreWorkspace = dynamic(
  () =>
    import('@/app/_components/explore/explore-workspace').then((module) => module.ExploreWorkspace),
  { loading: () => <p role="status">Opening Explore…</p> },
)

export const MentorApp = () => {
  const [profile, setProfile] = useAtom(profileAtom)
  const [sessions, setSessions] = useAtom(sessionHistoryAtom)
  const learningSelection = useAtomValue(learningSelectionAtom)
  const [scenarios, setScenarios] = useState(defaultScenarios)
  const [tab, setTab] = useState<NavigationTab>('practice')
  const [learningReady, setLearningReady] = useState(false)
  const [maintenanceReady, setMaintenanceReady] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [backupOpen, setBackupOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [selectedScenario, setSelectedScenario] = useState<Scenario | null>(null)
  const [activeScenario, setActiveScenario] = useState<Scenario | null>(null)
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null)
  const [freeConversationOpen, setFreeConversationOpen] = useState(false)
  const [initialTopic, setInitialTopic] = useState<string | undefined>()
  const [conversation, setConversation] = useState<ConversationOutline | undefined>()
  const [health, setHealth] = useState<ServiceHealth | null>(null)
  const [checking, setChecking] = useState(false)
  const [notification, setNotification] = useState<string | null>(null)
  const [reviewSession, setReviewSession] = useState<SessionRecord | null>(null)
  const [feedbackLoading, setFeedbackLoading] = useState(false)
  const [feedbackError, setFeedbackError] = useState<string | null>(null)
  const [feedbackSessionId, setFeedbackSessionId] = useState<string | null>(null)
  const feedbackController = useRef<AbortController | null>(null)
  const dataRevisionRef = useRef(0)
  useEffect(() => notifySpeechProviderChange(), [profile.speechProvider])
  useEffect(() => {
    stopCorrectionPlayback()
    return stopCorrectionPlayback
  }, [
    tab,
    sidebarOpen,
    profileOpen,
    settingsOpen,
    backupOpen,
    helpOpen,
    selectedScenario?.id,
    activeScenario?.id,
    freeConversationOpen,
    reviewSession?.id,
  ])
  const generatedScenarios = useGeneratedScenarios({
    selection: learningSelection,
    roleId: roles.some((role) => role.id === profile.roleId)
      ? profile.roleId
      : defaultProfile.roleId,
    level: profile.level,
    enabled: learningReady && maintenanceReady && !backupOpen && tab === 'practice',
  })
  const bookmarks = useScenarioBookmarks({
    enabled: learningReady && maintenanceReady && !backupOpen,
    sync: isLocalSupabaseConfigured() || !profile.localOnly,
    level: profile.level,
  })
  useEffect(() => () => feedbackController.current?.abort(), [])
  useEffect(() => {
    const navigate = () => {
      const next = window.location.hash.slice(1).split('/')[0]
      if (next === 'practice' || next === 'explore' || next === 'progress' || next === 'history')
        setTab(next)
    }
    navigate()
    window.addEventListener('hashchange', navigate)
    return () => window.removeEventListener('hashchange', navigate)
  }, [])

  const checkHealth = useCallback(async () => {
    setChecking(true)
    try {
      const response = await fetch('/api/health', { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error('Unable to check local services')
      setHealth((await response.json()) as ServiceHealth)
    } catch {
      setHealth({
        coach: { available: false },
        speech: { available: false },
        storage: { configured: false },
      })
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    if (settingsOpen || helpOpen) void checkHealth()
  }, [settingsOpen, helpOpen, checkHealth])

  useEffect(() => {
    let cancelled = false
    const revision = dataRevisionRef.current
    const initializeLearningData = async () => {
      let startupProfile = defaultProfile
      try {
        const local = readLearningData()
        startupProfile = local.profile
        setScenarios(local.scenarios)
        setProfile(local.profile)
        setSessions(local.sessions)
        setLearningReady(true)
        {
          const result = await loadLearningData({
            sync: isLocalSupabaseConfigured() || !local.profile.localOnly,
          })
          if (cancelled || revision !== dataRevisionRef.current) return
          startupProfile = result.data.profile
          setProfile(result.data.profile)
          setSessions(result.data.sessions)
          setScenarios(result.data.scenarios)
          if (result.error)
            setNotification(`Your local data is ready. Sync needs attention: ${result.error}`)
        }
      } catch (error) {
        if (!cancelled && revision === dataRevisionRef.current) setLearningReady(true)
        if (!cancelled && revision === dataRevisionRef.current)
          setNotification(
            error instanceof Error
              ? error.message
              : 'Browser storage is unavailable. Your learning history could not be restored.',
          )
      } finally {
        if (!cancelled && revision === dataRevisionRef.current) {
          try {
            const restoredProfile = applyProfileLearningSelection(
              startupProfile,
              getProfileLearningSelection(startupProfile),
            )
            if (JSON.stringify(startupProfile) !== JSON.stringify(restoredProfile)) {
              // Persist a legacy role/path once before starting personalized audio.
              const result = await saveLearningProfile(restoredProfile)
              if (cancelled || revision !== dataRevisionRef.current) return
              setProfile(result.data)
              if (result.error)
                setNotification(`Learning focus saved on this device. ${result.error}`)
            } else setProfile(restoredProfile)
          } catch (error) {
            if (!cancelled && revision === dataRevisionRef.current)
              setNotification(
                error instanceof Error
                  ? error.message
                  : 'Your learning focus could not be saved. Check browser storage and retry.',
              )
          } finally {
            if (!cancelled && revision === dataRevisionRef.current) setMaintenanceReady(true)
          }
        }
      }
    }
    void initializeLearningData()
    void checkHealth()
    return () => {
      cancelled = true
    }
  }, [setProfile, setSessions, checkHealth])

  const updateProfile = async (value: Profile) => {
    const revision = dataRevisionRef.current
    try {
      const result = await saveLearningProfile(value)
      if (revision !== dataRevisionRef.current) return
      setProfile(result.data)
      if (result.error) setNotification(`Profile saved on this device. ${result.error}`)
      else if (!value.localOnly) {
        const synced = await syncLearningData()
        if (revision !== dataRevisionRef.current) return
        setSessions(synced.data.sessions)
        setScenarios(synced.data.scenarios)
        setNotification(
          synced.error
            ? `Profile saved. ${synced.error}`
            : synced.syncStatus === 'synced'
              ? 'Your learning profile and sessions are synced.'
              : 'Your learning data is saved on this device.',
        )
      } else setNotification('Your learning profile is saved on this device.')
    } catch (error) {
      if (revision !== dataRevisionRef.current) return
      setNotification(error instanceof Error ? error.message : 'Your profile could not be saved.')
      throw error
    }
  }

  const saveLearningSelection = async (selection: LearningSelection) => {
    const valid = LearningSelectionSchema.parse(selection)
    assertLearningWriteAllowed()
    generatedScenarios.cancel()
    setSelectedScenario(null)
    const next = applyProfileLearningSelection(readLearningData().profile, valid)
    setProfile(next)
    await updateProfile(next)
  }

  const changeLearningSelection = (selection: LearningSelection) => {
    void saveLearningSelection(selection).catch((error: unknown) => {
      setNotification(
        error instanceof Error ? error.message : 'Your learning focus could not be saved.',
      )
    })
  }

  const startLearningSession = () => {
    const scenario = generatedScenarios.scenarios[0]
    if (!scenario || generatedScenarios.loading || !learningReady) return
    feedbackController.current?.abort()
    setFeedbackLoading(false)
    setConversation(undefined)
    setActiveProfile({ ...safeProfile, roleId: scenario.roleIds[0] })
    setActiveScenario(scenario)
  }

  const persistSession = async (session: SessionRecord) => {
    const revision = dataRevisionRef.current
    const result = await saveLearningSession(session, {
      sync: isLocalSupabaseConfigured() || !profile.localOnly,
    })
    if (revision !== dataRevisionRef.current) return
    setSessions((previous) => [session, ...previous.filter((item) => item.id !== session.id)])
    if (result.error) setNotification(`Session saved on this device. ${result.error}`)
  }

  const generateFeedback = async (session: SessionRecord) => {
    feedbackController.current?.abort()
    const controller = new AbortController()
    feedbackController.current = controller
    setFeedbackSessionId(session.id)
    setFeedbackLoading(true)
    setFeedbackError(null)
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenarioId: session.scenarioId,
          scenario: session.scenario ?? scenarios.find((item) => item.id === session.scenarioId),
          roleId: session.roleId,
          level: session.level,
          durationSeconds: session.durationSeconds,
          messages: session.messages.map(({ role, content }) => ({ role, content })),
        }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]),
      })
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(
          data.error ||
            'Your coach is unavailable. Your conversation is saved—try feedback again when the local model is ready.',
        )
      }
      const feedback = FeedbackSchema.parse(await response.json())
      if (controller.signal.aborted || feedbackController.current !== controller) return
      const updated = { ...session, feedback }
      await persistSession(updated)
      if (controller.signal.aborted || feedbackController.current !== controller) return
      setReviewSession((current) => (current?.id === session.id ? updated : current))
    } catch (error) {
      if (!controller.signal.aborted && feedbackController.current === controller)
        setFeedbackError(
          error instanceof Error
            ? error.message
            : 'Feedback could not be generated. Your session is saved.',
        )
    } finally {
      if (feedbackController.current === controller) setFeedbackLoading(false)
    }
  }

  const completeSession = async (session: SessionRecord) => {
    const revision = dataRevisionRef.current
    setActiveScenario(null)
    setReviewSession(session)
    setFeedbackError(null)
    setFeedbackSessionId(session.id)
    try {
      await persistSession(session)
      if (revision !== dataRevisionRef.current) return
      await generateFeedback(session)
    } catch (error) {
      if (revision !== dataRevisionRef.current) return
      setFeedbackError(
        error instanceof Error ? error.message : 'This browser could not save your session.',
      )
      setNotification(
        'Your session is still available in the review. Browser storage could not be updated.',
      )
    }
  }

  const goHome = () => {
    feedbackController.current?.abort()
    feedbackController.current = null
    stopCorrectionPlayback()
    setFeedbackLoading(false)
    setFeedbackError(null)
    setFeedbackSessionId(null)
    setReviewSession(null)
    setSelectedScenario(null)
    setActiveScenario(null)
    setActiveProfile(null)
    setConversation(undefined)
    setInitialTopic(undefined)
    setFreeConversationOpen(false)
    setProfileOpen(false)
    setSettingsOpen(false)
    setBackupOpen(false)
    setHelpOpen(false)
    setSidebarOpen(false)
    try {
      setSessions(readLearningData().sessions)
    } catch (error) {
      setNotification(
        error instanceof Error ? error.message : 'Your saved history could not be refreshed.',
      )
    }
    setTab('practice')
    window.location.hash = 'practice'
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

  const startMaintenance = useCallback(() => {
    generatedScenarios.cancel()
    dataRevisionRef.current += 1
    feedbackController.current?.abort()
    feedbackController.current = null
    setFeedbackLoading(false)
    setFeedbackError(null)
    setFeedbackSessionId(null)
    setReviewSession(null)
    setSelectedScenario(null)
    setFreeConversationOpen(false)
    setInitialTopic(undefined)
    setConversation(undefined)
    setNotification(null)
  }, [generatedScenarios.cancel])

  const applyLearningData = useCallback(
    (data: LearningData) => {
      setProfile(
        applyProfileLearningSelection(data.profile, getProfileLearningSelection(data.profile)),
      )
      setSessions(data.sessions)
      setScenarios(data.scenarios)
      setTab('practice')
      window.location.hash = 'practice'
    },
    [setProfile, setSessions],
  )

  useEffect(() => {
    let mounted = true
    const unsubscribe = subscribeLearningMaintenance((event) => {
      if (!event.external || !event.changesData) return
      if (event.phase === 'start') {
        startMaintenance()
        setActiveScenario(null)
        setLearningReady(false)
        setMaintenanceReady(false)
        setNotification('Your learning data is being updated in another Mentor tab.')
        return
      }
      if (!event.changed) {
        setLearningReady(true)
        setMaintenanceReady(true)
        setNotification(null)
        return
      }
      acknowledgeLearningRevision()
      const revision = dataRevisionRef.current
      void loadLearningData({ sync: false })
        .then((result) => {
          if (!mounted || revision !== dataRevisionRef.current) return
          applyLearningData(result.data)
          setNotification(
            result.error
              ? `Your learning data changed in another tab. ${result.error}`
              : 'Your learning data was updated in another Mentor tab.',
          )
        })
        .catch((error: unknown) => {
          if (mounted && revision === dataRevisionRef.current)
            setNotification(
              error instanceof Error
                ? error.message
                : 'Reload Mentor to refresh your learning data.',
            )
        })
        .finally(() => {
          if (mounted && revision === dataRevisionRef.current) {
            setLearningReady(true)
            setMaintenanceReady(true)
          }
        })
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [startMaintenance, applyLearningData])

  const safeProfile = roles.some((role) => role.id === profile.roleId)
    ? profile
    : { ...profile, roleId: defaultProfile.roleId }
  const practiceProfile = applyProfileLearningSelection(safeProfile, learningSelection)
  const sessionProfile = activeProfile ?? practiceProfile
  const selectedBookmark = bookmarks.records.find(
    (record) => record.saved && record.scenario.id === selectedScenario?.id,
  )
  const selectedSpeech = resolveSpeechProviderStatus(health?.speech, profile.speechProvider)
  const speechReady =
    (health?.speech.recognition ?? health?.speech.available) && selectedSpeech?.synthesis === true
  const selectedScenarioProfile = selectedScenario
    ? {
        ...practiceProfile,
        roleId: selectedScenario.roleIds[0],
        level: selectedBookmark?.level ?? practiceProfile.level,
      }
    : practiceProfile
  if (activeScenario)
    return (
      <SessionStudio
        key={activeScenario.id}
        scenario={activeScenario}
        conversation={conversation}
        profile={sessionProfile}
        roles={roles}
        onComplete={(session) => void completeSession(session)}
        onHome={goHome}
        onExit={() => {
          setSessions(readLearningData().sessions)
          setActiveScenario(null)
        }}
      />
    )

  return (
    <div className="app-shell">
      <Sidebar
        activeTab={tab}
        onHome={goHome}
        onNavigate={(next) => {
          setTab(next)
          window.location.hash = next
        }}
        onProfile={() => setProfileOpen(true)}
        onSettings={() => {
          setSettingsOpen(true)
          void checkHealth()
        }}
        onBackup={() => setBackupOpen(true)}
        onHelp={() => setHelpOpen(true)}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        localOnly={profile.localOnly}
      />
      <div className="app-main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-menu"
              aria-label="Open navigation"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={20} />
            </button>
            <span className="breadcrumb-home">Workspace</span>
            <ChevronRight size={12} />
            <strong>
              {tab === 'practice'
                ? 'Practice'
                : tab === 'explore'
                  ? 'Explore'
                  : tab === 'progress'
                    ? 'My progress'
                    : 'Session history'}
            </strong>
          </div>
          <div className="topbar-actions">
            <button
              className="local-status"
              onClick={() => {
                setSettingsOpen(true)
                void checkHealth()
              }}
            >
              <span
                className={
                  health?.coach.available && !health.coach.degraded && speechReady
                    ? 'status-dot'
                    : 'status-dot status-pending'
                }
              />
              {health?.coach.available && !health.coach.degraded && speechReady
                ? 'Local studio ready'
                : 'Local practice'}
            </button>
            <div className="role-select">
              <Sparkles size={14} />
              <select
                aria-label="Learning path"
                value={learningSelection?.path ?? profile.learningPath ?? 'professional'}
                disabled={!learningReady || !maintenanceReady}
                onChange={(event) =>
                  changeLearningSelection(
                    getProfileLearningSelection({
                      roleId: profile.roleId,
                      learningPath:
                        event.target.value === 'life-skills' ? 'life-skills' : 'professional',
                    }),
                  )
                }
              >
                <option value="professional">Professional Roles</option>
                <option value="life-skills">Life &amp; Workplace Skills</option>
              </select>
              <ChevronDown size={13} />
            </div>
            <ThemeToggle />
            <button
              className="profile-avatar"
              onClick={() => setProfileOpen(true)}
              aria-label="Edit learning profile"
            >
              {profile.name ? profile.name.slice(0, 2).toUpperCase() : <AudioLines size={19} />}
            </button>
          </div>
        </header>
        {notification && (
          <div className="notification" role="status">
            <ShieldCheck size={16} />
            <span>{notification}</span>
            <button onClick={() => setNotification(null)} aria-label="Dismiss notification">
              <X size={15} />
            </button>
          </div>
        )}
        <main className="main-content">
          {tab === 'practice' ? (
            <PracticeDashboard
              profile={practiceProfile}
              selection={learningReady && maintenanceReady ? learningSelection : null}
              onLearningSelectionChange={changeLearningSelection}
              onStartLearning={startLearningSession}
              scenarios={generatedScenarios.scenarios}
              scenariosLoading={generatedScenarios.loading}
              scenariosError={generatedScenarios.error}
              onRegenerateScenarios={() => void generatedScenarios.regenerate()}
              bookmarkedScenarios={bookmarks.scenarios}
              bookmarkedIds={bookmarks.ids}
              bookmarkPendingIds={bookmarks.pendingIds}
              bookmarksLoading={bookmarks.loading}
              bookmarksError={bookmarks.error}
              onToggleBookmark={(scenario) => void bookmarks.toggle(scenario)}
              onRetryBookmarks={() => void bookmarks.refresh()}
              sessions={sessions}
              onSelect={setSelectedScenario}
              onProfile={() => setProfileOpen(true)}
              voiceEnabled={
                learningReady &&
                maintenanceReady &&
                !freeConversationOpen &&
                !selectedScenario &&
                !profileOpen &&
                !settingsOpen &&
                !backupOpen &&
                !helpOpen &&
                !reviewSession &&
                !sidebarOpen
              }
              onFreeConversation={(topic) => {
                setInitialTopic(topic)
                setFreeConversationOpen(true)
              }}
            />
          ) : tab === 'explore' ? (
            <ExploreWorkspace
              enabled={learningReady && maintenanceReady && !backupOpen}
              selection={learningSelection}
              level={practiceProfile.level}
              onLearningSelectionChange={changeLearningSelection}
            />
          ) : tab === 'progress' ? (
            <ProgressView
              sessions={sessions}
              onPractice={() => {
                setTab('practice')
                window.location.hash = 'practice'
              }}
            />
          ) : (
            <HistoryView
              sessions={sessions}
              scenarios={scenarios}
              onSelect={(session) => {
                setReviewSession(session)
                setFeedbackError(null)
              }}
              onPractice={() => {
                setTab('practice')
                window.location.hash = 'practice'
              }}
            />
          )}
        </main>
      </div>
      <ProfileDialog
        open={profileOpen}
        onOpenChange={setProfileOpen}
        profile={safeProfile}
        roles={roles}
        onSave={updateProfile}
        supabaseConfigured={health?.storage.configured ?? false}
        supabaseLocal={health?.storage.local ?? false}
      />
      <ScenarioDialog
        scenario={selectedScenario}
        onClose={() => setSelectedScenario(null)}
        onStart={(scenario) => {
          feedbackController.current?.abort()
          setFeedbackLoading(false)
          setSelectedScenario(null)
          setConversation(undefined)
          setActiveProfile(selectedScenarioProfile)
          setActiveScenario(scenario)
        }}
        profile={selectedScenarioProfile}
        roles={roles}
      />
      {freeConversationOpen && (
        <FreeConversationDialog
          key={`${JSON.stringify(learningSelection)}:${practiceProfile.level}`}
          initialTopic={initialTopic}
          profile={practiceProfile}
          roles={roles}
          onClose={() => setFreeConversationOpen(false)}
          onStart={({ scenario, ...outline }) => {
            feedbackController.current?.abort()
            setFeedbackLoading(false)
            setFreeConversationOpen(false)
            setConversation(outline)
            setActiveProfile(practiceProfile)
            setActiveScenario(scenario)
          }}
        />
      )}
      <SettingsDialog
        open={settingsOpen || helpOpen}
        onOpenChange={(open) => {
          if (!open) {
            setSettingsOpen(false)
            setHelpOpen(false)
          }
        }}
        health={health}
        checking={checking}
        onCheck={() => void checkHealth()}
        help={helpOpen}
        speechProvider={profile.speechProvider}
        onSpeechProviderChange={(speechProvider) => updateProfile({ ...profile, speechProvider })}
        learningSelection={learningSelection}
        onLearningSelectionChange={saveLearningSelection}
        preferredRoleId={profile.roleId}
        learningReady={learningReady && maintenanceReady}
      />
      <BackupResetDialog
        open={backupOpen}
        onOpenChange={setBackupOpen}
        ready={maintenanceReady}
        onMaintenanceStart={startMaintenance}
        onDataChanged={(data) => {
          assertLearningWriteAllowed()
          applyLearningData(data)
        }}
      />
      <FeedbackDialog
        session={reviewSession}
        saved={sessions.some((session) => session.id === reviewSession?.id)}
        scenario={
          reviewSession?.scenario ??
          scenarios.find((scenario) => scenario.id === reviewSession?.scenarioId)
        }
        loading={feedbackLoading && feedbackSessionId === reviewSession?.id}
        error={feedbackSessionId === reviewSession?.id ? feedbackError : null}
        onClose={() => setReviewSession(null)}
        onRetry={() => {
          if (reviewSession) void generateFeedback(reviewSession)
        }}
      />
    </div>
  )
}
