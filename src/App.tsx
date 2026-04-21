import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from './hooks/useAuth'
import AuthScreen from './components/AuthScreen'
import SplashScreen from './components/SplashScreen'
import { identify, resetIdentity, track, startFlushLoop, AnalyticsEvent } from './lib/analytics'

const AdminDashboard = lazy(() => import('./screens/AdminDashboard'))
const ClientDashboard = lazy(() => import('./screens/ClientDashboard'))
const WalkerDashboard = lazy(() => import('./screens/WalkerDashboard'))

export default function App() {
  const {
    session,
    profile,
    loading,
    authError,
    signIn,
    signUp,
    signOut,
  } = useAuth()

  const [splashDone, setSplashDone] = useState(false)
  const handleSplashDone = useCallback(() => setSplashDone(true), [])

  // ── Analytics: identify + session ───────────────────────────
  const identifiedRef = useRef(false)

  useEffect(() => {
    startFlushLoop()
  }, [])

  useEffect(() => {
    if (profile && !identifiedRef.current) {
      identifiedRef.current = true
      identify(profile.id, profile.role)
      track(AnalyticsEvent.APP_OPENED, { source_screen: 'app' })
    }
    if (!session && identifiedRef.current) {
      identifiedRef.current = false
      resetIdentity()
    }
  }, [profile, session])

  // Auth is still resolving OR profile is still loading for a logged-in user.
  // If profile bootstrap failed, let the splash exit so the error/fallback UI can render.
  const isInitializing = loading

  // Resolve dashboard component as soon as profile is available —
  // this lets the map mount BEHIND the splash for a seamless morph transition
  const Dashboard = profile
    ? profile.role === 'admin'
      ? AdminDashboard
      : profile.role === 'walker'
        ? WalkerDashboard
        : ClientDashboard
    : null

  return (
    <>
      {/* ── Layer 1: Main content (renders behind splash) ──────── */}

      {/* Dashboard pre-renders during splash so the map is already painted
          when the splash dissolves — no white flash, no remount */}
      {Dashboard && (
        <Suspense
          fallback={
            <div
              style={{
                minHeight: '100svh',
                display: 'grid',
                placeItems: 'center',
                background: '#FAFAF8',
              }}
            >
              <div style={{ display: 'flex', gap: 6 }}>
                <span className="splash-dot splash-dot-1" />
                <span className="splash-dot splash-dot-2" />
                <span className="splash-dot splash-dot-3" />
              </div>
            </div>
          }
        >
          <Dashboard profile={profile!} onSignOut={signOut} />
        </Suspense>
      )}

      {/* Auth screen — only after splash (no map to morph into) */}
      {splashDone && !session && (
        <AuthScreen
          onSignIn={signIn}
          onSignUp={signUp}
          authError={authError}
        />
      )}

      {/* Session but no profile yet — very rare edge */}
      {splashDone && session && !profile && (
        <div
          style={{
            minHeight: '100svh',
            display: 'grid',
            placeItems: 'center',
            background: '#FAFAF8',
            fontFamily: 'Inter, system-ui, sans-serif',
            color: '#94A3B8',
          }}
        >
          <div style={{ padding: 24, textAlign: 'center' }}>
            <div style={{ fontWeight: 700, color: '#0F172A', marginBottom: 8 }}>
              Setting up your profile...
            </div>
            {authError && <div style={{ fontSize: 13 }}>{authError}</div>}
          </div>
        </div>
      )}

      {/* ── Layer 2: Splash overlay (on top, dissolves to reveal map) ── */}
      {!splashDone && (
        <SplashScreen
          ready={!isInitializing}
          authResolved={!loading}
          onDone={handleSplashDone}
        />
      )}
    </>
  )
}
