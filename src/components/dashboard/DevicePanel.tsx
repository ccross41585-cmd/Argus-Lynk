import type { DashboardTone } from '../../types/dashboard'
import { StatusPill } from '../StatusPill'

type DetailItem = {
  label: string
  value: string
}

type DevicePanelProps = {
  id?: string
  eyebrow: string
  title: string
  tone: DashboardTone
  summary: string
  detailItems: DetailItem[]
  actionLabel: string
  onAction: () => void
  children?: React.ReactNode
}

export function DevicePanel({
  id,
  eyebrow,
  title,
  tone,
  summary,
  detailItems,
  actionLabel,
  onAction,
  children,
}: DevicePanelProps) {
  return (
    <section className="device-panel" id={id}>
      <div className="device-panel__header">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
        <StatusPill tone={tone}>{summary}</StatusPill>
      </div>
      {children}
      <div className="device-panel__grid">
        {detailItems.map((item) => (
          <div key={item.label} className="info-tile">
            <span className="label">{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>
      <button type="button" className="secondary-button" onClick={onAction}>
        {actionLabel}
      </button>
    </section>
  )
}