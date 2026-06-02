export const DEVICE_TYPES = [
  'fence_controller',
  'freezer_alarm',
  'driveway_alarm',
  'pump_controller',
] as const

export type DeviceType = (typeof DEVICE_TYPES)[number] | (string & {})

export interface Device {
  id: string
  name: string
  type: DeviceType
  gateway_id: string | null
  desired_state: string | null
  confirmed_state: string | null
  online: boolean
  last_seen: string | null
  rssi: number | string | null
  battery_voltage: number | string | null
  updated_at: string
  metadata: Record<string, unknown> | null
}

export interface DeviceCommand {
  id: string
  device_id: string
  gateway_id: string | null
  command: string
  status: string
  created_at: string
  sent_at: string | null
  acknowledged_at: string | null
  error_message: string | null
}

export interface DeviceEvent {
  id: string
  device_id: string
  event_type: string
  message: string
  created_at: string
}