export function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return 'Never reported'
  }

  const parsed = new Date(value)

  if (Number.isNaN(parsed.getTime())) {
    return 'Unknown time'
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed)
}

export function formatVoltage(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === '') {
    return 'n/a'
  }

  const numericValue = typeof value === 'number' ? value : Number(value)

  if (Number.isNaN(numericValue)) {
    return 'n/a'
  }

  return `${numericValue.toFixed(2)} V`
}

export function humanizeToken(value: string | null | undefined) {
  if (!value) {
    return 'Unknown'
  }

  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

export function isPendingStatus(status: string | null | undefined) {
  return status === 'pending' ||
    status === 'sent' ||
    status === 'gateway_received' ||
    status === 'sent_to_node' ||
    status === 'node_acknowledged'
}

export function maskProjectUrl(url: string) {
  try {
    const parsed = new URL(url)
    const host = parsed.host

    return `${parsed.protocol}//${host.slice(0, 6)}...${host.slice(-7)}`
  } catch {
    return 'Not configured'
  }
}