import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { DashboardPage } from './pages/DashboardPage'
import { DeviceDetailPage } from './pages/DeviceDetailPage'
import { DevicesPage } from './pages/DevicesPage'
import { AlertsPage } from './pages/AlertsPage'
import { AlertDetailPage } from './pages/AlertDetailPage'
import { HistoryPage } from './pages/HistoryPage'
import { SystemPage } from './pages/SystemPage'
import { LoginPage } from './pages/LoginPage'
import { SettingsPage } from './pages/SettingsPage'
import { supabase } from './lib/supabase'

const LOCAL_TEST_MODE_KEY = 'argus-control-local-test-mode'

type ProtectedRouteProps = {
  isAuthenticated: boolean
  isBooting: boolean
  children: React.ReactNode
}

function ProtectedRoute({ isAuthenticated, isBooting, children }: ProtectedRouteProps) {
  if (isBooting) {
    return (
      <main className="auth-shell">
        <section className="panel auth-card">
          <div className="login-brand">
            <img className="login-brand__logo" src="/argus-lynk-logo.png" alt="Argus Lynk" />
            <div>
              <p className="eyebrow">Booting</p>
              <h1>Loading Argus Lynk</h1>
            </div>
          </div>
          <p className="muted-copy">Checking Supabase auth and local operator mode.</p>
        </section>
      </main>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [localMode, setLocalMode] = useState<boolean>(() => {
    return window.localStorage.getItem(LOCAL_TEST_MODE_KEY) === 'true'
  })
  const [isBooting, setIsBooting] = useState(true)

  useEffect(() => {
    window.localStorage.setItem(LOCAL_TEST_MODE_KEY, String(localMode))
  }, [localMode])

  useEffect(() => {
    let isActive = true

    async function hydrateSession() {
      if (!supabase) {
        if (isActive) {
          setIsBooting(false)
        }

        return
      }

      const { data } = await supabase.auth.getSession()

      if (isActive) {
        setSession(data.session)
        setIsBooting(false)
      }
    }

    void hydrateSession()

    const authSubscription = supabase?.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setIsBooting(false)
    })

    return () => {
      isActive = false
      authSubscription?.data.subscription.unsubscribe()
    }
  }, [])

  const isAuthenticated = Boolean(session) || localMode

  async function handleSignOut() {
    if (supabase && session) {
      await supabase.auth.signOut()
    }

    setSession(null)
    setLocalMode(false)
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={
          isAuthenticated ? (
            <Navigate to="/dashboard" replace />
          ) : (
            <LoginPage onContinueLocalMode={() => setLocalMode(true)} />
          )
        }
      />
      <Route
        element={
          <ProtectedRoute isAuthenticated={isAuthenticated} isBooting={isBooting}>
            <AppLayout localMode={localMode} onSignOut={handleSignOut} />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/devices" element={<DevicesPage />} />
        <Route path="/devices/:deviceId" element={<DeviceDetailPage />} />
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="/alerts/:alertId" element={<AlertDetailPage localMode={localMode} userId={session?.user.id ?? null} />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/system" element={<SystemPage />} />
        <Route
          path="/settings"
          element={<SettingsPage localMode={localMode} userId={session?.user.id ?? null} onSignOut={handleSignOut} />}
        />
      </Route>
      <Route
        path="*"
        element={<Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />}
      />
    </Routes>
  )
}

export default App
