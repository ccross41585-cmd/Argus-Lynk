-- ============================================================================
-- Migration 005: devices.location compatibility
-- ============================================================================
-- Some existing production databases may not have public.devices.location.
-- This adds the column safely.
--
-- Apply with: supabase db push
-- or paste in SQL editor
-- ============================================================================

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS location text;
