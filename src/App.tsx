import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { useAuth, type AppRole } from './hooks/useAuth'
import AuthScreen from './components/AuthScreen'
import SplashScreen from './components/SplashScreen'
import { identify, resetIdentity, track, startFlushLoop, AnalyticsEvent } from './lib/analytics'

const isStripeReturn =
  typeof window !== 'undefined' &&
  (
    window.location.href.includes('stripe_connect=return') ||
    window.location.href.includes('stripe_connect=refresh') ||
    window.location.pathname.includes('stripe-connect-return')
  )

if (isStripeReturn && typeof document !== 'undefined') {
  document.body.innerHTML = `
    <div style="
      height:100vh;
      display:flex;
      flex-direction:column;
      align-items:center;
      justify-content:center;
      font-family:sans-serif;
      text-align:center;
      padding:24px;
    ">
      <h2>Payout setup complete</h2>
      <p>Tap below to return to Regli</p>
      <button style="
        margin-top:20px;
        padding:12px 20px;
        font-size:16px;
        border-radius:12px;
        border:none;
        background:#000;
        color:#fff;
      " onclick="window.location.href='regli://stripe-connect-return'">
        Open Regli app
      </button>
      <p style="margin-top:12px;font-size:12px;color:#666;">
        If nothing happens, close this tab and return to Regli
      </p>
    </div>
  `

  window.setTimeout(() => {
    window.location.href = 'regli://stripe-connect-return'
  }, 500)

  throw new Error('Stripe return handled outside React')
}

const AdminDashboard = lazy(() => import('./screens/AdminDashboard'))
const ClientDashboard = lazy(() => import('./screens/ClientDashboard'))
const WalkerDashboard = lazy(() => import('./screens/WalkerDashboard'))

interface CapacitorAppUrlOpen {
  url: string
}

interface CapacitorAppPlugin {
  addListener(
    eventName: 'appUrlOpen',
    listenerFunc: (event: CapacitorAppUrlOpen) => void,
  ): Promise<PluginListenerHandle>
  getLaunchUrl(): Promise<{ url: string } | undefined>
}

const NativeApp = registerPlugin<CapacitorAppPlugin>('App')

function isProviderRole(role: string | null | undefined) {
  return role === 'walker' || role === 'provider'
}

function toDashboardRole(role: string | null | undefined): AppRole {
  if (role === 'admin') return 'admin'
  if (isProviderRole(role)) return 'walker'
  return 'client'
}

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
  const [wowRole, setWowRole] = useState<'provider' | 'customer' | null>(null)
  const [providerWowToken, setProviderWowToken] = useState(0)
  const [stripeReturnToken, setStripeReturnToken] = useState(0)
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

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return

    const handleNativeUrl = (url: string | null | undefined) => {
      const value = String(url ?? '')
      const isStripeReturn =
        value.startsWith('regli://stripe-connect-return') || value.includes('stripe_connect=return')

      if (!isStripeReturn) return

      console.log('[App] Native Stripe deep link received', { url: value })
      setStripeReturnToken((current) => current + 1)
    }

    let listener: PluginListenerHandle | null = null

    void NativeApp.addListener('appUrlOpen', ({ url }) => {
      handleNativeUrl(url)
    }).then((handle) => {
      listener = handle
    }).catch((error) => {
      console.warn('[App] appUrlOpen listener unavailable', error)
    })

    void NativeApp.getLaunchUrl()
      .then((result) => {
        handleNativeUrl(result?.url)
      })
      .catch((error) => {
        console.warn('[App] getLaunchUrl unavailable', error)
      })

    return () => {
      void listener?.remove()
    }
  }, [])

  // Auth is still resolving OR profile is still loading for a logged-in user.
  // If profile bootstrap failed, let the splash exit so the error/fallback UI can render.
  const isInitializing = loading

  // Resolve dashboard component as soon as profile is available —
  // this lets the map mount BEHIND the splash for a seamless morph transition
  const Dashboard = profile
    ? profile.role === 'admin'
      ? AdminDashboard
      : isProviderRole(profile.role)
        ? WalkerDashboard
        : ClientDashboard
    : null

  const dashboardProfile = profile
    ? {
        ...profile,
        role: toDashboardRole(profile.role),
      }
    : null

  useEffect(() => {
    if (!profile || typeof window === 'undefined') return
    const pendingWow = window.sessionStorage.getItem('regli:onboarding-wow')
    if (pendingWow === 'provider') {
      setProviderWowToken((value) => value + 1)
      setWowRole(null)
      window.sessionStorage.removeItem('regli:onboarding-wow')
      return
    }
    if (pendingWow === 'customer') {
      setWowRole('customer')
      window.sessionStorage.removeItem('regli:onboarding-wow')
      return
    }
    setWowRole(null)
  }, [profile])

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
          {dashboardProfile?.role === 'admin' ? (
            <AdminDashboard />
          ) : dashboardProfile?.role === 'walker' ? (
            <WalkerDashboard
              profile={dashboardProfile}
              onSignOut={signOut}
              showOnboardingWowToken={providerWowToken}
              stripeReturnToken={stripeReturnToken}
            />
          ) : (
            <ClientDashboard profile={dashboardProfile!} onSignOut={signOut} />
          )}
        </Suspense>
      )}

      {Dashboard && profile && wowRole === 'customer' && splashDone && (
        <div style={wowOverlayStyle}>
          <div style={wowCardStyle}>
            <div style={wowBadgeStyle}>💡</div>
            <div style={wowTitleStyle}>Ready to book your first service?</div>
            <div style={wowBodyStyle}>
              Everything is ready. Start exploring nearby providers and book your first service in just a few taps.
            </div>
            <button type="button" onClick={() => setWowRole(null)} style={wowButtonStyle}>
              Find a provider
            </button>
          </div>
        </div>
      )}

      {/* Auth screen — only after splash (no map to morph into) */}
      {splashDone && !session && (
        <AuthScreen
          onSignIn={signIn}
          onSignUp={signUp}
          authError={authError}
        />
      )}

      {/* Session but no profile yet — bounded fallback for delayed/failed bootstrap */}
      {splashDone && session && !profile && !authError && (
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
            <div style={{ fontSize: 13 }}>
              This should only take a moment.
            </div>
          </div>
        </div>
      )}

      {splashDone && session && !profile && authError && (
        <div
          style={{
            minHeight: '100svh',
            display: 'grid',
            placeItems: 'center',
            background: '#FAFAF8',
            fontFamily: 'Inter, system-ui, sans-serif',
            color: '#64748B',
            padding: 24,
          }}
        >
          <div style={{ width: 'min(100%, 360px)', textAlign: 'center' }}>
            <div style={{ fontWeight: 800, color: '#0F172A', marginBottom: 8 }}>
              We could not finish setting up your profile.
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 18 }}>
              {authError}
            </div>
            <button
              type="button"
              onClick={signOut}
              style={{
                width: '100%',
                minHeight: 48,
                border: 0,
                borderRadius: 12,
                background: '#0F172A',
                color: '#FFFFFF',
                fontWeight: 800,
                fontFamily: 'Inter, system-ui, sans-serif',
                cursor: 'pointer',
              }}
            >
              Return to sign in
            </button>
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

const wowOverlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 30,
  display: 'grid',
  placeItems: 'end center',
  padding:
    'calc(env(safe-area-inset-top, 0px) + 20px) 18px calc(env(safe-area-inset-bottom, 0px) + 24px)',
  background: 'linear-gradient(180deg, rgba(15,23,42,0.08) 0%, rgba(15,23,42,0.18) 100%)',
}

const wowCardStyle: CSSProperties = {
  width: 'min(100%, 420px)',
  borderRadius: 28,
  background: 'rgba(255,255,255,0.96)',
  border: '1px solid rgba(255,255,255,0.72)',
  boxShadow: '0 24px 60px rgba(15, 23, 42, 0.18)',
  padding: 22,
  display: 'grid',
  gap: 12,
  boxSizing: 'border-box',
  fontFamily: 'Inter, system-ui, sans-serif',
}

const wowBadgeStyle: CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: 16,
  background: 'rgba(91, 124, 250, 0.10)',
  display: 'grid',
  placeItems: 'center',
  fontSize: 24,
}

const wowTitleStyle: CSSProperties = {
  color: '#0F172A',
  fontSize: 28,
  lineHeight: 1.04,
  fontWeight: 900,
}

const wowBodyStyle: CSSProperties = {
  color: '#5E6B83',
  fontSize: 14,
  lineHeight: 1.55,
}

const wowButtonStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  minHeight: 54,
  borderRadius: 18,
  background: 'linear-gradient(180deg, #0F172A 0%, #233B74 100%)',
  color: '#FFFFFF',
  fontSize: 16,
  fontWeight: 800,
  cursor: 'pointer',
}
