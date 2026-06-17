import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

type DeviceRow = {
  id: string
  tenant_id?: string | null
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
  heartbeat_minutes?: number | null
  logging_interval_minutes?: number | null
  enabled: boolean
}

let devicesTenantColumnSupported: boolean | null = null
let alertsTenantColumnSupported: boolean | null = null

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

function metadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  if (!metadata) return null
  const value = metadata[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function getMissingColumn(message: string | undefined): string | null {
  const text = String(message ?? '')

  const direct = text.match(/column\s+[a-zA-Z0-9_]+\.([a-zA-Z0-9_]+)\s+does not exist/i)
  if (direct?.[1]) return direct[1]

  const schemaCache = text.match(/'([a-zA-Z0-9_]+)'\s+column\s+of\s+'[a-zA-Z0-9_]+'/i)
  if (schemaCache?.[1]) return schemaCache[1]

  return null
}

async function loadDevicesResilient(
  supabase: ReturnType<typeof createClient>,
): Promise<{ data: DeviceRow[]; error: string | null }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const columns = [
      'id',
      'name',
      'type',
      'device_type',
      'status',
      'online',
      'last_seen',
      'last_seen_at',
      'metadata',
    ]
    if (devicesTenantColumnSupported !== false) columns.push('tenant_id')

    const { data, error } = await supabase
      .from('devices')
      .select(columns.join(', '))
      .order('name')

    if (!error) {
      if (columns.includes('tenant_id')) devicesTenantColumnSupported = true
      return { data: (data ?? []) as DeviceRow[], error: null }
    }

    const missing = getMissingColumn(error.message)
    if (missing === 'tenant_id') {
      devicesTenantColumnSupported = false
      continue
    }

    return { data: [], error: error.message }
  }

  return { data: [], error: 'Unable to load devices due to repeated missing column mismatches.' }
}

async function insertOfflineAlert(
  supabase: ReturnType<typeof createClient>,
  payload: {
    tenant_id?: string | null
    device_id: string
    title: string
    message: string
  },
): Promise<{ id: string | null; error: string | null }> {
  let includeTenant = alertsTenantColumnSupported !== false && Boolean(payload.tenant_id)

  for (let attempt = 0; attempt < 4; attempt++) {
    const insertPayload: Record<string, unknown> = {
      device_id: payload.device_id,
      severity: 'warning',
      title: payload.title,
      message: payload.message,
      status: 'active',
    }
    if (includeTenant) insertPayload.tenant_id = payload.tenant_id

    const { data, error } = await supabase
      .from('alerts')
      .insert(insertPayload)
      .select('id')
      .single()

    if (!error) {
      if (includeTenant) alertsTenantColumnSupported = true
      return { id: String(data?.id ?? ''), error: null }
    }

    const missing = getMissingColumn(error.message)
    if (missing === 'tenant_id' && includeTenant) {
      alertsTenantColumnSupported = false
      includeTenant = false
      continue
    }

    return { id: null, error: error.message }
  }

  return { id: null, error: 'Unable to insert offline alert due to repeated missing column mismatches.' }
}

async function bestEffortSendPushForAlert(alertId: string): Promise<void> {
  const endpoint = Deno.env.get('PUSH_NOTIFY_FUNCTION_URL')
  if (!endpoint) return

  const functionAuthToken =
    Deno.env.get('PUSH_NOTIFY_AUTH_TOKEN')
    ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    ?? Deno.env.get('SUPABASE_ANON_KEY')
    ?? Deno.env.get('SERVICE_ROLE_KEY')
    ?? Deno.env.get('ANON_KEY')
    ?? ''

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (functionAuthToken.trim().length > 0) {
    headers.Authorization = `Bearer ${functionAuthToken.trim()}`
    headers.authorization = `Bearer ${functionAuthToken.trim()}`
    headers.apikey = functionAuthToken
  } else {
    console.error('Push notification auth token missing for freezer-offline-monitor -> send-push-notification call')
  }

  console.log('Dispatching offline push notification', {
    endpoint,
    hasAuthorizationHeader: Boolean(headers.Authorization || headers.authorization),
    hasApiKeyHeader: Boolean(headers.apikey),
  })

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
    loadDevicesResilient(supabase),
    supabase
      .from('freezer_lynk_settings')
      .select('device_id, offline_after_minutes, heartbeat_minutes, logging_interval_minutes, enabled'),
  ])

  if (devicesErr) return json({ error: devicesErr, stage: 'load_devices' }, 500)
  if (settingsErr) return json({ error: settingsErr.message, stage: 'load_settings' }, 500)

  const settingsByDevice = new Map<string, SettingsRow>()
  for (const row of (settingsRows ?? []) as SettingsRow[]) settingsByDevice.set(row.device_id, row)

  let checkedFreezers = 0
  let healthyCount = 0
  let delayedCount = 0
  let missingCount = 0
  let markedMissing = 0
  let skippedAlreadyMissing = 0
  let offlineAlertsCreated = 0
  let offlineAlertsResolved = 0
  let skippedDisabled = 0

  for (const row of devices) {
    if (!isFreezer(row)) continue
    checkedFreezers += 1

    const settings = settingsByDevice.get(row.id)
    if (settings && !settings.enabled) {
      skippedDisabled += 1
      console.log('Freezer offline monitor action', {
        device_name: row.name,
        last_seen_at: row.last_seen_at ?? row.last_seen,
        age_minutes: null,
        health: null,
        action: 'skipped_disabled',
      })
      continue
    }

    // Calculate thresholds for Freezer Lynk deep-sleep devices
    const loggingIntervalMinutes = Math.max(1, settings?.logging_interval_minutes ?? 8)
    const configuredOfflineAfter = Math.max(1, settings?.offline_after_minutes ?? 30)
    const offlineAfterMinutes = Math.max(configuredOfflineAfter, loggingIntervalMinutes * 4, 30)
    const delayedThresholdMinutes = Math.max(loggingIntervalMinutes * 2, 15)

    const offlineThresholdMs = offlineAfterMinutes * 60_000
    const delayedThresholdMs = delayedThresholdMinutes * 60_000

    const lastSeenMs = parseTimestamp(row.last_seen_at) || parseTimestamp(row.last_seen)
    const ageMs = nowMs - lastSeenMs
    const ageMinutes = lastSeenMs ? Number((ageMs / 60_000).toFixed(2)) : null

    // Determine connection health state
    let connectionHealth: 'healthy' | 'delayed' | 'missing'
    let shouldBeOnline = true
    let shouldBeOfflineStatus = false

    if (!lastSeenMs) {
      // Never reported
      connectionHealth = 'missing'
      shouldBeOnline = false
      shouldBeOfflineStatus = true
    } else if (ageMs <= delayedThresholdMs) {
      // Recent report - healthy
      connectionHealth = 'healthy'
    } else if (ageMs <= offlineThresholdMs) {
      // Getting old but not yet offline threshold - delayed
      connectionHealth = 'delayed'
    } else {
      // Past offline threshold - missing
      connectionHealth = 'missing'
      shouldBeOnline = false
      shouldBeOfflineStatus = true
    }

    const metadata = {
      ...(row.metadata ?? {}),
      connection_health: connectionHealth,
      last_connection_check_at: nowIso,
      connection_age_minutes: ageMinutes,
      expected_report_minutes: loggingIntervalMinutes,
      delayed_after_minutes: delayedThresholdMinutes,
      missing_after_minutes: offlineAfterMinutes,
    }

    // Handle state transitions and updates
    if (connectionHealth === 'healthy') {
      healthyCount += 1
      // Healthy state: do not overwrite status if already alarm/warning/normal
      const currentStatusLower = String(row.status ?? '').toLowerCase()
      if (currentStatusLower !== 'alarm' && currentStatusLower !== 'warning') {
        if (row.online !== true) {
          const { error: updateErr } = await supabase
            .from('devices')
            .update({
              online: true,
              metadata,
              updated_at: nowIso,
            })
            .eq('id', row.id)
          if (updateErr) {
            console.error('Failed to mark freezer healthy', row.id, updateErr.message)
          }
        } else {
          // Just update metadata
          const { error: updateErr } = await supabase
            .from('devices')
            .update({ metadata, updated_at: nowIso })
            .eq('id', row.id)
          if (updateErr) {
            console.error('Failed to update freezer metadata', row.id, updateErr.message)
          }
        }
      } else {
        // Just update metadata without changing status
        const { error: updateErr } = await supabase
          .from('devices')
          .update({ metadata, updated_at: nowIso })
          .eq('id', row.id)
        if (updateErr) {
          console.error('Failed to update freezer metadata', row.id, updateErr.message)
        }
      }

      console.log('Freezer offline monitor action', {
        device_name: row.name,
        last_seen_at: row.last_seen_at ?? row.last_seen,
        age_minutes: ageMinutes,
        health: 'healthy',
        expected_interval: loggingIntervalMinutes,
        action: 'healthy',
      })
    } else if (connectionHealth === 'delayed') {
      delayedCount += 1
      // Delayed state: keep online=true, do not create alert yet, just track metadata
      if (row.online !== true) {
        const { error: updateErr } = await supabase
          .from('devices')
          .update({
            online: true,
            metadata,
            updated_at: nowIso,
          })
          .eq('id', row.id)
        if (updateErr) {
          console.error('Failed to mark freezer delayed', row.id, updateErr.message)
        }
      } else {
        const { error: updateErr } = await supabase
          .from('devices')
          .update({ metadata, updated_at: nowIso })
          .eq('id', row.id)
        if (updateErr) {
          console.error('Failed to update freezer metadata', row.id, updateErr.message)
        }
      }

      console.log('Freezer offline monitor action', {
        device_name: row.name,
        last_seen_at: row.last_seen_at ?? row.last_seen,
        age_minutes: ageMinutes,
        health: 'delayed',
        expected_interval: loggingIntervalMinutes,
        action: 'delayed_no_alert',
      })
    } else {
      // Missing state
      missingCount += 1

      const currentStatusLower = String(row.status ?? '').toLowerCase()
      const isCurrentlyMissing = currentStatusLower === 'offline' && row.online === false

      if (isCurrentlyMissing) {
        // Already marked missing - do not re-mark
        skippedAlreadyMissing += 1
        console.log('Freezer offline monitor action', {
          device_name: row.name,
          last_seen_at: row.last_seen_at ?? row.last_seen,
          age_minutes: ageMinutes,
          health: 'missing',
          expected_interval: loggingIntervalMinutes,
          action: 'skipped_already_missing',
        })
      } else {
        // Transition to missing - mark offline and create alert
        if (currentStatusLower !== 'alarm') {
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
            console.error('Failed to mark freezer missing', row.id, updateErr.message)
            console.log('Freezer offline monitor action', {
              device_name: row.name,
              last_seen_at: row.last_seen_at ?? row.last_seen,
              age_minutes: ageMinutes,
              health: 'missing',
              expected_interval: loggingIntervalMinutes,
              action: 'mark_missing_failed',
            })
            continue
          }
        } else {
          // Do not overwrite alarm status, just update metadata
          const { error: updateErr } = await supabase
            .from('devices')
            .update({ metadata, updated_at: nowIso })
            .eq('id', row.id)
          if (updateErr) {
            console.error('Failed to update freezer metadata during missing', row.id, updateErr.message)
          }
        }

        markedMissing += 1
        console.log('Freezer offline monitor action', {
          device_name: row.name,
          last_seen_at: row.last_seen_at ?? row.last_seen,
          age_minutes: ageMinutes,
          health: 'missing',
          expected_interval: loggingIntervalMinutes,
          action: 'marked_missing',
        })
      }

      // Check for existing offline alert
      const { data: activeOffline } = await supabase
        .from('alerts')
        .select('id')
        .eq('device_id', row.id)
        .eq('title', 'Freezer Lynk Offline')
        .eq('status', 'active')
        .is('resolved_at', null)
        .limit(1)

      // Only create alert if no active one exists and we just transitioned to missing
      if ((!activeOffline || activeOffline.length === 0) && !isCurrentlyMissing) {
        const tenantForAlert = row.tenant_id ?? metadataString(row.metadata, 'owner_user_id')
        const { id: insertedId, error: insertErr } = await insertOfflineAlert(supabase, {
          tenant_id: tenantForAlert,
          device_id: row.id,
          title: 'Freezer Lynk Offline',
          message: `${row.name} has not reported in ${offlineAfterMinutes} minutes.`,
        })

        if (insertErr) {
          console.error('Failed to insert freezer offline alert', row.id, insertErr)
          continue
        }

        offlineAlertsCreated += 1
        if (insertedId) await bestEffortSendPushForAlert(insertedId)
      }
    }

    // Resolve offline alerts when device becomes healthy again
    if (connectionHealth === 'healthy') {
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

        if (!resolveErr) {
          offlineAlertsResolved += ids.length
          console.log('Freezer offline monitor action', {
            device_name: row.name,
            health: 'healthy',
            action: 'resolved_offline_alerts',
            resolved_count: ids.length,
          })
        }
      }
    }
  }

  return json({
    ok: true,
    checked_freezers: checkedFreezers,
    healthy_count: healthyCount,
    delayed_count: delayedCount,
    missing_count: missingCount,
    marked_missing: markedMissing,
    skipped_already_missing: skippedAlreadyMissing,
    offline_alerts_created: offlineAlertsCreated,
    offline_alerts_resolved: offlineAlertsResolved,
    skipped_disabled: skippedDisabled,
  })
})
