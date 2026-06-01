-- ============================================================================
-- Migration 002: Push Notifications Support
-- ============================================================================
-- Adds push_subscriptions, alert_preferences, and notification_events tables.
-- Apply with: supabase db push  OR  psql -f supabase/migrations/002_push_notifications.sql
-- ============================================================================

-- ── push_subscriptions ───────────────────────────────────────────────────────
-- Stores one Web Push subscription per browser/device per user.
-- Unique on endpoint (a browser can only have one active subscription endpoint).

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text        NOT NULL,
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint      text        NOT NULL UNIQUE,
  p256dh        text        NOT NULL,   -- public EC key for payload encryption
  auth          text        NOT NULL,   -- auth secret for payload encryption
  device_label  text,                  -- human label e.g. "iPhone", "Windows PC"
  user_agent    varchar(512),
  enabled       boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz            -- set when user disables from device
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx   ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS push_subscriptions_tenant_idx ON push_subscriptions(tenant_id);
CREATE INDEX IF NOT EXISTS push_subscriptions_enabled_idx ON push_subscriptions(tenant_id, enabled)
  WHERE enabled = true;

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Users can manage their own subscriptions only.
CREATE POLICY "push_subs_select_own" ON push_subscriptions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "push_subs_insert_own" ON push_subscriptions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "push_subs_update_own" ON push_subscriptions
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "push_subs_delete_own" ON push_subscriptions
  FOR DELETE USING (auth.uid() = user_id);

-- Service role (Edge Functions) can read all for sending.
CREATE POLICY "push_subs_service_read" ON push_subscriptions
  FOR SELECT USING (current_setting('role') = 'service_role');

-- ── alert_preferences ────────────────────────────────────────────────────────
-- Per-user, per-alert-type notification preferences.

CREATE TABLE IF NOT EXISTS alert_preferences (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            text        NOT NULL,
  user_id              uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  alert_type           text        NOT NULL,   -- e.g. 'well_pump_long_runtime'
  push_enabled         boolean     NOT NULL DEFAULT true,
  in_app_enabled       boolean     NOT NULL DEFAULT true,
  minimum_severity     text        NOT NULL DEFAULT 'info',
  quiet_hours_enabled  boolean     NOT NULL DEFAULT false,
  quiet_hours_start    time,                   -- local time e.g. '22:00'
  quiet_hours_end      time,                   -- local time e.g. '07:00'
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, alert_type)
);

ALTER TABLE alert_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "alert_prefs_own" ON alert_preferences
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── notification_events ──────────────────────────────────────────────────────
-- Audit log of every push attempt (success or failure).

CREATE TABLE IF NOT EXISTS notification_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         text        NOT NULL,
  alert_id          uuid,                      -- source alert, nullable for test events
  subscription_id   uuid REFERENCES push_subscriptions(id) ON DELETE SET NULL,
  user_id           uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  status            text        NOT NULL,      -- 'sent' | 'failed' | 'skipped' | 'expired'
  http_status       int,                       -- push service HTTP status code
  error_message     text,
  payload_preview   text,                      -- first 200 chars of payload for debugging
  sent_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notif_events_alert_idx ON notification_events(alert_id);
CREATE INDEX IF NOT EXISTS notif_events_sub_idx   ON notification_events(subscription_id);
CREATE INDEX IF NOT EXISTS notif_events_sent_idx  ON notification_events(sent_at DESC);

ALTER TABLE notification_events ENABLE ROW LEVEL SECURITY;

-- Only service_role inserts events; users can read their own.
CREATE POLICY "notif_events_read_own" ON notification_events
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "notif_events_insert_service" ON notification_events
  FOR INSERT WITH CHECK (current_setting('role') = 'service_role');
