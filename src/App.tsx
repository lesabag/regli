import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import {
  BiometricAuth,
  BiometryError,
  BiometryErrorType,
} from '@aparajita/capacitor-biometric-auth'
import { Browser } from '@capacitor/browser'
import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
import { useAuth, type AppRole } from './hooks/useAuth'
import AuthScreen from './components/AuthScreen'
import SplashScreen from './components/SplashScreen'
import { identify, resetIdentity, track, startFlushLoop, AnalyticsEvent } from './lib/analytics'
import { handleNativeStripeURLCallback, initializeNativeStripe } from './lib/nativeStripe'
import { emitPushDeepLink, parsePushDeepLink, PUSH_DEEP_LINK_EVENT, type ParsedPushDeepLink } from './lib/pushNotifications'
import { usePushNotifications } from './hooks/usePushNotifications'
import { disposeFirstInteractionPerf, initFirstInteractionPerf } from './utils/firstInteractionPerf'
import { warmHapticsBridge } from './utils/haptics'
import i18n from './i18n'

const isStripeReturn =
  typeof window !== 'undefined' &&
  (
    window.location.href.includes('stripe_connect=return') ||
    window.location.href.includes('stripe_connect=refresh') ||
    window.location.pathname.includes('stripe-connect-return')
  )

const isNativeOAuthReturn =
  typeof window !== 'undefined' &&
  Capacitor.isNativePlatform() &&
  (() => {
    const url = new URL(window.location.href)
    return (
      url.pathname === '/auth/callback' ||
      url.searchParams.has('code') ||
      url.searchParams.has('error') ||
      url.searchParams.has('error_description')
    )
  })()

if (isNativeOAuthReturn && typeof document !== 'undefined') {
  const nativeCallbackUrl = `regli://auth/callback${window.location.search}${window.location.hash}`
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
      <h2>Returning to Regli</h2>
      <p>Please wait while we reopen the app.</p>
      <button style="
        margin-top:20px;
        padding:12px 20px;
        font-size:16px;
        border-radius:12px;
        border:none;
        background:#000;
        color:#fff;
      " onclick="window.location.href='${nativeCallbackUrl}'">
        Open Regli app
      </button>
    </div>
  `

  window.setTimeout(() => {
    window.location.href = nativeCallbackUrl
  }, 100)

  throw new Error('Native OAuth return redirected to app')
}

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
// Re-lock only after a meaningful background period so quick app switching stays smooth.
const LOCAL_UNLOCK_RELOCK_AFTER_MS = 30 * 60 * 1000
const isNativeIos = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'

function safeCloseBrowser() {
  if (!Capacitor.isNativePlatform()) return
  void Browser.close().catch(() => undefined)
}

function LocalUnlockScreen(props: {
  busy: boolean
  errorMessage: string | null
  subtitle: string
  buttonLabel: string
  onUnlock: () => void
}) {
  const showPasscodeFallback = props.buttonLabel === 'Continue with passcode'

  return (
    <>
      <style>{`
        @keyframes regliUnlockOverlayFade {
          from {
            opacity: 0;
            backdrop-filter: blur(0px);
            -webkit-backdrop-filter: blur(0px);
          }
          to {
            opacity: 1;
            backdrop-filter: blur(32px);
            -webkit-backdrop-filter: blur(32px);
          }
        }

        @keyframes regliUnlockContentIn {
          from {
            opacity: 0;
            transform: translateY(8px) scale(0.985);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 70,
          overflow: 'hidden',
          display: 'grid',
          placeItems: 'center',
          padding: 'max(24px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom))',
          background: 'linear-gradient(180deg, rgba(2,6,23,0.34) 0%, rgba(2,6,23,0.52) 44%, rgba(15,23,42,0.68) 100%)',
          backdropFilter: 'blur(32px) saturate(0.96) brightness(0.82)',
          WebkitBackdropFilter: 'blur(32px) saturate(0.96) brightness(0.82)',
          animation: 'regliUnlockOverlayFade 240ms ease-out both',
          fontFamily: 'Inter, system-ui, sans-serif',
        }}
      >
        <div
          style={{
            width: 'min(100%, 420px)',
            display: 'grid',
            gap: 18,
            justifyItems: 'stretch',
            animation: 'regliUnlockContentIn 240ms ease-out both',
          }}
        >
          <div
            style={{
              display: 'grid',
              justifyItems: 'center',
              gap: 14,
              textAlign: 'center',
            }}
          >
            <div
              style={{
                width: 68,
                height: 68,
                borderRadius: 22,
                display: 'grid',
                placeItems: 'center',
                background: 'linear-gradient(180deg, rgba(255,255,255,0.78) 0%, rgba(255,255,255,0.56) 100%)',
                boxShadow: '0 18px 40px rgba(15, 23, 42, 0.14), inset 0 1px 0 rgba(255,255,255,0.55)',
                border: '1px solid rgba(255,255,255,0.52)',
              }}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M7 10V7.5C7 4.73858 9.23858 2.5 12 2.5C14.7614 2.5 17 4.73858 17 7.5V10"
                  stroke="#0F172A"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
                <rect
                  x="5"
                  y="10"
                  width="14"
                  height="11"
                  rx="3"
                  stroke="#0F172A"
                  strokeWidth="1.8"
                />
                <circle cx="12" cy="15.5" r="1.25" fill="#0F172A" />
              </svg>
            </div>
            <div
              style={{
                fontSize: 28,
                lineHeight: 1.08,
                fontWeight: 900,
                color: '#0F172A',
                letterSpacing: '-0.02em',
              }}
            >
              Unlock Regli
            </div>
            <div
              style={{
                fontSize: 15,
                lineHeight: 1.45,
                color: '#334155',
                fontWeight: 600,
                maxWidth: 280,
              }}
            >
              {props.subtitle}
            </div>
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            <button
              type="button"
              onClick={props.onUnlock}
              disabled={props.busy}
              style={{
                width: '100%',
                minHeight: 54,
                border: 0,
                borderRadius: 18,
                background: props.busy ? '#6B7A93' : '#08153B',
                color: '#FFFFFF',
                fontSize: 16,
                fontWeight: 800,
                cursor: props.busy ? 'default' : 'pointer',
                transition: 'transform 160ms ease, background 160ms ease, opacity 160ms ease',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                boxShadow: '0 16px 36px rgba(8,21,59,0.24)',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M7 10V7.5C7 4.73858 9.23858 2.5 12 2.5C14.7614 2.5 17 4.73858 17 7.5V10"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
                <rect
                  x="5"
                  y="10"
                  width="14"
                  height="11"
                  rx="3"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
              </svg>
              <span>{props.busy ? 'Unlocking...' : props.buttonLabel}</span>
            </button>

            {showPasscodeFallback ? (
              <button
                type="button"
                onClick={props.onUnlock}
                disabled={props.busy}
                style={{
                  width: '100%',
                  minHeight: 50,
                  borderRadius: 18,
                  border: '1px solid rgba(15,23,42,0.12)',
                  background: 'rgba(255,255,255,0.56)',
                  color: '#0F172A',
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: props.busy ? 'default' : 'pointer',
                  backdropFilter: 'blur(12px)',
                  WebkitBackdropFilter: 'blur(12px)',
                }}
              >
                Use device passcode instead
              </button>
            ) : null}
          </div>

          {props.errorMessage ? (
            <div
              style={{
                justifySelf: 'center',
                padding: '10px 12px',
                borderRadius: 14,
                background: 'rgba(255,247,237,0.84)',
                color: '#9A3412',
                fontSize: 13,
                lineHeight: 1.4,
                fontWeight: 600,
                textAlign: 'center',
                maxWidth: 320,
              }}
            >
              {props.errorMessage}
            </div>
          ) : null}

          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              fontSize: 12,
              lineHeight: 1.4,
              color: 'rgba(15,23,42,0.66)',
              fontWeight: 600,
              textAlign: 'center',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 3L19 6V11.5C19 16.2 15.9 20.42 12 21.5C8.1 20.42 5 16.2 5 11.5V6L12 3Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
            </svg>
            <span>Your data stays private and secure</span>
          </div>
        </div>
      </div>
    </>
  )
}

function isProviderRole(role: string | null | undefined) {
  return role === 'walker' || role === 'provider'
}

function toDashboardRole(role: string | null | undefined): AppRole {
  if (role === 'admin') return 'admin'
  if (isProviderRole(role)) return 'walker'
  return 'client'
}

function isWebOAuthCallbackInProgress() {
  if (typeof window === 'undefined') return false
  const url = new URL(window.location.href)
  return (
    url.pathname === '/auth/callback' ||
    url.searchParams.has('code') ||
    url.searchParams.has('error') ||
    url.searchParams.has('error_description')
  )
}

function isNativeAuthCallbackUrl(value: string | null | undefined): boolean {
  const urlValue = String(value ?? '').trim()
  if (!urlValue) return false

  try {
    const parsed = new URL(urlValue)
    return (
      parsed.protocol === 'regli:' &&
      parsed.hostname === 'auth' &&
      (parsed.pathname === '/callback' || parsed.pathname === '/callback/')
    )
  } catch {
    return urlValue.startsWith('regli://auth/callback')
  }
}

export default function App() {
  const {
    session,
    user,
    profile,
    profileReady,
    needsOnboarding,
    loading,
    authError,
    appleSignInEnabled,
    signIn,
    signUp,
    signInWithGoogle,
    signInWithApple,
    completeOnboarding,
    handleNativeOAuthCallback,
    signOut,
  } = useAuth()

  const [splashDone, setSplashDone] = useState(false)
  const [providerWowToken, setProviderWowToken] = useState(0)
  const [customerWowToken, setCustomerWowToken] = useState(0)
  const [stripeReturnToken, setStripeReturnToken] = useState(0)
  const [oauthRoutePending, setOauthRoutePending] = useState(() => isWebOAuthCallbackInProgress())
  const [, setPendingPushRoute] = useState<ParsedPushDeepLink | null>(null)
  const [localUnlockState, setLocalUnlockState] = useState<'locked' | 'unlocking' | 'unlocked'>('unlocked')
  const [localUnlockError, setLocalUnlockError] = useState<string | null>(null)
  const [localUnlockSupportsPasscodeOnly, setLocalUnlockSupportsPasscodeOnly] = useState(false)
  const handleSplashDone = useCallback(() => setSplashDone(true), [])
  const backgroundedAtRef = useRef<number | null>(null)
  const lastUnlockedUserIdRef = useRef<string | null>(null)
  const hasCompletedInitialUnlockRef = useRef(false)
  const hasAutoPromptedLocalUnlockRef = useRef(false)

  // ── Analytics: identify + session ───────────────────────────
  const identifiedRef = useRef(false)

  useEffect(() => {
    startFlushLoop()
  }, [])

  useEffect(() => {
    initFirstInteractionPerf()
    return () => {
      disposeFirstInteractionPerf()
    }
  }, [])

  useEffect(() => {
    const win = window as Window &
      typeof globalThis & {
        requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
        cancelIdleCallback?: (handle: number) => void
      }
    let rafId = 0
    let timeoutId = 0
    let fallbackTimeoutId = 0
    let idleId: number | null = null

    const warm = () => {
      warmHapticsBridge()
    }

    rafId = win.requestAnimationFrame(() => {
      timeoutId = win.setTimeout(warm, 100)
      if (typeof win.requestIdleCallback === 'function') {
        idleId = win.requestIdleCallback(warm, { timeout: 500 })
      } else {
        fallbackTimeoutId = win.setTimeout(warm, 0)
      }
    })

    return () => {
      win.cancelAnimationFrame(rafId)
      win.clearTimeout(timeoutId)
      win.clearTimeout(fallbackTimeoutId)
      if (idleId != null && typeof win.cancelIdleCallback === 'function') {
        win.cancelIdleCallback(idleId)
      }
    }
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
    const preferredLanguage = profile?.preferred_language
    if (!preferredLanguage) return
    if (i18n.resolvedLanguage === preferredLanguage) return
    void i18n.changeLanguage(preferredLanguage)
  }, [profile?.preferred_language])

  useEffect(() => {
    if (!isNativeIos) return
    void initializeNativeStripe()
  }, [])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return

    const handleNativeUrl = async (url: string | null | undefined) => {
      const value = String(url ?? '')
      const isStripeReturn =
        value.startsWith('regli://stripe-connect-return') || value.includes('stripe_connect=return')

      if (isNativeAuthCallbackUrl(value)) {
        try {
          await handleNativeOAuthCallback(value)
        } catch (error) {
          console.warn('[App] OAuth callback handling failed', error)
        } finally {
          safeCloseBrowser()
        }
        return
      }

      const pushRoute = parsePushDeepLink(value)
      if (pushRoute) {
        emitPushDeepLink(pushRoute)
        safeCloseBrowser()
        return
      }

      const nativeStripeHandled = await handleNativeStripeURLCallback(value)
      if (nativeStripeHandled) {
        safeCloseBrowser()
        return
      }

      if (isStripeReturn) {
        console.log('[App] Native Stripe deep link received', { url: value })
        setStripeReturnToken((current) => current + 1)
      }
    }

    let listener: PluginListenerHandle | null = null

    void CapacitorApp.addListener('appUrlOpen', ({ url }) => {
      void handleNativeUrl(url)
    }).then((handle) => {
      listener = handle
    }).catch((error) => {
      console.warn('[App] appUrlOpen listener unavailable', error)
    })

    void CapacitorApp.getLaunchUrl()
      .then((result) => {
        void handleNativeUrl(result?.url)
      })
      .catch((error) => {
        console.warn('[App] getLaunchUrl unavailable', error)
      })

    return () => {
      void listener?.remove()
    }
  }, [handleNativeOAuthCallback])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const handlePushDeepLink = (event: Event) => {
      const route = (event as CustomEvent<ParsedPushDeepLink>).detail
      if (!route) return

      // Placeholder routing handoff for future push-driven navigation.
      // Real screen-level navigation can subscribe here later without changing push payloads.
      setPendingPushRoute(route)
    }

    window.addEventListener(PUSH_DEEP_LINK_EVENT, handlePushDeepLink as EventListener)
    return () => {
      window.removeEventListener(PUSH_DEEP_LINK_EVENT, handlePushDeepLink as EventListener)
    }
  }, [])

  // Auth is still resolving OR profile is still loading for a logged-in user.
  // If profile bootstrap failed, let the splash exit so the error/fallback UI can render.
  const isInitializing = loading

  // Resolve dashboard only after splash teardown so heavy dashboard/map mount
  // cannot compete with the user's first visible interaction on cold launch.
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
      window.sessionStorage.removeItem('regli:onboarding-wow')
      // COST INVARIANT: creating a PayMe Seller has a per-provider setup cost, so
      // it must NOT be triggered by registration/onboarding. Completing provider
      // registration deliberately does NOT contact PayMe. Seller creation happens
      // ONLY behind an explicit provider activation action (see
      // src/payments/providerActivation.ts). Do not move any PayMe call back into
      // this registration effect.
      return
    }
    if (pendingWow === 'customer') {
      setCustomerWowToken((value) => value + 1)
      window.sessionStorage.removeItem('regli:onboarding-wow')
      return
    }
  }, [profile])

  useEffect(() => {
    if (!oauthRoutePending) return
    if (loading) return
    if (session || authError || !isWebOAuthCallbackInProgress()) {
      setOauthRoutePending(false)
    }
  }, [authError, loading, oauthRoutePending, session])

  const hasAuthenticatedUser = !!(session?.user ?? user)
  const shouldShowAuthScreen = splashDone && !hasAuthenticatedUser && !loading && !oauthRoutePending
  const shouldShowProfileBootstrap = splashDone && hasAuthenticatedUser && !profile && !authError
  const shouldShowProfileError = splashDone && hasAuthenticatedUser && !profile && authError
  const shouldShowAuthenticatedOnboarding =
    splashDone && hasAuthenticatedUser && !!profile && needsOnboarding && !authError
  const shouldRequireLocalUnlock = splashDone && isNativeIos && !!dashboardProfile && hasAuthenticatedUser
  const shouldShowUnlockedDashboard =
    splashDone &&
    Dashboard &&
    profileReady &&
    !needsOnboarding &&
    (!shouldRequireLocalUnlock || localUnlockState === 'unlocked')
  const localUnlockUserId = dashboardProfile?.id ?? session?.user?.id ?? user?.id ?? null
  const localUnlockActive = shouldRequireLocalUnlock && localUnlockState !== 'unlocked'

  usePushNotifications(splashDone && profileReady ? dashboardProfile?.id ?? null : null)

  const lockDashboard = useCallback((reason: 'initial' | 'resume') => {
    if (!isNativeIos) return
    setLocalUnlockState('locked')
    setLocalUnlockError(null)
    if (reason === 'resume') return
  }, [])

  const unlockDashboard = useCallback(async () => {
    if (!shouldRequireLocalUnlock) return

    setLocalUnlockState('unlocking')
    setLocalUnlockError(null)

    try {
      const availability = await BiometricAuth.checkBiometry()
      const shouldPreferPasscode = !availability.isAvailable && availability.deviceIsSecure
      setLocalUnlockSupportsPasscodeOnly(shouldPreferPasscode)

      if (!availability.isAvailable && !availability.deviceIsSecure) {
        setLocalUnlockState('locked')
        setLocalUnlockError('This device does not have Face ID or a device passcode enabled yet.')
        return
      }

      const authenticateOptions = {
        reason: 'Unlock Regli',
        cancelTitle: 'Cancel',
        allowDeviceCredential: true,
        iosFallbackTitle: 'Use Passcode',
      }
      await BiometricAuth.authenticate(authenticateOptions)
      setLocalUnlockState('unlocked')
      setLocalUnlockError(null)
      lastUnlockedUserIdRef.current = localUnlockUserId
      hasCompletedInitialUnlockRef.current = true
      backgroundedAtRef.current = null
    } catch (error) {
      const nextMessage = error instanceof BiometryError
        ? mapBiometryErrorToMessage(error)
        : 'Unable to use Face ID right now. Please try again.'
      setLocalUnlockState('locked')
      setLocalUnlockError(nextMessage)
    }
  }, [localUnlockUserId, shouldRequireLocalUnlock])

  useEffect(() => {
    if (!shouldRequireLocalUnlock) {
      setLocalUnlockState('unlocked')
      setLocalUnlockError(null)
      setLocalUnlockSupportsPasscodeOnly(false)
      hasCompletedInitialUnlockRef.current = false
      lastUnlockedUserIdRef.current = null
      hasAutoPromptedLocalUnlockRef.current = false
      return
    }

    if (!localUnlockUserId) {
      setLocalUnlockState('unlocked')
      setLocalUnlockError(null)
      return
    }

    if (lastUnlockedUserIdRef.current !== localUnlockUserId) {
      lastUnlockedUserIdRef.current = localUnlockUserId
      setLocalUnlockState('unlocked')
      setLocalUnlockError(null)
      setLocalUnlockSupportsPasscodeOnly(false)
      hasCompletedInitialUnlockRef.current = false
      hasAutoPromptedLocalUnlockRef.current = false
    }
  }, [
    localUnlockUserId,
    shouldRequireLocalUnlock,
  ])

  useEffect(() => {
    if (!localUnlockActive) {
      hasAutoPromptedLocalUnlockRef.current = false
      return
    }

    if (localUnlockState !== 'locked') return
    if (hasAutoPromptedLocalUnlockRef.current) return

    hasAutoPromptedLocalUnlockRef.current = true
    void unlockDashboard()
  }, [localUnlockActive, localUnlockState, unlockDashboard])

  useEffect(() => {
    if (!shouldRequireLocalUnlock) return undefined

    let listener: PluginListenerHandle | null = null

    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        backgroundedAtRef.current = Date.now()
        return
      }

      const backgroundedAt = backgroundedAtRef.current
      backgroundedAtRef.current = null
      if (!backgroundedAt) return
      if (Date.now() - backgroundedAt < LOCAL_UNLOCK_RELOCK_AFTER_MS) return
      if (!hasCompletedInitialUnlockRef.current) {
        hasCompletedInitialUnlockRef.current = true
      }
      lockDashboard('resume')
    }).then((handle) => {
      listener = handle
    }).catch(() => undefined)

    return () => {
      void listener?.remove()
    }
  }, [lockDashboard, shouldRequireLocalUnlock])

  const dashboardContent = useMemo(() => {
    if (!dashboardProfile) return null
    if (dashboardProfile.role === 'admin') {
      return <AdminDashboard />
    }
    if (dashboardProfile.role === 'walker') {
      return (
        <WalkerDashboard
          profile={dashboardProfile}
          onSignOut={signOut}
          showOnboardingWowToken={providerWowToken}
          stripeReturnToken={stripeReturnToken}
        />
      )
    }
    return (
      <ClientDashboard
        profile={dashboardProfile}
        onSignOut={signOut}
        showOnboardingWowToken={customerWowToken}
      />
    )
  }, [
    customerWowToken,
    dashboardProfile,
    providerWowToken,
    signOut,
    stripeReturnToken,
  ])

  return (
    <>
      {/* ── Layer 1: Main content (renders behind splash) ──────── */}

      {shouldShowUnlockedDashboard && (
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
          {dashboardContent}
        </Suspense>
      )}

      {localUnlockActive && (
        <LocalUnlockScreen
          busy={localUnlockState === 'unlocking'}
          errorMessage={localUnlockError}
          subtitle={localUnlockSupportsPasscodeOnly ? 'Use your device passcode to continue' : 'Use Face ID to continue'}
          buttonLabel={localUnlockSupportsPasscodeOnly ? 'Continue with passcode' : 'Continue with Face ID'}
          onUnlock={() => {
            void unlockDashboard()
          }}
        />
      )}

      {/* Auth screen — only after splash (no map to morph into) */}
      {shouldShowAuthScreen && (
        <AuthScreen
          onSignIn={signIn}
          onSignUp={signUp}
          onGoogleSignIn={signInWithGoogle}
          onAppleSignIn={signInWithApple}
          appleSignInEnabled={appleSignInEnabled}
          authError={authError}
        />
      )}

      {shouldShowAuthenticatedOnboarding && (
        <AuthScreen
          onSignIn={signIn}
          onSignUp={signUp}
          onGoogleSignIn={signInWithGoogle}
          onAppleSignIn={signInWithApple}
          onCompleteOnboarding={completeOnboarding}
          onStartOver={signOut}
          appleSignInEnabled={appleSignInEnabled}
          authenticatedOnboarding
          initialRole={toDashboardRole(profile.role)}
          initialLocationAddress={profile.location_address ?? null}
          initialShortBio={profile.short_bio ?? null}
          initialServiceTypes={profile.service_types ?? (profile.service_type ? [profile.service_type] : null)}
          initialServiceAttributes={profile.service_attributes ?? null}
          authError={authError}
        />
      )}

      {/* Session but no profile yet — bounded fallback for delayed/failed bootstrap */}
      {shouldShowProfileBootstrap && (
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

      {shouldShowProfileError && (
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

function mapBiometryErrorToMessage(error: BiometryError): string {
  switch (error.code) {
    case BiometryErrorType.userCancel:
    case BiometryErrorType.systemCancel:
    case BiometryErrorType.appCancel:
      return ''
    case BiometryErrorType.biometryNotAvailable:
      return 'Face ID is not available on this device. You can try using your device passcode.'
    case BiometryErrorType.biometryNotEnrolled:
      return 'Face ID is not set up yet. You can try using your device passcode.'
    case BiometryErrorType.passcodeNotSet:
    case BiometryErrorType.noDeviceCredential:
      return 'Set up a device passcode to unlock Regli on this device.'
    case BiometryErrorType.biometryLockout:
      return 'Face ID is temporarily locked. Use your device passcode to continue.'
    case BiometryErrorType.authenticationFailed:
      return 'Face ID did not recognize you. Please try again.'
    default:
      return 'Unable to use Face ID right now. Please try again.'
  }
}
