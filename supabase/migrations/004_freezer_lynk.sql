-- ============================================================================
-- Migration 004: Freezer Lynk (WiFi-first telemetry + settings)
-- ============================================================================
-- Adds:
--   - devices model extensions for freezer_lynk registration
--   - freezer_temperature_logs (time-series readings)
--   - freezer_lynk_settings (per-device thresholds/intervals)
--   - device_telemetry_state (generic state tracking for dedupe + future LoRa)
--
-- Apply with:
--   supabase db push
--   or paste in SQL editor
-- ============================================================================

-- ── devices extensions (backward compatible) ─────────────────────────────────

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS device_type text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS firmware_version text,
  ADD COLUMN IF NOT EXISTS device_key text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- Keep old/new columns aligned for existing app code.
UPDATE public.devices
SET
  device_type = COALESCE(device_type, type),
  status = COALESCE(status, CASE WHEN online THEN 'online' ELSE 'offline' END),
  last_seen_at = COALESCE(last_seen_at, last_seen)
WHERE true;

CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_device_key_unique
  ON public.devices(device_key)
  WHERE device_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_devices_device_type
  ON public.devices(device_type);

CREATE INDEX IF NOT EXISTS idx_devices_status
  ON public.devices(status);

-- ── freezer temperature logs ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.freezer_temperature_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NULL,
  device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  temperature_f numeric(8,3) NOT NULL,
  temperature_c numeric(8,3) NOT NULL,
  raw_sensor_value text NULL,
  signal_strength numeric NULL,
  battery_voltage numeric NULL,
  battery_percent numeric NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_freezer_logs_tenant
  ON public.freezer_temperature_logs (tenant_id);

CREATE INDEX IF NOT EXISTS idx_freezer_logs_device_created_desc
  ON public.freezer_temperature_logs (device_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_freezer_logs_tenant_device_created_desc
  ON public.freezer_temperature_logs (tenant_id, device_id, created_at DESC);

-- ── freezer settings ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.freezer_lynk_settings (
  device_id uuid PRIMARY KEY REFERENCES public.devices(id) ON DELETE CASCADE,
  tenant_id uuid NULL,
  temp_alarm_high_f numeric(8,3) NOT NULL DEFAULT 10,
  temp_warning_high_f numeric(8,3) NOT NULL DEFAULT 5,
  alert_delay_minutes int NOT NULL DEFAULT 5,
  heartbeat_minutes int NOT NULL DEFAULT 5,
  offline_after_minutes int NOT NULL DEFAULT 15,
  logging_interval_minutes int NOT NULL DEFAULT 5,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_freezer_settings_tenant
  ON public.freezer_lynk_settings (tenant_id);

-- ── generic telemetry state (for dedupe, recovery, future transports) ───────

CREATE TABLE IF NOT EXISTS public.device_telemetry_state (
  device_id uuid PRIMARY KEY REFERENCES public.devices(id) ON DELETE CASCADE,
  tenant_id uuid NULL,
  device_type text NOT NULL,
  transport text NULL, -- wifi | lora | cellular | etc
  last_state text NOT NULL DEFAULT 'ok', -- ok | warning | alarm | offline
  warning_started_at timestamptz NULL,
  alarm_started_at timestamptz NULL,
  alarm_active boolean NOT NULL DEFAULT false,
  last_reading_at timestamptz NULL,
  last_alert_id uuid NULL REFERENCES public.alerts(id) ON DELETE SET NULL,
  last_recovery_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_telemetry_state_tenant
  ON public.device_telemetry_state (tenant_id);

CREATE INDEX IF NOT EXISTS idx_device_telemetry_state_type
  ON public.device_telemetry_state (device_type);

-- ── permissions ──────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON TABLE public.devices TO anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.devices TO authenticated;

GRANT SELECT, INSERT ON TABLE public.freezer_temperature_logs TO anon;
GRANT SELECT, INSERT ON TABLE public.freezer_temperature_logs TO authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.freezer_lynk_settings TO anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.freezer_lynk_settings TO authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.device_telemetry_state TO anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.device_telemetry_state TO authenticated;
