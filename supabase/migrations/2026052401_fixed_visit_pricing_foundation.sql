do $$
declare
  pricing_model_type_schema text;
  pricing_model_type_name text;
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'provider_service_preferences'
  ) then
    if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'provider_service_preferences'
        and column_name = 'visit_fee_min'
    ) then
      alter table public.provider_service_preferences
        add column visit_fee_min numeric;
    end if;

    if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'provider_service_preferences'
        and column_name = 'visit_fee_preferred'
    ) then
      alter table public.provider_service_preferences
        add column visit_fee_preferred numeric;
    end if;
  end if;

  select ns.nspname, typ.typname
  into pricing_model_type_schema, pricing_model_type_name
  from pg_attribute attr
  join pg_class cls
    on cls.oid = attr.attrelid
  join pg_namespace cls_ns
    on cls_ns.oid = cls.relnamespace
  join pg_type typ
    on typ.oid = attr.atttypid
  join pg_namespace ns
    on ns.oid = typ.typnamespace
  where cls_ns.nspname = 'public'
    and cls.relname = 'provider_service_preferences'
    and attr.attname = 'pricing_model'
    and attr.attnum > 0
    and not attr.attisdropped
    and typ.typtype = 'e'
  limit 1;

  if pricing_model_type_name is not null then
    if not exists (
      select 1
      from pg_enum enum
      join pg_type typ
        on typ.oid = enum.enumtypid
      join pg_namespace ns
        on ns.oid = typ.typnamespace
      where ns.nspname = pricing_model_type_schema
        and typ.typname = pricing_model_type_name
        and enum.enumlabel = 'fixed_visit'
    ) then
      execute format(
        'alter type %I.%I add value %L',
        pricing_model_type_schema,
        pricing_model_type_name,
        'fixed_visit'
      );
    end if;
  end if;
end
$$;
