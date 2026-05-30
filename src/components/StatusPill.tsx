type StatusPillProps = {
  tone?: 'success' | 'warning' | 'danger' | 'info' | 'neutral'
  children: React.ReactNode
}

export function StatusPill({ tone = 'neutral', children }: StatusPillProps) {
  return <span className={`status-pill status-pill--${tone}`}>{children}</span>
}