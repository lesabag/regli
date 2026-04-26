-- ============================================================================
-- Fix Duplicate Notifications
-- Add deduplication constraint to prevent duplicate notifications
-- ============================================================================

-- Partial unique indexes preserve the intended one-notification-per-type-per-job
-- behavior for selected notification types.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup_walker_accepted
  ON public.notifications (user_id, type, related_job_id)
  WHERE type = 'walker_accepted';

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup_dispatch_started
  ON public.notifications (user_id, type, related_job_id)
  WHERE type = 'dispatch_started';

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup_job_completed
  ON public.notifications (user_id, type, related_job_id)
  WHERE type = 'job_completed';

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup_new_rating
  ON public.notifications (user_id, type, related_job_id)
  WHERE type = 'new_rating';
