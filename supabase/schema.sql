-- Argus Control schema for local Supabase testing.
-- RLS is intentionally left disabled for development.
-- Add authentication and RLS policies before production use.

create extension if not exists pgcrypto;

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  tenant_id uuid null,
  name text not null,
  type text not null,
  device_type text null,
  status text null,
  location text null,
  enabled boolean not null default true,
  sort_order int not null default 0,
  device_key text null,
  gateway_id text null,
  desired_state text null,
  confirmed_state text null,
  online boolean not null default false,
  last_seen timestamptz null,
  last_seen_at timestamptz null,
  firmware_version text null,
  rssi numeric null,
  battery_voltage numeric null,
  metadata jsonb null,
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_devices_device_key_unique
  on public.devices (device_key)
  where device_key is not null;

create index if not exists idx_devices_device_type
  on public.devices (device_type);

create index if not exists idx_devices_status
  on public.devices (status);

create table if not exists public.device_commands (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid null,
  device_id uuid not null references public.devices(id) on delete cascade,
  gateway_id text null,
  client_command_id text null,
  command_type text not null,
  payload jsonb null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  sent_at timestamptz null,
  gateway_received_at timestamptz null,
  sent_to_node_at timestamptz null,
  node_acknowledged_at timestamptz null,
  acknowledged_at timestamptz null,
  verified_at timestamptz null,
  failed_at timestamptz null,
  confirmed_at timestamptz null,
  failure_reason text null
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

create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid null,
  device_id uuid null references public.devices(id) on delete set null,
  severity text not null default 'info',       -- info | warning | critical
  title text not null,
  message text not null,
  status text not null default 'active',        -- active | acknowledged | silenced | resolved
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz null,
  silenced_until timestamptz null,
  resolved_at timestamptz null
);

create index if not exists idx_devices_gateway_id
  on public.devices (gateway_id);

-- User profile: stores location preferences per authenticated user.
-- Linked to auth.users via id (same UUID).
create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  location_label text null,        -- Human-readable e.g. "Abilene, Texas, US"
  latitude numeric(9, 6) null,
  longitude numeric(9, 6) null,
  timezone text null,              -- IANA timezone e.g. "America/Chicago"
  updated_at timestamptz not null default now()
);

-- Row-level security: each user can only read/write their own profile.
alter table public.user_profiles enable row level security;

create policy "user_profiles_owner" on public.user_profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

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

create table if not exists public.freezer_temperature_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid null,
  device_id uuid not null references public.devices(id) on delete cascade,
  temperature_f numeric(8,3) not null,
  temperature_c numeric(8,3) not null,
  raw_sensor_value text null,
  signal_strength numeric null,
  battery_voltage numeric null,
  battery_percent numeric null,
  created_at timestamptz not null default now()
);

create index if not exists idx_freezer_logs_tenant
  on public.freezer_temperature_logs (tenant_id);

create index if not exists idx_freezer_logs_device_created_desc
  on public.freezer_temperature_logs (device_id, created_at desc);

create index if not exists idx_freezer_logs_tenant_device_created_desc
  on public.freezer_temperature_logs (tenant_id, device_id, created_at desc);

create table if not exists public.freezer_lynk_settings (
  device_id uuid primary key references public.devices(id) on delete cascade,
  tenant_id uuid null,
  temp_alarm_high_f numeric(8,3) not null default 10,
  temp_warning_high_f numeric(8,3) not null default 5,
  alert_delay_minutes int not null default 5,
  heartbeat_minutes int not null default 5,
  offline_after_minutes int not null default 15,
  logging_interval_minutes int not null default 5,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_freezer_settings_tenant
  on public.freezer_lynk_settings (tenant_id);

create table if not exists public.device_telemetry_state (
  device_id uuid primary key references public.devices(id) on delete cascade,
  tenant_id uuid null,
  device_type text not null,
  transport text null,
  last_state text not null default 'ok',
  warning_started_at timestamptz null,
  alarm_started_at timestamptz null,
  alarm_active boolean not null default false,
  last_reading_at timestamptz null,
  last_alert_id uuid null references public.alerts(id) on delete set null,
  last_recovery_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_device_telemetry_state_tenant
  on public.device_telemetry_state (tenant_id);

create index if not exists idx_device_telemetry_state_type
  on public.device_telemetry_state (device_type);