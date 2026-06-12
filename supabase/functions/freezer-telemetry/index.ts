import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface TelemetryPayload {
  device_key: string
  temperature_f?: number
  temperature_c?: number
  raw_sensor_value?: string | null
  signal_strength?: number | null
  battery_voltage?: number | null
  battery_percent?: number | null
  firmware_version?: string | null
}

interface DeviceRow {
  id: string
  name: string
  tenant_id?: string | null
  type: string | null
  device_type: string | null
  status: string | null
  location?: string | null
  metadata: Record<string, unknown> | null
}

interface FreezerSettingsRow {
  device_id: string
  temp_alarm_high_f: number
  temp_warning_high_f: number
  alert_delay_minutes: number
  heartbeat_minutes: number
  offline_after_minutes: number
  logging_interval_minutes: number
  enabled: boolean
}

interface TelemetryStateRow {
  device_id: string
  last_state: 'ok' | 'warning' | 'alarm' | 'offline'
  alarm_started_at: string | null
  warning_started_at: string | null
  alarm_active: boolean
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  })
}

function toCelsius(f: number): number {
  return (f - 32) * (5 / 9)
}

function toFahrenheit(c: number): number {
  return (c * 9) / 5 + 32
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function deviceKind(device: DeviceRow): string {
  return (device.device_type ?? device.type ?? '').toLowerCase()
}

let devicesTenantColumnSupported: boolean | null = null

function isMissingTenantColumnError(message: string | undefined): boolean {
  const text = String(message ?? '').toLowerCase()
  if (!text.includes('tenant_id')) return false
  return text.includes('does not exist') || text.includes('schema cache') || text.includes('could not find the')
}

async function assignDeviceOwnerIfNeeded(
  supabase: ReturnType<typeof createClient>,
  deviceId: string,
  existingTenantId: string | null | undefined,
  ownerUserId: string | null,
  nowIso: string,
): Promise<string | null> {
  if (existingTenantId) return existingTenantId
  if (!ownerUserId) return null
  if (devicesTenantColumnSupported === false) return null

  const { error } = await supabase
    .from('devices')
    .update({ tenant_id: ownerUserId, updated_at: nowIso })
    .eq('id', deviceId)

  if (!error) {
    devicesTenantColumnSupported = true
    return ownerUserId
  }

  if (isMissingTenantColumnError(error.message)) {
    devicesTenantColumnSupported = false
    return null
  }

  throw new Error(error.message)
}

async function bestEffortSendPushForAlert(alertId: string): Promise<void> {
  const endpoint = Deno.env.get('PUSH_NOTIFY_FUNCTION_URL')
  if (!endpoint) return

  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertId }),
    })
  } catch {
    // Notification fanout is best-effort and should not fail telemetry ingestion.
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return json({ ok: true })
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  let payload: TelemetryPayload
  try {
    payload = await req.json() as TelemetryPayload
  } catch {
    return json({ error: 'Invalid JSON payload' }, 400)
  }

  const deviceKey = payload.device_key?.trim()
  if (!deviceKey) return json({ error: 'device_key is required' }, 400)

  const hasF = Number.isFinite(payload.temperature_f)
  const hasC = Number.isFinite(payload.temperature_c)
  if (!hasF && !hasC) {
    return json({ error: 'temperature_f or temperature_c is required' }, 400)
  }

  const temperatureF = round3(hasF ? Number(payload.temperature_f) : toFahrenheit(Number(payload.temperature_c)))
  const temperatureC = round3(hasC ? Number(payload.temperature_c) : toCelsius(Number(payload.temperature_f)))

  const { data: device, error: deviceErr } = await supabase
    .from('devices')
    .select('id, name, tenant_id, type, device_type, status, location, metadata')
    .eq('device_key', deviceKey)
    .maybeSingle()

  if (deviceErr) return json({ error: deviceErr.message }, 500)
  if (!device) return json({ error: 'Unknown device_key' }, 401)

  const typedDevice = device as DeviceRow
  const kind = deviceKind(typedDevice)
  if (kind !== 'freezer_lynk' && kind !== 'freezer_alarm') {
    return json({ error: `device_key belongs to unsupported type: ${kind || 'unknown'}` }, 400)
  }

  const nowIso = new Date().toISOString()
  const configuredOwnerUserId = Deno.env.get('FREEZER_OWNER_USER_ID')?.trim() || null
  const configuredLocationLabel = Deno.env.get('FREEZER_OWNER_LOCATION_LABEL')?.trim() || null

  let ownerUserId = typedDevice.tenant_id ?? null
  try {
    ownerUserId = await assignDeviceOwnerIfNeeded(
      supabase,
      typedDevice.id,
      ownerUserId,
      configuredOwnerUserId,
      nowIso,
    )
  } catch (ownerErr) {
    return json({ error: (ownerErr as Error).message }, 500)
  }

  let { data: settings, error: settingsErr } = await supabase
    .from('freezer_lynk_settings')
    .select('device_id, temp_alarm_high_f, temp_warning_high_f, alert_delay_minutes, heartbeat_minutes, offline_after_minutes, logging_interval_minutes, enabled')
    .eq('device_id', typedDevice.id)
    .maybeSingle()

  if (settingsErr) return json({ error: settingsErr.message }, 500)

  if (!settings) {
    const { data: insertedSettings, error: insertSettingsErr } = await supabase
      .from('freezer_lynk_settings')
      .insert({ device_id: typedDevice.id })
      .select('device_id, temp_alarm_high_f, temp_warning_high_f, alert_delay_minutes, heartbeat_minutes, offline_after_minutes, logging_interval_minutes, enabled')
      .single()

    if (insertSettingsErr) return json({ error: insertSettingsErr.message }, 500)
    settings = insertedSettings
  }

  const freezerSettings = settings as FreezerSettingsRow
  if (!freezerSettings.enabled) {
    return json({ ok: true, ignored: true, reason: 'freezer_lynk_settings.enabled=false' })
  }

  const { error: insertLogErr } = await supabase
    .from('freezer_temperature_logs')
    .insert({
      device_id: typedDevice.id,
      temperature_f: temperatureF,
      temperature_c: temperatureC,
      raw_sensor_value: payload.raw_sensor_value ?? null,
      signal_strength: payload.signal_strength ?? null,
      battery_voltage: payload.battery_voltage ?? null,
      battery_percent: payload.battery_percent ?? null,
    })

  if (insertLogErr) return json({ error: insertLogErr.message }, 500)

  const { data: currentState, error: stateErr } = await supabase
    .from('device_telemetry_state')
    .select('device_id, last_state, alarm_started_at, warning_started_at, alarm_active')
    .eq('device_id', typedDevice.id)
    .maybeSingle()

  if (stateErr) return json({ error: stateErr.message }, 500)

  const prevState = (currentState?.last_state ?? 'ok') as TelemetryStateRow['last_state']

  let nextState: TelemetryStateRow['last_state'] = 'ok'
  let nextAlarmStartedAt = currentState?.alarm_started_at ?? null
  let nextWarningStartedAt = currentState?.warning_started_at ?? null
  let alarmActive = false

  if (temperatureF > freezerSettings.temp_alarm_high_f) {
    if (!nextAlarmStartedAt) nextAlarmStartedAt = nowIso
    nextWarningStartedAt = nextWarningStartedAt ?? nowIso

    const elapsedMs = Date.parse(nowIso) - Date.parse(nextAlarmStartedAt)
    const elapsedMinutes = elapsedMs / 60000
    const meetsDelay = elapsedMinutes >= freezerSettings.alert_delay_minutes

    nextState = meetsDelay ? 'alarm' : 'warning'
    alarmActive = meetsDelay
  } else if (temperatureF > freezerSettings.temp_warning_high_f) {
    nextState = 'warning'
    nextAlarmStartedAt = null
    nextWarningStartedAt = nextWarningStartedAt ?? nowIso
    alarmActive = false
  } else {
    nextState = 'ok'
    nextAlarmStartedAt = null
    nextWarningStartedAt = null
    alarmActive = false
  }

  const shouldCreateAlarm = nextState === 'alarm' && prevState !== 'alarm'
  const shouldCreateRecovery = nextState === 'ok' && (prevState === 'warning' || prevState === 'alarm')

  let createdAlarmId: string | null = null

  if (shouldCreateAlarm) {
    const { data: alertRow, error: alertErr } = await supabase
      .from('alerts')
      .insert({
        device_id: typedDevice.id,
        severity: 'critical',
        title: `Freezer Alarm · ${typedDevice.name}`,
        message: `Temperature ${temperatureF.toFixed(1)}°F exceeded alarm threshold ${freezerSettings.temp_alarm_high_f.toFixed(1)}°F for ${freezerSettings.alert_delay_minutes} minute(s).`,
        status: 'active',
      })
      .select('id')
      .single()

    if (alertErr) return json({ error: alertErr.message }, 500)
    createdAlarmId = String(alertRow.id)
    await bestEffortSendPushForAlert(createdAlarmId)
  }

  if (shouldCreateRecovery) {
    const { error: recoveryErr } = await supabase
      .from('alerts')
      .insert({
        device_id: typedDevice.id,
        severity: 'info',
        title: `Freezer Recovered · ${typedDevice.name}`,
        message: `Temperature recovered to ${temperatureF.toFixed(1)}°F (warning threshold ${freezerSettings.temp_warning_high_f.toFixed(1)}°F).`,
        status: 'resolved',
        resolved_at: nowIso,
      })

    if (recoveryErr) return json({ error: recoveryErr.message }, 500)

    const { error: resolveErr } = await supabase
      .from('alerts')
      .update({ status: 'resolved', resolved_at: nowIso })
      .eq('device_id', typedDevice.id)
      .eq('status', 'active')
      .in('severity', ['warning', 'critical'])

    if (resolveErr) return json({ error: resolveErr.message }, 500)
  }

  const { error: upsertStateErr } = await supabase
    .from('device_telemetry_state')
    .upsert({
      device_id: typedDevice.id,
      device_type: 'freezer_lynk',
      transport: 'wifi',
      last_state: nextState,
      warning_started_at: nextWarningStartedAt,
      alarm_started_at: nextAlarmStartedAt,
      alarm_active: alarmActive,
      last_reading_at: nowIso,
      last_alert_id: createdAlarmId,
      last_recovery_at: shouldCreateRecovery ? nowIso : null,
      updated_at: nowIso,
    })

  if (upsertStateErr) return json({ error: upsertStateErr.message }, 500)

  const metadata = {
    ...(typedDevice.metadata ?? {}),
    owner_user_id: ownerUserId ?? configuredOwnerUserId ?? null,
    owner_location_label: typedDevice.location ?? configuredLocationLabel ?? null,
    transport: 'wifi',
    freezer_state: nextState,
    temperature: `${temperatureF.toFixed(1)}°F`,
    temperature_f: temperatureF,
    temperature_c: temperatureC,
    battery_voltage: payload.battery_voltage ?? null,
    battery_percent: payload.battery_percent ?? null,
    warning_high_f: freezerSettings.temp_warning_high_f,
    alarm_high_f: freezerSettings.temp_alarm_high_f,
    last_telemetry_at: nowIso,
  }

  const deviceStatus = payload.battery_percent !== null && payload.battery_percent !== undefined && Number(payload.battery_percent) <= 15
    ? 'low_battery'
    : nextState === 'alarm'
      ? 'alarm'
      : 'online'

  const resolvedLocation = (typedDevice.location ?? '').trim() || configuredLocationLabel || null

  const { error: updateDeviceErr } = await supabase
    .from('devices')
    .update({
      status: deviceStatus,
      online: true,
      location: resolvedLocation,
      last_seen: nowIso,
      last_seen_at: nowIso,
      firmware_version: payload.firmware_version ?? null,
      metadata,
      updated_at: nowIso,
    })
    .eq('id', typedDevice.id)

  if (updateDeviceErr) return json({ error: updateDeviceErr.message }, 500)

  return json({
    ok: true,
    device_id: typedDevice.id,
    status: deviceStatus,
    freezer_state: nextState,
    created_alert_id: createdAlarmId,
  })
})
