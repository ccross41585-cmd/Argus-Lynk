type FreezerRange = '24h' | '7d' | '30d' | 'custom'

type FreezerTrendPoint = {
  temperatureF: number
  timestamp: string
}

type FreezerQuickDetailSheetProps = {
  open: boolean
  deviceName: string
  currentTempLabel: string
  statusLabel: 'Normal' | 'Warning' | 'Alarm' | 'Offline'
  lastReportLabel: string
  batteryLabel: string
  connectionLabel: string
  connectionTypeLabel: string
  range: FreezerRange
  customStart: string
  customEnd: string
  warningThresholdF: number
  alarmThresholdF: number
  points: FreezerTrendPoint[]
  loading?: boolean
  onClose: () => void
  onRangeChange: (range: FreezerRange) => void
  onCustomStartChange: (value: string) => void
  onCustomEndChange: (value: string) => void
  onOpenSettings: () => void
  onViewFullHistory: () => void
}

function toChartModel(points: FreezerTrendPoint[], warning: number, alarm: number) {
  const width = 620
  const height = 220
  if (points.length === 0) {
    return {
      width,
      height,
      path: '',
      yTicks: [] as number[],
      current: null as null | { x: number; y: number; value: number },
      high: null as number | null,
      low: null as number | null,
      warningY: 0,
      alarmY: 0,
    }
  }

  const values = points.map((p) => p.temperatureF)
  let minY = Math.min(...values, warning, alarm)
  let maxY = Math.max(...values, warning, alarm)
  const span = Math.max(maxY - minY, 2)
  const pad = Math.max(span * 0.15, 1)
  minY -= pad
  maxY += pad

  const toX = (idx: number) => (points.length <= 1 ? width / 2 : (idx / (points.length - 1)) * width)
  const toY = (value: number) => height - ((value - minY) / Math.max(maxY - minY, 0.001)) * height

  const path = points
    .map((point, idx) => `${idx === 0 ? 'M' : 'L'} ${toX(idx).toFixed(2)} ${toY(point.temperatureF).toFixed(2)}`)
    .join(' ')

  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const ratio = i / 4
    return maxY - ratio * (maxY - minY)
  })

  const lastIdx = Math.max(points.length - 1, 0)
  return {
    width,
    height,
    path,
    yTicks,
    current: {
      x: toX(lastIdx),
      y: toY(points[lastIdx].temperatureF),
      value: points[lastIdx].temperatureF,
    },
    high: Math.max(...values),
    low: Math.min(...values),
    warningY: toY(warning),
    alarmY: toY(alarm),
  }
}

function formatXAxis(ts: string) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function FreezerQuickDetailSheet({
  open,
  deviceName,
  currentTempLabel,
  statusLabel,
  lastReportLabel,
  batteryLabel,
  connectionLabel,
  connectionTypeLabel,
  range,
  customStart,
  customEnd,
  warningThresholdF,
  alarmThresholdF,
  points,
  loading,
  onClose,
  onRangeChange,
  onCustomStartChange,
  onCustomEndChange,
  onOpenSettings,
  onViewFullHistory,
}: FreezerQuickDetailSheetProps) {
  if (!open) return null

  const chart = toChartModel(points, warningThresholdF, alarmThresholdF)
  const firstPoint = points[0]
  const middlePoint = points[Math.floor(points.length / 2)]
  const lastPoint = points[points.length - 1]

  return (
    <div className="modal-backdrop modal-backdrop--sheet" role="presentation" onClick={onClose}>
      <section
        className="freezer-quick-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="freezer-quick-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="field-lynk-sheet__handle" />

        <div className="field-lynk-sheet__header">
          <div>
            <p className="eyebrow">Freezer Lynk</p>
            <h2 id="freezer-quick-sheet-title">{deviceName}</h2>
          </div>
          <button type="button" className="ghost-button btn-sm" onClick={onClose}>Close</button>
        </div>

        <div className="field-lynk-sheet__grid">
          <div className="data-row"><span className="label">Current Temperature</span><strong>{currentTempLabel}</strong></div>
          <div className="data-row"><span className="label">Status</span><strong>{statusLabel}</strong></div>
          <div className="data-row"><span className="label">Last Report</span><strong>{lastReportLabel}</strong></div>
          <div className="data-row"><span className="label">Battery</span><strong>{batteryLabel}</strong></div>
          <div className="data-row"><span className="label">Connection</span><strong>{connectionLabel}</strong></div>
          <div className="data-row"><span className="label">Connection Type</span><strong>{connectionTypeLabel}</strong></div>
        </div>

        <div className="freezer-range-picker" role="tablist" aria-label="Freezer chart range">
          {(['24h', '7d', '30d', 'custom'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={`freezer-range-pill ${range === key ? 'is-active' : ''}`}
              onClick={() => onRangeChange(key)}
            >
              {key.toUpperCase()}
            </button>
          ))}
        </div>

        {range === 'custom' && (
          <div className="freezer-custom-range">
            <label>
              <span className="label">From</span>
              <input type="date" className="settings-location-input" value={customStart} onChange={(e) => onCustomStartChange(e.target.value)} />
            </label>
            <label>
              <span className="label">To</span>
              <input type="date" className="settings-location-input" value={customEnd} onChange={(e) => onCustomEndChange(e.target.value)} />
            </label>
          </div>
        )}

        {loading ? (
          <div className="empty-state">Loading temperature readings...</div>
        ) : points.length < 2 ? (
          <div className="empty-state">Not enough temperature data in this range.</div>
        ) : (
          <div className="freezer-chart-wrap">
            <div className="freezer-chart-yticks">
              {chart.yTicks.map((tick) => (
                <span key={tick.toFixed(2)}>{tick.toFixed(1)}F</span>
              ))}
            </div>
            <svg viewBox={`0 0 ${chart.width} ${chart.height}`} className="freezer-chart-advanced" preserveAspectRatio="none">
              {chart.yTicks.map((tick) => {
                const y = ((chart.yTicks[0] - tick) / Math.max(chart.yTicks[0] - chart.yTicks[chart.yTicks.length - 1], 0.001)) * chart.height
                return <line key={tick.toFixed(3)} x1="0" x2={chart.width} y1={y} y2={y} className="freezer-gridline" />
              })}
              <line x1="0" x2={chart.width} y1={chart.warningY} y2={chart.warningY} className="freezer-threshold freezer-threshold--warning" />
              <line x1="0" x2={chart.width} y1={chart.alarmY} y2={chart.alarmY} className="freezer-threshold freezer-threshold--alarm" />
              <path d={chart.path} className="freezer-trace" />
              {chart.current && <circle cx={chart.current.x} cy={chart.current.y} r="5" className="freezer-marker" />}
            </svg>
            <div className="freezer-chart-xlabels">
              <span>{firstPoint ? formatXAxis(firstPoint.timestamp) : '-'}</span>
              <span>{middlePoint ? formatXAxis(middlePoint.timestamp) : '-'}</span>
              <span>{lastPoint ? formatXAxis(lastPoint.timestamp) : '-'}</span>
            </div>
            <div className="freezer-chart-stats">
              <div className="key-value-item"><span className="label">High</span><strong>{chart.high === null ? '-' : `${chart.high.toFixed(1)}F`}</strong></div>
              <div className="key-value-item"><span className="label">Low</span><strong>{chart.low === null ? '-' : `${chart.low.toFixed(1)}F`}</strong></div>
              <div className="key-value-item"><span className="label">Warn</span><strong>{warningThresholdF.toFixed(1)}F</strong></div>
              <div className="key-value-item"><span className="label">Alarm</span><strong>{alarmThresholdF.toFixed(1)}F</strong></div>
            </div>
          </div>
        )}

        <div className="freezer-quick-sheet__actions">
          <button type="button" className="secondary-button" onClick={onOpenSettings}>Settings</button>
          <button type="button" className="primary-button" onClick={onViewFullHistory}>View Full History</button>
        </div>
      </section>
    </div>
  )
}
