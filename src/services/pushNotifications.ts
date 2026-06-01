/**
 * Push notification utilities for Argus Lynk.
 *
 * All functions are safe to call in environments that don't support push
 * (e.g. Firefox private windows, iOS WebKit without the right flags).
 * Check isPushSupported() before calling subscription functions.
 *
 * VAPID public key is read from VITE_VAPID_PUBLIC_KEY env var.
 * VAPID private key never touches the frontend.
 */

import { supabase } from '../lib/supabase'

// ── Support detection ─────────────────────────────────────────────────────────

export function isPushSupported(): boolean {
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export function getNotificationPermission(): NotificationPermission {
  if (!('Notification' in window)) return 'denied'
  return Notification.permission
}

// ── Service worker ────────────────────────────────────────────────────────────

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  } catch (err) {
    console.error('[push] SW registration failed:', err)
    return null
  }
}

export async function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  try {
    const reg = await navigator.serviceWorker.getRegistration('/')
    return reg ?? null
  } catch {
    return null
  }
}

// ── Subscription ──────────────────────────────────────────────────────────────

/** Returns the active push subscription for this browser, if any. */
export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  const reg = await getServiceWorkerRegistration()
  if (!reg) return null
  try {
    return await reg.pushManager.getSubscription()
  } catch {
    return null
  }
}

/**
 * Requests notification permission, creates a push subscription, and saves it
 * to Supabase.  Returns the subscription or null if anything fails.
 */
export async function subscribeToPushNotifications(
  userId: string,
  tenantId: string,
): Promise<{ subscription: PushSubscription | null; error: string | null }> {
  if (!isPushSupported()) {
    return { subscription: null, error: 'Push notifications are not supported in this browser.' }
  }

  // 1. Request permission
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    return {
      subscription: null,
      error:
        permission === 'denied'
          ? 'Notifications are blocked for this device. Enable them in browser/site settings.'
          : 'Notification permission was not granted.',
    }
  }

  // 2. Ensure SW is registered
  let reg = await getServiceWorkerRegistration()
  if (!reg) {
    reg = await registerServiceWorker()
  }
  if (!reg) {
    return { subscription: null, error: 'Service worker could not be registered.' }
  }

  // 3. Get VAPID public key
  const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined
  if (!vapidKey) {
    return { subscription: null, error: 'VAPID public key is not configured (VITE_VAPID_PUBLIC_KEY).' }
  }

  // 4. Subscribe
  let subscription: PushSubscription
  try {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    } as PushSubscriptionOptionsInit)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { subscription: null, error: `Push subscribe failed: ${msg}` }
  }

  // 5. Save to Supabase
  const saveError = await savePushSubscription(subscription, userId, tenantId)
  if (saveError) {
    console.warn('[push] Subscription active but could not be saved to cloud:', saveError)
    // Don't treat as fatal — subscription still works locally
  }

  return { subscription, error: null }
}

/**
 * Unsubscribes this browser from push and marks the subscription disabled in
 * Supabase (does not delete, for audit trail).
 */
export async function unsubscribeFromPushNotifications(
  userId: string,
): Promise<{ error: string | null }> {
  const subscription = await getCurrentPushSubscription()
  if (!subscription) return { error: null }

  try {
    const endpoint = subscription.endpoint
    await subscription.unsubscribe()

    // Mark disabled in Supabase
    if (supabase && userId) {
      await supabase
        .from('push_subscriptions')
        .update({ enabled: false, revoked_at: new Date().toISOString() })
        .eq('endpoint', endpoint)
        .eq('user_id', userId)
    }
    return { error: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { error: `Unsubscribe failed: ${msg}` }
  }
}

// ── Save subscription to Supabase ─────────────────────────────────────────────

export async function savePushSubscription(
  subscription: PushSubscription,
  userId: string,
  tenantId: string,
): Promise<string | null> {
  if (!supabase) return 'Supabase not configured'

  const json = subscription.toJSON()
  const keys = json.keys ?? {}

  const deviceLabel = buildDeviceLabel()

  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_id: userId,
      tenant_id: tenantId,
      endpoint: subscription.endpoint,
      p256dh: keys['p256dh'] ?? '',
      auth: keys['auth'] ?? '',
      device_label: deviceLabel,
      user_agent: navigator.userAgent.slice(0, 512),
      enabled: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'endpoint' },
  )

  return error ? error.message : null
}

// ── Test notification ─────────────────────────────────────────────────────────

/**
 * Sends a local test notification (no server required).
 * Used from Settings to verify the browser permission + SW are working.
 */
export async function sendTestNotification(): Promise<{ error: string | null }> {
  if (!isPushSupported()) {
    return { error: 'Push notifications are not supported in this browser.' }
  }
  if (Notification.permission !== 'granted') {
    return { error: 'Notification permission not granted.' }
  }

  const reg = await getServiceWorkerRegistration()
  if (!reg) {
    return { error: 'Service worker not registered.' }
  }

  await reg.showNotification('Argus Lynk Test Alert', {
    body: 'Notifications are working on this device.',
    icon: '/app-icon.svg',
    badge: '/app-icon.svg',
    tag: 'argus-test',
    data: { url: '/settings' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  return { error: null }
}

/**
 * Sends a mock well pump alert notification (local test mode).
 * Demonstrates the alert notification payload format.
 */
export async function sendTestWellPumpAlert(alertId = 'alert-well-runtime'): Promise<{ error: string | null }> {
  if (Notification.permission !== 'granted') {
    return { error: 'Notification permission not granted.' }
  }
  const reg = await getServiceWorkerRegistration()
  if (!reg) return { error: 'Service worker not registered.' }

  await reg.showNotification('Well Pump Alert', {
    body: 'House Well Pump has been running longer than normal.',
    icon: '/app-icon.svg',
    badge: '/app-icon.svg',
    tag: 'alert-well-pump-long-run',
    requireInteraction: true,
    data: {
      url: `/alerts/${alertId}`,
      alertId,
      deviceId: 'well-pump-1',
      severity: 'warning',
      commandOptions: ['YES_USING_WATER', 'SHUT_OFF_PUMP', 'SILENCE_ALERT'],
    },
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'silence', title: 'Silence' },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  return { error: null }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a VAPID base64url public key to a Uint8Array for PushManager.subscribe. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)))
}

/** Build a human-readable label for the current browser/device. */
function buildDeviceLabel(): string {
  const ua = navigator.userAgent
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/iPad/i.test(ua)) return 'iPad'
  if (/Android/i.test(ua)) return 'Android'
  if (/Macintosh/i.test(ua)) return 'Mac'
  if (/Windows/i.test(ua)) return 'Windows PC'
  return 'Unknown device'
}
