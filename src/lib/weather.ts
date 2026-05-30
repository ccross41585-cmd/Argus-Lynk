/**
 * Open-Meteo weather + geocoding service.
 * No API key required. Completely free.
 * Docs: https://open-meteo.com/
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type WeatherCondition =
  | 'sunny'
  | 'partly-cloudy'
  | 'cloudy'
  | 'foggy'
  | 'drizzle'
  | 'rain'
  | 'heavy-rain'
  | 'snow'
  | 'thunderstorm'
  | 'unknown'

export type LiveWeather = {
  temperatureF: number
  condition: WeatherCondition
  summary: string
  isDay: boolean
  windSpeedMph: number
  humidity: number
}

export type GeoResult = {
  label: string      // "Abilene, Texas, US"
  latitude: number
  longitude: number
  timezone: string   // IANA e.g. "America/Chicago"
}

// ── WMO weather code → condition + summary ──────────────────────────────────
// https://open-meteo.com/en/docs#weathervariables (WMO Weather interpretation codes)

const WMO_MAP: Record<number, { condition: WeatherCondition; summary: string }> = {
  0:  { condition: 'sunny',         summary: 'Clear Sky' },
  1:  { condition: 'sunny',         summary: 'Mainly Clear' },
  2:  { condition: 'partly-cloudy', summary: 'Partly Cloudy' },
  3:  { condition: 'cloudy',        summary: 'Overcast' },
  45: { condition: 'foggy',         summary: 'Foggy' },
  48: { condition: 'foggy',         summary: 'Icy Fog' },
  51: { condition: 'drizzle',       summary: 'Light Drizzle' },
  53: { condition: 'drizzle',       summary: 'Drizzle' },
  55: { condition: 'drizzle',       summary: 'Heavy Drizzle' },
  56: { condition: 'drizzle',       summary: 'Freezing Drizzle' },
  57: { condition: 'drizzle',       summary: 'Heavy Freezing Drizzle' },
  61: { condition: 'rain',          summary: 'Light Rain' },
  63: { condition: 'rain',          summary: 'Rain' },
  65: { condition: 'heavy-rain',    summary: 'Heavy Rain' },
  66: { condition: 'rain',          summary: 'Freezing Rain' },
  67: { condition: 'heavy-rain',    summary: 'Heavy Freezing Rain' },
  71: { condition: 'snow',          summary: 'Light Snow' },
  73: { condition: 'snow',          summary: 'Snow' },
  75: { condition: 'snow',          summary: 'Heavy Snow' },
  77: { condition: 'snow',          summary: 'Snow Grains' },
  80: { condition: 'rain',          summary: 'Light Showers' },
  81: { condition: 'rain',          summary: 'Rain Showers' },
  82: { condition: 'heavy-rain',    summary: 'Violent Showers' },
  85: { condition: 'snow',          summary: 'Snow Showers' },
  86: { condition: 'snow',          summary: 'Heavy Snow Showers' },
  95: { condition: 'thunderstorm',  summary: 'Thunderstorm' },
  96: { condition: 'thunderstorm',  summary: 'Thunderstorm w/ Hail' },
  99: { condition: 'thunderstorm',  summary: 'Heavy Thunderstorm' },
}

function decodeWmo(code: number, isDay: boolean): { condition: WeatherCondition; summary: string } {
  const entry = WMO_MAP[code]
  if (!entry) return { condition: 'unknown', summary: 'Unknown' }
  // At night, "sunny" becomes "clear"
  if (!isDay && entry.condition === 'sunny') {
    return { condition: 'sunny', summary: entry.summary === 'Clear Sky' ? 'Clear Night' : entry.summary }
  }
  return entry
}

// ── Geocoding helpers ────────────────────────────────────────────────────────

/** Fetch IANA timezone for a lat/lon from Open-Meteo (no key required). */
async function getTimezoneForCoords(lat: number, lon: number): Promise<string> {
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast')
    url.searchParams.set('latitude', String(lat))
    url.searchParams.set('longitude', String(lon))
    url.searchParams.set('timezone', 'auto')
    url.searchParams.set('forecast_days', '1')
    url.searchParams.set('hourly', 'temperature_2m')
    const res = await fetch(url.toString())
    if (!res.ok) return 'America/Chicago'
    const data = await res.json() as { timezone?: string }
    return data.timezone ?? 'America/Chicago'
  } catch {
    return 'America/Chicago'
  }
}

/** Look up a US zip code via Zippopotam.us (free, no key). */
async function geocodeByZip(zip: string): Promise<GeoResult[]> {
  const res = await fetch(`https://api.zippopotam.us/us/${zip}`)
  if (!res.ok) return []
  const data = await res.json() as {
    places?: Array<{ 'place name': string; 'state abbreviation': string; latitude: string; longitude: string }>
  }
  const place = data.places?.[0]
  if (!place) return []
  const lat = parseFloat(place.latitude)
  const lon = parseFloat(place.longitude)
  const timezone = await getTimezoneForCoords(lat, lon)
  return [{
    label: `${place['place name']}, ${place['state abbreviation']}, US`,
    latitude: lat,
    longitude: lon,
    timezone,
  }]
}

export async function geocodeLocation(query: string): Promise<GeoResult[]> {
  const trimmed = query.trim()

  // Zip code: exactly 5 digits
  if (/^\d{5}$/.test(trimmed)) {
    return geocodeByZip(trimmed)
  }

  // City search: Open-Meteo only wants the city name — strip ", STATE" suffix
  const parts = trimmed.split(',')
  const cityPart = parts[0].trim()
  const stateHint = parts[1]?.trim().toUpperCase() ?? null  // e.g. "TX" or "TEXAS"

  const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
  url.searchParams.set('name', cityPart)
  url.searchParams.set('count', '10')
  url.searchParams.set('language', 'en')
  url.searchParams.set('format', 'json')

  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`Geocoding request failed: ${res.status}`)

  const data = await res.json() as {
    results?: Array<{
      name: string
      admin1?: string
      country?: string
      country_code?: string
      latitude: number
      longitude: number
      timezone: string
    }>
  }

  if (!data.results?.length) return []

  let results = data.results

  // If user typed a state hint ("TX" / "Texas"), prefer matches from that state
  if (stateHint) {
    const filtered = results.filter((r) => {
      const admin = (r.admin1 ?? '').toUpperCase()
      const country = (r.country_code ?? '').toUpperCase()
      // Match full state name or 2-letter abbreviation within the admin region
      return country === 'US' && (admin.includes(stateHint) || admin.startsWith(stateHint))
    })
    if (filtered.length > 0) results = filtered
  }

  return results.slice(0, 5).map((r) => ({
    label: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone,
  }))
}

// ── Weather fetch ────────────────────────────────────────────────────────────

export async function fetchWeather(lat: number, lon: number): Promise<LiveWeather> {
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', String(lat))
  url.searchParams.set('longitude', String(lon))
  url.searchParams.set('current', [
    'temperature_2m',
    'relative_humidity_2m',
    'weather_code',
    'wind_speed_10m',
    'is_day',
  ].join(','))
  url.searchParams.set('temperature_unit', 'fahrenheit')
  url.searchParams.set('wind_speed_unit', 'mph')
  url.searchParams.set('forecast_days', '1')

  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`Weather request failed: ${res.status}`)

  const data = await res.json() as {
    current: {
      temperature_2m: number
      relative_humidity_2m: number
      weather_code: number
      wind_speed_10m: number
      is_day: number
    }
  }

  const c = data.current
  const isDay = c.is_day === 1
  const { condition, summary } = decodeWmo(c.weather_code, isDay)

  return {
    temperatureF: Math.round(c.temperature_2m),
    condition,
    summary,
    isDay,
    windSpeedMph: Math.round(c.wind_speed_10m),
    humidity: c.relative_humidity_2m,
  }
}
