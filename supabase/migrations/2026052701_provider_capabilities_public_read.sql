do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_capabilities'
      and policyname = 'provider_capabilities_select_public_provider_profiles'
  ) then
    create policy provider_capabilities_select_public_provider_profiles
      on public.provider_capabilities
      for select
      to authenticated
      using (
        exists (
          select 1
          from public.profiles p
          where p.id = provider_capabilities.provider_id
            and p.role in ('walker', 'provider')
        )
      );
  end if;
end $$;
