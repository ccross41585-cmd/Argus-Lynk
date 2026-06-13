export const ONLINE_TIMEOUT_MS = 2 * 60 * 1000

export type DeviceOnlineInput = {
  online?: boolean | null
  last_seen?: string | null
  lastSeen?: string | null
  last_heartbeat?: string | null
  lastHeartbeat?: string | null
  updated_at?: string | null
}

export type DeviceOnlineStatus = {
  online: boolean
  label: 'ONLINE' | 'OFFLINE'
  lastSeenMs: number
  ageMs: number | null
}

function parseTimestampMs(value: unknown): number {
  if (typeof value !== 'string' || value.trim().length === 0) return 0
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : 0
}

export function getDeviceOnlineStatus(device: DeviceOnlineInput): DeviceOnlineStatus {
  const now = Date.now()

  const lastSeenRaw =
    device.last_seen ??
    device.lastSeen ??
    device.last_heartbeat ??
    device.lastHeartbeat ??
    device.updated_at ??
    null

  const lastSeenMs = parseTimestampMs(lastSeenRaw)

  const online =
    Boolean(device.online) ||
    (lastSeenMs > 0 && now - lastSeenMs < ONLINE_TIMEOUT_MS)

  return {
    online,
    label: online ? 'ONLINE' : 'OFFLINE',
    lastSeenMs,
    ageMs: lastSeenMs ? now - lastSeenMs : null,
  }
}
