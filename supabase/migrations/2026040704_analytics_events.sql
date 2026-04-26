-- Analytics events table — stores platform-level behavioral events.
-- Event names are generic (service-agnostic); service context is in the payload JSONB.
-- Designed for future verticals without schema changes.

CREATE TABLE IF NOT EXISTS analytics_events (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  session_id  UUID,
  event_name  TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_analytics_events_event_name  ON analytics_events (event_name);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user_id     ON analytics_events (user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at  ON analytics_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session     ON analytics_events (session_id);

-- Composite index for event + time range queries (admin dashboard KPIs)
CREATE INDEX IF NOT EXISTS idx_analytics_events_event_time  ON analytics_events (event_name, created_at DESC);

-- RLS
ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;

-- Authenticated users can insert their own events
DROP POLICY IF EXISTS "Users can insert own events" ON analytics_events;
CREATE POLICY "Users can insert own events"
  ON analytics_events
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

-- Anon can insert (for pre-auth events like app_opened)
DROP POLICY IF EXISTS "Anon can insert events" ON analytics_events;
CREATE POLICY "Anon can insert events"
  ON analytics_events
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- Only admins can read all events
DROP POLICY IF EXISTS "Admins can read all events" ON analytics_events;
CREATE POLICY "Admins can read all events"
  ON analytics_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

-- Users can read their own events
DROP POLICY IF EXISTS "Users can read own events" ON analytics_events;
CREATE POLICY "Users can read own events"
  ON analytics_events
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Grant permissions
GRANT SELECT, INSERT ON analytics_events TO authenticated;
GRANT INSERT ON analytics_events TO anon;
