-- ============================================================================
-- Migration 006: Universal push dispatch trigger for every new alert row.
-- ============================================================================
-- Adds push_dispatched_at to alerts for atomic dedup, then creates a
-- pg_net trigger that calls send-push-notification on every INSERT.
--
-- This version uses a table-based config to avoid ALTER DATABASE permissions
-- that are blocked in hosted Supabase SQL roles.
-- ============================================================================

-- 1. Add dedup timestamp to alerts
ALTER TABLE public.alerts
  ADD COLUMN IF NOT EXISTS push_dispatched_at timestamptz NULL;

-- 2. Enable pg_net if not already enabled (safe to run multiple times)
CREATE EXTENSION IF NOT EXISTS pg_net SCHEMA extensions;

-- 3. Runtime config table for trigger dispatch endpoint and auth header.
-- Put an anon key here (recommended for this trigger) or a service-role key.
CREATE TABLE IF NOT EXISTS public.app_runtime_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Baseline URL value (safe default for this project)
INSERT INTO public.app_runtime_config (key, value)
VALUES ('supabase_url', 'https://zmdijnkvymiuuwiwtmhd.supabase.co')
ON CONFLICT (key) DO NOTHING;

-- 4. Trigger function: call send-push-notification via pg_net on every insert
CREATE OR REPLACE FUNCTION public.notify_push_on_alert_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  _url text;
  _auth text;
  _token text;
BEGIN
  SELECT value INTO _url FROM public.app_runtime_config WHERE key = 'supabase_url';
  SELECT value INTO _auth FROM public.app_runtime_config WHERE key = 'push_dispatch_auth';

  -- Skip if runtime config is not ready yet.
  -- Example push_dispatch_auth value: 'Bearer <anon-or-service-role-key>'
  IF _url IS NULL OR _url = '' OR _auth IS NULL OR _auth = '' THEN
    RETURN NEW;
  END IF;

  -- Normalize common config mistakes:
  -- - Allow raw JWT or "Bearer <jwt>" formats
  _auth := btrim(_auth);
  _auth := regexp_replace(_auth, '^Bearer\s*<([^>]+)>\s*$', 'Bearer \1', 'i');
  IF _auth !~* '^Bearer\s+' THEN
    _auth := 'Bearer ' || _auth;
  END IF;
  _token := regexp_replace(_auth, '^Bearer\s+', '', 'i');
  _token := btrim(_token);
  _token := regexp_replace(_token, '^<+', '');
  _token := regexp_replace(_token, '>+$', '');
  _auth := 'Bearer ' || _token;

  PERFORM net.http_post(
    _url || '/functions/v1/send-push-notification',
    jsonb_build_object('alertId', NEW.id::text)::jsonb,
    '{}'::jsonb,
    jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', _auth,
      'apikey', _token
    )::jsonb
  );

  RETURN NEW;
END;
$$;

-- 5. Attach trigger — fires after every new alert row regardless of source
DROP TRIGGER IF EXISTS alerts_push_dispatch ON public.alerts;
CREATE TRIGGER alerts_push_dispatch
  AFTER INSERT ON public.alerts
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_push_on_alert_insert();
