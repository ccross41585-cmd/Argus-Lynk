import { Activity, Clock, ShieldCheck, Wifi } from 'lucide-react'

type DashboardHeaderProps = {
  gatewayStatus: 'online' | 'offline'
  networkStrength: 'Strong' | 'Weak' | 'Offline'
  currentTime: string
}

export function DashboardHeader({
  gatewayStatus,
  networkStrength,
  currentTime,
}: DashboardHeaderProps) {
  const gatewayOnline = gatewayStatus === 'online'

  return (
    <header className="dashboard-header panel">
      <div className="dashboard-header__hero">
        <h1 className="dashboard-header__title">
          Argus
          <ShieldCheck size={24} strokeWidth={1.8} className="dashboard-header__logo-icon" aria-hidden="true" />
          Dashboard
        </h1>
        <p className="dashboard-header__tagline">
          Welcome back. All systems connected.
          <span className={`dashboard-header__dot${gatewayOnline ? ' dashboard-header__dot--online' : ''}`} />
        </p>
      </div>

      <div className="dashboard-header__metrics">
        <div className={`header-metric${gatewayOnline ? ' header-metric--online' : ' header-metric--offline'}`}>
          <span className="header-metric__icon"><Wifi size={22} strokeWidth={1.8} /></span>
          <span className="header-metric__body">
            <span className="header-metric__label">Gateway</span>
            <strong className="header-metric__value">{gatewayOnline ? 'Online' : 'Offline'}</strong>
          </span>
        </div>

        <div className="header-metric">
          <span className="header-metric__icon"><Activity size={22} strokeWidth={1.8} /></span>
          <span className="header-metric__body">
            <span className="header-metric__label">Network</span>
            <strong className="header-metric__value">{networkStrength}</strong>
          </span>
        </div>

        <div className="header-metric header-metric--time">
          <span className="header-metric__icon"><Clock size={22} strokeWidth={1.8} /></span>
          <span className="header-metric__body">
            <span className="header-metric__label">Local Time</span>
            <strong className="header-metric__value">{currentTime}</strong>
          </span>
        </div>
      </div>
    </header>
  )
}
