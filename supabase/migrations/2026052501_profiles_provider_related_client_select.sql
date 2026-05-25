do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'profiles_select_provider_related_clients'
  ) then
    create policy "profiles_select_provider_related_clients"
      on public.profiles
      for select
      to authenticated
      using (
        exists (
          select 1
          from public.walk_requests wr
          where wr.walker_id = auth.uid()
            and wr.client_id = public.profiles.id
        )
        or exists (
          select 1
          from public.favorite_customers fc
          where fc.walker_id = auth.uid()
            and fc.client_id = public.profiles.id
        )
      );
  end if;
end
$$;
