import { StatusPill } from '../StatusPill'

type DrivewayAlarmCardProps = {
  status: 'Clear' | 'Motion Detected' | 'Node Offline'
  lastTriggered: string
  node: 'Online' | 'Offline'
}

export function DrivewayAlarmCard({ status, lastTriggered, node }: DrivewayAlarmCardProps) {
  const tone = status === 'Motion Detected' ? 'warning' : status === 'Node Offline' ? 'danger' : 'success'

  return (
    <section className="stack-card" id="driveway-alarm">
      <div className="command-card__header">
        <div>
          <p className="eyebrow">Driveway Alarm</p>
          <h2>Motion node</h2>
        </div>
        <StatusPill tone={tone}>{status}</StatusPill>
      </div>

      <div className="stack-card__body">
        <div className="info-tile">
          <span className="label">Last Triggered</span>
          <strong>{lastTriggered}</strong>
        </div>
        <div className="info-tile">
          <span className="label">Field Node</span>
          <strong>{node}</strong>
        </div>
      </div>
    </section>
  )
}
