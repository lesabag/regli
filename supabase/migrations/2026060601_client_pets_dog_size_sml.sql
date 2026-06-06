update public.client_pets
set dog_size = 'L'
where dog_size = 'XL';

alter table public.client_pets
drop constraint if exists client_pets_dog_size_check;

alter table public.client_pets
add constraint client_pets_dog_size_check
check (dog_size is null or dog_size in ('S', 'M', 'L'));
