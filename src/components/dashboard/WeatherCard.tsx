import {
  Cloud,
  CloudDrizzle,
  CloudLightning,
  CloudRain,
  CloudSnow,
  HelpCircle,
  Moon,
  Sun,
  Wind,
  type LucideIcon,
} from 'lucide-react'
import type { WeatherCondition } from '../../lib/weather'

export const CONDITION_ICON: Record<WeatherCondition, LucideIcon> = {
  'sunny':         Sun,
  'partly-cloudy': Cloud,
  'cloudy':        Cloud,
  'foggy':         Wind,
  'drizzle':       CloudDrizzle,
  'rain':          CloudRain,
  'heavy-rain':    CloudRain,
  'snow':          CloudSnow,
  'thunderstorm':  CloudLightning,
  'unknown':       HelpCircle,
}

const CONDITION_COLOR: Record<WeatherCondition, string> = {
  'sunny':         '#f5c876',
  'partly-cloudy': '#a8c8e8',
  'cloudy':        '#8899aa',
  'foggy':         '#99aabb',
  'drizzle':       '#7dc4ff',
  'rain':          '#5da8ff',
  'heavy-rain':    '#4488dd',
  'snow':          '#c8e8ff',
  'thunderstorm':  '#cc88ff',
  'unknown':       '#666',
}

type WeatherCardProps = {
  temperatureF?: number
  summary: string
  condition?: WeatherCondition
  isDay?: boolean
  windSpeedMph?: number
  humidity?: number
  /** Fallback text temperature if live data not yet loaded */
  temperatureText?: string
}

export function WeatherCard({
  temperatureF,
  temperatureText,
  summary,
  condition = 'unknown',
  isDay = true,
  windSpeedMph,
  humidity,
}: WeatherCardProps) {
  const displayCondition = !isDay && condition === 'sunny' ? 'sunny' : condition
  const Icon = !isDay && condition === 'sunny' ? Moon : CONDITION_ICON[displayCondition]
  const iconColor = !isDay && condition === 'sunny' ? '#c8d8f0' : CONDITION_COLOR[displayCondition]
  const tempDisplay = temperatureF !== undefined ? `${temperatureF}°F` : (temperatureText ?? '—')

  return (
    <section className="stack-card weather-card" id="weather">
      <div className="weather-card__header">
        <p className="eyebrow">Weather</p>
        <h2>Outside Conditions</h2>
      </div>
      <div className="weather-card__hero">
        <span className="weather-card__icon" style={{ color: iconColor }}>
          <Icon size={54} strokeWidth={1.4} />
        </span>
        <div className="weather-card__reading">
          <strong className="weather-card__temp">{tempDisplay}</strong>
          <span className="weather-card__summary">{summary}</span>
        </div>
      </div>
      {(windSpeedMph !== undefined || humidity !== undefined) && (
        <div className="weather-card__meta">
          {windSpeedMph !== undefined && (
            <span className="weather-card__meta-item">
              <Wind size={13} />
              {windSpeedMph} mph
            </span>
          )}
          {humidity !== undefined && (
            <span className="weather-card__meta-item">
              Humidity {humidity}%
            </span>
          )}
        </div>
      )}
    </section>
  )
}
