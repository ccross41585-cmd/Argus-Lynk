/**
 * Live Supabase-backed data layer for the dashboard.
 *
 * When Supabase is not configured the calling page should fall back to
 * dashboardMock so local / offline development still works.
 *
 * Column conventions (matching the live DB schema used by the gateway):
 *   devices.type            = 'fence_controller' | 'pump_controller' | …
 *   devices.confirmed_state = 'on' | 'off'  (written by gateway on ACK)
 *   devices.desired_state   = 'on' | 'off'  (written when command queued)
 *   devices.online          = boolean
 *   device_commands.command = 'turn_on' | 'turn_off'   (gateway reads this)
 */

import { supabase } from './supabase'
import { getDeviceOnlineStatus, ONLINE_TIMEOUT_MS } from './deviceOnlineStatus'
import type {
  AlertRecord,
  CommandRecord,
  CreateCommandInput,
  DashboardDevice,
  DashboardOverview,
} from '../types/dashboard'
import type { Device } from '../types/domain'

// ── Connection freshness ──────────────────────────────────────────────────────

// Re-export the canonical timeout so callers can import from either module.
export const OFFLINE_TIMEOUT_MS = ONLINE_TIMEOUT_MS

/**
 * Convenience boolean helper. Delegates to getDeviceOnlineStatus so there is
 * exactly one implementation of the freshness logic.
 */
export function isDeviceOnline(device: {
  last_seen?: string | null
  last_seen_at?: string | null
  last_heartbeat?: string | null
  updated_at?: string | null
}): boolean {
  return getDeviceOnlineStatus(device).online
}

const DEVICE_SELECT_COLUMNS_FALLBACK = [
  'id',
  'tenant_id',
  'name',
  'type',
  'device_type',
  'status',
  'online',
  'confirmed_state',
  'desired_state',
  'last_seen',
  'last_seen_at',
  'updated_at',
  'location',
  'gateway_id',
  'battery_voltage',
  'rssi',
  'metadata',
].join(', ')

function getMissingDevicesColumn(message: string | undefined): string | null {
  const text = String(message ?? '')
  const direct = text.match(/column\s+devices\.([a-zA-Z0-9_]+)\s+does not exist/i)
  if (direct?.[1]) return direct[1]
  const schemaCache = text.match(/'([a-zA-Z0-9_]+)'\s+column\s+of\s+'devices'/i)
  if (schemaCache?.[1]) return schemaCache[1]
  return null
}

async function selectDevicesResilient(): Promise<{ data: Device[] | null; error: string | null }> {
  if (!supabase) return { data: [], error: null }

  const baseColumns = [
    'id',
    'tenant_id',
    'name',
    'type',
    'device_type',
    'status',
    'online',
    'confirmed_state',
    'desired_state',
    'last_seen',
    'last_seen_at',
    'last_heartbeat',
    'updated_at',
    'location',
    'gateway_id',
    'battery_voltage',
    'rssi',
    'metadata',
  ]

  const selected = new Set(baseColumns)

  for (let attempt = 0; attempt < baseColumns.length; attempt++) {
    const selectColumns = Array.from(selected).join(', ')
    const { data, error } = await supabase
      .from('devices')
      .select(selectColumns)
      .order('name')

    if (!error) return { data: (data ?? null) as unknown as Device[] | null, error: null }

    const missingColumn = getMissingDevicesColumn(error.message)
    if (!missingColumn || !selected.has(missingColumn)) {
      return { data: null, error: error.message }
    }

    selected.delete(missingColumn)
  }

  // Final conservative fallback.
  const { data, error } = await supabase
    .from('devices')
    .select(DEVICE_SELECT_COLUMNS_FALLBACK)
    .order('name')

  if (error) return { data: null, error: error.message }
  return { data: (data ?? null) as unknown as Device[] | null, error: null }
}

// ── Type mapping ──────────────────────────────────────────────────────────────

function toDashboardType(dbType: string): DashboardDevice['type'] {
  const map: Record<string, DashboardDevice['type']> = {
    fence_controller: 'fence',
    pump_controller:  'well_pump',
    freezer_alarm:    'freezer',
    freezer_lynk:     'freezer',
    driveway_alarm:   'driveway',
    gateway:          'gateway',
  }
  return map[dbType] ?? 'custom'
}

/**
 * Maps an app-level command_type to the 'command' value the gateway expects.
 * FENCE_TURN_ON  → turn_on
 * FENCE_TURN_OFF → turn_off
 */
export function toGatewayCommand(commandType: string): string {
  const map: Record<string, string> = {
    FENCE_TURN_ON:  'turn_on',
    FENCE_TURN_OFF: 'turn_off',
  }
  return map[commandType] ?? commandType.toLowerCase().replace(/_/g, '_')
}

// ── Device mapping ────────────────────────────────────────────────────────────

// Contactor feedback values that indicate an electrical fault.
const CONTACTOR_FAULT_VALUES = ['FAILED', 'STUCK_ON'] as const
type ContactorFault = typeof CONTACTOR_FAULT_VALUES[number]

function isContactorFault(fb: string): fb is ContactorFault {
  return (CONTACTOR_FAULT_VALUES as readonly string[]).includes(fb)
}

function deviceStatus(row: Device): DashboardDevice['status'] {
  const connection = getDeviceOnlineStatus(row)
  if (!connection.online) return 'offline'

  const dbStatus = String(row.status ?? '').toLowerCase()
  if (dbStatus === 'alarm') return 'critical'
  if (dbStatus === 'low_battery') return 'warning'
  return 'online'
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function freezerTemperatureLabel(meta: Record<string, unknown>): string {
  const existing = meta.temperature
  if (typeof existing === 'string' && existing.trim().length > 0 && existing !== '—') {
    return existing
  }

  const tempF = asFiniteNumber(meta.temperature_f)
  if (tempF !== null) return `${tempF.toFixed(1)}°F`

  const tempC = asFiniteNumber(meta.temperature_c)
  if (tempC !== null) return `${((tempC * 9) / 5 + 32).toFixed(1)}°F`

  return '—'
}

function fenceMeta(row: Device): Record<string, string | number | boolean | null | number[]> {
  const base = (row.metadata ?? {}) as Record<string, string | number | boolean | null | number[]>
  const desired    = (row.desired_state    ?? '').toUpperCase()  // '' | 'ON' | 'OFF'
  const confirmed  = (row.confirmed_state  ?? '').toUpperCase()  // '' | 'ON' | 'OFF'
  const connection = getDeviceOnlineStatus(row)

  // Contactor feedback stored in metadata by the gateway on each ACK / HB.
  const contactorFeedback = (base.contactor_feedback as string | null) ?? '—'

  // Use the physical contactor state when we have reliable aux feedback.
  // CONFIRMED/STUCK_ON = contactor is physically closed (energized).
  // FAILED/OPEN        = contactor is physically open (de-energized).
  // If the device is offline (stale last_seen), assume OFF — the relay is
  // normally-open so it de-energizes when the field node loses power.
  // Anything else      = fall back to the last commanded state from the gateway.
  const chargerPower = (() => {
    if (!connection.online) {
      console.log(
        `[fenceMeta] device=${row.id} last_seen=${row.last_seen ?? 'null'} — treating charger_power as OFF (stale)`,
      )
      return 'OFF'
    }
    if (contactorFeedback === 'CONFIRMED' || contactorFeedback === 'STUCK_ON') return 'ON'
    if (contactorFeedback === 'FAILED'    || contactorFeedback === 'OPEN')     return 'OFF'
    return confirmed || desired || '—'
  })()

  return {
    ...base,
    charger_power:       chargerPower,
    relay_feedback:      confirmed || '—',
    last_command:        desired   || '—',
    contactor_feedback:  contactorFeedback,
    command_status:      (base.command_status as string | null) ?? 'idle',
    rssi:                row.rssi ?? null,
  }
}

type FreezerReadingRow = {
  device_id: string
  temperature_f: number
  battery_percent: number | null
  battery_voltage: number | null
  created_at: string
}

type FreezerSettingRow = {
  device_id: string
  temp_warning_high_f: number
  temp_alarm_high_f: number
}

function freezerStatusLabel(deviceStatusValue: DashboardDevice['status'], freezerState?: string | null): 'Normal' | 'Warning' | 'Critical' {
  if (deviceStatusValue === 'critical' || freezerState === 'alarm') return 'Critical'
  if (deviceStatusValue === 'warning' || freezerState === 'warning') return 'Warning'
  return 'Normal'
}

async function withFreezerMetadata(rows: Device[]): Promise<Device[]> {
  if (!supabase) return rows

  const freezerIds = rows
    .filter((row) => {
      const dbType = (row.device_type ?? row.type ?? '').toLowerCase()
      return dbType === 'freezer_lynk' || dbType === 'freezer_alarm'
    })
    .map((row) => row.id)

  if (freezerIds.length === 0) return rows

  const [readingsRes, settingsRes] = await Promise.all([
    supabase
      .from('freezer_temperature_logs')
      .select('device_id, temperature_f, battery_percent, battery_voltage, created_at')
      .in('device_id', freezerIds)
      .order('created_at', { ascending: false })
      .limit(Math.max(24 * freezerIds.length, 24)),
    supabase
      .from('freezer_lynk_settings')
      .select('device_id, temp_warning_high_f, temp_alarm_high_f')
      .in('device_id', freezerIds),
  ])

  const latestByDevice = new Map<string, FreezerReadingRow>()
  const trendByDevice = new Map<string, number[]>()

  if (readingsRes.data) {
    for (const raw of readingsRes.data as unknown as FreezerReadingRow[]) {
      if (!latestByDevice.has(raw.device_id)) latestByDevice.set(raw.device_id, raw)
      const arr = trendByDevice.get(raw.device_id) ?? []
      if (arr.length < 16) arr.push(Number(raw.temperature_f))
      trendByDevice.set(raw.device_id, arr)
    }
  }

  const settingsByDevice = new Map<string, FreezerSettingRow>()
  if (settingsRes.data) {
    for (const raw of settingsRes.data as unknown as FreezerSettingRow[]) {
      settingsByDevice.set(raw.device_id, raw)
    }
  }

  return rows.map((row) => {
    if (!freezerIds.includes(row.id)) return row

    const latest = latestByDevice.get(row.id)
    const settings = settingsByDevice.get(row.id)
    const meta = (row.metadata ?? {}) as Record<string, unknown>
    const state = String(meta.freezer_state ?? '').toLowerCase() || null
    const status = deviceStatus(row)
    const statusLabel = freezerStatusLabel(status, state)

    return {
      ...row,
      metadata: {
        ...meta,
        temperature: latest ? `${Number(latest.temperature_f).toFixed(1)}°F` : freezerTemperatureLabel(meta),
        temperature_f: latest?.temperature_f ?? (meta.temperature_f as number | undefined) ?? null,
        battery_percent: latest?.battery_percent ?? (meta.battery_percent as number | undefined) ?? null,
        battery_voltage: latest?.battery_voltage ?? (meta.battery_voltage as number | undefined) ?? null,
        warning_high_f: settings?.temp_warning_high_f ?? (meta.warning_high_f as number | undefined) ?? 5,
        alarm_high_f: settings?.temp_alarm_high_f ?? (meta.alarm_high_f as number | undefined) ?? 10,
        safe_range: `Below ${(settings?.temp_warning_high_f ?? 5).toFixed(0)}°F`,
        updated: latest?.created_at ?? (meta.updated as string | undefined) ?? row.last_seen,
        freezer_state: state ?? (statusLabel === 'Critical' ? 'alarm' : statusLabel === 'Warning' ? 'warning' : 'ok'),
        trend_points: (trendByDevice.get(row.id) ?? []).slice().reverse(),
      },
    }
  })
}

export function mapDevice(row: Device): DashboardDevice {
  const type = toDashboardType(String(row.device_type ?? row.type ?? ''))
  const isFreezerLynk = type === 'freezer'
  // Freezer Lynk devices are managed by freezer-offline-monitor which sets
  // devices.online authoritatively. Trust it directly instead of re-computing
  // from last_seen timestamp (which would always show offline between sleep cycles).
  const connection = getDeviceOnlineStatus({ ...row, trustOnlineField: isFreezerLynk })
  const baseMeta = type === 'fence' ? fenceMeta(row)
    : ((row.metadata ?? {}) as Record<string, string | number | boolean | null | number[]>)

  const meta = (() => {
    if (type !== 'freezer') return baseMeta
    const freezerMeta = { ...baseMeta } as Record<string, string | number | boolean | null | number[]>
    const normalized = freezerTemperatureLabel(freezerMeta as Record<string, unknown>)
    freezerMeta.temperature = normalized
    return freezerMeta
  })()

  // A fence device can be online (comms OK) but electrically faulted.
  let status = deviceStatus(row)
  if (type === 'fence' && status === 'online') {
    const fb = String(meta.contactor_feedback ?? '')
    if (fb === 'STUCK_ON') status = 'critical'
    else if (fb === 'FAILED') status = 'warning'
  }

  return {
    id:         row.id,
    tenant_id:  row.tenant_id ?? '',
    name:       row.name,
    type,
    location:   row.location ?? undefined,
    enabled:    true,
    sort_order: 0,
    pinned:     type === 'fence',
    status,
    online: connection.online,
    confirmed_state: row.confirmed_state ?? null,
    desired_state: row.desired_state ?? null,
    // Always use last_seen as the primary heartbeat timestamp.
    // last_seen_at and last_heartbeat are fallbacks for legacy rows only.
    last_seen:  row.last_seen ?? row.last_seen_at ?? row.last_heartbeat ?? row.updated_at ?? new Date().toISOString(),
    last_heartbeat: row.last_heartbeat ?? null,
    updated_at: row.updated_at,
    metadata:   meta,
  }
}

// ── Overview builder ──────────────────────────────────────────────────────────

export function buildOverview(devices: DashboardDevice[]): DashboardOverview {
  const fence = devices.find((d) => d.type === 'fence')
  const freezer = devices.find((d) => d.type === 'freezer')
  const anyOnline = devices.some((d) => d.status !== 'offline')
  const now = new Date().toISOString()

  const fencePower = (
    String(fence?.metadata.charger_power ?? 'OFF').toUpperCase() === 'ON' ? 'ON' : 'OFF'
  ) as 'ON' | 'OFF'

  const fenceConfirmed = String(fence?.metadata.relay_feedback ?? '').toUpperCase()
  const fenceContactor = String(fence?.metadata.contactor_feedback ?? fenceConfirmed).toUpperCase()
  const fenceAuxRaw    = String(fence?.metadata.aux_raw ?? '')

  const fenceFeedback = ((): DashboardOverview['fenceLine']['feedback'] => {
    if (fenceContactor === 'CONFIRMED') return 'Contactor confirmed ON'
    if (fenceContactor === 'OPEN')      return 'Contactor confirmed OFF'
    if (fenceContactor === 'FAILED')    return 'Contactor confirmed OFF'
    if (fenceContactor === 'STUCK_ON')  return 'Contactor confirmed ON'
    if (fenceConfirmed === 'ON')        return 'Contactor confirmed ON'
    if (fenceConfirmed === 'OFF')       return 'Contactor confirmed OFF'
    return 'Awaiting confirmation'
  })()

  const fenceLastCmd = (String(fence?.metadata.last_command ?? 'OFF').toUpperCase()) as 'ON' | 'OFF' | 'TEST'

  const fenceVerificationNote = (() => {
    if (fenceContactor === 'FAILED')    return 'Fault: Contactor failed to engage'
    if (fenceContactor === 'STUCK_ON')  return 'Fault: Contactor stuck on'
    if (fenceContactor === 'CONFIRMED') return 'Aux contact confirmed contactor engaged.'
    if (fenceContactor === 'OPEN')      return 'Aux contact confirmed contactor open.'
    if (!fenceAuxRaw)                   return 'Aux feedback not verified — no raw GPIO data received yet.'
    return 'Auxiliary contact feedback from field node.'
  })()

  return {
    title: 'Home Overview',
    gatewayStatus:   anyOnline ? 'online' : 'offline',
    networkStrength: anyOnline ? 'Strong' : 'Offline',
    weatherQuick:    '—',
    systemHealth:    fence?.status === 'critical' ? 'alert'
                   : fence?.status === 'warning'  ? 'degraded'
                   : fence?.status === 'online'   ? 'operational' : 'degraded',
    lastUpdated: now,
    fenceLine: {
      chargerPower:     fencePower,
      fieldNode:        fence ? (isDeviceOnline(fence) ? 'Online' : 'Offline') : 'Offline',
      lastCommand:      fenceLastCmd,
      feedback:         fenceFeedback,
      verificationNote: fenceVerificationNote,
      auxRaw:           fenceAuxRaw,
      commandStatus:    String(fence?.metadata.command_status ?? 'idle'),
    },
    // Placeholder stubs — replaced when those devices are installed
    wellPump: {
      pumpPower:        'OFF',
      runtime:          '—',
      fieldNode:        'Offline',
      feedback:         'Awaiting confirmation',
      alertState:       'Normal',
      thresholdMinutes: 60,
    },
    freezer: {
      temperature:      freezer ? freezerTemperatureLabel(freezer.metadata as Record<string, unknown>) : '—',
      state:            String((freezer?.metadata.freezer_state ?? '')).toLowerCase() === 'alarm'
        ? 'Critical'
        : String((freezer?.metadata.freezer_state ?? '')).toLowerCase() === 'warning'
          ? 'Warning'
          : freezer?.status === 'critical'
            ? 'Critical'
            : freezer?.status === 'warning'
              ? 'Warning'
              : 'Normal',
      safeRange:        `Warn > ${String(freezer?.metadata.warning_high_f ?? 5)}°F · Alarm > ${String(freezer?.metadata.alarm_high_f ?? 10)}°F`,
      node:             freezer && isDeviceOnline(freezer) ? 'Online' : 'Offline',
      healthLabel:      (() => {
        if (!freezer) return 'Missing'
        const tempState = String(freezer.metadata.freezer_state ?? '').toLowerCase()
        if (tempState === 'alarm') return 'Alarm'
        if (tempState === 'warning') return 'Warning'
        const health = String(freezer.metadata.connection_health ?? '').toLowerCase()
        if (health === 'missing') return 'Missing'
        if (health === 'delayed') return 'Delayed'
        if (health === 'healthy') return 'Healthy'
        // Fallback: trust devices.online when no health metadata yet
        return freezer.online ? 'Healthy' : 'Missing'
      })() as 'Healthy' | 'Delayed' | 'Missing' | 'Warning' | 'Alarm',
      lastUpdatedLabel: String(freezer?.metadata.updated ?? '—'),
    },
    drivewayAlarm: {
      status:       'Node Offline',
      lastTriggered: '—',
      node:         'Offline',
    },
    weather: {
      temperature: '—',
      summary:     '—',
    },
    system: {
      queueDepth:           0,
      awaitingConfirmations: 0,
      lastCommand:          fence ? `Fence ${fenceLastCmd}` : 'None',
    },
  }
}

// ── Contactor fault alert generation ─────────────────────────────────────────

/**
 * Generates synthetic client-side alerts for contactor fault states.
 * Deduplicates by device id + fault type so only one active alert per fault.
 * These supplement DB-sourced alerts — they do not write to Supabase.
 */
export function generateContactorAlerts(
  devices: DashboardDevice[],
  existingAlerts: AlertRecord[],
): AlertRecord[] {
  const synthetic: AlertRecord[] = []

  for (const device of devices) {
    if (device.type !== 'fence') continue
    const ageMs = device.last_seen ? Date.now() - new Date(device.last_seen).getTime() : Infinity
    if (ageMs >= OFFLINE_TIMEOUT_MS) continue
    const fb = String(device.metadata.contactor_feedback ?? '').toUpperCase()
    if (!isContactorFault(fb as ContactorFault)) continue

    // Suppress fault alerts while a command is being verified — physical state
    // may not have settled yet and a false alert would be confusing.
    const cmdStatus = String(device.metadata.command_status ?? 'idle')
    if (cmdStatus === 'verifying' || cmdStatus === 'sent' || cmdStatus === 'acknowledged') continue

    const alertType = fb === 'STUCK_ON' ? 'fence_contactor_stuck_on' : 'fence_contactor_failed'

    // Skip if a matching active alert already exists (DB-sourced or already synthetic)
    const alreadyActive = existingAlerts.some(
      (a) => a.device_id === device.id && a.type === alertType && !a.resolved_at,
    )
    if (alreadyActive) continue

    synthetic.push({
      id:             `synth-${device.id}-${alertType}`,
      device_id:      device.id,
      type:           alertType,
      severity:       fb === 'STUCK_ON' ? 'critical' : 'warning',
      message:        fb === 'STUCK_ON'
        ? 'Fence was commanded off, but the auxiliary contact still reports the contactor engaged.'
        : 'Fence command was sent, but the auxiliary contact did not confirm the contactor engaged.',
      acknowledged:   false,
      silenced_until: null,
      created_at:     new Date().toISOString(),
      resolved_at:    null,
    })
  }

  // If the fence is online (fresh last_seen) but has never sent aux_raw, generate a "feedback unknown" notice.
  for (const device of devices) {
    if (device.type !== 'fence') continue
    // Use freshness of last_seen to determine if the device is reachable.
    const ageMs = device.last_seen ? Date.now() - new Date(device.last_seen).getTime() : Infinity
    if (ageMs >= OFFLINE_TIMEOUT_MS) continue  // device is stale — no alert needed
    const auxRaw = String(device.metadata.aux_raw ?? '')
    if (auxRaw) continue  // aux_raw present — no warning needed
    const warnId = `synth-${device.id}-aux_raw_missing`
    const alreadyActive = existingAlerts.some(
      (a) => a.id === warnId && !a.resolved_at,
    )
    if (alreadyActive) continue
    synthetic.push({
      id:             warnId,
      device_id:      device.id,
      type:           'fence_aux_feedback_unknown',
      severity:       'warning',
      message:        'Aux contact feedback (GPIO34) has not been received yet. Contactor state cannot be independently verified.',
      acknowledged:   false,
      silenced_until: null,
      created_at:     new Date().toISOString(),
      resolved_at:    null,
    })
  }

  return synthetic
}

// ── Public data functions ─────────────────────────────────────────────────────

export async function getLiveDevices(): Promise<DashboardDevice[]> {
  if (!supabase) return []
  const { data, error } = await selectDevicesResilient()

  if (error || !data) {
    console.error('getLiveDevices:', error)
    return []
  }
  const enriched = await withFreezerMetadata(data as unknown as Device[])
  return enriched.map(mapDevice)
}

export async function getLiveAlerts(): Promise<AlertRecord[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('alerts')
    .select('*')
    .is('resolved_at', null)
    .not('status', 'in', '("acknowledged","silenced")')
    .order('created_at', { ascending: false })
  if (error || !data) {
    console.error('getLiveAlerts:', error?.message)
    return []
  }
  return (data as Record<string, unknown>[]).map((row) => ({
    id:            String(row.id),
    device_id:     String(row.device_id ?? ''),
    type:          String(row.severity ?? 'info'),
    message:       String(row.message ?? ''),
    severity:      (row.severity ?? 'info') as AlertRecord['severity'],
    acknowledged:  row.status === 'acknowledged',
    silenced_until: (row.silenced_until as string | null) ?? null,
    created_at:    String(row.created_at),
    resolved_at:   (row.resolved_at as string | null) ?? null,
  }))
}

export async function getLiveDashboard(): Promise<{
  overview: DashboardOverview
  devices:  DashboardDevice[]
  alerts:   AlertRecord[]
}> {
  const [devices, dbAlerts] = await Promise.all([getLiveDevices(), getLiveAlerts()])
  const contactorAlerts = generateContactorAlerts(devices, dbAlerts)
  const alerts = [...contactorAlerts, ...dbAlerts]
  return { overview: buildOverview(devices), devices, alerts }
}

export async function createLiveCommand(
  input: CreateCommandInput,
  options?: { clientCommandId?: string },
): Promise<{ command: CommandRecord | null; error: string | null }> {
  if (!supabase) return { command: null, error: 'Supabase not configured.' }

  let insertPayload: Record<string, unknown> = {
    device_id: input.target_device_id,
    command:   toGatewayCommand(input.command_type),
    status:    'pending',
    client_command_id: options?.clientCommandId ?? null,
  }

  let { data, error } = await supabase
    .from('device_commands')
    .insert(insertPayload)
    .select('*')
    .single()

  // Backward compatibility: older DBs may not have client_command_id yet.
  if (error && /client_command_id|column .* does not exist|schema cache/i.test(error.message ?? '')) {
    insertPayload = {
      device_id: input.target_device_id,
      command:   toGatewayCommand(input.command_type),
      status:    'pending',
    }

    const retry = await supabase
      .from('device_commands')
      .insert(insertPayload)
      .select('*')
      .single()

    data = retry.data
    error = retry.error
  }

  if (error) return { command: null, error: error.message }

  const row = data as Record<string, unknown>
  const record: CommandRecord = {
    id:               String(row.id),
    target_device_id: String(row.device_id),
    command_type:     input.command_type,
    payload:          (input.payload ?? {}) as Record<string, string | number | boolean>,
    status:           String(row.status ?? 'pending') as CommandRecord['status'],
    requested_by:     input.requested_by ?? 'dashboard',
    created_at:       String(row.created_at),
    sent_at:          null,
    acknowledged_at:  (row.acknowledged_at as string | null) ?? null,
    confirmed_at:     (row.confirmed_at as string | null) ?? null,
    failure_reason:   (row.failure_reason as string | null) ?? null,
  }
  return { command: record, error: null }
}

export function subscribeToCommandStatus(
  commandId: string,
  onUpdate: (command: CommandRecord) => void,
): () => void {
  if (!supabase) return () => {}

  const channel = supabase
    .channel(`device-command-${commandId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'device_commands',
        filter: `id=eq.${commandId}`,
      },
      (payload) => {
        if (payload.eventType === 'DELETE') return
        const row = payload.new as Record<string, unknown>
        const rawCmd = String(row.command ?? row.command_type ?? '').toLowerCase()
        const mappedType: CommandRecord['command_type'] =
          rawCmd === 'turn_on' ? 'FENCE_TURN_ON'
          : rawCmd === 'turn_off' ? 'FENCE_TURN_OFF'
          : rawCmd === 'fence_turn_on' ? 'FENCE_TURN_ON'
          : rawCmd === 'fence_turn_off' ? 'FENCE_TURN_OFF'
          : 'FENCE_TEST_RELAY'
        const command = {
          id: String(row.id),
          target_device_id: String(row.device_id ?? ''),
          command_type: mappedType,
          payload: (row.payload as Record<string, string | number | boolean>) ?? {},
          status: String(row.status ?? 'pending') as CommandRecord['status'],
          requested_by: 'dashboard',
          created_at: String(row.created_at ?? new Date().toISOString()),
          sent_at: (row.sent_at as string | null) ?? null,
          acknowledged_at: (row.acknowledged_at as string | null) ?? null,
          confirmed_at: (row.confirmed_at as string | null) ?? null,
          failure_reason: (row.failure_reason as string | null) ?? null,
        } satisfies CommandRecord
        onUpdate(command)
      },
    )
    .subscribe()

  return () => { void supabase!.removeChannel(channel) }
}

export async function acknowledgeLiveAlert(alertId: string): Promise<void> {
  if (!supabase) return
  const now = new Date().toISOString()
  await supabase
    .from('alerts')
    .update({ status: 'acknowledged', acknowledged_at: now, resolved_at: now })
    .eq('id', alertId)
}

export async function silenceLiveAlert(alertId: string): Promise<void> {
  if (!supabase) return
  const silencedUntil = new Date(Date.now() + 30 * 60_000).toISOString()
  await supabase
    .from('alerts')
    .update({ status: 'silenced', silenced_until: silencedUntil })
    .eq('id', alertId)
}

export async function clearAllLiveAlerts(alertIds: string[]): Promise<void> {
  if (!supabase || alertIds.length === 0) return
  const now = new Date().toISOString()
  await supabase
    .from('alerts')
    .update({ status: 'acknowledged', acknowledged_at: now, resolved_at: now })
    .in('id', alertIds)
}

// ── Realtime ──────────────────────────────────────────────────────────────────

/**
 * Subscribes to all device changes and calls onUpdate with the mapped device.
 * Returns a cleanup function to unsubscribe.
 */
export function subscribeToDevices(
  onUpdate: (device: DashboardDevice) => void,
): () => void {
  if (!supabase) return () => {}

  const channel = supabase
    .channel('dashboard-devices')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'devices' },
      (payload) => {
        if (payload.eventType !== 'DELETE') {
          onUpdate(mapDevice(payload.new as Device))
        }
      },
    )
    .subscribe()

  return () => { void supabase!.removeChannel(channel) }
}

/**
 * Subscribes to INSERT events on the alerts table.
 * Calls onNew with a mapped AlertRecord whenever a new alert row is inserted.
 * Returns a cleanup function to unsubscribe.
 */
export function subscribeToAlerts(
  onNew: (alert: AlertRecord) => void,
): () => void {
  if (!supabase) return () => {}

  const channel = supabase
    .channel('dashboard-alerts')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'alerts' },
      (payload) => {
        const row = payload.new as Record<string, unknown>
        onNew({
          id:             String(row.id),
          device_id:      String(row.device_id ?? ''),
          type:           String(row.severity ?? 'info'),
          message:        String(row.message ?? ''),
          severity:       (row.severity ?? 'info') as AlertRecord['severity'],
          acknowledged:   row.status === 'acknowledged',
          silenced_until: (row.silenced_until as string | null) ?? null,
          created_at:     String(row.created_at),
          resolved_at:    (row.resolved_at as string | null) ?? null,
        })
      },
    )
    .subscribe()

  return () => { void supabase!.removeChannel(channel) }
}
