drop policy if exists "profiles_select_provider_related_clients" on public.profiles;

create policy "profiles_select_provider_related_clients"
  on public.profiles
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.walk_requests wr
      where wr.client_id = public.profiles.id
        and wr.walker_id = auth.uid()
    )
    or exists (
      select 1
      from public.favorite_customers fc
      where fc.client_id = public.profiles.id
        and fc.walker_id = auth.uid()
    )
  );

drop policy if exists "wr_admin_select" on public.walk_requests;
create policy "wr_admin_select"
  on public.walk_requests
  for select
  to authenticated
  using (public.is_admin());

drop policy if exists "wr_admin_all" on public.walk_requests;
create policy "wr_admin_all"
  on public.walk_requests
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
