export type {
  ConversationOutline,
  Feedback,
  FeedbackMetric,
  Profile,
  ProficiencyLevel,
  Role,
  Scenario,
  SessionRecord,
  TranscriptMessage,
  TranscriptImprovement,
} from '@/app/_schema'

export type SessionState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'paused' | 'complete'
export type ActiveTab = 'practice' | 'progress' | 'history' | 'settings'
export type SyncStatus = 'local' | 'synced' | 'error'
