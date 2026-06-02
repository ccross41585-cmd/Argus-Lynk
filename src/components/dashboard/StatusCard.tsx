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
  /** If provided, ON/OFF control buttons are rendered on the card */
  onToggleOn?: () => void
  onToggleOff?: () => void
}

export function StatusCard({ icon, label, status, detail, tone, customIcon, onToggleOn, onToggleOff }: StatusCardProps) {
  const Icon = customIcon ?? ICON_MAP[icon]
  const hasControls = !!(onToggleOn || onToggleOff)
  return (
    <article className={`status-card status-card--${tone}${hasControls ? ' status-card--controllable' : ''}`}>
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
      {hasControls && (
        <div className="status-card__toggle-row">
          {onToggleOn && (
            <button type="button" className="status-card__btn status-card__btn--on" onClick={onToggleOn}>
              ON
            </button>
          )}
          {onToggleOff && (
            <button type="button" className="status-card__btn status-card__btn--off" onClick={onToggleOff}>
              OFF
            </button>
          )}
        </div>
      )}
    </article>
  )
}