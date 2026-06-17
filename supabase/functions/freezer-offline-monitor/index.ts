import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

type DeviceRow = {
  id: string
  tenant_id: string | null
  name: string
  type: string | null
  device_type: string | null
  status: string | null
  online: boolean | null
  last_seen: string | null
  last_seen_at: string | null
  metadata: Record<string, unknown> | null
}

type SettingsRow = {
  device_id: string
  offline_after_minutes: number
  enabled: boolean
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey',
    },
  })
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return 0
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : 0
}

function isFreezer(row: DeviceRow): boolean {
  const type = String(row.device_type ?? row.type ?? '').toLowerCase()
  return type === 'freezer_lynk' || type === 'freezer_alarm'
}

async function bestEffortSendPushForAlert(alertId: string): Promise<void> {
  const endpoint = Deno.env.get('PUSH_NOTIFY_FUNCTION_URL')
  if (!endpoint) return

  const functionAuthToken = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    ?? Deno.env.get('SUPABASE_ANON_KEY')
    ?? ''

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (functionAuthToken.trim().length > 0) {
    headers.Authorization = `Bearer ${functionAuthToken}`
    headers.apikey = functionAuthToken
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ alertId }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    console.error('Offline push notification failed', response.status, body.slice(0, 300))
    return
  }

  console.log('Offline push notification sent')
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return json({ ok: true })
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) return json({ error: 'Missing Supabase environment variables' }, 500)

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()

  const [{ data: devices, error: devicesErr }, { data: settingsRows, error: settingsErr }] = await Promise.all([
    supabase
      .from('devices')
      .select('id, tenant_id, name, type, device_type, status, online, last_seen, last_seen_at, metadata')
      .order('name'),
    supabase
      .from('freezer_lynk_settings')
      .select('device_id, offline_after_minutes, enabled'),
  ])

  if (devicesErr) return json({ error: devicesErr.message, stage: 'load_devices' }, 500)
  if (settingsErr) return json({ error: settingsErr.message, stage: 'load_settings' }, 500)

  const settingsByDevice = new Map<string, SettingsRow>()
  for (const row of (settingsRows ?? []) as SettingsRow[]) settingsByDevice.set(row.device_id, row)

  let markedOffline = 0
  let alreadyOffline = 0
  let resolvedOfflineAlerts = 0

  for (const row of (devices ?? []) as DeviceRow[]) {
    if (!isFreezer(row)) continue

    const settings = settingsByDevice.get(row.id)
    if (settings && !settings.enabled) continue

    const offlineAfterMinutes = Math.max(1, settings?.offline_after_minutes ?? 15)
    const thresholdMs = offlineAfterMinutes * 60_000

    const lastSeenMs = parseTimestamp(row.last_seen_at) || parseTimestamp(row.last_seen)
    const stale = !lastSeenMs || (nowMs - lastSeenMs >= thresholdMs)

    if (stale) {
      const metadata = {
        ...(row.metadata ?? {}),
        freezer_state: 'offline',
      }

      if (String(row.status ?? '').toLowerCase() !== 'offline' || row.online !== false) {
        const { error: updateErr } = await supabase
          .from('devices')
          .update({
            status: 'offline',
            online: false,
            metadata,
            updated_at: nowIso,
          })
          .eq('id', row.id)

        if (updateErr) {
          console.error('Failed to mark freezer offline', row.id, updateErr.message)
          continue
        }
        markedOffline += 1
      } else {
        alreadyOffline += 1
      }

      const { data: activeOffline } = await supabase
        .from('alerts')
        .select('id')
        .eq('device_id', row.id)
        .eq('title', 'Freezer Lynk Offline')
        .eq('status', 'active')
        .is('resolved_at', null)
        .limit(1)

      if (!activeOffline || activeOffline.length === 0) {
        const { data: inserted, error: insertErr } = await supabase
          .from('alerts')
          .insert({
            tenant_id: row.tenant_id,
            device_id: row.id,
            severity: 'warning',
            title: 'Freezer Lynk Offline',
            message: `${row.name} has not reported in ${offlineAfterMinutes} minutes.`,
            status: 'active',
          })
          .select('id')
          .single()

        if (insertErr) {
          console.error('Failed to insert freezer offline alert', row.id, insertErr.message)
          continue
        }

        await bestEffortSendPushForAlert(String(inserted.id))
      }

      continue
    }

    const { data: activeOffline, error: activeErr } = await supabase
      .from('alerts')
      .select('id')
      .eq('device_id', row.id)
      .eq('title', 'Freezer Lynk Offline')
      .eq('status', 'active')
      .is('resolved_at', null)

    if (!activeErr && activeOffline && activeOffline.length > 0) {
      const ids = activeOffline.map((item) => item.id)
      const { error: resolveErr } = await supabase
        .from('alerts')
        .update({ status: 'resolved', resolved_at: nowIso })
        .in('id', ids)

      if (!resolveErr) resolvedOfflineAlerts += ids.length
    }
  }

  return json({
    ok: true,
    marked_offline: markedOffline,
    already_offline: alreadyOffline,
    resolved_offline_alerts: resolvedOfflineAlerts,
  })
})
