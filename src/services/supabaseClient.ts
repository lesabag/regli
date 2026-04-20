import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY environment variables')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})

/**
 * Invoke a Supabase Edge Function using raw fetch.
 *
 * Why: `supabase.functions` is a getter that creates a NEW FunctionsClient
 * on every access, so `setAuth()` is lost immediately. And when explicit
 * Authorization headers are passed to `invoke()`, the internal `fetchWithAuth`
 * wrapper skips its own token injection. This raw approach matches how
 * PostgREST calls work and guarantees the correct token reaches the gateway.
 */
export async function invokeEdgeFunction<T = unknown>(
  functionName: string,
  options?: { body?: unknown; timeoutMs?: number }
): Promise<{ data: T | null; error: string | null }> {
  const { data: { session } } = await supabase.auth.getSession()

  if (!session?.access_token) {
    console.warn(`[invokeEdgeFunction] ${functionName}: no session`)
    return { data: null, error: 'NO_SESSION' }
  }

  const url = `${supabaseUrl}/functions/v1/${functionName}`
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), options?.timeoutMs ?? 30_000)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${session.access_token}`,
      },
      body: options?.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    })
  } catch (error) {
    const aborted =
      error instanceof DOMException
        ? error.name === 'AbortError'
        : error instanceof Error && error.name === 'AbortError'

    if (aborted) {
      console.error(`[invokeEdgeFunction] ${functionName} timed out`)
      return { data: null, error: 'Request timed out. Please try again.' }
    }

    const message = error instanceof Error ? error.message : 'Network request failed'
    console.error(`[invokeEdgeFunction] ${functionName} network error:`, message)
    return { data: null, error: message }
  } finally {
    window.clearTimeout(timeout)
  }

  let body: T | null = null
  try {
    body = await res.json()
  } catch {
    // non-JSON response
  }

  if (!res.ok) {
    // Extract error message — handle both our format ({ error }) and gateway format ({ message })
    let errMsg: string | null = null
    if (body && typeof body === 'object') {
      const obj = body as Record<string, unknown>
      if (typeof obj.error === 'string') errMsg = obj.error
      else if (typeof obj.message === 'string') errMsg = obj.message
      // Include details if present
      if (typeof obj.details === 'string' && obj.details) {
        errMsg = errMsg ? `${errMsg}: ${obj.details}` : obj.details
      }
    }
    errMsg = errMsg ?? `Edge function returned ${res.status}`
    console.error(`[invokeEdgeFunction] ${functionName} failed (${res.status}):`, errMsg)
    return { data: null, error: errMsg }
  }

  return { data: body, error: null }
}
