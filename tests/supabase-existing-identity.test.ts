import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getExistingAuthenticatedClient } from '@/lib/supabase/client'

const mocks = vi.hoisted(() => ({
  configured: vi.fn(() => true),
  getSession: vi.fn(),
  signInAnonymously: vi.fn(),
}))

vi.mock('@/lib/supabase/config', () => ({
  isSupabaseConfigured: mocks.configured,
  isLocalSupabaseConfigured: () => true,
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getSession: mocks.getSession, signInAnonymously: mocks.signInAnonymously },
  }),
}))

describe('read-only existing sync identity lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.configured.mockReturnValue(true)
  })

  it('does not create an anonymous account when no identity exists', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null })
    expect(await getExistingAuthenticatedClient()).toBeNull()
    expect(mocks.signInAnonymously).not.toHaveBeenCalled()
  })

  it('returns the current identity without changing authentication', async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { user: { id: 'existing-learner' } } },
      error: null,
    })
    expect(await getExistingAuthenticatedClient()).toMatchObject({ userId: 'existing-learner' })
    expect(mocks.signInAnonymously).not.toHaveBeenCalled()
  })

  it('reports identity lookup errors instead of silently omitting database records', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: { message: 'Expired' } })
    await expect(getExistingAuthenticatedClient()).rejects.toThrow('Expired')
    expect(mocks.signInAnonymously).not.toHaveBeenCalled()
  })

  it('does not contact an unconfigured database', async () => {
    mocks.configured.mockReturnValue(false)
    expect(await getExistingAuthenticatedClient()).toBeNull()
    expect(mocks.getSession).not.toHaveBeenCalled()
  })
})
