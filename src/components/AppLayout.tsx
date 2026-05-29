import { NavLink, Outlet } from 'react-router-dom'
import { StatusPill } from './StatusPill'

type AppLayoutProps = {
  localMode: boolean
  onSignOut: () => Promise<void>
}

export function AppLayout({ localMode, onSignOut }: AppLayoutProps) {
  return (
    <div className="app-shell">
      <header className="panel topbar">
        <div className="brand-row">
          <div className="brand-mark">A</div>
          <div className="brand-copy">
            <p className="eyebrow">Argus Control</p>
            <h1>LoRa Field Ops</h1>
            <p className="muted-copy">
              Confirmed state is treated as the real-world truth. Commands wait for ACK.
            </p>
          </div>
        </div>
        <div className="status-row">
          <StatusPill tone={localMode ? 'warning' : 'success'}>
            {localMode ? 'Local Test Mode' : 'Supabase Session'}
          </StatusPill>
          <StatusPill tone="neutral">PWA Ready</StatusPill>
          <button type="button" className="ghost-button" onClick={() => void onSignOut()}>
            Sign Out
          </button>
        </div>
      </header>

      <nav className="panel page-section nav-strip" aria-label="Primary">
        <NavLink
          to="/dashboard"
          className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
        >
          Dashboard
        </NavLink>
        <NavLink
          to="/settings"
          className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
        >
          Settings
        </NavLink>
      </nav>

      <main className="shell-main">
        <Outlet />
      </main>
    </div>
  )
}