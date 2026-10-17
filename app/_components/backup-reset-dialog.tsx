'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { format } from 'date-fns'
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  FileJson,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Button } from '@/app/_components/ui/button'
import { Modal } from '@/app/_components/ui/modal'
import {
  createLearningBackup,
  MAX_LEARNING_BACKUP_BYTES,
  parseLearningBackup,
  resetLearningData,
  restoreLearningBackup,
  type LearningBackup,
} from '@/lib/learning/backup'
import type { LearningData } from '@/lib/learning/storage'
import { getStorageMode, syncLearningData } from '@/lib/learning/persistence'
import { isLocalSupabaseConfigured, isSupabaseConfigured } from '@/lib/supabase/client'
import styles from '@/app/_components/backup-reset-dialog.module.css'

const ResetConfirmationSchema = z.object({
  confirmation: z.literal('RESET', { error: 'Type RESET exactly to confirm.' }),
  acknowledged: z.literal(true, { error: 'Confirm that you have a backup or do not need one.' }),
})

type ResetConfirmation = z.infer<typeof ResetConfirmationSchema>
type Section = 'backup' | 'restore' | 'reset'
type Operation = 'loading' | 'exporting' | 'reading' | 'restoring' | 'resetting' | 'syncing'

const sections = [
  { id: 'backup', label: 'Back up', icon: ArrowDownToLine },
  { id: 'restore', label: 'Restore', icon: ArrowUpFromLine },
  { id: 'reset', label: 'Reset', icon: RotateCcw },
] as const

const describeError = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback

const countData = (data: LearningData) => ({
  sessions: data.sessions.length,
  turns: data.sessions.reduce(
    (count, session) => count + session.messages.length + (session.pendingTranscript ? 1 : 0),
    0,
  ),
  improvements: data.sessions.reduce(
    (count, session) => count + (session.improvements?.length ?? 0),
    0,
  ),
  plans: data.sessions.filter((session) => session.conversation).length,
  bookmarks: (data.bookmarks ?? []).filter((bookmark) => bookmark.saved).length,
  explorations: data.explore?.sessions.length ?? 0,
  artifacts: data.explore?.artifacts.length ?? 0,
  revisions: data.explore?.revisions.length ?? 0,
})

export const BackupResetDialog = ({
  open,
  onOpenChange,
  ready,
  onMaintenanceStart,
  onDataChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  ready: boolean
  onMaintenanceStart: () => void
  onDataChanged: (data: LearningData) => void
}) => {
  const identifier = useId()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const snapshotVersion = useRef(0)
  const operationRef = useRef<Operation | null>(null)
  const [section, setSection] = useState<Section>('backup')
  const [snapshot, setSnapshot] = useState<LearningBackup | null>(null)
  const [selectedBackup, setSelectedBackup] = useState<LearningBackup | null>(null)
  const [selectedFileName, setSelectedFileName] = useState('')
  const [operation, setOperation] = useState<Operation | null>(null)
  const [error, setError] = useState('')
  const [snapshotError, setSnapshotError] = useState('')
  const [notice, setNotice] = useState('')
  const [needsSyncRetry, setNeedsSyncRetry] = useState(false)
  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<ResetConfirmation>({
    resolver: zodResolver(ResetConfirmationSchema),
    mode: 'onChange',
  })

  const busy = operation !== null
  const counts = snapshot ? countData(snapshot.data) : null
  const importedCounts = selectedBackup ? countData(selectedBackup.data) : null
  const willSync = getStorageMode() === 'supabase'
  const syncLocation = isLocalSupabaseConfigured() ? 'local Supabase' : 'your Supabase account'
  const confirmation = watch('confirmation')
  const acknowledged = watch('acknowledged')

  const startOperation = (next: Operation): boolean => {
    if (operationRef.current) return false
    operationRef.current = next
    setOperation(next)
    setError('')
    setNotice('')
    return true
  }

  const finishOperation = () => {
    operationRef.current = null
    setOperation(null)
  }

  useEffect(() => {
    if (!open || !ready) return
    const version = ++snapshotVersion.current
    setSection('backup')
    setSnapshot(null)
    setSelectedBackup(null)
    setSelectedFileName('')
    setError('')
    setSnapshotError('')
    setNotice('')
    setNeedsSyncRetry(false)
    reset()
    operationRef.current = 'loading'
    setOperation('loading')
    void createLearningBackup()
      .then((backup) => {
        if (snapshotVersion.current === version) setSnapshot(backup)
      })
      .catch((cause: unknown) => {
        if (snapshotVersion.current === version)
          setSnapshotError(
            describeError(cause, 'Your learning data could not be read. Please try again.'),
          )
      })
      .finally(() => {
        if (snapshotVersion.current === version) {
          operationRef.current = null
          setOperation(null)
        }
      })
    return () => {
      snapshotVersion.current += 1
    }
  }, [open, ready, reset])

  const exportBackup = async () => {
    if (!ready || !startOperation('exporting')) return
    try {
      const backup = await createLearningBackup()
      setSnapshot(backup)
      setSnapshotError('')
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `mentor-backup-${backup.exportedAt.replaceAll(':', '-')}.json`
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
      setNotice('Backup download started. Check your Downloads folder before resetting your data.')
    } catch (cause) {
      setError(
        describeError(cause, 'The backup could not be created. Your learning data is unchanged.'),
      )
    } finally {
      finishOperation()
    }
  }

  const readBackupFile = async (file: File | undefined) => {
    if (!file || !startOperation('reading')) return
    setSelectedBackup(null)
    setSelectedFileName('')
    try {
      if (file.size > MAX_LEARNING_BACKUP_BYTES)
        throw new Error('This file is too large. Choose a mentor JSON backup smaller than 25 MB.')
      const content = await file.text()
      let backup: LearningBackup
      try {
        backup = parseLearningBackup(content)
      } catch {
        throw new Error(
          'This is not a valid mentor backup. Your existing learning data has not changed.',
        )
      }
      setSelectedBackup(backup)
      setSelectedFileName(file.name)
    } catch (cause) {
      setError(describeError(cause, 'The backup file could not be read. Try selecting it again.'))
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
      finishOperation()
    }
  }

  const restoreBackup = async () => {
    if (!ready || !selectedBackup || !startOperation('restoring')) return
    try {
      onMaintenanceStart()
      const result = await restoreLearningBackup(selectedBackup)
      onDataChanged(result.data)
      setSnapshot({ ...selectedBackup, data: result.data, exportedAt: new Date().toISOString() })
      setSnapshotError('')
      setNeedsSyncRetry(result.syncStatus === 'error')
      if (result.syncStatus === 'error') {
        setNotice('Your backup was restored in this browser. Your local data is safe.')
        setError(
          result.error ?? 'Supabase sync did not finish. Retry when the database is available.',
        )
      } else {
        setNotice(
          result.syncStatus === 'synced'
            ? 'Backup restored in this browser and synced to Supabase.'
            : 'Backup restored in this browser. Your current privacy preference is unchanged.',
        )
      }
      setSelectedBackup(null)
      setSelectedFileName('')
      reset()
    } catch (cause) {
      setError(describeError(cause, 'The backup could not be restored. Please try again.'))
    } finally {
      finishOperation()
    }
  }

  const retryDatabaseSync = async () => {
    if (!ready || !needsSyncRetry || !startOperation('syncing')) return
    try {
      if (getStorageMode() !== 'supabase') {
        setNeedsSyncRetry(false)
        setNotice(
          'Your restored data stays in this browser. Database sync is off in your current privacy settings.',
        )
        return
      }
      onMaintenanceStart()
      const result = await syncLearningData()
      onDataChanged(result.data)
      setSnapshot((current) =>
        current
          ? {
              ...current,
              data: {
                ...result.data,
                ...(current.data.explore ? { explore: current.data.explore } : {}),
              },
              exportedAt: new Date().toISOString(),
            }
          : null,
      )
      setNeedsSyncRetry(result.syncStatus === 'error')
      if (result.syncStatus === 'error') {
        setNotice('Your restored data is still saved in this browser.')
        setError(
          result.error ?? 'Database sync did not finish. Please try again when it reconnects.',
        )
      } else {
        setNotice(
          result.syncStatus === 'synced'
            ? 'Your restored data is now synced to Supabase.'
            : 'Your restored data stays in this browser. Your current privacy preference is unchanged.',
        )
      }
    } catch (cause) {
      setError(
        describeError(
          cause,
          'Database sync could not finish. Your restored data is still saved in this browser.',
        ),
      )
    } finally {
      finishOperation()
    }
  }

  const resetData = handleSubmit(async () => {
    if (!ready || !snapshot || !startOperation('resetting')) return
    try {
      onMaintenanceStart()
      const data = await resetLearningData()
      onDataChanged(data)
      setSnapshot({ ...snapshot, data, exportedAt: new Date().toISOString() })
      setSnapshotError('')
      setNeedsSyncRetry(false)
      reset()
      setNotice(
        willSync
          ? `Your learning data was reset in this browser and ${syncLocation}. A fresh profile is ready.`
          : 'Your learning data was reset in this browser. A fresh profile is ready.',
      )
    } catch (cause) {
      setError(describeError(cause, 'The reset could not be completed. Please try again.'))
    } finally {
      finishOperation()
    }
  })

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!operationRef.current) onOpenChange(next)
      }}
      title="Backup & reset"
      description="Keep a copy of your progress, bring it back, or make a fresh start."
      className={`${styles.modal} ${busy ? styles.busy : ''}`}
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        const trigger = document.getElementById('backup-reset-trigger')
        const bounds = trigger?.getBoundingClientRect()
        if (trigger && bounds && bounds.left >= 0 && bounds.right <= window.innerWidth)
          trigger.focus()
        else document.querySelector<HTMLButtonElement>('.mobile-menu')?.focus()
      }}
    >
      <div className={styles.body} aria-busy={busy}>
        <div className={styles.summary} aria-label="Current learning data">
          <div>
            <strong>{counts?.sessions ?? '—'}</strong>
            <span>Sessions</span>
          </div>
          <div>
            <strong>{counts?.turns ?? '—'}</strong>
            <span>Transcript turns</span>
          </div>
          <div>
            <strong>{counts?.improvements ?? '—'}</strong>
            <span>Improved responses</span>
          </div>
        </div>

        {counts && counts.explorations > 0 && (
          <p className={styles.note}>
            {counts.explorations} explorations · {counts.artifacts} artifacts · {counts.revisions}{' '}
            artifact revisions
          </p>
        )}
        <div className={styles.tabs} role="tablist" aria-label="Manage learning data">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              role="tab"
              id={`${identifier}-${id}-tab`}
              aria-selected={section === id}
              aria-controls={`${identifier}-${id}-panel`}
              disabled={busy}
              tabIndex={section === id ? 0 : -1}
              onClick={() => {
                setSection(id)
                setError('')
                setNotice('')
              }}
              onKeyDown={(event) => {
                const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
                if (!offset) return
                event.preventDefault()
                const nextIndex =
                  (sections.findIndex((item) => item.id === id) + offset + sections.length) %
                  sections.length
                const next = sections[nextIndex].id
                setSection(next)
                document.getElementById(`${identifier}-${next}-tab`)?.focus()
              }}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>

        {(!ready || operation === 'loading') && (
          <p className={styles.loading} role="status">
            <LoaderCircle size={16} className="spin" />
            Reading your saved learning data…
          </p>
        )}

        <section
          className={styles.panel}
          role="tabpanel"
          id={`${identifier}-${section}-panel`}
          aria-labelledby={`${identifier}-${section}-tab`}
          tabIndex={0}
        >
          {section === 'backup' && (
            <>
              <div className={styles.panelHeading}>
                <span className={styles.icon}>
                  <FileJson size={23} />
                </span>
                <div>
                  <h3>Your progress, in one file</h3>
                  <p>Download a portable JSON backup that you can restore in mentor.</p>
                </div>
              </div>
              <ul className={styles.includes}>
                <li>
                  <Check size={14} /> Learning profile and preferences
                </li>
                <li>
                  <Check size={14} /> Original and improved transcripts
                </li>
                <li>
                  <Check size={14} /> Session history, feedback, and progress
                </li>
                <li>
                  <Check size={14} /> Saved conversation plans, bookmarked scenarios, and settings
                </li>
                <li>
                  <Check size={14} /> Explorations, prompts, interactive artifacts, revisions, and
                  learning state
                </li>
              </ul>
              <Button
                onClick={() => void exportBackup()}
                disabled={busy || !ready}
                className={styles.primaryAction}
              >
                {operation === 'exporting' ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <ArrowDownToLine size={16} />
                )}
                {operation === 'exporting' ? 'Preparing your backup…' : 'Download backup'}
              </Button>
              <p className={styles.note}>
                Contains your conversation text. Audio recordings and sign-in credentials are not
                included.
              </p>
            </>
          )}

          {section === 'restore' && (
            <>
              <div className={styles.panelHeading}>
                <span className={styles.icon}>
                  <ArrowUpFromLine size={23} />
                </span>
                <div>
                  <h3>Pick up where you left off</h3>
                  <p>Choose a mentor backup. You can review it before restoring.</p>
                </div>
              </div>
              <input
                ref={fileInputRef}
                className={styles.fileInput}
                type="file"
                accept=".json,application/json"
                aria-label="Choose a mentor backup file"
                disabled={busy || !ready}
                onChange={(event) => void readBackupFile(event.currentTarget.files?.[0])}
              />
              <Button
                variant="secondary"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy || !ready}
              >
                {operation === 'reading' ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <FileJson size={16} />
                )}
                {selectedBackup ? 'Choose a different file' : 'Choose backup file'}
              </Button>
              <p className={styles.note}>Mentor JSON backup · Up to 25 MB</p>
              {selectedBackup && importedCounts && (
                <div className={styles.preview}>
                  <span className={styles.validFile}>
                    <Check size={14} /> Valid mentor backup
                  </span>
                  <strong>{selectedFileName}</strong>
                  <p>
                    Created {format(new Date(selectedBackup.exportedAt), 'MMM d, yyyy · h:mm a')}
                  </p>
                  <dl>
                    <div>
                      <dt>Learning profile</dt>
                      <dd>
                        {selectedBackup.data.profile.name || 'Unnamed learner'} ·{' '}
                        {selectedBackup.data.profile.level}
                      </dd>
                    </div>
                    <div>
                      <dt>Sessions</dt>
                      <dd>{importedCounts.sessions}</dd>
                    </div>
                    <div>
                      <dt>Saved scenarios</dt>
                      <dd>{importedCounts.bookmarks}</dd>
                    </div>
                    <div>
                      <dt>Transcript turns</dt>
                      <dd>{importedCounts.turns}</dd>
                    </div>
                    <div>
                      <dt>Improved responses</dt>
                      <dd>{importedCounts.improvements}</dd>
                    </div>
                    <div>
                      <dt>Conversation plans</dt>
                      <dd>{importedCounts.plans}</dd>
                    </div>
                    <div>
                      <dt>Explorations / artifacts / revisions</dt>
                      <dd>
                        {importedCounts.explorations} / {importedCounts.artifacts} /{' '}
                        {importedCounts.revisions}
                      </dd>
                    </div>
                  </dl>
                </div>
              )}
              <p className={styles.explanation}>
                Restoring merges sessions with your existing history, replaces your learning
                profile, and imports scenario settings. Your current privacy preference stays the
                same.
                {willSync
                  ? ` Restored data also syncs to ${syncLocation}.`
                  : ' This restores practice data in this browser only.'}
                {Boolean(importedCounts?.explorations) &&
                  ' Explorations restore to your learning database, preserving existing history. A connected database is required.'}
              </p>
              <Button
                onClick={() => void restoreBackup()}
                disabled={!selectedBackup || busy || !ready}
                className={styles.primaryAction}
              >
                {operation === 'restoring' ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <ArrowUpFromLine size={16} />
                )}
                {operation === 'restoring' ? 'Restoring your data…' : 'Restore this backup'}
              </Button>
            </>
          )}

          {section === 'reset' && (
            <form onSubmit={resetData}>
              <div className={styles.panelHeading}>
                <span className={`${styles.icon} ${styles.dangerIcon}`}>
                  <RotateCcw size={23} />
                </span>
                <div>
                  <h3>Start fresh, intentionally</h3>
                  <p>Download a backup first if you want to keep your progress.</p>
                </div>
              </div>
              <div className={styles.resetScope}>
                <strong>This clears your learning data</strong>
                <p>
                  Your profile, session history, original and improved transcripts, feedback, saved
                  conversation plans, and personal scenario settings will be removed from this
                  browser
                  {willSync ? ` and your learner’s records in ${syncLocation}` : ''}.
                  {willSync &&
                    ' Your explorations, artifacts, and revision histories are included in the database reset.'}
                </p>
                <p>
                  Your theme, shared practice scenarios, and other learners’ data stay in place.
                  {!willSync && isSupabaseConfigured()
                    ? ' Existing Supabase copies are not changed while sync is off.'
                    : ''}
                </p>
              </div>
              <label className={styles.confirmation} htmlFor={`${identifier}-confirmation`}>
                Type <strong>RESET</strong> to confirm
              </label>
              <input
                {...register('confirmation')}
                id={`${identifier}-confirmation`}
                className={styles.textInput}
                autoComplete="off"
                spellCheck={false}
                placeholder="RESET"
                disabled={busy || !ready || !snapshot}
                aria-invalid={Boolean(errors.confirmation)}
                aria-describedby={
                  errors.confirmation ? `${identifier}-confirmation-error` : undefined
                }
              />
              {errors.confirmation && (
                <p className={styles.fieldError} id={`${identifier}-confirmation-error`}>
                  {errors.confirmation.message}
                </p>
              )}
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  {...register('acknowledged')}
                  disabled={busy || !ready || !snapshot}
                />
                <span>I saved a backup or do not need one.</span>
              </label>
              <Button
                type="submit"
                variant="destructive"
                disabled={
                  busy || !ready || !snapshot || confirmation !== 'RESET' || acknowledged !== true
                }
                className={styles.primaryAction}
              >
                {operation === 'resetting' ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <RotateCcw size={16} />
                )}
                {operation === 'resetting' ? 'Resetting learning data…' : 'Reset my learning data'}
              </Button>
            </form>
          )}
        </section>

        {notice && (
          <p className={styles.notice} role="status">
            <Check size={16} />
            <span>{notice}</span>
          </p>
        )}
        {(error || snapshotError) && (
          <p className={styles.error} role="alert">
            <AlertCircle size={16} />
            <span>{error || snapshotError}</span>
          </p>
        )}
        {section === 'restore' && needsSyncRetry && (
          <Button
            variant="secondary"
            className={styles.retrySync}
            disabled={busy || !ready}
            onClick={() => void retryDatabaseSync()}
          >
            {operation === 'syncing' ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <RotateCcw size={15} />
            )}
            {operation === 'syncing' ? 'Retrying database sync…' : 'Retry database sync'}
          </Button>
        )}
        <p className={styles.privacy}>
          <ShieldCheck size={14} /> Backups stay on your device. No model processes your backup.
        </p>
      </div>
    </Modal>
  )
}
