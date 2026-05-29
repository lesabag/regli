alter table public.profiles
  add column if not exists preferred_language text;

update public.profiles
set preferred_language = 'en'
where preferred_language is null;

alter table public.profiles
  alter column preferred_language set default 'en',
  alter column preferred_language set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_preferred_language_check'
  ) then
    alter table public.profiles
      add constraint profiles_preferred_language_check
      check (preferred_language in ('en', 'he'));
  end if;
end $$;

grant select (preferred_language) on table public.profiles to authenticated;
grant update (preferred_language) on table public.profiles to authenticated;
