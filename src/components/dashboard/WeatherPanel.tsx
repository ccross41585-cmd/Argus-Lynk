type WeatherPanelProps = {
  temperature: string
  humidity: string
  wind: string
  rain24h: string
  pressure: string
  summary: string
  onViewForecast: () => void
}

export function WeatherPanel({
  temperature,
  humidity,
  wind,
  rain24h,
  pressure,
  summary,
  onViewForecast,
}: WeatherPanelProps) {
  return (
    <section className="device-panel" id="weather">
      <div className="device-panel__header">
        <div>
          <p className="eyebrow">Weather Station</p>
          <h2>Local conditions</h2>
        </div>
      </div>

      <div className="weather-panel__hero">
        <strong>{temperature}</strong>
        <p className="section-copy">{summary}</p>
      </div>

      <div className="device-panel__grid">
        <div className="info-tile">
          <span className="label">Humidity</span>
          <strong>{humidity}</strong>
        </div>
        <div className="info-tile">
          <span className="label">Wind</span>
          <strong>{wind}</strong>
        </div>
        <div className="info-tile">
          <span className="label">Rain 24h</span>
          <strong>{rain24h}</strong>
        </div>
        <div className="info-tile">
          <span className="label">Pressure</span>
          <strong>{pressure}</strong>
        </div>
      </div>

      <button type="button" className="secondary-button" onClick={onViewForecast}>
        View Forecast
      </button>
    </section>
  )
}