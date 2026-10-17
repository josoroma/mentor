'use client'

import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Check, ShieldCheck } from 'lucide-react'
import { ProfileSchema } from '@/app/_schema'
import type { Profile, Role } from '@/app/_types'
import { Modal } from '@/app/_components/ui/modal'
import { Button } from '@/app/_components/ui/button'
import { applyProfileLearningSelection, getProfileLearningSelection } from '@/lib/learning/paths'

export const ProfileDialog = ({
  open,
  onOpenChange,
  profile,
  roles,
  onSave,
  supabaseConfigured,
  supabaseLocal = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  profile: Profile
  roles: Role[]
  onSave: (profile: Profile) => Promise<void>
  supabaseConfigured: boolean
  supabaseLocal?: boolean
}) => {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Profile>({ resolver: zodResolver(ProfileSchema), defaultValues: profile })
  useEffect(() => {
    if (open) reset(profile)
  }, [open, profile, reset])
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Make mentor yours"
      description="A little context helps your coach meet you where you are."
    >
      <form
        className="profile-form"
        onSubmit={handleSubmit(async (values) => {
          try {
            const focus = getProfileLearningSelection(profile)
            await onSave(
              applyProfileLearningSelection(
                { ...values, speechProvider: profile.speechProvider },
                focus.path === 'professional'
                  ? { path: 'professional', roleId: values.roleId }
                  : focus,
              ),
            )
            onOpenChange(false)
          } catch {
            /* Parent displays the persistence error. */
          }
        })}
      >
        <label>
          Your name
          <input
            {...register('name')}
            placeholder="What should we call you?"
            autoComplete="given-name"
          />
          {errors.name && <span className="field-error">{errors.name.message}</span>}
        </label>
        <label>
          Your role
          <select {...register('roleId')}>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </label>
        <div className="form-row">
          <label>
            English level
            <select {...register('level')}>
              <option value="A2">A2 · Elementary</option>
              <option value="B1">B1 · Intermediate</option>
              <option value="B2">B2 · Upper intermediate</option>
              <option value="C1">C1 · Advanced</option>
              <option value="C2">C2 · Proficient</option>
            </select>
          </label>
          <label>
            Daily practice goal
            <select {...register('dailyGoalMinutes', { valueAsNumber: true })}>
              <option value={5}>5 minutes</option>
              <option value={10}>10 minutes</option>
              <option value={15}>15 minutes</option>
              <option value={20}>20 minutes</option>
              <option value={30}>30 minutes</option>
            </select>
          </label>
        </div>
        <label className="checkbox-row">
          <input type="checkbox" {...register('localOnly')} />
          <span>
            Keep my learning data on this device
            <small>
              {supabaseLocal
                ? 'Your local Supabase database saves both transcripts automatically. They stay on this machine.'
                : supabaseConfigured
                  ? 'Uncheck to sync your profile and transcripts with hosted Supabase.'
                  : 'Your transcripts save automatically to this browser’s on-device database.'}
            </small>
          </span>
          <ShieldCheck size={19} />
        </label>
        <p className="form-note">
          Your level shapes the vocabulary, pace, and follow-up questions. You can change it
          anytime.
        </p>
        <Button type="submit" disabled={isSubmitting}>
          <Check size={16} />
          {isSubmitting ? 'Saving…' : 'Save learning profile'}
        </Button>
      </form>
    </Modal>
  )
}
