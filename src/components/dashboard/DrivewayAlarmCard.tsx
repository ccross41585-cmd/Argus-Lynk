import { StatusPill } from '../StatusPill'

type DrivewayAlarmCardProps = {
  status: 'Clear' | 'Motion Detected' | 'Node Offline'
  lastTriggered: string
  node: 'Online' | 'Offline'
}

export function DrivewayAlarmCard({ status, lastTriggered, node }: DrivewayAlarmCardProps) {
  const tone = status === 'Motion Detected' ? 'warning' : status === 'Node Offline' ? 'danger' : 'success'

  return (
    <section className="compact-card" id="driveway-alarm">
      <div className="compact-card__header">
        <p className="eyebrow">Driveway Alarm</p>
        <StatusPill tone={tone}>{status}</StatusPill>
      </div>

      <div className="data-rows">
        <div className="data-row">
          <span className="label">Last Triggered</span>
          <strong>{lastTriggered}</strong>
        </div>
        <div className="data-row">
          <span className="label">Field Node</span>
          <strong className={node === 'Online' ? 'value-green' : 'value-danger'}>{node}</strong>
        </div>
      </div>
    </section>
  )
}
