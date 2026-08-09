/**
 * Run a side-effect so that it can never reject.
 *
 * Used for background provider-onboarding triggers (e.g. PayMe seller creation)
 * that must NOT be able to fail the surrounding flow: provider registration must
 * remain successful even if the side-effect throws. Kept dependency-free so it is
 * cheap to unit-test in isolation.
 */
export async function runNonBlocking(
  fn: () => Promise<unknown>,
): Promise<{ ok: boolean }> {
  try {
    await fn()
    return { ok: true }
  } catch {
    return { ok: false }
  }
}
