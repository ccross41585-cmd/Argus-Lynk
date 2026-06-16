-- Add columns to devices table that may be missing in older deployments.

alter table public.devices
  add column if not exists enabled boolean not null default true,
  add column if not exists online boolean not null default false,
  add column if not exists sort_order int not null default 0,
  add column if not exists device_type text null,
  add column if not exists last_seen_at timestamptz null,
  add column if not exists firmware_version text null,
  add column if not exists rssi numeric null,
  add column if not exists battery_voltage numeric null,
  add column if not exists metadata jsonb null,
  add column if not exists updated_at timestamptz not null default now();
