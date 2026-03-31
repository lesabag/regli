-- Add ratings table to the supabase_realtime publication so that
-- postgres_changes subscriptions on ratings actually fire events.
ALTER PUBLICATION supabase_realtime ADD TABLE public.ratings;
