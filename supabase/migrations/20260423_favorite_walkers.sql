CREATE TABLE IF NOT EXISTS public.favorite_walkers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  walker_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, walker_id)
);

CREATE INDEX IF NOT EXISTS idx_favorite_walkers_client_id
  ON public.favorite_walkers(client_id);

CREATE INDEX IF NOT EXISTS idx_favorite_walkers_walker_id
  ON public.favorite_walkers(walker_id);

ALTER TABLE public.favorite_walkers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "favorite_walkers_select_own" ON public.favorite_walkers;
CREATE POLICY "favorite_walkers_select_own"
  ON public.favorite_walkers
  FOR SELECT
  USING (client_id = auth.uid());

DROP POLICY IF EXISTS "favorite_walkers_insert_own" ON public.favorite_walkers;
CREATE POLICY "favorite_walkers_insert_own"
  ON public.favorite_walkers
  FOR INSERT
  WITH CHECK (client_id = auth.uid());

DROP POLICY IF EXISTS "favorite_walkers_delete_own" ON public.favorite_walkers;
CREATE POLICY "favorite_walkers_delete_own"
  ON public.favorite_walkers
  FOR DELETE
  USING (client_id = auth.uid());

GRANT SELECT, INSERT, DELETE ON public.favorite_walkers TO authenticated;
