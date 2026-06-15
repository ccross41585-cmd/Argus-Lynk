import {
  Activity,
  Bell,
  Droplets,
  ShieldCheck,
  Snowflake,
  type LucideIcon,
  Wifi,
} from 'lucide-react'
import type { DashboardTone } from '../../types/dashboard'

export type StatusCardIcon =
  | 'fence'
  | 'pump'
  | 'freezer'
  | 'driveway'
  | 'weather'
  | 'nodes'

const ICON_MAP: Record<StatusCardIcon, LucideIcon> = {
  fence: ShieldCheck,
  pump: Droplets,
  freezer: Snowflake,
  driveway: Bell,
  weather: Activity,
  nodes: Wifi,
}

type StatusCardProps = {
  icon: StatusCardIcon
  label: string
  status: string
  detail: string
  tone: DashboardTone
  /** Override the default icon with any Lucide icon component */
  customIcon?: LucideIcon
  onClick?: () => void
}

export function StatusCard({ icon, label, status, detail, tone, customIcon, onClick }: StatusCardProps) {
  const Icon = customIcon ?? ICON_MAP[icon]
  return (
    <article
      className={`status-card status-card--${tone}${onClick ? ' status-card--interactive' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick()
        }
      } : undefined}
    >
      <div className="status-card__main">
        <span className={`status-card__icon status-card__icon--${tone}`} aria-hidden="true">
          <Icon size={26} strokeWidth={1.6} />
        </span>
        <div className="status-card__body">
          <span className="label">{label}</span>
          <strong className="status-card__value">{status}</strong>
          <p className="status-card__detail">{detail}</p>
        </div>
      </div>
    </article>
  )
}