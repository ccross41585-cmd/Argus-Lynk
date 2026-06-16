import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface ManifestRequest {
  device_key?: string
  current_version?: string
  channel?: string
  model?: string
}

interface DeviceRow {
  id: string
  device_key: string
  metadata: Record<string, unknown> | null
}

function json(data: unknown, status = 200): Response {
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

function readMetadataString(metadata: Record<string, unknown> | null, key: string): string | null {
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

function parseVersion(v: string): number[] {
  return v
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0))
}

function isVersionGreater(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    const ai = a[i] ?? 0
    const bi = b[i] ?? 0
    if (ai > bi) return true
    if (ai < bi) return false
  }
  return false
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return json({ ok: true })
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Missing Supabase environment variables' }, 500)
  }

  const body = await req.json().catch(() => ({})) as ManifestRequest
  const deviceKey = body.device_key?.trim()
  if (!deviceKey) return json({ error: 'device_key is required' }, 400)

  const currentVersion = body.current_version?.trim() || '0.0.0'
  const requestedChannel = body.channel?.trim().toLowerCase() === 'beta' ? 'beta' : 'stable'
  const model = body.model?.trim() || 'freezer_lynk_wifi_mvp'

  const serviceClient = createClient(supabaseUrl, serviceKey)
  const { data: device, error: deviceErr } = await serviceClient
    .from('devices')
    .select('id, device_key, metadata')
    .eq('device_key', deviceKey)
    .maybeSingle()

  if (deviceErr) return json({ error: deviceErr.message }, 500)
  if (!device) return json({ error: 'Unknown device' }, 401)

  const typedDevice = device as DeviceRow
  const configuredToken = readMetadataString(typedDevice.metadata, 'telemetry_token')
  const bearer = extractBearerToken(req)

  if (configuredToken && bearer !== configuredToken) {
    return json({ error: 'Unauthorized' }, 401)
  }

  const metadataChannel = readMetadataString(typedDevice.metadata, 'update_channel')
  const channel = metadataChannel === 'beta' ? 'beta' : requestedChannel
  const upper = channel.toUpperCase()

  const latestVersion = Deno.env.get(`FREEZER_FIRMWARE_${upper}_VERSION`)?.trim() || ''
  const firmwareUrl = Deno.env.get(`FREEZER_FIRMWARE_${upper}_URL`)?.trim() || ''
  const firmwareSha256 = Deno.env.get(`FREEZER_FIRMWARE_${upper}_SHA256`)?.trim() || null
  const minBatteryPercent = Number.parseInt(Deno.env.get('FREEZER_FIRMWARE_MIN_BATTERY_PERCENT') ?? '20', 10)

  if (!latestVersion || !firmwareUrl) {
    return json({
      update: false,
      reason: 'manifest_not_configured',
      channel,
      current_version: currentVersion,
      model,
    })
  }

  const needsUpdate = isVersionGreater(latestVersion, currentVersion)

  if (!needsUpdate) {
    return json({
      update: false,
      reason: 'up_to_date',
      channel,
      current_version: currentVersion,
      latest_version: latestVersion,
      model,
    })
  }

  return json({
    update: true,
    channel,
    model,
    current_version: currentVersion,
    latest_version: latestVersion,
    firmware_url: firmwareUrl,
    firmware_sha256: firmwareSha256,
    min_battery_percent: Number.isFinite(minBatteryPercent) ? minBatteryPercent : 20,
    force: false,
  })
})
