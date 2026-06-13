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

interface DeviceRow {
  id: string
  name: string
  type: string | null
  device_type: string | null
}

interface RequestPayload {
  alertId: string
  /** Optional: send only to a specific user (useful for tests) */
  targetUserId?: string
  /** Optional: deep link route for notification click */
  url?: string
  /** Optional: enrich push data payload */
  deviceId?: string
  deviceType?: string
  alertType?: string
  temperatureF?: number
}

function normalizeDeviceType(deviceType: string | null | undefined): string | null {
  const value = String(deviceType ?? '').trim().toLowerCase()
  if (!value) return null
  if (value === 'fence_controller') return 'field_lynk'
  if (value === 'freezer_lynk' || value === 'freezer_alarm') return 'freezer_lynk'
  if (value === 'pump_controller') return 'well_pump_lynk'
  return value
}

function sourceLabelForDeviceType(deviceType: string | null | undefined): string {
  switch (normalizeDeviceType(deviceType)) {
    case 'field_lynk':
      return 'Field Lynk'
    case 'freezer_lynk':
      return 'Freezer Lynk'
    case 'well_pump_lynk':
      return 'Well Pump Lynk'
    default:
      return 'Argus Lynk'
  }
}

function buildNotificationTitle(title: string, sourceLabel: string): string {
  const trimmedTitle = title.trim() || 'Alert'
  if (trimmedTitle.toLowerCase().startsWith(sourceLabel.toLowerCase())) return trimmedTitle
  return `${sourceLabel}: ${trimmedTitle}`
}

// ── Vapid signing helpers ─────────────────────────────────────────────────────
// Web-push libraries for Deno are limited; we perform VAPID signing manually
// using the SubtleCrypto API that is available in Deno's V8 runtime.

const VAPID_PUBLIC_KEY  = Deno.env.get('VAPID_PUBLIC_KEY')!
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!
const VAPID_SUBJECT     = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@arguslynk.com'

/** Build the VAPID Authorization header value for a given push endpoint origin */
async function buildVapidAuthHeader(audience: string): Promise<string> {
  const expiry = Math.floor(Date.now() / 1000) + 12 * 3600  // 12h

  const header = { typ: 'JWT', alg: 'ES256' }
  const claims = { aud: audience, exp: expiry, sub: VAPID_SUBJECT }

  const encode = (obj: unknown) =>
    b64uEncode(new TextEncoder().encode(JSON.stringify(obj)))

  const signingInput = `${encode(header)}.${encode(claims)}`

  // Import the ECDSA P-256 private key.
  // VAPID_PRIVATE_KEY may be stored as a JWK JSON string or as a raw
  // base64url-encoded private scalar (d value only).
  // Web Crypto does NOT support 'raw' format for ECDSA private keys,
  // so for the raw-scalar case we derive x/y from the public key and
  // construct a complete JWK before importing.
  let privateKey: CryptoKey
  try {
    // Try JWK path first
    const jwk = JSON.parse(VAPID_PRIVATE_KEY) as JsonWebKey
    privateKey = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
    )
    console.log('[VAPID] Private key imported as JWK')
  } catch {
    // Fall back: raw base64url private scalar.
    // Extract x,y from the uncompressed public key (0x04 || x32 || y32).
    console.log('[VAPID] JWK parse failed, building JWK from raw scalar + public key')
    const pubBytes = b64uDecode(VAPID_PUBLIC_KEY)
    if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) {
      throw new Error(`VAPID_PUBLIC_KEY is not a 65-byte uncompressed P-256 point (got ${pubBytes.length} bytes, first byte 0x${pubBytes[0].toString(16)})`)
    }
    const x = b64uEncode(pubBytes.slice(1, 33))
    const y = b64uEncode(pubBytes.slice(33, 65))
    const jwk: JsonWebKey = {
      kty: 'EC', crv: 'P-256',
      d: VAPID_PRIVATE_KEY,
      x, y,
      key_ops: ['sign'], ext: true,
    }
    privateKey = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
    )
    console.log('[VAPID] Private key imported via constructed JWK')
  }

  const signatureBytes = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signingInput),
  )

  const token = `${signingInput}.${b64uEncode(new Uint8Array(signatureBytes))}`
  return `vapid t=${token},k=${VAPID_PUBLIC_KEY}`
}

// ── RFC 8291 payload encryption ───────────────────────────────────────────────
// Implements the Web Push Message Encryption spec (RFC 8291) using the
// "aes128gcm" content encoding required by Chrome on Android.

/** Decode a base64url string to Uint8Array, tolerating standard base64 too */
function b64uDecode(b64: string): Uint8Array {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4)
  const std = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(std)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** Encode Uint8Array as base64url */
function b64uEncode(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/**
 * Encrypt a Web Push payload per RFC 8291 / draft-ietf-webpush-encryption.
 *
 * Returns the encrypted body bytes with the aes128gcm binary header prepended,
 * ready to POST with Content-Encoding: aes128gcm.
 */
async function encryptPushPayload(
  plaintext: string,
  p256dhBase64url: string,
  authBase64url: string,
): Promise<Uint8Array> {
  const enc = new TextEncoder()

  // Subscription keys
  const receiverPublicKeyBytes = b64uDecode(p256dhBase64url)  // 65-byte uncompressed P-256 point
  const authSecret = b64uDecode(authBase64url)                 // 16 bytes

  // 1. Generate ephemeral sender key pair (P-256)
  const senderKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits'],
  )

  // Export sender public key as raw uncompressed point (65 bytes)
  const senderPublicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', senderKeyPair.publicKey),
  )

  // Import receiver public key for ECDH
  const receiverPublicKey = await crypto.subtle.importKey(
    'raw',
    receiverPublicKeyBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )

  // 2. ECDH shared secret (32 bytes)
  const sharedSecretBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: receiverPublicKey },
    senderKeyPair.privateKey,
    256,
  )
  const sharedSecret = new Uint8Array(sharedSecretBits)

  // 3. Generate random 16-byte salt
  const salt = crypto.getRandomValues(new Uint8Array(16))

  // 4. HKDF-SHA-256 — PRK via Extract using authSecret as salt
  const hmacKey = await crypto.subtle.importKey(
    'raw', authSecret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const prkBytes = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, sharedSecret))
  const prk = await crypto.subtle.importKey(
    'raw', prkBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )

  // 5. Key material via HKDF Expand
  // info = "WebPush: info\x00" + receiverPublicKeyBytes + senderPublicKeyRaw
  const keyInfoPrefix = enc.encode('WebPush: info\x00')
  const keyInfo = new Uint8Array(keyInfoPrefix.length + receiverPublicKeyBytes.length + senderPublicKeyRaw.length)
  keyInfo.set(keyInfoPrefix, 0)
  keyInfo.set(receiverPublicKeyBytes, keyInfoPrefix.length)
  keyInfo.set(senderPublicKeyRaw, keyInfoPrefix.length + receiverPublicKeyBytes.length)

  const ikmInput = new Uint8Array(keyInfo.length + 1)
  ikmInput.set(keyInfo, 0)
  ikmInput[keyInfo.length] = 0x01
  const ikmRaw = new Uint8Array(await crypto.subtle.sign('HMAC', prk, ikmInput))

  // 6. CEK and nonce via second HKDF with salt
  const saltKey = await crypto.subtle.importKey(
    'raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const prkCek = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, ikmRaw)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const cekInfo = new Uint8Array([...enc.encode('Content-Encoding: aes128gcm\x00'), 0x01])
  const cekRaw = (new Uint8Array(await crypto.subtle.sign('HMAC', prkCek, cekInfo))).slice(0, 16)

  const nonceInfo = new Uint8Array([...enc.encode('Content-Encoding: nonce\x00'), 0x01])
  const nonce = (new Uint8Array(await crypto.subtle.sign('HMAC', prkCek, nonceInfo))).slice(0, 12)

  // 7. AES-128-GCM encrypt
  const cek = await crypto.subtle.importKey('raw', cekRaw, { name: 'AES-GCM' }, false, ['encrypt'])

  // Pad plaintext: append 0x02 delimiter (RFC 8291) — no extra zero-padding
  // needed for small payloads.  Using a fixed 4096-byte record size caused the
  // total body to exceed FCM's 4096-byte limit; we size the record to exactly
  // fit the content instead.
  const plaintextBytes = enc.encode(plaintext)
  const padded = new Uint8Array(plaintextBytes.length + 1)
  padded.set(plaintextBytes, 0)
  padded[plaintextBytes.length] = 0x02  // RFC 8291 delimiter

  // Record size written into the header = padded length + 16-byte AES-GCM tag.
  const recordSize = padded.length + 16

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cek, padded),
  )

  // 8. Build aes128gcm binary header:
  //    salt (16) | rs (4, big-endian uint32) | idlen (1) | keyid (senderPublicKeyRaw, 65)
  const rs = recordSize
  const header = new Uint8Array(16 + 4 + 1 + senderPublicKeyRaw.length)
  header.set(salt, 0)
  const rsView = new DataView(header.buffer, 16, 4)
  rsView.setUint32(0, rs, false)  // big-endian
  header[20] = senderPublicKeyRaw.length
  header.set(senderPublicKeyRaw, 21)

  // Concatenate header + ciphertext
  const result = new Uint8Array(header.length + ciphertext.length)
  result.set(header, 0)
  result.set(ciphertext, header.length)
  return result
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

  // RFC 8291 encrypted payload — required by Chrome on Android
  let encryptedBody: Uint8Array
  try {
    encryptedBody = await encryptPushPayload(payloadJson, sub.p256dh, sub.auth)
  } catch (err) {
    return { status: 0, error: `Encryption error: ${(err as Error).message}` }
  }

  const response = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': vapidAuth,
      'TTL': '86400',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
    },
    body: encryptedBody,
  })

  const responseText = await response.text().catch(() => '')
  if (!response.ok) {
    console.error(`[PUSH] HTTP ${response.status} for endpoint ${sub.endpoint.slice(0, 60)}: ${responseText.slice(0, 200)}`)
    return { status: response.status, error: responseText.slice(0, 200) }
  }

  console.log(`[PUSH] HTTP ${response.status} OK for sub ${sub.id}`)
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

  console.log(`[HANDLER] alertId=${body.alertId}`)

  // 1. Load alert
  const { data: alert, error: alertErr } = await supabase
    .from('alerts')
    .select('id, title, message, severity, device_id, tenant_id')
    .eq('id', body.alertId)
    .single()

  if (alertErr || !alert) {
    console.error('[HANDLER] Alert not found:', alertErr?.message)
    return new Response(JSON.stringify({ error: alertErr?.message ?? 'Alert not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const alertRow = alert as AlertRow
  console.log(`[HANDLER] Alert loaded: "${alertRow.title}" severity=${alertRow.severity} tenant=${alertRow.tenant_id ?? 'null'}`)

  let resolvedDeviceType = body.deviceType ?? null
  let resolvedDeviceName: string | null = null
  if (alertRow.device_id) {
    const { data: deviceRow } = await supabase
      .from('devices')
      .select('id, name, type, device_type')
      .eq('id', alertRow.device_id)
      .maybeSingle()

    if (deviceRow) {
      const typedDevice = deviceRow as DeviceRow
      resolvedDeviceType = resolvedDeviceType ?? typedDevice.device_type ?? typedDevice.type
      resolvedDeviceName = typedDevice.name
    }
  }

  const sourceLabel = sourceLabelForDeviceType(resolvedDeviceType)
  const notificationTitle = buildNotificationTitle(alertRow.title || 'Argus Lynk Alert', sourceLabel)
  const sourceType = normalizeDeviceType(resolvedDeviceType)

  // 2. Load enabled subscriptions.
  // When tenant_id is null (e.g. gateway-inserted alert), send to ALL enabled
  // subscriptions so device-level alerts always reach users.
  let subsQuery = supabase
    .from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth, device_label')
    .eq('enabled', true)

  if (body.targetUserId) {
    subsQuery = subsQuery.eq('user_id', body.targetUserId)
  }

  if (alertRow.tenant_id) {
    subsQuery = subsQuery.eq('tenant_id', alertRow.tenant_id)
  }

  const { data: subscriptions, error: subsErr } = await subsQuery
  if (subsErr) {
    console.error('[HANDLER] push_subscriptions query error:', subsErr.message)
    return new Response(JSON.stringify({ error: subsErr.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  const subs = (subscriptions ?? []) as PushSubscriptionRow[]
  console.log(`[HANDLER] Found ${subs.length} active subscription(s)`)

  if (subs.length === 0) {
    return new Response(JSON.stringify({ sent: 0, message: 'No active subscriptions' }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 3. Build payload
  const alertUrl = body.url || `/alerts/${alertRow.id}`
  const payloadDeviceId = body.deviceId || alertRow.device_id
  const pushPayload = JSON.stringify({
    title: notificationTitle,
    body: alertRow.message,
    icon: '/app-icon2.png',
    badge: '/app-icon2.png',
    tag: `alert-${alertRow.id}`,
    requireInteraction: alertRow.severity === 'critical' || alertRow.severity === 'warning',
    data: {
      url: alertUrl,
      alertId: alertRow.id,
      deviceId: payloadDeviceId,
      severity: alertRow.severity,
      source_label: sourceLabel,
      source_type: sourceType,
      device_name: resolvedDeviceName,
      device_id: payloadDeviceId,
      device_type: sourceType,
      alert_type: body.alertType,
      temperature_f: body.temperatureF,
    },
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'silence', title: 'Silence' },
    ],
  })

  // 4. Send to each subscription and log events
  const results = { sent: 0, failed: 0, expired: 0 }

  for (const sub of subs) {
    console.log(`[SEND] sub=${sub.id} endpoint=${sub.endpoint.slice(0, 60)}`)
    const { status, error: pushError } = await sendWebPush(sub, pushPayload)
    console.log(`[SEND] result status=${status} error=${pushError ?? 'none'}`)

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

  console.log(`[HANDLER] Done: sent=${results.sent} failed=${results.failed} expired=${results.expired}`)
  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json' },
  })
})
