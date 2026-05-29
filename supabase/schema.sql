-- Argus Control schema for local Supabase testing.
-- RLS is intentionally left disabled for development.
-- Add authentication and RLS policies before production use.

create extension if not exists pgcrypto;

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null,
  gateway_id text null,
  desired_state text null,
  confirmed_state text null,
  online boolean not null default false,
  last_seen timestamptz null,
  rssi numeric null,
  battery_voltage numeric null,
  updated_at timestamptz not null default now()
);

create table if not exists public.device_commands (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  gateway_id text null,
  command text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  sent_at timestamptz null,
  acknowledged_at timestamptz null,
  error_message text null
);

create table if not exists public.device_events (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  event_type text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_device_commands_status_created_at
  on public.device_commands (status, created_at desc);

create index if not exists idx_devices_gateway_id
  on public.devices (gateway_id);

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'devices'
  ) then
    alter publication supabase_realtime add table public.devices;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'device_commands'
  ) then
    alter publication supabase_realtime add table public.device_commands;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'device_events'
  ) then
    alter publication supabase_realtime add table public.device_events;
  end if;
end
$$;

insert into public.devices (
  name,
  type,
  confirmed_state,
  online
)
select
  'North Fence',
  'fence_controller',
  'off',
  true
where not exists (
  select 1
  from public.devices
  where name = 'North Fence'
);