import type {
  AlertRecord,
  CommandRecord,
  CreateCommandInput,
  DashboardDevice,
  DashboardOverview,
  DeviceStatusRecord,
} from '../types/dashboard'

function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

function minutesFromNow(minutes: number) {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

const tenantId = 'lynk-farm-001'

const overview: DashboardOverview = {
  title: 'Home Overview',
  gatewayStatus: 'online',
  networkStrength: 'Strong',
  weatherQuick: '87°F',
  systemHealth: 'degraded',
  lastUpdated: new Date().toISOString(),
  fenceLine: {
    chargerPower: 'ON',
    fieldNode: 'Online',
    lastCommand: 'ON',
    feedback: 'Contactor confirmed ON',
    verificationNote: 'Fence charge verification requires inline voltage sensing.',
    auxRaw: '',
    commandStatus: 'idle',
  },
  wellPump: {
    pumpPower: 'ON',
    runtime: '12 min 47 sec',
    fieldNode: 'Online',
    feedback: 'Contactor confirmed ON',
    alertState: 'Long Run Alert',
    thresholdMinutes: 60,
  },
  freezer: {
    temperature: '2.4°F',
    state: 'Normal',
    safeRange: 'Safe range -10°F to 5°F',
    node: 'Online',
    lastUpdatedLabel: '1 min ago',
  },
  drivewayAlarm: {
    status: 'Clear',
    lastTriggered: '10:36 AM',
    node: 'Online',
  },
  weather: {
    temperature: '87°F',
    summary: 'Partly Cloudy',
  },
  system: {
    queueDepth: 2,
    awaitingConfirmations: 1,
    lastCommand: 'Well pump runtime alert pending operator decision.',
  },
}

const devices: DashboardDevice[] = [
  {
    id: 'gateway-home-base',
    tenant_id: tenantId,
    name: 'Home Base Gateway',
    type: 'gateway',
    location: 'Main House',
    enabled: true,
    sort_order: 0,
    status: 'online',
    last_seen: new Date().toISOString(),
    metadata: { firmware: 'gateway-mvp', uplink: 'wifi', nodes_online: 5 },
  },
  {
    id: 'fence-line-1',
    tenant_id: tenantId,
    name: 'North Fence Controller',
    type: 'fence',
    location: 'North Pasture',
    enabled: true,
    sort_order: 1,
    pinned: true,
    status: 'online',
    last_seen: new Date().toISOString(),
    metadata: { charger_power: 'ON', relay_feedback: 'ON', last_command: 'ON' },
  },
  {
    id: 'well-pump-1',
    tenant_id: tenantId,
    name: 'House Well Pump',
    type: 'well_pump',
    location: 'Well House',
    enabled: true,
    sort_order: 2,
    pinned: true,
    status: 'warning',
    last_seen: new Date().toISOString(),
    metadata: { runtime: '12 min 47 sec', relay_feedback: 'ON', alert_state: 'Long Run Alert' },
  },
  {
    id: 'freezer-1',
    tenant_id: tenantId,
    name: 'Shop Freezer',
    type: 'freezer',
    location: 'Shop Building',
    enabled: true,
    sort_order: 3,
    status: 'online',
    last_seen: new Date().toISOString(),
    metadata: { temperature: '2.4°F', safe_range: '-10°F to 5°F', updated: '1 min ago' },
  },
  {
    id: 'weather-1',
    tenant_id: tenantId,
    name: 'Farm Weather Station',
    type: 'weather',
    location: 'Open Field',
    enabled: true,
    sort_order: 4,
    status: 'online',
    last_seen: new Date().toISOString(),
    metadata: { summary: 'Partly Cloudy', temperature: '87°F' },
  },
  {
    id: 'driveway-1',
    tenant_id: tenantId,
    name: 'Front Gate Alarm',
    type: 'driveway',
    location: 'Front Entrance',
    enabled: true,
    sort_order: 5,
    status: 'online',
    last_seen: new Date().toISOString(),
    metadata: { status: 'Clear', last_triggered: '10:36 AM', battery: null },
  },
]

const deviceStatuses: DeviceStatusRecord[] = [
  {
    id: 'status-well-runtime',
    device_id: 'well-pump-1',
    status_key: 'runtime',
    value: '12:47',
    unit: 'mm:ss',
    severity: 'warning',
    created_at: new Date().toISOString(),
  },
  {
    id: 'status-freezer-temp',
    device_id: 'freezer-1',
    status_key: 'temperature',
    value: '2.4',
    unit: 'F',
    severity: 'info',
    created_at: new Date().toISOString(),
  },
  {
    id: 'status-driveway-state',
    device_id: 'driveway-1',
    status_key: 'state',
    value: 'clear',
    unit: null,
    severity: 'info',
    created_at: new Date().toISOString(),
  },
]

const alerts: AlertRecord[] = [
  {
    id: 'alert-well-runtime',
    device_id: 'well-pump-1',
    type: 'well_pump_long_runtime',
    message: 'Well Pump — Long Run Time',
    severity: 'warning',
    acknowledged: false,
    silenced_until: null,
    created_at: new Date(Date.now() - 12 * 60_000).toISOString(),
    resolved_at: null,
  },
  {
    id: 'alert-driveway-motion',
    device_id: 'driveway-1',
    type: 'driveway_motion',
    message: 'Driveway Alarm — Motion Detected',
    severity: 'info',
    acknowledged: false,
    silenced_until: null,
    created_at: new Date(Date.now() - 8 * 60_000).toISOString(),
    resolved_at: null,
  },
]

const commands: CommandRecord[] = []

export async function getDashboardStatus() {
  return cloneValue(overview)
}

export async function getDevices() {
  return cloneValue(devices)
}

export async function getDeviceById(id: string) {
  return cloneValue(devices.find((d) => d.id === id) ?? null)
}

export async function getDeviceStatuses() {
  return cloneValue(deviceStatuses)
}

export async function getAlerts() {
  return cloneValue(alerts)
}

export async function getAlertById(id: string) {
  return cloneValue(alerts.find((a) => a.id === id) ?? null)
}

export async function createCommand(input: CreateCommandInput) {
  const command: CommandRecord = {
    id: `cmd-${commands.length + 1}`,
    target_device_id: input.target_device_id,
    command_type: input.command_type,
    payload: input.payload,
    status: 'pending',
    requested_by: input.requested_by,
    created_at: new Date().toISOString(),
    sent_at: null,
    acknowledged_at: null,
    confirmed_at: null,
    failure_reason: null,
  }

  commands.unshift(command)
  overview.lastUpdated = new Date().toISOString()
  overview.system.queueDepth = Math.max(1, commands.filter((item) => item.status === 'pending').length)
  overview.system.lastCommand = `${input.command_type} queued from tablet dashboard.`

  if (input.command_type === 'WELL_PUMP_EXTEND_RUNTIME') {
    const longRunAlert = alerts.find((alert) => alert.type === 'well_pump_long_runtime' && !alert.resolved_at)
    if (longRunAlert) {
      longRunAlert.acknowledged = true
      longRunAlert.silenced_until = minutesFromNow(45)
    }
  }

  if (input.command_type === 'WELL_PUMP_SILENCE_ALERT') {
    const longRunAlert = alerts.find((alert) => alert.type === 'well_pump_long_runtime' && !alert.resolved_at)
    if (longRunAlert) {
      longRunAlert.silenced_until = minutesFromNow(30)
    }
  }

  if (input.command_type === 'FENCE_TURN_ON') {
    overview.fenceLine.lastCommand = 'ON'
  }

  if (input.command_type === 'FENCE_TURN_OFF') {
    overview.fenceLine.lastCommand = 'OFF'
  }

  if (input.command_type === 'FENCE_TEST_RELAY') {
    overview.fenceLine.lastCommand = 'TEST'
  }

  return cloneValue(command)
}

export async function acknowledgeAlert(alertId: string) {
  const alert = alerts.find((item) => item.id === alertId)
  if (alert) {
    alert.acknowledged = true
  }
}

export async function silenceAlert(alertId: string) {
  const alert = alerts.find((item) => item.id === alertId)
  if (alert) {
    alert.silenced_until = minutesFromNow(30)
  }

  return cloneValue(alert)
}