drop view if exists public.active_dispatch_offers;

create view public.active_dispatch_offers as
select
  da.id,
  da.request_id,
  dc.walker_id,
  dc.rank,
  dc.score,
  da.created_at as offered_at,
  da.expires_at,
  da.attempt_no,
  wr.status as request_status,
  coalesce(wr.dispatch_state::text, 'queued') as dispatch_state,
  da.status,
  wr.client_id,
  wr.selected_walker_id,
  wr.dog_name,
  wr.dog_count,
  wr.location,
  wr.address,
  wr.notes,
  wr.created_at as request_created_at,
  wr.price,
  wr.platform_fee,
  wr.walker_earnings,
  wr.payment_status,
  wr.paid_at,
  wr.stripe_payment_intent_id,
  wr.booking_timing,
  wr.scheduled_for,
  wr.smart_dispatch_state,
  client.full_name as client_full_name,
  client.email as client_email,
  client.avatar_url as client_avatar_url
from public.dispatch_attempts da
join public.dispatch_candidates dc
  on dc.request_id = da.request_id
 and dc.rank = da.attempt_no
join public.walk_requests wr
  on wr.id = da.request_id
left join public.profiles client
  on client.id = wr.client_id
where da.status = 'pending'
  and da.expires_at > now()
  and wr.status = 'open'
  and wr.payment_status = 'authorized'
  and wr.stripe_payment_intent_id is not null
  and wr.walker_id is null;

grant select on public.active_dispatch_offers to authenticated;
