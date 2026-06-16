import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface PairRequest {
  display_name?: string
  location_label?: string
  update_channel?: 'stable' | 'beta'
  factory_id?: string
  device_key?: string
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

function randomHex(size = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

function randomToken(size = 24): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function normalizeChannel(channel: string | undefined): 'stable' | 'beta' {
  return channel?.toLowerCase() === 'beta' ? 'beta' : 'stable'
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingTenantColumnError(message: string | undefined): boolean {
  const text = String(message ?? '').toLowerCase()
  if (!text.includes('tenant_id')) return false
  return text.includes('does not exist') || text.includes('schema cache') || text.includes('could not find the')
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return json({ ok: true })
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !anonKey || !serviceKey) {
      return json({ error: 'Missing Supabase environment variables' }, 500)
    }

    const authHeader = req.headers.get('authorization') ?? req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)

    const userClient = createClient(supabaseUrl, anonKey, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    })

    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData.user) {
      return json({ error: 'Unauthorized' }, 401)
    }

    const body = await req.json().catch(() => ({})) as PairRequest
    const displayName = body.display_name?.trim() || 'Freezer Lynk'
    const location = body.location_label?.trim() || null
    const updateChannel = normalizeChannel(body.update_channel)
    const factoryId = body.factory_id?.trim() || null
    const deviceKey = body.device_key?.trim() || `FL-${randomHex(4)}`
    const telemetryToken = randomToken(24)

    const serviceClient = createClient(supabaseUrl, serviceKey)

    const nowIso = new Date().toISOString()
    const metadata = {
      owner_user_id: userData.user.id,
      owner_location_label: location,
      factory_id: factoryId,
      telemetry_token: telemetryToken,
      update_channel: updateChannel,
      paired_at: nowIso,
    }

    const devicePayload = {
      name: displayName,
      type: 'freezer_lynk',
      device_type: 'freezer_lynk',
      device_key: deviceKey,
      location,
      enabled: true,
      online: false,
      status: 'offline',
      tenant_id: userData.user.id,
      metadata,
    }

    let deviceId: string | null = null

    const firstInsert = await serviceClient
      .from('devices')
      .insert(devicePayload)
      .select('id')
      .single()

    if (firstInsert.error && isMissingTenantColumnError(firstInsert.error.message)) {
      const fallbackInsert = await serviceClient
        .from('devices')
        .insert({ ...devicePayload, tenant_id: undefined })
        .select('id')
        .single()

      if (fallbackInsert.error || !fallbackInsert.data?.id) {
        return json({ error: fallbackInsert.error?.message ?? 'Failed to create device' }, 500)
      }
      deviceId = fallbackInsert.data.id
    } else if (firstInsert.error || !firstInsert.data?.id) {
      return json({ error: firstInsert.error?.message ?? 'Failed to create device' }, 500)
    } else {
      deviceId = firstInsert.data.id
    }

    const { error: settingsErr } = await serviceClient
      .from('freezer_lynk_settings')
      .upsert({
        device_id: deviceId,
        enabled: true,
      })

    if (settingsErr) {
      return json({ error: settingsErr.message }, 500)
    }

    const telemetryUrl = `${supabaseUrl}/functions/v1/freezer-telemetry`
    const manifestUrl = `${supabaseUrl}/functions/v1/freezer-firmware-manifest`

    return json({
      ok: true,
      device: {
        id: deviceId,
        key: deviceKey,
        name: displayName,
      },
      config: {
        device_key: deviceKey,
        telemetry_url: telemetryUrl,
        telemetry_token: telemetryToken,
        supabase_anon_key: anonKey,
        firmware_manifest_url: manifestUrl,
        update_channel: updateChannel,
      },
    })
  } catch (error) {
    return json({ error: toErrorMessage(error) }, 500)
  }
})
