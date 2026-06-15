export type DashboardTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

export type SystemHealth = 'operational' | 'degraded' | 'alert'

export type DashboardDeviceType =
  | 'gateway'
  | 'fence'
  | 'well_pump'
  | 'freezer'
  | 'weather'
  | 'driveway'
  | 'relay_node'
  | 'sensor_node'
  | 'custom'

export type DeviceHealthStatus = 'online' | 'offline' | 'warning' | 'critical'

export type AlertSeverity = 'info' | 'warning' | 'critical'

export type CommandStatus = 'pending' | 'sent' | 'acknowledged' | 'confirmed' | 'failed'

export type WellPumpCommandType =
  | 'WELL_PUMP_SHUTOFF'
  | 'WELL_PUMP_RESTART'
  | 'WELL_PUMP_SILENCE_ALERT'
  | 'WELL_PUMP_EXTEND_RUNTIME'

export interface DashboardOverview {
  title: string
  gatewayStatus: 'online' | 'offline'
  networkStrength: 'Strong' | 'Weak' | 'Offline'
  weatherQuick: string
  systemHealth: SystemHealth
  lastUpdated: string
  fenceLine: {
    chargerPower: 'ON' | 'OFF'
    fieldNode: 'Online' | 'Offline'
    lastCommand: 'ON' | 'OFF' | 'TEST'
    feedback: 'Contactor confirmed ON' | 'Contactor confirmed OFF' | 'Awaiting confirmation'
    verificationNote: string
    auxRaw: string   // 'AUX_LOW' | 'AUX_HIGH' | '' (empty = not yet received)
    commandStatus: string  // 'idle' | 'verifying' | 'verified' | 'verification_failed'
  }
  wellPump: {
    pumpPower: 'ON' | 'OFF'
    runtime: string
    fieldNode: 'Online' | 'Offline'
    feedback: 'Contactor confirmed ON' | 'Contactor confirmed OFF' | 'Awaiting confirmation'
    alertState: 'Normal' | 'Long Run Alert'
    thresholdMinutes: number
  }
  freezer: {
    temperature: string
    state: 'Normal' | 'Warning' | 'Critical'
    safeRange: string
    node: 'Online' | 'Offline'
    lastUpdatedLabel: string
  }
  drivewayAlarm: {
    status: 'Clear' | 'Motion Detected' | 'Node Offline'
    lastTriggered: string
    node: 'Online' | 'Offline'
  }
  weather: {
    temperature: string
    summary: string
  }
  system: {
    queueDepth: number
    awaitingConfirmations: number
    lastCommand: string
  }
}

export interface DashboardDevice {
  id: string
  tenant_id: string
  name: string
  type: DashboardDeviceType
  location?: string
  enabled: boolean
  sort_order: number
  pinned?: boolean
  status: DeviceHealthStatus
  online?: boolean
  confirmed_state?: string | null
  desired_state?: string | null
  last_seen: string
  last_heartbeat?: string | null
  updated_at?: string
  metadata: Record<string, string | number | boolean | null | number[]>
}

export interface DeviceStatusRecord {
  id: string
  device_id: string
  status_key: string
  value: string
  unit: string | null
  severity: AlertSeverity
  created_at: string
}

export interface AlertRecord {
  id: string
  device_id: string
  type: string
  message: string
  severity: AlertSeverity
  acknowledged: boolean
  silenced_until: string | null
  created_at: string
  resolved_at: string | null
}

export interface CommandRecord {
  id: string
  target_device_id: string
  command_type:
    | WellPumpCommandType
    | 'FENCE_TURN_ON'
    | 'FENCE_TURN_OFF'
    | 'FENCE_TEST_RELAY'
  payload: Record<string, string | number | boolean>
  status: CommandStatus
  requested_by: string
  created_at: string
  sent_at: string | null
  acknowledged_at: string | null
  confirmed_at: string | null
  failure_reason: string | null
}

export interface CreateCommandInput {
  target_device_id: string
  command_type:
    | WellPumpCommandType
    | 'FENCE_TURN_ON'
    | 'FENCE_TURN_OFF'
    | 'FENCE_TEST_RELAY'
  payload: Record<string, string | number | boolean>
  requested_by: string
}

// ── Push notification types ───────────────────────────────────────────────────

export type PushPermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported'

export interface PushSubscriptionRecord {
  id: string
  tenant_id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
  device_label: string | null
  user_agent: string | null
  enabled: boolean
  created_at: string
  updated_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export interface AlertPreference {
  id: string
  tenant_id: string
  user_id: string
  alert_type: string
  push_enabled: boolean
  in_app_enabled: boolean
  minimum_severity: AlertSeverity
  quiet_hours_enabled: boolean
  quiet_hours_start: string | null
  quiet_hours_end: string | null
  created_at: string
  updated_at: string
}
