import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PushSubscriptionRow {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
  device_label: string | null
}

interface AlertRow {
  id: string
  title: string
  message: string
  severity: string
  device_id: string
  tenant_id: string | null
}

interface RequestPayload {
  alertId: string
  /** Optional: send only to a specific user (useful for tests) */
  targetUserId?: string
}

// ── Vapid signing helpers ─────────────────────────────────────────────────────
// Web-push libraries for Deno are limited; we perform VAPID signing manually
// using the SubtleCrypto API that is available in Deno's V8 runtime.

const VAPID_PUBLIC_KEY  = Deno.env.get('VAPID_PUBLIC_KEY')!
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!
const VAPID_SUBJECT     = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@arguslynk.com'

/** Convert a base64url string to Uint8Array */
function base64urlToUint8Array(b64: string): Uint8Array {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4)
  const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  return new Uint8Array([...binary].map((c) => c.charCodeAt(0)))
}

/** Convert Uint8Array to base64url */
function uint8ArrayToBase64url(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

/** Build the VAPID Authorization header value for a given push endpoint origin */
async function buildVapidAuthHeader(audience: string): Promise<string> {
  const expiry = Math.floor(Date.now() / 1000) + 12 * 3600  // 12h

  const header = { typ: 'JWT', alg: 'ES256' }
  const claims = { aud: audience, exp: expiry, sub: VAPID_SUBJECT }

  const encode = (obj: unknown) =>
    uint8ArrayToBase64url(new TextEncoder().encode(JSON.stringify(obj)))

  const signingInput = `${encode(header)}.${encode(claims)}`

  // Import private key (uncompressed EC P-256 raw/pkcs8 or JWK)
  // Supabase VAPID secrets are typically stored as base64url raw private scalar.
  // For simplicity we expect them as JWK JSON string in the env var.
  let privateKey: CryptoKey
  try {
    const jwk = JSON.parse(VAPID_PRIVATE_KEY) as JsonWebKey
    privateKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
  } catch {
    // Fallback: treat as raw base64url scalar
    const rawBytes = base64urlToUint8Array(VAPID_PRIVATE_KEY)
    privateKey = await crypto.subtle.importKey(
      'raw',
      rawBytes,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
  }

  const signatureBytes = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signingInput),
  )

  const token = `${signingInput}.${uint8ArrayToBase64url(new Uint8Array(signatureBytes))}`
  return `vapid t=${token},k=${VAPID_PUBLIC_KEY}`
}

// ── Push sender ───────────────────────────────────────────────────────────────

async function sendWebPush(
  sub: PushSubscriptionRow,
  payloadJson: string,
): Promise<{ status: number; error?: string }> {
  const url = new URL(sub.endpoint)
  const audience = `${url.protocol}//${url.host}`

  let vapidAuth: string
  try {
    vapidAuth = await buildVapidAuthHeader(audience)
  } catch (err) {
    return { status: 0, error: `VAPID sign error: ${(err as Error).message}` }
  }

  // Note: payload encryption (RFC 8291 / web-push content encoding) requires
  // the p256dh/auth keys and AES-GCM.  For a production implementation, use a
  // full web-push library (e.g. https://deno.land/x/web_push).
  // We send an unencrypted payload here; browsers will accept it for same-origin
  // service workers when content-encoding is omitted (plain text).
  const response = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': vapidAuth,
      'TTL': '86400',
      'Content-Type': 'application/json',
    },
    body: payloadJson,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { status: response.status, error: text.slice(0, 200) }
  }

  return { status: response.status }
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      },
    })
  }

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  let body: RequestPayload
  try {
    body = await req.json() as RequestPayload
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }

  if (!body.alertId) {
    return new Response('Missing alertId', { status: 400 })
  }

  // 1. Load alert
  const { data: alert, error: alertErr } = await supabase
    .from('alerts')
    .select('id, title, message, severity, device_id, tenant_id')
    .eq('id', body.alertId)
    .single()

  if (alertErr || !alert) {
    return new Response(JSON.stringify({ error: alertErr?.message ?? 'Alert not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const alertRow = alert as AlertRow

  // 2. Load enabled subscriptions.
  // When tenant_id is null (e.g. gateway-inserted alert), send to ALL enabled
  // subscriptions so device-level alerts always reach users.
  let subsQuery = supabase
    .from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth, device_label')
    .eq('enabled', true)

  if (alertRow.tenant_id) {
    subsQuery = subsQuery.eq('tenant_id', alertRow.tenant_id)
  }

  const { data: subscriptions, error: subsErr } = await subsQuery
  if (subsErr) {
    return new Response(JSON.stringify({ error: subsErr.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  const subs = (subscriptions ?? []) as PushSubscriptionRow[]

  if (subs.length === 0) {
    return new Response(JSON.stringify({ sent: 0, message: 'No active subscriptions' }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 3. Build payload
  const alertUrl = `/alerts/${alertRow.id}`
  const pushPayload = JSON.stringify({
    title: alertRow.title || 'Argus Lynk Alert',
    body: alertRow.message,
    icon: '/app-icon.svg',
    badge: '/app-icon.svg',
    tag: `alert-${alertRow.id}`,
    requireInteraction: alertRow.severity === 'critical' || alertRow.severity === 'warning',
    data: {
      url: alertUrl,
      alertId: alertRow.id,
      deviceId: alertRow.device_id,
      severity: alertRow.severity,
    },
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'silence', title: 'Silence' },
    ],
  })

  // 4. Send to each subscription and log events
  const results = { sent: 0, failed: 0, expired: 0 }

  for (const sub of subs) {
    const { status, error: pushError } = await sendWebPush(sub, pushPayload)

    let eventStatus: string
    if (status >= 200 && status < 300) {
      eventStatus = 'sent'
      results.sent++
    } else if (status === 404 || status === 410) {
      // Subscription expired/gone — disable it
      eventStatus = 'expired'
      results.expired++
      await supabase
        .from('push_subscriptions')
        .update({ enabled: false, revoked_at: new Date().toISOString() })
        .eq('id', sub.id)
    } else {
      eventStatus = 'failed'
      results.failed++
    }

    // Log event (non-blocking — ignore insert errors)
    await supabase.from('notification_events').insert({
      tenant_id: alertRow.tenant_id,
      alert_id: alertRow.id,
      subscription_id: sub.id,
      user_id: sub.user_id,
      status: eventStatus,
      http_status: status,
      error_message: pushError ?? null,
      payload_preview: pushPayload.slice(0, 200),
    })
  }

  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json' },
  })
})
