-- Create Freezer Lynk tables if they don't exist in the live database.

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
