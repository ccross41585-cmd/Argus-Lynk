import { Activity, AlertTriangle, Clock, Home, Server, Settings2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { getDashboardStatus } from '../../lib/dashboardMock'
import type { SystemHealth } from '../../types/dashboard'
import { StatusPill } from '../StatusPill'

type SidebarProps = {
  localMode: boolean
  onSignOut: () => Promise<void>
}

type SidebarStatus = {
  health: SystemHealth
  lastUpdated: string
}

function formatHealthLabel(health: SystemHealth) {
  if (health === 'operational') return 'All systems operational'
  if (health === 'alert') return 'System alert state'
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

const navItems = [
  { label: 'Home',     route: '/dashboard', Icon: Home },
  { label: 'Devices',  route: '/devices',   Icon: Server },
  { label: 'Alerts',   route: '/alerts',    Icon: AlertTriangle },
  { label: 'History',  route: '/history',   Icon: Clock },
  { label: 'Settings', route: '/settings',  Icon: Settings2 },
  { label: 'System',   route: '/system',    Icon: Activity },
] as const

export function Sidebar({ localMode, onSignOut }: SidebarProps) {
  const [status, setStatus] = useState<SidebarStatus>({
    health: 'degraded',
    lastUpdated: new Date().toISOString(),
  })

  useEffect(() => {
    let isActive = true
    async function loadStatus() {
      const overview = await getDashboardStatus()
      if (isActive) {
        setStatus({ health: overview.systemHealth, lastUpdated: overview.lastUpdated })
      }
    }
    void loadStatus()
    return () => { isActive = false }
  }, [])

  const healthTone = useMemo(() => {
    if (status.health === 'operational') return 'success' as const
    if (status.health === 'alert') return 'danger' as const
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
        {navItems.map(({ label, route, Icon }) => (
          <NavLink
            key={route}
            to={route}
            end={route === '/dashboard'}
            className={({ isActive }) => `sidebar__link${isActive ? ' active' : ''}`}
          >
            <span className="sidebar__link-icon">
              <Icon size={16} aria-hidden="true" />
            </span>
            <span>{label}</span>
          </NavLink>
        ))}
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
            <button type="button" className="ghost-button btn-sm" onClick={() => void onSignOut()}>
              Sign Out
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}