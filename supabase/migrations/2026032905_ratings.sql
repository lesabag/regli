-- Ratings table: one rating per user per job
CREATE TABLE IF NOT EXISTS public.ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES public.walk_requests(id) ON DELETE CASCADE,
  from_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  to_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, from_user_id)
);

CREATE INDEX IF NOT EXISTS idx_ratings_job_id ON public.ratings(job_id);
CREATE INDEX IF NOT EXISTS idx_ratings_to_user_id ON public.ratings(to_user_id);
CREATE INDEX IF NOT EXISTS idx_ratings_from_user_id ON public.ratings(from_user_id);

ALTER TABLE public.ratings ENABLE ROW LEVEL SECURITY;

-- Everyone can read ratings
DROP POLICY IF EXISTS "ratings_select" ON public.ratings;
CREATE POLICY "ratings_select" ON public.ratings
  FOR SELECT USING (true);

-- Users can insert their own ratings
DROP POLICY IF EXISTS "ratings_insert" ON public.ratings;
CREATE POLICY "ratings_insert" ON public.ratings
  FOR INSERT WITH CHECK (from_user_id = auth.uid());

-- Grant access to both roles
GRANT SELECT, INSERT ON public.ratings TO authenticated;
GRANT SELECT, INSERT ON public.ratings TO anon;
