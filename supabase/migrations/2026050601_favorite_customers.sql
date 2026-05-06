CREATE TABLE IF NOT EXISTS public.favorite_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  walker_id uuid NOT NULL,
  client_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (walker_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_favorite_customers_walker_id
  ON public.favorite_customers(walker_id);

CREATE INDEX IF NOT EXISTS idx_favorite_customers_client_id
  ON public.favorite_customers(client_id);

ALTER TABLE public.favorite_customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "favorite_customers_select_own" ON public.favorite_customers;
CREATE POLICY "favorite_customers_select_own"
  ON public.favorite_customers
  FOR SELECT
  TO authenticated
  USING (walker_id = auth.uid());

DROP POLICY IF EXISTS "favorite_customers_insert_own" ON public.favorite_customers;
CREATE POLICY "favorite_customers_insert_own"
  ON public.favorite_customers
  FOR INSERT
  TO authenticated
  WITH CHECK (walker_id = auth.uid());

DROP POLICY IF EXISTS "favorite_customers_delete_own" ON public.favorite_customers;
CREATE POLICY "favorite_customers_delete_own"
  ON public.favorite_customers
  FOR DELETE
  TO authenticated
  USING (walker_id = auth.uid());

GRANT SELECT, INSERT, DELETE ON public.favorite_customers TO authenticated;
