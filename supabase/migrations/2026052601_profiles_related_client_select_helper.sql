create or replace function public.can_read_related_client_profile(client_profile_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.walk_requests wr
    where wr.client_id = client_profile_id
      and wr.walker_id = auth.uid()
  )
  or exists (
    select 1
    from public.favorite_customers fc
    where fc.client_id = client_profile_id
      and fc.walker_id = auth.uid()
  );
$$;

grant execute on function public.can_read_related_client_profile(uuid) to authenticated;

drop policy if exists "profiles_select_provider_related_clients" on public.profiles;

create policy "profiles_select_provider_related_clients"
  on public.profiles
  for select
  to authenticated
  using (public.can_read_related_client_profile(id));
