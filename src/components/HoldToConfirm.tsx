import { useEffect, useRef, useState } from 'react'

type HoldToConfirmProps = {
  label: string
  subLabel?: string
  holdMs?: number
  disabled?: boolean
  loading?: boolean
  onConfirm: () => void | Promise<void>
  className?: string
}

export function HoldToConfirm({
  label,
  subLabel,
  holdMs = 1500,
  disabled = false,
  loading = false,
  onConfirm,
  className,
}: HoldToConfirmProps) {
  const [isHolding, setIsHolding] = useState(false)
  const [progress, setProgress] = useState(0)
  const intervalRef = useRef<number | null>(null)
  const startedAtRef = useRef<number>(0)
  const completedRef = useRef(false)

  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current)
      }
    }
  }, [])

  function resetHold() {
    setIsHolding(false)
    setProgress(0)
    completedRef.current = false
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }

  function startHold() {
    if (disabled || loading || isHolding) return
    completedRef.current = false
    startedAtRef.current = Date.now()
    setIsHolding(true)
    setProgress(0)

    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current)
    }

    intervalRef.current = window.setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current
      const ratio = Math.min(1, elapsed / holdMs)
      setProgress(ratio)

      if (ratio >= 1 && !completedRef.current) {
        completedRef.current = true
        if (intervalRef.current !== null) {
          window.clearInterval(intervalRef.current)
          intervalRef.current = null
        }
        setIsHolding(false)
        void onConfirm()
      }
    }, 16)
  }

  function cancelHold() {
    if (!isHolding || completedRef.current) return
    resetHold()
  }

  const rootClassName = [
    'hold-to-confirm',
    className ?? '',
    disabled ? 'is-disabled' : '',
    loading ? 'is-loading' : '',
    isHolding ? 'is-holding' : '',
  ].filter(Boolean).join(' ')

  return (
    <button
      type="button"
      className={rootClassName}
      disabled={disabled || loading}
      onPointerDown={startHold}
      onPointerUp={cancelHold}
      onPointerLeave={cancelHold}
      onPointerCancel={cancelHold}
      aria-live="polite"
    >
      <span className="hold-to-confirm__progress" style={{ transform: `scaleX(${progress})` }} />
      <span className="hold-to-confirm__content">
        <strong className="hold-to-confirm__label">{loading ? 'Sending...' : label}</strong>
        {subLabel && <span className="hold-to-confirm__sub">{subLabel}</span>}
      </span>
    </button>
  )
}
