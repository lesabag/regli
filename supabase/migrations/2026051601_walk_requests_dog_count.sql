alter table public.walk_requests
  add column if not exists dog_count integer;

update public.walk_requests
set dog_count = 1
where dog_count is null;

alter table public.walk_requests
  alter column dog_count set default 1;

alter table public.walk_requests
  alter column dog_count set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'walk_requests_dog_count_check'
  ) then
    alter table public.walk_requests
      add constraint walk_requests_dog_count_check
      check (dog_count in (1, 2));
  end if;
end
$$;
