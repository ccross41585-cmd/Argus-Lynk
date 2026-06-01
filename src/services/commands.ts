/**
 * Device command creation helpers.
 *
 * Delegates to dashboardMock in local mode and to Supabase RPC in cloud mode.
 *
 * Safety rules:
 * - Dangerous commands (well pump shutoff, fence control) log every invocation.
 * - Commands are never auto-confirmed — field node confirmation is required.
 * - Cloud path validates via Supabase RLS: the user must own the tenant/device.
 */

import { createCommand as mockCreateCommand } from '../lib/dashboardMock'
import { supabase } from '../lib/supabase'
import type { CommandRecord, CreateCommandInput } from '../types/dashboard'

// Re-export the input type so callers don't need to reach into types/dashboard
export type { CreateCommandInput } from '../types/dashboard'

// ── Core command creator ──────────────────────────────────────────────────────

/**
 * Creates a device command.
 * @param input  Command payload
 * @param localMode  When true uses the mock implementation; false = Supabase
 * @param userId  Used as `requested_by` in cloud mode
 */
export async function createDeviceCommand(
  input: CreateCommandInput,
  localMode: boolean,
  userId?: string,
): Promise<{ command: CommandRecord | null; error: string | null }> {
  if (localMode) {
    const cmd = await mockCreateCommand(input)
    return { command: cmd, error: null }
  }

  if (!supabase) {
    return { command: null, error: 'Supabase not configured.' }
  }

  const { data, error } = await supabase
    .from('device_commands')
    .insert({
      device_id: input.target_device_id,
      command_type: input.command_type,
      payload: input.payload ?? {},
      status: 'pending',
      // requested_by is derived from auth.uid() via RLS/trigger on the server.
      // We pass it here for display purposes only; the server re-validates.
      metadata: { requested_by: userId ?? 'unknown' },
    })
    .select()
    .single()

  if (error) {
    return { command: null, error: error.message }
  }

  // Map Supabase row to CommandRecord shape
  const record = data as Record<string, unknown>
  const cmd: CommandRecord = {
    id: record.id as string,
    target_device_id: record.device_id as string,
    command_type: record.command_type as CommandRecord['command_type'],
    payload: (record.payload ?? {}) as Record<string, string | number | boolean>,
    status: record.status as CommandRecord['status'],
    requested_by: userId ?? 'unknown',
    created_at: record.created_at as string,
    sent_at: record.sent_at as string | null,
    acknowledged_at: record.acknowledged_at as string | null,
    confirmed_at: record.confirmed_at as string | null,
    failure_reason: record.failure_reason as string | null,
  }

  return { command: cmd, error: null }
}

// ── Well pump convenience commands ───────────────────────────────────────────

export async function createWellPumpShutoffCommand(
  deviceId: string,
  alertId: string,
  localMode: boolean,
  userId?: string,
): Promise<{ command: CommandRecord | null; error: string | null }> {
  return createDeviceCommand(
    {
      target_device_id: deviceId,
      command_type: 'WELL_PUMP_SHUTOFF',
      payload: { triggered_by_alert: alertId },
      requested_by: userId ?? 'operator',
    },
    localMode,
    userId,
  )
}

export async function createWellPumpExtendCommand(
  deviceId: string,
  alertId: string,
  localMode: boolean,
  userId?: string,
): Promise<{ command: CommandRecord | null; error: string | null }> {
  return createDeviceCommand(
    {
      target_device_id: deviceId,
      command_type: 'WELL_PUMP_EXTEND_RUNTIME',
      payload: { triggered_by_alert: alertId },
      requested_by: userId ?? 'operator',
    },
    localMode,
    userId,
  )
}

// ── Alert state helpers ───────────────────────────────────────────────────────

/**
 * Acknowledges an alert via Supabase (cloud) or mock (local).
 * The mock acknowledgeAlert is also exported from dashboardMock for direct use
 * in list/detail components; this wrapper adds cloud support.
 */
export async function acknowledgeAlertCommand(
  alertId: string,
  localMode: boolean,
): Promise<{ error: string | null }> {
  if (localMode) {
    const { acknowledgeAlert } = await import('../lib/dashboardMock')
    await acknowledgeAlert(alertId)
    return { error: null }
  }
  if (!supabase) return { error: 'Supabase not configured.' }

  const { error } = await supabase
    .from('alerts')
    .update({ status: 'acknowledged', acknowledged_at: new Date().toISOString() })
    .eq('id', alertId)

  return { error: error?.message ?? null }
}

/**
 * Silences an alert for `durationMinutes` (default 30).
 */
export async function silenceAlertCommand(
  alertId: string,
  localMode: boolean,
  durationMinutes = 30,
): Promise<{ error: string | null }> {
  if (localMode) {
    const { silenceAlert } = await import('../lib/dashboardMock')
    await silenceAlert(alertId)
    return { error: null }
  }
  if (!supabase) return { error: 'Supabase not configured.' }

  const { error } = await supabase
    .from('alerts')
    .update({
      status: 'silenced',
      silenced_until: new Date(Date.now() + durationMinutes * 60_000).toISOString(),
    })
    .eq('id', alertId)

  return { error: error?.message ?? null }
}
