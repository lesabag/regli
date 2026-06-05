alter table public.client_pets
add column if not exists dog_size text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'client_pets_dog_size_check'
      and conrelid = 'public.client_pets'::regclass
  ) then
    alter table public.client_pets
    add constraint client_pets_dog_size_check
    check (dog_size is null or dog_size in ('S', 'M', 'L', 'XL'));
  end if;
end
$$;

comment on column public.client_pets.dog_size
is 'Dog size: S, M, L, XL';
