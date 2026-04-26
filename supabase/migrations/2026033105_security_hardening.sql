-- ============================================================
-- Security Hardening Migration
-- Enables RLS on unprotected tables, tightens grants,
-- fixes overly permissive policies.
-- ============================================================

-- ─── 1. walk_requests: Enable RLS + add policies ───────────
-- CRITICAL: This table had NO RLS. Any user could read/write all rows.

ALTER TABLE public.walk_requests ENABLE ROW LEVEL SECURITY;

-- Force RLS even for table owner (prevents accidental bypass)
ALTER TABLE public.walk_requests FORCE ROW LEVEL SECURITY;

-- Client can read own jobs
DROP POLICY IF EXISTS "wr_client_select" ON public.walk_requests;
CREATE POLICY "wr_client_select" ON public.walk_requests
  FOR SELECT USING (client_id = auth.uid());

-- Walker can read: own assigned jobs, jobs targeted at them, open+paid jobs
DROP POLICY IF EXISTS "wr_walker_select" ON public.walk_requests;
CREATE POLICY "wr_walker_select" ON public.walk_requests
  FOR SELECT USING (
    walker_id = auth.uid()
    OR selected_walker_id = auth.uid()
    OR (status = 'open' AND payment_status IN ('authorized', 'paid'))
  );

-- Admin can read all
DROP POLICY IF EXISTS "wr_admin_select" ON public.walk_requests;
CREATE POLICY "wr_admin_select" ON public.walk_requests
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Client can update own jobs (payment authorization)
DROP POLICY IF EXISTS "wr_client_update" ON public.walk_requests;
CREATE POLICY "wr_client_update" ON public.walk_requests
  FOR UPDATE
  USING (client_id = auth.uid())
  WITH CHECK (client_id = auth.uid());

-- Walker can update own assigned jobs (location, release)
-- or accept open jobs (walker_id is still NULL at accept-time)
DROP POLICY IF EXISTS "wr_walker_update" ON public.walk_requests;
CREATE POLICY "wr_walker_update" ON public.walk_requests
  FOR UPDATE
  USING (
    walker_id = auth.uid()
    OR (status = 'open' AND payment_status IN ('authorized', 'paid'))
  );

-- Admin can do everything on walk_requests
DROP POLICY IF EXISTS "wr_admin_all" ON public.walk_requests;
CREATE POLICY "wr_admin_all" ON public.walk_requests
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Explicit grants (no INSERT for client — edge functions use service_role)
GRANT SELECT, UPDATE ON public.walk_requests TO authenticated;


-- ─── 2. profiles: Enable RLS + add policies ────────────────
-- CRITICAL: This table had NO RLS. Any user could read/write any profile.

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;

-- Authenticated users can read all profiles (needed for walker list, names)
DROP POLICY IF EXISTS "profiles_select_authenticated" ON public.profiles;
CREATE POLICY "profiles_select_authenticated" ON public.profiles
  FOR SELECT USING (auth.role() = 'authenticated');

-- Users can update their own profile only
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- Admin can do everything on profiles
DROP POLICY IF EXISTS "profiles_admin_all" ON public.profiles;
CREATE POLICY "profiles_admin_all" ON public.profiles
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

GRANT SELECT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT ON public.profiles TO anon;


-- ─── 3. Revoke excessive anon grants ────────────────────────
-- The fix_notifications migration granted INSERT/UPDATE to anon.
-- anon should never write to notifications.
REVOKE INSERT, UPDATE ON public.notifications FROM anon;

-- anon should not insert ratings
REVOKE INSERT ON public.ratings FROM anon;

-- anon should not read payout requests
REVOKE SELECT ON public.payout_requests FROM anon;


-- ─── 4. walker_wallets + wallet_transactions: Add missing GRANTs
-- These tables have RLS but no explicit GRANT for authenticated role.
GRANT SELECT ON public.walker_wallets TO authenticated;
GRANT SELECT ON public.wallet_transactions TO authenticated;


-- ─── 5. Tighten notifications INSERT policy ─────────────────
-- Current policy: any authenticated user can insert for any user_id.
-- This allows notification spam/impersonation.
-- Fix: require that the inserting user is either:
--   (a) the target user (self-notification), or
--   (b) a participant in the related job
-- NOTE: We drop the old permissive policy and replace it.

DROP POLICY IF EXISTS "Authenticated users can insert notifications" ON public.notifications;

CREATE POLICY "Authenticated users can insert notifications"
  ON public.notifications FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated'
    AND (
      -- Self-notification
      user_id = auth.uid()
      -- Or sender is a participant in the related job
      OR EXISTS (
        SELECT 1 FROM public.walk_requests wr
        WHERE wr.id = related_job_id
          AND (wr.client_id = auth.uid() OR wr.walker_id = auth.uid())
      )
      -- Or sender is admin
      OR EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid() AND role = 'admin'
      )
    )
  );


-- ─── 6. Ratings: Tighten INSERT policy ──────────────────────
-- Current: from_user_id = auth.uid() (good)
-- Add: must be a participant in the job (prevent rating random users)

DROP POLICY IF EXISTS "ratings_insert" ON public.ratings;

CREATE POLICY "ratings_insert" ON public.ratings
  FOR INSERT WITH CHECK (
    from_user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.walk_requests wr
      WHERE wr.id = job_id
        AND wr.status = 'completed'
        AND (wr.client_id = auth.uid() OR wr.walker_id = auth.uid())
    )
  );


-- ─── 7. Payout requests: Ensure walker_id matches on INSERT ─
-- Extra safety: verify the inserting user is actually a walker
DROP POLICY IF EXISTS "payout_requests_walker_insert" ON public.payout_requests;

CREATE POLICY "payout_requests_walker_insert" ON public.payout_requests
  FOR INSERT WITH CHECK (
    walker_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'walker'
    )
  );
