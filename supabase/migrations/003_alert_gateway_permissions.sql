-- ============================================================================
-- Migration 003: Grant gateway (anon key) INSERT on alerts
-- ============================================================================
-- The ESP32 gateway uses the anon key (not service role) to insert alert rows
-- directly into Supabase when it detects fence power loss or a node going
-- offline via heartbeat timeout.
--
-- Without this grant the gateway's INSERT calls return HTTP 403, and no push
-- notification is sent.
--
-- The alerts table intentionally has RLS disabled (dev/single-tenant setup).
-- Apply with: run this file in the Supabase SQL editor, or:
--   supabase db push
-- ============================================================================

-- Allow the gateway (anon key) to insert and read alerts.
-- UPDATE/DELETE are intentionally omitted from the anon role.
GRANT INSERT, SELECT ON TABLE public.alerts TO anon;

-- Allow the gateway to read device rows (needed for fetchFenceDeviceId).
-- SELECT is typically already granted, but included here for clarity.
GRANT SELECT ON TABLE public.devices TO anon;

-- Allow the authenticated role the same alert access (dashboard queries).
GRANT INSERT, SELECT, UPDATE ON TABLE public.alerts TO authenticated;
