-- ============================================================
-- Security Hardening v2
-- Fixes: admin self-assignment, walker update WITH CHECK,
--        profile role escalation.
-- ============================================================

-- ─── 1. Profiles: Block admin role on INSERT and UPDATE ──────
-- Only service_role (edge functions, triggers) can set role='admin'.
-- Regular authenticated users can only be 'client' or 'walker'.

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;

CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND role IN ('client', 'walker')
  );

-- Block admin on INSERT (signup creates profiles via client-side upsert)
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT
  WITH CHECK (
    id = auth.uid()
    AND role IN ('client', 'walker')
  );

GRANT INSERT ON public.profiles TO authenticated;


-- ─── 2. walk_requests: Add WITH CHECK to walker update policy ─
-- Ensures walkers can only set walker_id to themselves (accepting)
-- and cannot reassign jobs to other users.

DROP POLICY IF EXISTS "wr_walker_update" ON public.walk_requests;

CREATE POLICY "wr_walker_update" ON public.walk_requests
  FOR UPDATE
  USING (
    walker_id = auth.uid()
    OR (status = 'open' AND payment_status IN ('authorized', 'paid'))
  )
  WITH CHECK (
    walker_id = auth.uid()
  );
