CREATE TABLE IF NOT EXISTS public.payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_type TEXT,
  external_event_id TEXT,
  related_booking_id UUID NULL REFERENCES public.walk_requests(id) ON DELETE SET NULL,
  related_provider_id UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  processed BOOLEAN NOT NULL DEFAULT false,
  processed_at TIMESTAMPTZ NULL,
  error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_provider
  ON public.payment_events(provider);

CREATE INDEX IF NOT EXISTS idx_payment_events_event_type
  ON public.payment_events(event_type);

CREATE INDEX IF NOT EXISTS idx_payment_events_external_event_id
  ON public.payment_events(external_event_id);

CREATE INDEX IF NOT EXISTS idx_payment_events_created_at
  ON public.payment_events(created_at DESC);

ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.payment_events FROM PUBLIC;
REVOKE ALL ON TABLE public.payment_events FROM anon;
REVOKE ALL ON TABLE public.payment_events FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payment_events TO service_role;
