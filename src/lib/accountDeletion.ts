import { invokeEdgeFunction } from '../services/supabaseClient'

export async function requestAccountDeletion(): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await invokeEdgeFunction<{ success?: boolean }>('delete-account', {
    timeoutMs: 30_000,
  })

  if (error) {
    return {
      ok: false,
      error: 'We could not delete your account right now. Please try again.',
    }
  }

  if (!data?.success) {
    return {
      ok: false,
      error: 'We could not delete your account right now. Please try again.',
    }
  }

  return { ok: true }
}
