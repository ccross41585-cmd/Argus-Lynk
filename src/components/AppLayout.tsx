import { AlertTriangle, Home, Server, Settings2 } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import { Sidebar } from './dashboard/Sidebar'

type AppLayoutProps = {
  localMode: boolean
  onSignOut: () => Promise<void>
}

export function AppLayout({ localMode, onSignOut }: AppLayoutProps) {
  return (
    <div className="dashboard-shell">
      <Sidebar localMode={localMode} onSignOut={onSignOut} />

      <div className="workspace-shell">
        <main className="workspace-main">
          <Outlet />
        </main>
      </div>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        <NavLink
          to="/dashboard"
          end
          className={({ isActive }) => `mobile-nav__link${isActive ? ' active' : ''}`}
        >
          <Home size={22} aria-hidden="true" />
          <span>Home</span>
        </NavLink>
        <NavLink
          to="/devices"
          className={({ isActive }) => `mobile-nav__link${isActive ? ' active' : ''}`}
        >
          <Server size={22} aria-hidden="true" />
          <span>Devices</span>
        </NavLink>
        <NavLink
          to="/alerts"
          className={({ isActive }) => `mobile-nav__link${isActive ? ' active' : ''}`}
        >
          <AlertTriangle size={22} aria-hidden="true" />
          <span>Alerts</span>
        </NavLink>
        <NavLink
          to="/settings"
          className={({ isActive }) => `mobile-nav__link${isActive ? ' active' : ''}`}
        >
          <Settings2 size={22} aria-hidden="true" />
          <span>Settings</span>
        </NavLink>
      </nav>
    </div>
  )
}