import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { isSupabaseConfigured, supabase } from '../lib/supabase'

type LoginPageProps = {
  onContinueLocalMode: () => void
}

export function LoginPage({ onContinueLocalMode }: LoginPageProps) {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!supabase) {
      setErrorMessage('Supabase environment values are missing. Add them in .env.local.')
      return
    }

    setIsSubmitting(true)
    setErrorMessage(null)

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    setIsSubmitting(false)

    if (error) {
      setErrorMessage(error.message)
      return
    }

    navigate('/dashboard', { replace: true })
  }

  function handleLocalMode() {
    onContinueLocalMode()
    navigate('/dashboard', { replace: true })
  }

  return (
    <main className="auth-shell">
      <section className="panel auth-card stack">
        <div>
          <p className="eyebrow">Field Controller Login</p>
          <h1>Argus Control</h1>
          <p className="section-copy">
            Sign in with a Supabase user, or enter local test mode while RLS remains disabled.
          </p>
        </div>

        {!isSupabaseConfigured && (
          <div className="alert alert--warning">
            Supabase is not configured yet. Copy .env.example to .env.local and set the URL and
            anon key.
          </div>
        )}

        {errorMessage && <div className="alert alert--danger">{errorMessage}</div>}

        <form className="stack" onSubmit={handleSubmit}>
          <label className="field">
            <span className="label">Email</span>
            <input
              type="email"
              autoComplete="email"
              placeholder="operator@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          <label className="field">
            <span className="label">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              placeholder="Enter your password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          <div className="auth-actions">
            <button type="submit" className="primary-button" disabled={isSubmitting || !supabase}>
              {isSubmitting ? 'Signing In...' : 'Sign In'}
            </button>
            <button type="button" className="secondary-button" onClick={handleLocalMode}>
              Enter Local Test Mode
            </button>
          </div>
        </form>
      </section>
    </main>
  )
}