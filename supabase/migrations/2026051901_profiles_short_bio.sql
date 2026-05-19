alter table public.profiles
add column if not exists short_bio text;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'profiles_short_bio_length_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
    drop constraint profiles_short_bio_length_check;
  end if;

  alter table public.profiles
  add constraint profiles_short_bio_length_check
  check (short_bio is null or char_length(short_bio) <= 80);
end
$$;
