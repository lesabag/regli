ALTER TABLE public.dispatch_attempts
ALTER COLUMN dispatch_version SET DEFAULT 1;

UPDATE public.dispatch_attempts
SET dispatch_version = 1
WHERE dispatch_version IS NULL;

ALTER TABLE public.dispatch_attempts
ALTER COLUMN dispatch_version SET NOT NULL;
