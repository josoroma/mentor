export const isSupabaseConfigured = (): boolean =>
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)

export const isLocalSupabaseConfigured = (): boolean => {
  if (!isSupabaseConfigured()) return false
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    )
  } catch {
    return false
  }
}
