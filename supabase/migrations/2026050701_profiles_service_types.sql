alter table public.profiles
  add column if not exists service_types text[];

update public.profiles
set service_types = case
  when service_type is not null and btrim(service_type) <> '' then array[service_type]
  else service_types
end
where (service_types is null or array_length(service_types, 1) is null)
  and service_type is not null;
