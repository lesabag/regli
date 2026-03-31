-- Fix: grant notifications table access to anon role
-- The Supabase JS client connects as 'anon' even for authenticated users.
-- The original migration only granted to 'authenticated', which blocks
-- all queries from the frontend client.
GRANT SELECT, INSERT, UPDATE ON public.notifications TO anon;
