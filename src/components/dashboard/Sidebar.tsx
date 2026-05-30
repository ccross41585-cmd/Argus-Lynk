import {
  AlertTriangle,
  Bell,
  Cloud,
  Droplets,
  Home,
  LayoutDashboard,
  Settings2,
  Snowflake,
  Zap,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { getDashboardStatus } from '../../lib/dashboardMock'
import type { SystemHealth } from '../../types/dashboard'
import { StatusPill } from '../StatusPill'

type SidebarProps = {
  localMode: boolean
  onSignOut: () => Promise<void>
}

type SidebarNavItem =
  | {
      kind: 'route'
      label: string
      route: string
      icon: 'home' | 'settings'
    }
  | {
      kind: 'hash'
      label: string
      href: string
      icon: 'fence' | 'pump' | 'freezer' | 'driveway' | 'weather' | 'alerts' | 'system'
    }

type SidebarStatus = {
  health: SystemHealth
  lastUpdated: string
}

function formatHealthLabel(health: SystemHealth) {
  if (health === 'operational') {
    return 'All systems operational'
  }

  if (health === 'alert') {
    return 'System alert state'
  }

  return 'Systems degraded'
}

function formatLastUpdated(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

const navItems: SidebarNavItem[] = [
  { kind: 'route', label: 'Home', route: '/dashboard', icon: 'home' },
  { kind: 'hash', label: 'Fence Controller', href: '/dashboard#fence-line', icon: 'fence' },
  { kind: 'hash', label: 'Well Pump', href: '/dashboard#well-pump', icon: 'pump' },
  { kind: 'hash', label: 'Freezer', href: '/dashboard#freezer', icon: 'freezer' },
  { kind: 'hash', label: 'Driveway Alarm', href: '/dashboard#driveway-alarm', icon: 'driveway' },
  { kind: 'hash', label: 'Weather', href: '/dashboard#weather', icon: 'weather' },
  { kind: 'hash', label: 'Alerts', href: '/dashboard#alerts', icon: 'alerts' },
  { kind: 'route', label: 'Settings', route: '/settings', icon: 'settings' },
  { kind: 'hash', label: 'System', href: '/dashboard#system', icon: 'system' },
]

const NAV_ICONS = {
  home: Home,
  fence: Zap,
  pump: Droplets,
  freezer: Snowflake,
  driveway: Bell,
  weather: Cloud,
  alerts: AlertTriangle,
  settings: Settings2,
  system: LayoutDashboard,
} as const

function NavIcon({ icon }: { icon: SidebarNavItem['icon'] }) {
  const Icon = NAV_ICONS[icon]
  return <Icon size={18} aria-hidden="true" />
}

export function Sidebar({ localMode, onSignOut }: SidebarProps) {
  const location = useLocation()
  const [status, setStatus] = useState<SidebarStatus>({
    health: 'degraded',
    lastUpdated: new Date().toISOString(),
  })

  useEffect(() => {
    let isActive = true

    async function loadStatus() {
      const overview = await getDashboardStatus()

      if (isActive) {
        setStatus({
          health: overview.systemHealth,
          lastUpdated: overview.lastUpdated,
        })
      }
    }

    void loadStatus()

    return () => {
      isActive = false
    }
  }, [])

  const healthTone = useMemo(() => {
    if (status.health === 'operational') {
      return 'success' as const
    }

    if (status.health === 'alert') {
      return 'danger' as const
    }

    return 'warning' as const
  }, [status.health])

  return (
    <aside className="sidebar panel">
      <div className="sidebar__brand-wrap">
        <div className="sidebar__brand-mark">
          <img className="sidebar__logo" src="/argus-lynk-logo.png" alt="Argus Lynk" />
        </div>
      </div>

      <nav className="sidebar__nav" aria-label="Primary">
        {navItems.map((item) => {
          if (item.kind === 'route') {
            const isRouteActive =
              item.icon === 'home'
                ? location.pathname === '/dashboard' && location.hash === ''
                : location.pathname === item.route
            return (
              <NavLink
                key={item.label}
                to={item.route}
                className={() => `sidebar__link${isRouteActive ? ' active' : ''}`}
              >
                <span className="sidebar__link-icon">
                  <NavIcon icon={item.icon} />
                </span>
                <span>{item.label}</span>
              </NavLink>
            )
          }

          const isActive = location.pathname === '/dashboard' && location.hash === item.href.replace('/dashboard', '')

          return (
            <a key={item.label} href={item.href} className={`sidebar__link${isActive ? ' active' : ''}`}>
              <span className="sidebar__link-icon">
                <NavIcon icon={item.icon} />
              </span>
              <span>{item.label}</span>
            </a>
          )
        })}
      </nav>

      <div className="sidebar__footer">
        <div className="sidebar__status-card">
          <div className="sidebar__status-header">
            <p className="eyebrow">System State</p>
            <StatusPill tone={healthTone}>{status.health}</StatusPill>
          </div>
          <strong>{formatHealthLabel(status.health)}</strong>
          <p className="muted-copy">Last updated {formatLastUpdated(status.lastUpdated)}</p>
          <div className="sidebar__status-row">
            <StatusPill tone={localMode ? 'warning' : 'success'}>
              {localMode ? 'Local Test Mode' : 'Authenticated'}
            </StatusPill>
            <button type="button" className="ghost-button" onClick={() => void onSignOut()}>
              Sign Out
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}