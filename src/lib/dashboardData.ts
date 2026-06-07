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
import type {
  AlertRecord,
  CommandRecord,
  CreateCommandInput,
  DashboardDevice,
  DashboardOverview,
} from '../types/dashboard'
import type { Device } from '../types/domain'

// ── Type mapping ──────────────────────────────────────────────────────────────

function toDashboardType(dbType: string): DashboardDevice['type'] {
  const map: Record<string, DashboardDevice['type']> = {
    fence_controller: 'fence',
    pump_controller:  'well_pump',
    freezer_alarm:    'freezer',
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
  return row.online ? 'online' : 'offline'
}

function fenceMeta(row: Device): Record<string, string | number | boolean | null> {
  const base = (row.metadata ?? {}) as Record<string, string | number | boolean | null>
  const desired    = (row.desired_state    ?? '').toUpperCase()  // '' | 'ON' | 'OFF'
  const confirmed  = (row.confirmed_state  ?? '').toUpperCase()  // '' | 'ON' | 'OFF'

  // Contactor feedback stored in metadata by the gateway on each ACK / HB.
  const contactorFeedback = (base.contactor_feedback as string | null) ?? '—'

  // Use the physical contactor state when we have reliable aux feedback.
  // CONFIRMED/STUCK_ON = contactor is physically closed (energized).
  // FAILED/OPEN        = contactor is physically open (de-energized).
  // Anything else      = fall back to the last commanded state from the gateway.
  const chargerPower = (() => {
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
    rssi:                row.rssi ?? null,
  }
}

export function mapDevice(row: Device): DashboardDevice {
  const type = toDashboardType(row.type)
  const meta = type === 'fence' ? fenceMeta(row)
    : ((row.metadata ?? {}) as Record<string, string | number | boolean | null>)

  // A fence device can be online (comms OK) but electrically faulted.
  let status = deviceStatus(row)
  if (type === 'fence' && status === 'online') {
    const fb = String(meta.contactor_feedback ?? '')
    if (fb === 'STUCK_ON') status = 'critical'
    else if (fb === 'FAILED') status = 'warning'
  }

  return {
    id:         row.id,
    tenant_id:  '',
    name:       row.name,
    type,
    enabled:    true,
    sort_order: 0,
    pinned:     type === 'fence',
    status,
    last_seen:  row.last_seen ?? new Date().toISOString(),
    metadata:   meta,
  }
}

// ── Overview builder ──────────────────────────────────────────────────────────

export function buildOverview(devices: DashboardDevice[]): DashboardOverview {
  const fence = devices.find((d) => d.type === 'fence')
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
      fieldNode:        fence ? (fence.status !== 'offline' ? 'Online' : 'Offline') : 'Offline',
      lastCommand:      fenceLastCmd,
      feedback:         fenceFeedback,
      verificationNote: fenceVerificationNote,
      auxRaw:           fenceAuxRaw,
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
      temperature:     '—',
      state:           'Normal',
      safeRange:       '—',
      node:            'Offline',
      lastUpdatedLabel: '—',
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
    const fb = String(device.metadata.contactor_feedback ?? '').toUpperCase()
    if (!isContactorFault(fb as ContactorFault)) continue

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

  // If the fence is online but has never sent aux_raw, generate a "feedback unknown" notice.
  for (const device of devices) {
    if (device.type !== 'fence' || device.status === 'offline') continue
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
  const { data, error } = await supabase
    .from('devices')
    .select('*')
    .order('name')
  if (error || !data) {
    console.error('getLiveDevices:', error?.message)
    return []
  }
  return (data as Device[]).map(mapDevice)
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
): Promise<{ command: CommandRecord | null; error: string | null }> {
  if (!supabase) return { command: null, error: 'Supabase not configured.' }

  const { data, error } = await supabase
    .from('device_commands')
    .insert({
      device_id: input.target_device_id,
      command:   toGatewayCommand(input.command_type),
      status:    'pending',
    })
    .select('*')
    .single()

  if (error) return { command: null, error: error.message }

  const row = data as Record<string, unknown>
  const record: CommandRecord = {
    id:               String(row.id),
    target_device_id: String(row.device_id),
    command_type:     input.command_type,
    payload:          (input.payload ?? {}) as Record<string, string | number | boolean>,
    status:           'pending',
    requested_by:     input.requested_by ?? 'dashboard',
    created_at:       String(row.created_at),
    sent_at:          null,
    acknowledged_at:  null,
    confirmed_at:     null,
    failure_reason:   null,
  }
  return { command: record, error: null }
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
