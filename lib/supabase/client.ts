'use client'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { isSupabaseConfigured } from '@/lib/supabase/config'

let browserClient: SupabaseClient | null = null
let pendingIdentity: Promise<{ client: SupabaseClient; userId: string }> | null = null

export { isSupabaseConfigured, isLocalSupabaseConfigured } from '@/lib/supabase/config'

export const getSupabaseClient = (): SupabaseClient | null => {
  if (!isSupabaseConfigured()) return null
  if (!browserClient) {
    browserClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
        global: {
          fetch: (input, init) =>
            fetch(input, {
              ...init,
              signal: init?.signal
                ? AbortSignal.any([init.signal, AbortSignal.timeout(12_000)])
                : AbortSignal.timeout(12_000),
            }),
        },
      },
    )
  }
  return browserClient
}

// Calling this is an explicit sync action. Merely opening mentor never creates a remote account.
const resolveAuthenticatedClient = async (): Promise<{
  client: SupabaseClient
  userId: string
}> => {
  const client = getSupabaseClient()
  if (!client)
    throw new Error('Supabase is not configured. Your learning data is still saved on this device.')
  const { data: sessionData, error: sessionError } = await client.auth.getSession()
  if (sessionError) throw new Error(`Could not read your sync session: ${sessionError.message}`)
  if (sessionData.session) return { client, userId: sessionData.session.user.id }

  const { data, error } = await client.auth.signInAnonymously()
  if (error || !data.user)
    throw new Error(
      `Could not enable sync. Enable anonymous sign-in in Supabase. ${error?.message ?? ''}`.trim(),
    )
  return { client, userId: data.user.id }
}

export const getAuthenticatedClient = (): Promise<{ client: SupabaseClient; userId: string }> => {
  // Concurrent profile/session requests must share one anonymous identity.
  pendingIdentity ??= resolveAuthenticatedClient().finally(() => {
    pendingIdentity = null
  })
  return pendingIdentity
}

export const getExistingAuthenticatedClient = async (): Promise<{
  client: SupabaseClient
  userId: string
} | null> => {
  const client = getSupabaseClient()
  if (!client) return null
  const { data, error } = await client.auth.getSession()
  if (error) throw new Error(`Could not read your sync session: ${error.message}`)
  return data.session ? { client, userId: data.session.user.id } : null
}
