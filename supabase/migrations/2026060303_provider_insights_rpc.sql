create or replace function public.normalize_provider_service_type_key(p_value text)
returns text
language sql
immutable
as $$
  select case lower(trim(coalesce(p_value, '')))
    when '' then null
    when 'dog_walking' then 'dog_walker'
    when 'dog-walker' then 'dog_walker'
    when 'dog_walker' then 'dog_walker'
    when 'babysitter' then 'baby_sitter'
    when 'baby-sitter' then 'baby_sitter'
    when 'baby_sitter' then 'baby_sitter'
    when 'air-conditioner-technician' then 'air_conditioner_technician'
    else lower(trim(coalesce(p_value, '')))
  end
$$;

create index if not exists idx_dispatch_attempts_walker_created_at
  on public.dispatch_attempts (walker_id, created_at desc);

create or replace function public.get_provider_insights(
  p_timezone text default 'Asia/Jerusalem'
)
returns table (
  period_start timestamptz,
  period_end timestamptz,
  acceptance_rate numeric,
  completion_rate numeric,
  average_rating numeric,
  requests_received integer,
  requests_accepted integer,
  requests_declined integer,
  requests_expired integer,
  requests_received_while_offline integer,
  requests_outside_availability integer,
  estimated_missed_earnings numeric,
  most_active_weekday integer,
  most_active_hour integer
)
language sql
security definer
set search_path = public
as $$
with provider_profile as (
  select
    p.id as provider_id,
    array(
      select distinct public.normalize_provider_service_type_key(service_value)
      from unnest(
        case
          when p.service_types is not null and cardinality(p.service_types) > 0 then p.service_types
          when p.service_type is not null then array[p.service_type]
          else array[]::text[]
        end
      ) as service_value
      where public.normalize_provider_service_type_key(service_value) is not null
    ) as supported_service_types
  from public.profiles p
  where p.id = auth.uid()
),
period_bounds as (
  select
    (date_trunc('month', now() at time zone p_timezone) at time zone p_timezone) as period_start,
    ((date_trunc('month', now() at time zone p_timezone) + interval '1 month') at time zone p_timezone) as period_end
),
provider_availability_rows as (
  select
    pa.provider_id,
    public.normalize_provider_service_type_key(pa.service_type) as service_type,
    pa.day_of_week,
    extract(hour from pa.start_time)::int * 60 + extract(minute from pa.start_time)::int as start_minutes,
    extract(hour from pa.end_time)::int * 60 + extract(minute from pa.end_time)::int as end_minutes
  from public.provider_availability pa
  join provider_profile pp
    on pp.provider_id = pa.provider_id
  where pa.is_active = true
),
matching_requests as (
  select
    wr.id,
    wr.created_at,
    public.normalize_provider_service_type_key(wr.service_type) as service_type,
    wr.price,
    wr.walker_earnings,
    wr.status,
    wr.walker_id
  from public.walk_requests wr
  join provider_profile pp
    on cardinality(pp.supported_service_types) > 0
   and public.normalize_provider_service_type_key(wr.service_type) = any(pp.supported_service_types)
  join period_bounds pb
    on wr.created_at >= pb.period_start
   and wr.created_at < pb.period_end
),
matching_requests_local as (
  select
    mr.*,
    extract(dow from timezone(p_timezone, mr.created_at))::int as request_weekday,
    (
      extract(hour from timezone(p_timezone, mr.created_at))::int * 60
      + extract(minute from timezone(p_timezone, mr.created_at))::int
    ) as request_minutes
  from matching_requests mr
),
request_schedule_flags as (
  select
    mrl.id as request_id,
    exists(
      select 1
      from provider_availability_rows par
      where par.service_type = mrl.service_type
        and par.day_of_week = mrl.request_weekday
        and mrl.request_minutes >= par.start_minutes
        and mrl.request_minutes < par.end_minutes
    ) as within_schedule
  from matching_requests_local mrl
),
provider_attempts as (
  select
    da.request_id,
    da.status,
    coalesce(da.responded_at, da.created_at) as received_at
  from public.dispatch_attempts da
  join provider_profile pp
    on da.walker_id = pp.provider_id
  join period_bounds pb
    on da.created_at >= pb.period_start
   and da.created_at < pb.period_end
),
received_requests as (
  select
    pa.request_id,
    max(pa.received_at) as received_at,
    case
      when bool_or(pa.status = 'accepted') then 'accepted'
      when bool_or(pa.status in ('rejected', 'skipped', 'cancelled')) then 'declined'
      when bool_or(pa.status = 'expired') then 'expired'
      else 'pending'
    end as outcome
  from provider_attempts pa
  group by pa.request_id
),
received_counts as (
  select
    count(*)::int as requests_received,
    count(*) filter (where rr.outcome = 'accepted')::int as requests_accepted,
    count(*) filter (where rr.outcome = 'declined')::int as requests_declined,
    count(*) filter (where rr.outcome = 'expired')::int as requests_expired,
    count(*) filter (where rr.outcome = 'accepted' and mr.status = 'completed')::int as requests_completed
  from received_requests rr
  left join matching_requests mr
    on mr.id = rr.request_id
),
availability_counts as (
  select
    count(*) filter (where coalesce(rsf.within_schedule, false) = false)::int as requests_outside_availability,
    count(*) filter (
      where coalesce(rsf.within_schedule, false) = true
        and rr.request_id is null
    )::int as requests_received_while_offline
  from matching_requests mr
  left join request_schedule_flags rsf
    on rsf.request_id = mr.id
  left join received_requests rr
    on rr.request_id = mr.id
),
missed_earnings as (
  select
    coalesce(sum(
      case
        when rr.outcome = 'accepted' or mr.walker_id = pp.provider_id then 0
        when mr.walker_earnings is not null then mr.walker_earnings
        when mr.price is not null then mr.price * 0.8
        else 0
      end
    ), 0)::numeric as estimated_missed_earnings
  from matching_requests mr
  cross join provider_profile pp
  left join received_requests rr
    on rr.request_id = mr.id
),
ratings_summary as (
  select round(avg(r.rating)::numeric, 1) as average_rating
  from public.ratings r
  join provider_profile pp
    on r.to_user_id = pp.provider_id
),
best_weekday as (
  select weekday
  from (
    select
      extract(dow from timezone(p_timezone, rr.received_at))::int as weekday,
      count(*) as received_count
    from received_requests rr
    group by 1
    order by received_count desc, weekday asc
    limit 1
  ) ranked_weekdays
),
best_hour as (
  select hour_of_day
  from (
    select
      extract(hour from timezone(p_timezone, rr.received_at))::int as hour_of_day,
      count(*) as received_count
    from received_requests rr
    group by 1
    order by received_count desc, hour_of_day asc
    limit 1
  ) ranked_hours
)
select
  pb.period_start,
  pb.period_end,
  case
    when rc.requests_received > 0
      then round((rc.requests_accepted::numeric / rc.requests_received::numeric) * 100, 1)
    else null
  end as acceptance_rate,
  case
    when rc.requests_accepted > 0
      then round((rc.requests_completed::numeric / rc.requests_accepted::numeric) * 100, 1)
    else null
  end as completion_rate,
  rs.average_rating,
  rc.requests_received,
  rc.requests_accepted,
  rc.requests_declined,
  rc.requests_expired,
  ac.requests_received_while_offline,
  ac.requests_outside_availability,
  me.estimated_missed_earnings,
  bw.weekday as most_active_weekday,
  bh.hour_of_day as most_active_hour
from period_bounds pb
cross join received_counts rc
cross join availability_counts ac
cross join missed_earnings me
cross join ratings_summary rs
left join best_weekday bw on true
left join best_hour bh on true
$$;

grant execute on function public.get_provider_insights(text) to authenticated;
