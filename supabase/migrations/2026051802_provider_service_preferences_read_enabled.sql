do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_service_preferences'
      and policyname = 'provider service preferences read enabled authenticated'
  ) then
    create policy "provider service preferences read enabled authenticated"
      on public.provider_service_preferences
      for select
      to authenticated
      using (is_enabled = true);
  end if;
end
$$;
