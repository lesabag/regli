import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

export type RankedCandidate = {
  walkerId: string
  score: number
  meta?: Record<string, unknown>
}

export function jsonResponse(status: number, body: Record<string, unknown>, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(extraHeaders ?? {}),
    },
  })
}

export function getEnv(name: string): string {
  const value = Deno.env.get(name)
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`)
  }
  return value
}

export function createAdminClient(): SupabaseClient {
  const supabaseUrl = getEnv('SUPABASE_URL')
  const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY')

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

export function normalizeTimeoutSeconds(value: unknown, fallback = 20): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : fallback

  if (!Number.isFinite(parsed)) return fallback
  return Math.max(3, Math.min(60, Math.floor(parsed)))
}

export function sanitizeCandidates(input: unknown): RankedCandidate[] {
  if (!Array.isArray(input)) return []

  const cleaned = input
    .map((item) => {
      if (!item || typeof item !== 'object') return null

      const row = item as Record<string, unknown>
      const walkerId = String(row.walkerId ?? '').trim()
      const rawScore = row.score
      const score =
        typeof rawScore === 'number'
          ? rawScore
          : typeof rawScore === 'string'
            ? Number(rawScore)
            : NaN

      const meta =
        row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)
          ? (row.meta as Record<string, unknown>)
          : {}

      if (!walkerId || !Number.isFinite(score)) return null

      return {
        walkerId,
        score,
        meta,
      } satisfies RankedCandidate
    })
    .filter((item): item is RankedCandidate => item !== null)

  const deduped = new Map<string, RankedCandidate>()
  for (const candidate of cleaned) {
    if (!deduped.has(candidate.walkerId)) {
      deduped.set(candidate.walkerId, candidate)
    }
  }

  return [...deduped.values()].sort((a, b) => b.score - a.score)
}

export async function requireAuthUser(req: Request): Promise<{ userId: string | null }> {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { userId: null }
  }

  const token = authHeader.slice('Bearer '.length).trim()
  if (!token) {
    return { userId: null }
  }

  const supabaseUrl = getEnv('SUPABASE_URL')
  const anonKey = getEnv('SUPABASE_ANON_KEY')

  const userClient = createClient(supabaseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  })

  const { data, error } = await userClient.auth.getUser()
  if (error || !data.user) {
    return { userId: null }
  }

  return { userId: data.user.id }
}
