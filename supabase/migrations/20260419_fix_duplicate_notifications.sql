-- ============================================================================
-- Fix Duplicate Notifications
-- Add deduplication constraint to prevent duplicate notifications
-- ============================================================================

-- Add a unique constraint to prevent duplicate walker_accepted notifications
-- for the same job and walker
ALTER TABLE public.notifications
ADD CONSTRAINT notifications_dedup_walker_accepted
UNIQUE (user_id, type, related_job_id)
WHERE type = 'walker_accepted';

-- Similarly for dispatch_started notifications
ALTER TABLE public.notifications
ADD CONSTRAINT notifications_dedup_dispatch_started
UNIQUE (user_id, type, related_job_id)
WHERE type = 'dispatch_started';

-- And for job_completed
ALTER TABLE public.notifications
ADD CONSTRAINT notifications_dedup_job_completed
UNIQUE (user_id, type, related_job_id)
WHERE type = 'job_completed';

-- And for new_rating
ALTER TABLE public.notifications
ADD CONSTRAINT notifications_dedup_new_rating
UNIQUE (user_id, type, related_job_id)
WHERE type = 'new_rating';

