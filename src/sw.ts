/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core'
import { precacheAndRoute } from 'workbox-precaching'

declare const self: ServiceWorkerGlobalScope

clientsClaim()

// Inject Vite PWA precache manifest
precacheAndRoute(self.__WB_MANIFEST)

// ── Types ────────────────────────────────────────────────────────────────────

interface NotificationData {
  url?: string
  alertId?: string
  deviceId?: string
  severity?: string
  commandOptions?: string[]
}

interface PushPayload {
  title: string
  body: string
  icon?: string
  badge?: string
  tag?: string
  data?: NotificationData
  actions?: Array<{ action: string; title: string; icon?: string }>
}

// ── Push event ───────────────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  if (!event.data) return

  let payload: PushPayload
  try {
    payload = event.data.json() as PushPayload
  } catch {
    payload = {
      title: 'Argus Lynk Alert',
      body: event.data.text(),
    }
  }

  const data = payload.data ?? {}
  const options = {
    body: payload.body,
    icon: payload.icon ?? '/app-icon2.png',
    badge: payload.badge ?? '/app-icon2.png',
    tag: payload.tag,
    data,
    // Actions: browser/OS support varies; safe fallback is always notificationclick
    actions: payload.actions ?? [],
    vibrate: [200, 100, 200],
    // Require interaction only for critical — keeps lesser alerts from cluttering the screen
    requireInteraction: data.severity === 'critical',
  } as NotificationOptions

  event.waitUntil(
    self.registration.showNotification(payload.title, options),
  )
})

// ── Notification click ────────────────────────────────────────────────────────
// Safety rule: for dangerous commands (shutoff, fence control) we ALWAYS open
// the app first so the user confirms in a secure, authenticated context.
// Only "silence" is safe to attempt as a background action.

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const data = event.notification.data as NotificationData
  const action = event.action

  if (action === 'arm-fence') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
        for (const client of clients) {
          client.postMessage({ type: 'FENCE_REARM' })
        }
        await openOrFocusUrl('/')
      }),
    )
    return
  }

  if (action === 'dismiss-fence') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        for (const client of clients) {
          client.postMessage({ type: 'FENCE_REARM_SUPPRESS' })
        }
      }),
    )
    return
  }

  if (action === 'silence' && data?.alertId) {
    // Best-effort background silence; then open the detail page regardless
    const silenceFetch = fetch(`/api/silence-alert?alertId=${encodeURIComponent(data.alertId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => { /* network might not be available */ })

    event.waitUntil(
      Promise.allSettled([silenceFetch]).then(() =>
        openOrFocusUrl(`/alerts/${data.alertId}`),
      ),
    )
    return
  }

  // Default action (tap notification or "open" action): navigate to alert detail
  let targetUrl: string
  if (data?.url) {
    targetUrl = data.url
  } else if (data?.alertId) {
    targetUrl = `/alerts/${data.alertId}`
  } else {
    targetUrl = '/alerts'
  }

  event.waitUntil(openOrFocusUrl(targetUrl))
})

// ── Notification close ────────────────────────────────────────────────────────

self.addEventListener('notificationclose', (event) => {
  // Dismissing the fence rearm notification counts as "Not Now"
  if (event.notification.tag === 'argus-fence-rearm') {
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          client.postMessage({ type: 'FENCE_REARM_SUPPRESS' })
        }
      })
      .catch(() => { /* best-effort */ })
  }
})

// ── Helper: focus existing window or open new one ────────────────────────────

async function openOrFocusUrl(url: string): Promise<void> {
  const allClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  })

  const absoluteUrl = new URL(url, self.location.origin).href

  for (const client of allClients) {
    if ('focus' in client) {
      // Prefer an exact-match window; also accept any same-origin window
      if (client.url === absoluteUrl || client.url.startsWith(self.location.origin)) {
        await (client as WindowClient).focus()
        ;(client as WindowClient).postMessage({ type: 'NAVIGATE', url })
        return
      }
    }
  }

  if (self.clients.openWindow) {
    await self.clients.openWindow(url)
  }
}
