import { getCoachHealth, getSpeechHealth } from '@/lib/ai/local-provider'
import { isSupabaseConfigured, isLocalSupabaseConfigured } from '@/lib/supabase/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const [coach, speech] = await Promise.all([getCoachHealth(), getSpeechHealth()])
  return Response.json(
    {
      coach,
      speech,
      storage: {
        configured: isSupabaseConfigured(),
        local: isLocalSupabaseConfigured(),
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
