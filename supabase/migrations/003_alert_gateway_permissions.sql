-- ============================================================================
-- Migration 003: Create alerts table + grant gateway (anon key) INSERT access
-- ============================================================================
-- The alerts table is defined in schema.sql but may not exist in production
-- if the initial schema was never applied.  This migration creates it first,
-- then grants the permissions the ESP32 gateway needs to insert alert rows
-- using the Supabase anon key.
--
-- Apply with: paste into the Supabase SQL editor and click Run
-- ============================================================================

-- ── Create alerts table if it doesn't exist ──────────────────────────────────

CREATE TABLE IF NOT EXISTS public.alerts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NULL,
  device_id       uuid        NULL REFERENCES public.devices(id) ON DELETE SET NULL,
  severity        text        NOT NULL DEFAULT 'info',   -- info | warning | critical
  title           text        NOT NULL,
  message         text        NOT NULL,
  status          text        NOT NULL DEFAULT 'active', -- active | acknowledged | silenced | resolved
  created_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz NULL,
  silenced_until  timestamptz NULL,
  resolved_at     timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_alerts_device_id  ON public.alerts (device_id);
CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON public.alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_status     ON public.alerts (status);

-- ── Grant permissions ─────────────────────────────────────────────────────────

-- Allow the gateway (anon key) to insert and read alerts.
GRANT INSERT, SELECT ON TABLE public.alerts TO anon;

-- Allow the gateway to read device rows (needed for fetchFenceDeviceId).
GRANT SELECT ON TABLE public.devices TO anon;

-- Allow the authenticated role (dashboard) full alert access.
GRANT INSERT, SELECT, UPDATE ON TABLE public.alerts TO authenticated;
