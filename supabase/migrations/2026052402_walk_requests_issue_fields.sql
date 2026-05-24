do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'walk_requests'
  ) then
    if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'walk_requests'
        and column_name = 'issue_type'
    ) then
      alter table public.walk_requests
        add column issue_type text;
    end if;

    if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'walk_requests'
        and column_name = 'issue_description'
    ) then
      alter table public.walk_requests
        add column issue_description text;
    end if;
  end if;
end
$$;
