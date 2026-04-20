-- Push notification tokens for iOS (APNs)
-- One row per device per user. Upsert by (user_id, token) to avoid duplicates.

CREATE TABLE public.push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'ios',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, token)
);

CREATE INDEX idx_push_tokens_user_id ON public.push_tokens(user_id);

ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;

-- Users can read their own tokens
CREATE POLICY "Users can read own push tokens"
  ON public.push_tokens FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own tokens
CREATE POLICY "Users can insert own push tokens"
  ON public.push_tokens FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own tokens
CREATE POLICY "Users can update own push tokens"
  ON public.push_tokens FOR UPDATE
  USING (auth.uid() = user_id);

-- Users can delete their own tokens
CREATE POLICY "Users can delete own push tokens"
  ON public.push_tokens FOR DELETE
  USING (auth.uid() = user_id);

-- Enable realtime (not strictly needed but consistent with other tables)
ALTER PUBLICATION supabase_realtime ADD TABLE public.push_tokens;
