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

interface TelemetryAuthResult {
  ok: boolean
  reason?: string
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

interface PushDispatchOptions {
  targetUserId?: string | null
  url?: string
  deviceId?: string
  deviceType?: string
  alertType?: string
  temperatureF?: number
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

function fail(stage: string, error: unknown, status = 500): Response {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : JSON.stringify(error)

  console.error(
    JSON.stringify({
      stage,
      error: message,
    }),
  )

  return json({ error: message, stage }, status)
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

function metadataString(
  metadata: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!metadata) return null
  const value = metadata[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get('authorization') ?? req.headers.get('Authorization')
  if (!authHeader) return null
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!match) return null
  const token = match[1]?.trim()
  return token || null
}

function validateTelemetryAuth(req: Request, device: DeviceRow): TelemetryAuthResult {
  const metadataToken = metadataString(device.metadata, 'telemetry_token')
  if (!metadataToken) {
    return { ok: true }
  }

  const bearer = extractBearerToken(req)
  if (!bearer) {
    return { ok: false, reason: 'Missing bearer token for this device' }
  }

  if (bearer !== metadataToken) {
    return { ok: false, reason: 'Invalid bearer token for this device' }
  }

  return { ok: true }
}

let devicesTenantColumnSupported: boolean | null = null
let devicesLocationColumnSupported: boolean | null = null

function getMissingDevicesColumn(message: string | undefined): string | null {
  const text = String(message ?? '')

  const direct = text.match(/column\s+devices\.([a-zA-Z0-9_]+)\s+does not exist/i)
  if (direct?.[1]) return direct[1]

  const schemaCache = text.match(/'([a-zA-Z0-9_]+)'\s+column\s+of\s+'devices'/i)
  if (schemaCache?.[1]) return schemaCache[1]

  return null
}

function isMissingTenantColumnError(message: string | undefined): boolean {
  return getMissingDevicesColumn(message) === 'tenant_id'
}

async function loadDeviceByKey(
  supabase: ReturnType<typeof createClient>,
  deviceKey: string,
): Promise<{ device: DeviceRow | null; error: string | null }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const selectColumns = ['id', 'name', 'type', 'device_type', 'status', 'metadata']
    if (devicesTenantColumnSupported !== false) selectColumns.push('tenant_id')
    if (devicesLocationColumnSupported !== false) selectColumns.push('location')

    const { data, error } = await supabase
      .from('devices')
      .select(selectColumns.join(', '))
      .eq('device_key', deviceKey)
      .maybeSingle()

    if (!error) {
      if (selectColumns.includes('tenant_id')) devicesTenantColumnSupported = true
      if (selectColumns.includes('location')) devicesLocationColumnSupported = true
      return { device: (data as DeviceRow | null) ?? null, error: null }
    }

    const missingColumn = getMissingDevicesColumn(error.message)
    if (!missingColumn) return { device: null, error: error.message }

    if (missingColumn === 'tenant_id') {
      devicesTenantColumnSupported = false
      continue
    }

    if (missingColumn === 'location') {
      devicesLocationColumnSupported = false
      continue
    }

    return { device: null, error: error.message }
  }

  return { device: null, error: 'Unable to load device due to repeated missing column mismatches.' }
}

async function updateDeviceWithColumnFallback(
  supabase: ReturnType<typeof createClient>,
  deviceId: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  const updatePayload: Record<string, unknown> = { ...payload }

  for (let attempt = 0; attempt < 10; attempt++) {
    const { error } = await supabase
      .from('devices')
      .update(updatePayload)
      .eq('id', deviceId)

    if (!error) return null

    const missingColumn = getMissingDevicesColumn(error.message)
    if (!missingColumn || !(missingColumn in updatePayload)) {
      return error.message
    }

    delete updatePayload[missingColumn]

    if (missingColumn === 'tenant_id') devicesTenantColumnSupported = false
    if (missingColumn === 'location') devicesLocationColumnSupported = false
  }

  return 'Unable to update device due to repeated missing column mismatches.'
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

async function bestEffortSendPushForAlert(
  alertId: string,
  options: PushDispatchOptions = {},
): Promise<void> {
  const configuredEndpoint = Deno.env.get('PUSH_NOTIFY_FUNCTION_URL')?.trim() ?? ''
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim() ?? ''
  const fallbackEndpoint = supabaseUrl ? `${supabaseUrl}/functions/v1/send-push-notification` : ''

  // Always prefer the canonical project-local edge function URL to avoid
  // stale/misconfigured PUSH_NOTIFY_FUNCTION_URL values pointing elsewhere.
  const endpoint = fallbackEndpoint || configuredEndpoint

  if (!endpoint) {
    console.error('Push notification endpoint missing for freezer-telemetry')
    return
  }

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
    headers.apikey = functionAuthToken.trim()
  } else {
    console.error('Push notification auth token missing for freezer-telemetry -> send-push-notification call')
  }

  console.log('Dispatching push notification', {
    endpoint,
    configuredEndpoint,
    fallbackEndpoint,
    hasAuthorizationHeader: Boolean(headers.Authorization),
    hasApiKeyHeader: Boolean(headers.apikey),
  })

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        alertId,
        targetUserId: options.targetUserId ?? undefined,
        url: options.url,
        deviceId: options.deviceId,
        deviceType: options.deviceType,
        alertType: options.alertType,
        temperatureF: options.temperatureF,
      }),
    })

    if (!response.ok) {
      const responseBody = await response.text().catch(() => '')
      console.error('Push notification failed', response.status, responseBody.slice(0, 300))
      return
    }

    console.log('Push notification sent')
  } catch (pushErr) {
    console.error('Push notification failed', (pushErr as Error).message)
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
    return fail('parse_json', 'Invalid JSON payload', 400)
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

  const { device, error: deviceErr } = await loadDeviceByKey(supabase, deviceKey)

  if (deviceErr) return fail('load_device', deviceErr)
  if (!device) return json({ error: 'Unknown device_key' }, 401)

  const typedDevice = device as DeviceRow
  const kind = deviceKind(typedDevice)
  if (kind !== 'freezer_lynk' && kind !== 'freezer_alarm') {
    return json({ error: `device_key belongs to unsupported type: ${kind || 'unknown'}` }, 400)
  }

  const authResult = validateTelemetryAuth(req, typedDevice)
  if (!authResult.ok) {
    return json({ error: authResult.reason ?? 'Unauthorized' }, 401)
  }

  const nowIso = new Date().toISOString()
  const configuredOwnerUserId = Deno.env.get('FREEZER_OWNER_USER_ID')?.trim() || null
  const configuredLocationLabel = Deno.env.get('FREEZER_OWNER_LOCATION_LABEL')?.trim() || null
  const metadataOwnerUserId = metadataString(typedDevice.metadata, 'owner_user_id')
  const metadataTenantId = metadataString(typedDevice.metadata, 'tenant_id')

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
    return fail('assign_device_owner', ownerErr)
  }

  let { data: settings, error: settingsErr } = await supabase
    .from('freezer_lynk_settings')
    .select('device_id, temp_alarm_high_f, temp_warning_high_f, alert_delay_minutes, heartbeat_minutes, offline_after_minutes, logging_interval_minutes, enabled')
    .eq('device_id', typedDevice.id)
    .maybeSingle()

  if (settingsErr) return fail('load_settings', settingsErr.message)

  if (!settings) {
    const { data: insertedSettings, error: insertSettingsErr } = await supabase
      .from('freezer_lynk_settings')
      .insert({ device_id: typedDevice.id })
      .select('device_id, temp_alarm_high_f, temp_warning_high_f, alert_delay_minutes, heartbeat_minutes, offline_after_minutes, logging_interval_minutes, enabled')
      .single()

    if (insertSettingsErr) return fail('insert_default_settings', insertSettingsErr.message)
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

  if (insertLogErr) return fail('insert_temperature_log', insertLogErr.message)

  const { data: currentState, error: stateErr } = await supabase
    .from('device_telemetry_state')
    .select('device_id, last_state, alarm_started_at, warning_started_at, alarm_active')
    .eq('device_id', typedDevice.id)
    .maybeSingle()

  if (stateErr) return fail('load_telemetry_state', stateErr.message)

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

  const ownerTargetUserId = metadataOwnerUserId ?? configuredOwnerUserId ?? null
  const alertTenantId = typedDevice.tenant_id ?? metadataTenantId ?? null
  const deviceDeepLink = `/devices/${typedDevice.id}`

  const { data: existingActiveRows, error: existingActiveErr } = await supabase
    .from('alerts')
    .select('id, severity, title, status, resolved_at')
    .eq('device_id', typedDevice.id)
    .eq('status', 'active')
    .is('resolved_at', null)
    .in('severity', ['warning', 'critical'])
    .order('created_at', { ascending: false })
    .limit(1)

  if (existingActiveErr) return fail('load_existing_active_alert', existingActiveErr.message)

  const existingActiveAlert = (existingActiveRows?.[0] ?? null) as {
    id: string
    severity: string
    title: string
    status: string
    resolved_at: string | null
  } | null

  const shouldCreateWarning = nextState === 'warning' && prevState === 'ok'
  const shouldCreateAlarm = nextState === 'alarm' && prevState !== 'alarm'
  const shouldCreateRecovery = nextState === 'ok' && (prevState === 'warning' || prevState === 'alarm')

  let createdWarningId: string | null = null
  let createdAlarmId: string | null = null
  let createdRecoveryId: string | null = null

  if (shouldCreateWarning) {
    console.log('Freezer warning transition')

    if (existingActiveAlert) {
      console.log('Push notification skipped - duplicate/active alert exists', {
        severity: existingActiveAlert.severity,
        title: existingActiveAlert.title,
        alert_id: existingActiveAlert.id,
      })
    } else {
      const { data: warningRow, error: warningErr } = await supabase
        .from('alerts')
        .insert({
          tenant_id: alertTenantId,
          device_id: typedDevice.id,
          severity: 'warning',
          title: 'Freezer Lynk Warning',
          message: `${typedDevice.name} is above warning temp: ${temperatureF.toFixed(1)}°F (warning ${freezerSettings.temp_warning_high_f.toFixed(1)}°F).`,
          status: 'active',
        })
        .select('id')
        .single()

      if (warningErr) return fail('insert_warning_alert', warningErr.message)
      createdWarningId = String(warningRow.id)
      await bestEffortSendPushForAlert(createdWarningId, {
        targetUserId: ownerTargetUserId,
        url: deviceDeepLink,
        deviceId: typedDevice.id,
        deviceType: 'freezer_lynk',
        alertType: 'freezer_high_temp_warning',
        temperatureF,
      })
    }
  }

  if (shouldCreateAlarm) {
    console.log('Freezer alarm transition')

    if (existingActiveAlert && existingActiveAlert.severity === 'critical') {
      createdAlarmId = existingActiveAlert.id
      console.log('Push notification skipped - duplicate/active alert exists', {
        severity: existingActiveAlert.severity,
        title: existingActiveAlert.title,
        alert_id: existingActiveAlert.id,
      })
    } else {
      const { data: alertRow, error: alertErr } = await supabase
        .from('alerts')
        .insert({
          tenant_id: alertTenantId,
          device_id: typedDevice.id,
          severity: 'critical',
          title: 'Freezer Lynk Alarm',
          message: `${typedDevice.name} is too warm: ${temperatureF.toFixed(1)}°F (alarm ${freezerSettings.temp_alarm_high_f.toFixed(1)}°F).`,
          status: 'active',
        })
        .select('id')
        .single()

      if (alertErr) return fail('insert_alarm_alert', alertErr.message)
      createdAlarmId = String(alertRow.id)
      await bestEffortSendPushForAlert(createdAlarmId, {
        targetUserId: ownerTargetUserId,
        url: deviceDeepLink,
        deviceId: typedDevice.id,
        deviceType: 'freezer_lynk',
        alertType: 'freezer_high_temp',
        temperatureF,
      })
    }
  }

  if (shouldCreateRecovery) {
    console.log('Freezer recovery transition')

    const { data: recoveryRow, error: recoveryErr } = await supabase
      .from('alerts')
      .insert({
        tenant_id: alertTenantId,
        device_id: typedDevice.id,
        severity: 'info',
        title: 'Freezer Lynk Recovered',
        message: `${typedDevice.name} is back within spec: ${temperatureF.toFixed(1)}°F (warning ${freezerSettings.temp_warning_high_f.toFixed(1)}°F).`,
        status: 'resolved',
        resolved_at: nowIso,
      })
      .select('id')
      .single()

    if (recoveryErr) return fail('insert_recovery_alert', recoveryErr.message)
    createdRecoveryId = String(recoveryRow.id)

    await bestEffortSendPushForAlert(createdRecoveryId, {
      targetUserId: ownerTargetUserId,
      url: deviceDeepLink,
      deviceId: typedDevice.id,
      deviceType: 'freezer_lynk',
      alertType: 'freezer_temp_recovered',
      temperatureF,
    })

    const { error: resolveErr } = await supabase
      .from('alerts')
      .update({ status: 'resolved', resolved_at: nowIso })
      .eq('device_id', typedDevice.id)
      .eq('status', 'active')
      .in('severity', ['warning', 'critical'])

    if (resolveErr) return fail('resolve_active_alerts', resolveErr.message)
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
      last_alert_id: createdAlarmId ?? createdWarningId,
      last_recovery_at: shouldCreateRecovery ? nowIso : null,
      updated_at: nowIso,
    })

  if (upsertStateErr) return fail('upsert_telemetry_state', upsertStateErr.message)

  // Resolve any active offline/missing alert and send reconnected push notification
  const { data: activeOfflineAlerts } = await supabase
    .from('alerts')
    .select('id')
    .eq('device_id', typedDevice.id)
    .eq('title', 'Freezer Lynk Offline')
    .eq('status', 'active')
    .is('resolved_at', null)

  if (activeOfflineAlerts && activeOfflineAlerts.length > 0) {
    const offlineIds = activeOfflineAlerts.map((a: { id: string }) => a.id)
    await supabase
      .from('alerts')
      .update({ status: 'resolved', resolved_at: nowIso })
      .in('id', offlineIds)

    // Send reconnected push notification
    const { data: reconnectRow } = await supabase
      .from('alerts')
      .insert({
        device_id: typedDevice.id,
        severity: 'info',
        title: 'Freezer Lynk Reconnected',
        message: `${typedDevice.name} is reporting again.`,
        status: 'resolved',
        resolved_at: nowIso,
      })
      .select('id')
      .single()

    if (reconnectRow?.id) {
      await bestEffortSendPushForAlert(String(reconnectRow.id), {
        targetUserId: ownerTargetUserId,
        url: deviceDeepLink,
        deviceId: typedDevice.id,
        deviceType: 'freezer_lynk',
        alertType: 'freezer_reconnected',
      })
    }
  }

  const metadata = {
    ...(typedDevice.metadata ?? {}),
    owner_user_id: ownerUserId ?? configuredOwnerUserId ?? null,
    owner_location_label: typedDevice.location ?? configuredLocationLabel ?? null,
    transport: 'wifi',
    freezer_state: nextState,
    connection_health: 'healthy',
    last_connection_check_at: nowIso,
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

  const updateDeviceErr = await updateDeviceWithColumnFallback(supabase, typedDevice.id, {
    status: deviceStatus,
    online: true,
    location: resolvedLocation,
    last_seen: nowIso,
    last_seen_at: nowIso,
    firmware_version: payload.firmware_version ?? null,
    metadata,
    updated_at: nowIso,
  })

  if (updateDeviceErr) return fail('update_device_snapshot', updateDeviceErr)

  return json({
    ok: true,
    device_id: typedDevice.id,
    status: deviceStatus,
    freezer_state: nextState,
    created_alert_id: createdAlarmId,
  })
})
