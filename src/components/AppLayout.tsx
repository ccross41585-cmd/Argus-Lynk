import { Outlet } from 'react-router-dom'
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
    </div>
  )
}