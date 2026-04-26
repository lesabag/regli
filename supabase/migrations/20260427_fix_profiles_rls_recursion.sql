CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon;

DROP POLICY IF EXISTS "Admins can update all walk requests" ON public.walk_requests;
CREATE POLICY "Admins can update all walk requests"
ON public.walk_requests
FOR UPDATE
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "wallet_select_admin" ON public.walker_wallets;
CREATE POLICY wallet_select_admin
ON public.walker_wallets
FOR SELECT
TO authenticated
USING (public.is_admin());

DROP POLICY IF EXISTS "wallet_tx_select_admin" ON public.wallet_transactions;
CREATE POLICY wallet_tx_select_admin
ON public.wallet_transactions
FOR SELECT
TO authenticated
USING (public.is_admin());

DROP POLICY IF EXISTS "ba_admin_read" ON public.walker_balance_adjustments;
CREATE POLICY "ba_admin_read"
ON public.walker_balance_adjustments
FOR SELECT
TO authenticated
USING (public.is_admin());
