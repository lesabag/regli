import { Browser } from '@capacitor/browser'
import { Capacitor } from '@capacitor/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../services/supabaseClient'
import { normalizeProfileServiceTypes, type ProfileServiceType } from '../lib/profileServiceTypes'
import {
  buildProviderCapabilityRows,
  buildProviderSignupCapabilities,
  mergeProviderCapabilitiesSources,
} from '../lib/providerCapabilities'
import { disableCurrentPushTokenForUser } from './usePushNotifications'
import { LANGUAGE_STORAGE_KEY, normalizeSupportedLanguage, type SupportedLanguage } from '../i18n'

export type AppRole = 'client' | 'walker' | 'admin'
export type ProfileRole = AppRole | 'provider' | 'customer'

export type ServiceAttributes = Record<string, Record<string, unknown>>

interface Profile {
  id: string
  email: string | null
  full_name: string | null
  avatar_url?: string | null
  role: ProfileRole
  preferred_language?: SupportedLanguage | null
  short_bio?: string | null
  whatsapp_number?: string | null
  primary_service?: string | null
  location_address?: string | null
  service_type?: ProfileServiceType | null
  service_types?: ProfileServiceType[] | null
  service_attributes?: ServiceAttributes | null
}

const SESSION_INIT_TIMEOUT_MS = 8000
const PROFILE_LOAD_TIMEOUT_MS = 8000
const OAUTH_ONBOARDING_CONTEXT_KEY = 'regli:oauth-onboarding-context'
const OAUTH_PROVIDER_STORAGE_KEY = 'regli:oauth-provider'
const SIGNUP_STEP_STORAGE_KEY = 'regli_signup_step'

type OAuthOnboardingContext = {
  role: AppRole
  primaryService?: string
  locationAddress?: string
  shortBio?: string
  serviceTypes?: ProfileServiceType[]
  serviceAttributes?: ServiceAttributes | null
}

function getErrorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback
}

function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, message: string) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId)
  })
}

function readOAuthOnboardingContext(): OAuthOnboardingContext | null {
  if (typeof window === 'undefined') return null
  const raw = window.sessionStorage.getItem(OAUTH_ONBOARDING_CONTEXT_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as OAuthOnboardingContext
    return {
      ...parsed,
      role: parsed.role === 'admin' ? 'client' : parsed.role,
      serviceTypes: normalizeProfileServiceTypes(parsed.serviceTypes),
    }
  } catch {
    return null
  }
}

function writeOAuthOnboardingContext(context: OAuthOnboardingContext) {
  if (typeof window === 'undefined') return
  window.sessionStorage.setItem(OAUTH_ONBOARDING_CONTEXT_KEY, JSON.stringify({
    ...context,
    role: context.role === 'admin' ? 'client' : context.role,
    serviceTypes: normalizeProfileServiceTypes(context.serviceTypes),
  }))
}

function clearOAuthOnboardingContext() {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(OAUTH_ONBOARDING_CONTEXT_KEY)
}

function readPendingOAuthProvider(): 'google' | 'apple' | null {
  if (typeof window === 'undefined') return null
  const raw = window.sessionStorage.getItem(OAUTH_PROVIDER_STORAGE_KEY)
  return raw === 'google' || raw === 'apple' ? raw : null
}

function writePendingOAuthProvider(provider: 'google' | 'apple') {
  if (typeof window === 'undefined') return
  window.sessionStorage.setItem(OAUTH_PROVIDER_STORAGE_KEY, provider)
}

function clearPendingOAuthProvider() {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(OAUTH_PROVIDER_STORAGE_KEY)
}

function getUserDisplayName(currentUser: User): string | null {
  const metadataName = currentUser.user_metadata?.full_name
    ?? currentUser.user_metadata?.name
    ?? currentUser.user_metadata?.user_name

  return typeof metadataName === 'string' && metadataName.trim().length > 0
    ? metadataName.trim()
    : null
}

function getUserAvatarUrl(currentUser: User): string | null {
  const metadataAvatar = currentUser.user_metadata?.avatar_url
    ?? currentUser.user_metadata?.picture

  return typeof metadataAvatar === 'string' && metadataAvatar.trim().length > 0
    ? metadataAvatar
    : null
}

function getDefaultPreferredLanguage(currentUser: User): SupportedLanguage {
  const fromUserMetadata =
    normalizeSupportedLanguage(currentUser.user_metadata?.preferred_language as string | undefined) ??
    normalizeSupportedLanguage(currentUser.user_metadata?.language as string | undefined)

  if (fromUserMetadata) return fromUserMetadata

  if (typeof window !== 'undefined') {
    const fromStorage = normalizeSupportedLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY))
    if (fromStorage) return fromStorage
  }

  return 'en'
}

function getFallbackProfile(currentUser: User): Profile {
  const pendingContext = readOAuthOnboardingContext()
  const fallbackServiceTypes = normalizeProfileServiceTypes(
    currentUser.user_metadata?.service_types ?? pendingContext?.serviceTypes,
  )
  const fallbackRole = (currentUser.user_metadata?.role as ProfileRole | undefined)
    ?? pendingContext?.role
    ?? 'client'
  return {
    id: currentUser.id,
    email: currentUser.email ?? null,
    full_name: getUserDisplayName(currentUser),
    avatar_url: getUserAvatarUrl(currentUser),
    role: fallbackRole,
    preferred_language: getDefaultPreferredLanguage(currentUser),
    short_bio:
      (currentUser.user_metadata?.short_bio as string | undefined) ?? pendingContext?.shortBio ?? null,
    primary_service:
      (currentUser.user_metadata?.primary_service as string | undefined) ?? pendingContext?.primaryService ?? null,
    location_address:
      (currentUser.user_metadata?.location_address as string | undefined) ?? pendingContext?.locationAddress ?? null,
    service_attributes: pendingContext?.serviceAttributes ?? null,
    service_types: fallbackServiceTypes,
    service_type:
      fallbackServiceTypes[0] ??
      ((currentUser.user_metadata?.service_type as ProfileServiceType | undefined) ?? null),
  }
}

function normalizeLoadedProfile(profile: Partial<Profile> & { id: string }): Profile {
  const normalizedServiceTypes = normalizeProfileServiceTypes(profile.service_types ?? profile.service_type)
  return {
    ...profile,
    email: profile.email ?? null,
    full_name: profile.full_name ?? null,
    avatar_url: profile.avatar_url ?? null,
    role: profile.role ?? 'client',
    preferred_language: normalizeSupportedLanguage(profile.preferred_language ?? null),
    service_type: normalizedServiceTypes[0] ?? normalizeProfileServiceTypeFallback(profile.service_type),
    service_types: normalizedServiceTypes,
  }
}

function normalizeProfileServiceTypeFallback(value: Profile['service_type']): ProfileServiceType | null {
  return typeof value === 'string' ? (normalizeProfileServiceTypes(value)[0] ?? null) : value ?? null
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function hasProviderProfileDetails(serviceAttributes: ServiceAttributes | null | undefined): boolean {
  if (!serviceAttributes || typeof serviceAttributes !== 'object') return false
  const providerProfile = serviceAttributes.provider_profile
  return !!providerProfile && typeof providerProfile === 'object'
}

function isProfileOnboardingComplete(profile: Profile): boolean {
  if (profile.role === 'admin') return true

  if (profile.role === 'walker' || profile.role === 'provider') {
    const normalizedServiceTypes = normalizeProfileServiceTypes(profile.service_types ?? profile.service_type)
    return (
      hasText(profile.location_address) &&
      hasText(profile.short_bio) &&
      normalizedServiceTypes.length > 0 &&
      hasProviderProfileDetails(profile.service_attributes)
    )
  }

  return hasText(profile.location_address)
}

async function hydrateProviderProfileFromCapabilities(profile: Profile): Promise<Profile> {
  if (profile.role !== 'walker' && profile.role !== 'provider') {
    return profile
  }

  const { data, error } = await withTimeout(
    supabase
      .from('provider_capabilities')
      .select('provider_id, capability_scope, capabilities')
      .eq('provider_id', profile.id),
    PROFILE_LOAD_TIMEOUT_MS,
    'Provider capabilities loading timed out',
  )

  if (error) {
    console.warn('[useAuth] provider_capabilities load failed during profile hydration:', error.message)
    return profile
  }

  const mergedCapabilities = mergeProviderCapabilitiesSources({
    rows: (data as Array<{ provider_id: string; capability_scope: string; capabilities: Record<string, unknown> }> | null) ?? [],
    fallbackServiceAttributes: profile.service_attributes ?? null,
    shortBio: profile.short_bio ?? null,
  })

  return {
    ...profile,
    service_attributes: Object.keys(mergedCapabilities).length > 0 ? mergedCapabilities : profile.service_attributes ?? null,
  }
}

function getGoogleOAuthRedirectTo(): string {
  if (Capacitor.isNativePlatform()) {
    return 'regli://auth/callback'
  }

  return `${window.location.origin}/`
}

function isAppleAuthEnabled(): boolean {
  return String(import.meta.env.VITE_APPLE_AUTH_ENABLED ?? '').toLowerCase() === 'true'
}

function isAppleAuthSupportedOnCurrentPlatform(): boolean {
  if (!isAppleAuthEnabled()) return false
  if (Capacitor.isNativePlatform()) {
    return Capacitor.getPlatform() === 'ios'
  }
  return true
}

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profileReady, setProfileReady] = useState(false)
  const [needsOnboarding, setNeedsOnboarding] = useState(false)
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const profileRequestRef = useRef(0)
  const appleBootstrapPromiseRef = useRef<Promise<Profile | null> | null>(null)
  const appleBootstrapUserIdRef = useRef<string | null>(null)
  const pendingOAuthProviderRef = useRef<'google' | 'apple' | null>(readPendingOAuthProvider())

  // ✅ יצירה/טעינה של פרופיל
  const loadProfile = useCallback(async (currentUser: User) => {
    const requestId = profileRequestRef.current + 1
    profileRequestRef.current = requestId
    const fallbackProfile = getFallbackProfile(currentUser)

    const isCurrentRequest = () =>
      mountedRef.current && profileRequestRef.current === requestId

    try {
      let data: Profile | null = null
      let error: {
        code?: string | null
        message?: string | null
        details?: string | null
        hint?: string | null
        status?: number | null
      } | null = null

      try {
        const lookupResult = await withTimeout(
          supabase
            .from('profiles')
            .select('*')
            .eq('id', currentUser.id)
            .maybeSingle(),
          PROFILE_LOAD_TIMEOUT_MS,
          'Profile loading timed out',
        )
        data = (lookupResult.data as Profile | null) ?? null
        error = lookupResult.error
          ? {
              code: lookupResult.error.code ?? null,
              message: lookupResult.error.message ?? null,
              details: lookupResult.error.details ?? null,
              hint: lookupResult.error.hint ?? null,
              status: 'status' in lookupResult.error && typeof lookupResult.error.status === 'number'
                ? lookupResult.error.status
                : null,
            }
          : null
      } catch (lookupError) {
        throw lookupError
      }

      if (!isCurrentRequest()) return null

      if (!error && data) {
        const patchPayload: Partial<Profile> = {}
        const currentName = getUserDisplayName(currentUser)
        const currentAvatarUrl = getUserAvatarUrl(currentUser)

        if ((data.email ?? null) !== (currentUser.email ?? null) && currentUser.email) {
          patchPayload.email = currentUser.email
        }
        if (!(typeof data.full_name === 'string' && data.full_name.trim()) && currentName) {
          patchPayload.full_name = currentName
        }
        if (!(typeof data.avatar_url === 'string' && data.avatar_url.trim()) && currentAvatarUrl) {
          patchPayload.avatar_url = currentAvatarUrl
        }

        let nextProfileData = data as Profile
        if (Object.keys(patchPayload).length > 0) {
          const { data: updatedProfile, error: updateError } = await withTimeout(
            supabase
              .from('profiles')
              .update(patchPayload)
              .eq('id', currentUser.id)
              .select('*')
              .single(),
            PROFILE_LOAD_TIMEOUT_MS,
            'Profile refresh timed out',
          )

          if (!isCurrentRequest()) return null

          if (!updateError && updatedProfile) {
            nextProfileData = updatedProfile as Profile
          }
        }

        const hydratedProfile = await hydrateProviderProfileFromCapabilities(nextProfileData as Profile)
        if (!isCurrentRequest()) return null

        clearOAuthOnboardingContext()
        clearPendingOAuthProvider()
        pendingOAuthProviderRef.current = null
        const normalizedProfile = normalizeLoadedProfile(hydratedProfile)
        const onboardingComplete = isProfileOnboardingComplete(normalizedProfile)
        setProfile(normalizedProfile)
        setProfileReady(onboardingComplete)
        setNeedsOnboarding(!onboardingComplete)
        setAuthError(null)
        return normalizedProfile
      }

      if (error) {
        throw error
      }

      // 🔥 יצירה אוטומטית אם לא קיים
      let insertedProfile: Profile | null = null
      let insertError: {
        code?: string | null
        message?: string | null
        details?: string | null
        hint?: string | null
        status?: number | null
      } | null = null

      try {
        const insertResult = await withTimeout(
          supabase
            .from('profiles')
            .upsert({
              id: fallbackProfile.id,
              email: fallbackProfile.email,
              full_name: fallbackProfile.full_name,
              avatar_url: fallbackProfile.avatar_url ?? null,
              role: fallbackProfile.role,
              preferred_language: fallbackProfile.preferred_language ?? null,
              short_bio: fallbackProfile.short_bio ?? null,
              primary_service: fallbackProfile.primary_service ?? null,
              location_address: fallbackProfile.location_address ?? null,
              service_type: fallbackProfile.service_type ?? null,
              service_types: fallbackProfile.service_types ?? null,
              service_attributes: fallbackProfile.service_attributes ?? null,
            }, { onConflict: 'id' })
            .select()
            .single(),
          PROFILE_LOAD_TIMEOUT_MS,
          'Profile setup timed out',
        )
        insertedProfile = (insertResult.data as Profile | null) ?? null
        insertError = insertResult.error
          ? {
              code: insertResult.error.code ?? null,
              message: insertResult.error.message ?? null,
              details: insertResult.error.details ?? null,
              hint: insertResult.error.hint ?? null,
              status: 'status' in insertResult.error && typeof insertResult.error.status === 'number'
                ? insertResult.error.status
                : null,
            }
          : null
      } catch (profileInsertError) {
        throw profileInsertError
      }

      if (!isCurrentRequest()) return null

      if (insertError) {
        throw insertError
      }

      const pendingContext = readOAuthOnboardingContext()
      if ((fallbackProfile.role === 'walker' || pendingContext?.role === 'walker') && pendingContext?.serviceAttributes) {
        const normalizedProviderCapabilities = buildProviderSignupCapabilities({
          serviceAttributes: pendingContext.serviceAttributes,
          shortBio: pendingContext.shortBio ?? null,
        })
        const providerCapabilityRows = buildProviderCapabilityRows(currentUser.id, normalizedProviderCapabilities)
          .map((row) => ({
            ...row,
            updated_at: new Date().toISOString(),
          }))

        if (providerCapabilityRows.length > 0) {
          const { error: capabilityError } = await withTimeout(
            supabase
              .from('provider_capabilities')
              .upsert(providerCapabilityRows, { onConflict: 'provider_id,capability_scope' }),
            PROFILE_LOAD_TIMEOUT_MS,
            'Provider capabilities setup timed out',
          )

          if (capabilityError) {
            console.warn('[useAuth] provider_capabilities upsert failed during oauth signup:', capabilityError.message)
          }
        }
      }

      const hydratedInsertedProfile = await hydrateProviderProfileFromCapabilities(insertedProfile as Profile)
      if (!isCurrentRequest()) return null

      clearOAuthOnboardingContext()
      clearPendingOAuthProvider()
      pendingOAuthProviderRef.current = null
      const normalizedProfile = normalizeLoadedProfile(hydratedInsertedProfile)
      const onboardingComplete = isProfileOnboardingComplete(normalizedProfile)
      setProfile(normalizedProfile)
      setProfileReady(onboardingComplete)
      setNeedsOnboarding(!onboardingComplete)
      setAuthError(null)
      return normalizedProfile
    } catch (err) {
      if (!isCurrentRequest()) return null

      console.warn('[useAuth] loadProfile:error', {
        requestId,
        userId: currentUser.id,
        message: getErrorMessage(err, 'Failed to load profile'),
      })
      clearPendingOAuthProvider()
      pendingOAuthProviderRef.current = null
      setAuthError(getErrorMessage(err, 'Failed to load profile'))
      setProfile(null)
      setProfileReady(false)
      setNeedsOnboarding(false)
      return null
    }
  }, [])

  const bootstrapProfileForOAuth = useCallback(async (
    currentUser: User,
    provider: 'google' | 'apple' | null,
  ) => {
    if (provider !== 'apple') {
      return loadProfile(currentUser)
    }

    if (
      appleBootstrapPromiseRef.current &&
      appleBootstrapUserIdRef.current === currentUser.id
    ) {
      return appleBootstrapPromiseRef.current
    }

    const bootstrapPromise = loadProfile(currentUser)
      .catch(() => null)
      .finally(() => {
        if (appleBootstrapUserIdRef.current === currentUser.id) {
          appleBootstrapPromiseRef.current = null
          appleBootstrapUserIdRef.current = null
        }
      })

    appleBootstrapUserIdRef.current = currentUser.id
    appleBootstrapPromiseRef.current = bootstrapPromise
    return bootstrapPromise
  }, [loadProfile])

  const handleNativeOAuthCallback = useCallback(async (urlValue: string) => {
    const provider = pendingOAuthProviderRef.current ?? readPendingOAuthProvider()
    if (!provider) return

    const callbackUrl = new URL(urlValue)
    const authCode = callbackUrl.searchParams.get('code')
    const oauthError = callbackUrl.searchParams.get('error') || callbackUrl.searchParams.get('error_description')

    if (oauthError) {
      console.error('[useAuth] native OAuth callback failed', { provider, message: oauthError })
      setAuthError(oauthError)
      return
    }

    if (!authCode) {
      return
    }

    const { data, error } = await supabase.auth.exchangeCodeForSession(authCode)

    if (error) {
      console.error('[useAuth] native OAuth session exchange failed', { provider, message: error.message })
      setAuthError(error.message)
      return
    }

    if (provider === 'apple' && data.session?.user) {
      if (typeof window !== 'undefined') {
        window.sessionStorage.setItem(OAUTH_PROVIDER_STORAGE_KEY, 'apple')
      }
      pendingOAuthProviderRef.current = 'apple'
    }
  }, [bootstrapProfileForOAuth])

  useEffect(() => {
    mountedRef.current = true

    const init = async () => {
      try {
        const url = typeof window !== 'undefined' ? new URL(window.location.href) : null
        const hasOAuthCode = !!url?.searchParams.has('code')
        const oauthError = url?.searchParams.get('error') || url?.searchParams.get('error_description')
        const pendingOAuthProvider = readPendingOAuthProvider()
        let sessionFromExchange: Session | null = null

        if (hasOAuthCode && url) {
          const { data: exchangeData, error: exchangeError } = await withTimeout(
            supabase.auth.exchangeCodeForSession(window.location.href),
            SESSION_INIT_TIMEOUT_MS,
            'OAuth session exchange timed out',
          )
          sessionFromExchange = exchangeData.session ?? null
          const exchangedUserId = sessionFromExchange?.user?.id ?? null

          if (exchangeError) {
            console.error('[useAuth] web OAuth session exchange failed', {
              provider: pendingOAuthProvider,
              message: exchangeError.message,
              userId: exchangedUserId,
            })
            setAuthError(exchangeError.message)
          }

          window.history.replaceState({}, document.title, window.location.pathname)
        }

        if (oauthError) {
          console.error('[useAuth] OAuth callback failed', {
            provider: pendingOAuthProvider,
            message: oauthError,
          })
          setAuthError(oauthError)
          if (typeof window !== 'undefined') {
            window.history.replaceState({}, document.title, window.location.pathname)
          }
          clearPendingOAuthProvider()
        }

        const { data, error } = await withTimeout(
          supabase.auth.getSession(),
          SESSION_INIT_TIMEOUT_MS,
          'Session initialization timed out'
        )

        if (!mountedRef.current) return

        if (error) {
          setAuthError(error.message)
          setSession(null)
          setUser(null)
          setProfile(null)
          setProfileReady(false)
          setNeedsOnboarding(false)
          return
        }

        const currentSession = data.session ?? sessionFromExchange
        const currentUser = currentSession?.user ?? null

        if (currentUser) {
          if (typeof window !== 'undefined') {
            window.sessionStorage.removeItem(SIGNUP_STEP_STORAGE_KEY)
          }
        }

        if (currentUser) {
          const bootstrappedProfile = pendingOAuthProvider === 'apple'
            ? await bootstrapProfileForOAuth(currentUser, pendingOAuthProvider)
            : await loadProfile(currentUser)
          setSession(currentSession)
          setUser(currentUser)
          if (pendingOAuthProvider === 'apple' && !bootstrappedProfile) {
            console.error('[useAuth] OAuth profile bootstrap failed', {
              provider: pendingOAuthProvider,
              userId: currentUser.id,
            })
          }
        } else {
          setSession(currentSession)
          setUser(currentUser)
          profileRequestRef.current += 1
          setProfile(null)
          setProfileReady(false)
          setNeedsOnboarding(false)
          clearPendingOAuthProvider()
          pendingOAuthProviderRef.current = null
        }
      } catch (err) {
        if (!mountedRef.current) return
        profileRequestRef.current += 1
        setAuthError(getErrorMessage(err, 'Failed to initialize session'))
        setSession(null)
        setUser(null)
        setProfile(null)
        setProfileReady(false)
        setNeedsOnboarding(false)
      } finally {
        if (mountedRef.current) {
          setLoading(false)
        }
      }
    }

    init()

    // ✅ FIX: בלי await
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      const currentUser = newSession?.user ?? null
      const oauthProvider = readPendingOAuthProvider()
      setAuthError(null)

      if (currentUser) {
        if (oauthProvider === 'apple') {
          void (async () => {
            await bootstrapProfileForOAuth(currentUser, oauthProvider)
            if (!mountedRef.current) return
            setSession(newSession)
            setUser(currentUser)
            if (typeof window !== 'undefined') {
              window.sessionStorage.removeItem(SIGNUP_STEP_STORAGE_KEY)
            }
            setLoading(false)
          })()
          return
        }

        setSession(newSession)
        setUser(currentUser)
        void loadProfile(currentUser) // ❗ בלי await
        if (typeof window !== 'undefined') {
          window.sessionStorage.removeItem(SIGNUP_STEP_STORAGE_KEY)
        }
      } else {
        setSession(newSession)
        setUser(currentUser)
        profileRequestRef.current += 1
        setProfile(null)
        setProfileReady(false)
        clearPendingOAuthProvider()
        pendingOAuthProviderRef.current = null
      }

      setLoading(false)
    })

    return () => {
      mountedRef.current = false
      subscription.unsubscribe()
    }
  }, [loadProfile])

  const signUp = useCallback(
    async ({
      email,
      password,
      fullName,
      role,
      primaryService,
      locationAddress,
      shortBio,
      serviceTypes,
      serviceAttributes,
    }: {
      email: string
      password: string
      fullName: string
      role: AppRole
      primaryService?: string
      locationAddress?: string
      shortBio?: string
      serviceTypes?: ProfileServiceType[]
      serviceAttributes?: ServiceAttributes | null
    }) => {
      setAuthError(null)

      const safeRole: AppRole = role === 'admin' ? 'client' : role

      const normalizedServiceTypes = normalizeProfileServiceTypes(serviceTypes)
      const normalizedProviderCapabilities = safeRole === 'walker'
        ? buildProviderSignupCapabilities({
            serviceAttributes: serviceAttributes ?? null,
            shortBio: shortBio ?? null,
          })
        : null

      try {
        const { data, error } = await withTimeout(
          supabase.auth.signUp({
            email,
            password,
            options: {
              data: {
                full_name: fullName,
                role: safeRole,
                short_bio: shortBio ?? null,
                primary_service: primaryService ?? null,
                location_address: locationAddress ?? null,
                service_type: normalizedServiceTypes[0] ?? null,
                service_types: normalizedServiceTypes,
              },
            },
          }),
          SESSION_INIT_TIMEOUT_MS,
          'Sign up timed out'
        )

        if (error) {
          setAuthError(error.message)
          return { ok: false }
        }

        const newUser = data.user
        if (!newUser) {
          setAuthError('Could not create user')
          return { ok: false }
        }

        const profilePayload: Profile = {
          id: newUser.id,
          email,
          full_name: fullName,
          role: safeRole,
          short_bio: shortBio ?? null,
          primary_service: primaryService ?? null,
          location_address: locationAddress ?? null,
          service_type: normalizedServiceTypes[0] ?? null,
          service_types: normalizedServiceTypes,
          service_attributes: normalizedProviderCapabilities ?? serviceAttributes ?? null,
        }

        const { error: profileError } = await withTimeout(
          supabase
            .from('profiles')
            .upsert(profilePayload, { onConflict: 'id' }),
          PROFILE_LOAD_TIMEOUT_MS,
          'Profile setup timed out'
        )

      if (profileError) {
          setProfile(profilePayload)
          setNeedsOnboarding(false)
          return { ok: true }
        }

        if (safeRole === 'walker' && normalizedProviderCapabilities) {
          const providerCapabilityRows = buildProviderCapabilityRows(newUser.id, normalizedProviderCapabilities)
            .map((row) => ({
              ...row,
              updated_at: new Date().toISOString(),
            }))

          if (providerCapabilityRows.length > 0) {
            const { error: capabilityError } = await withTimeout(
              supabase
                .from('provider_capabilities')
                .upsert(providerCapabilityRows, { onConflict: 'provider_id,capability_scope' }),
              PROFILE_LOAD_TIMEOUT_MS,
              'Provider capabilities setup timed out',
            )

            if (capabilityError) {
              console.warn('[useAuth] provider_capabilities upsert failed during signup:', capabilityError.message)
            }
          }
        }

        await loadProfile(newUser)
        return { ok: true }
      } catch (err) {
        setAuthError(getErrorMessage(err, 'Failed to sign up'))
        return { ok: false }
      }
    },
    [loadProfile]
  )

  const signIn = useCallback(
    async ({ email, password }: { email: string; password: string }) => {
      setAuthError(null)

      try {
        const { error } = await withTimeout(
          supabase.auth.signInWithPassword({
            email,
            password,
          }),
          SESSION_INIT_TIMEOUT_MS,
          'Sign in timed out'
        )

        if (error) {
          console.log('SIGN IN ERROR:', error.message)
          setAuthError(error.message)
          return { ok: false }
        }

        return { ok: true }
      } catch (err) {
        setAuthError(getErrorMessage(err, 'Failed to sign in'))
        return { ok: false }
      }
    },
    []
  )

  const signInWithGoogle = useCallback(async ({
    role,
    primaryService,
    locationAddress,
    shortBio,
    serviceTypes,
    serviceAttributes,
  }: {
    role: AppRole
    primaryService?: string
    locationAddress?: string
    shortBio?: string
    serviceTypes?: ProfileServiceType[]
    serviceAttributes?: ServiceAttributes | null
  }) => {
    setAuthError(null)

    const safeRole: AppRole = role === 'admin' ? 'client' : role
    const normalizedServiceTypes = normalizeProfileServiceTypes(serviceTypes)
    writeOAuthOnboardingContext({
      role: safeRole,
      primaryService,
      locationAddress,
      shortBio,
      serviceTypes: normalizedServiceTypes,
      serviceAttributes: serviceAttributes ?? null,
    })

    try {
      const redirectTo = getGoogleOAuthRedirectTo()
      writePendingOAuthProvider('google')
      pendingOAuthProviderRef.current = 'google'

      const { data, error } = await withTimeout(
        supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo,
            skipBrowserRedirect: Capacitor.isNativePlatform(),
            queryParams: {
              access_type: 'offline',
              prompt: 'select_account',
            },
          },
        }),
        SESSION_INIT_TIMEOUT_MS,
        'Google sign in timed out',
      )

      if (error) {
        pendingOAuthProviderRef.current = null
        clearPendingOAuthProvider()
        clearOAuthOnboardingContext()
        setAuthError(error.message)
        return { ok: false }
      }

      if (Capacitor.isNativePlatform()) {
        if (!data?.url) {
          pendingOAuthProviderRef.current = null
          clearPendingOAuthProvider()
          clearOAuthOnboardingContext()
          setAuthError('Could not start Google sign in')
          return { ok: false }
        }

        await Browser.open({ url: data.url })
      }

      return { ok: true }
    } catch (err) {
      pendingOAuthProviderRef.current = null
      clearPendingOAuthProvider()
      clearOAuthOnboardingContext()
      setAuthError(getErrorMessage(err, 'Failed to sign in with Google'))
      return { ok: false }
    }
  }, [])

  const signInWithApple = useCallback(async ({
    role,
    primaryService,
    locationAddress,
    shortBio,
    serviceTypes,
    serviceAttributes,
  }: {
    role: AppRole
    primaryService?: string
    locationAddress?: string
    shortBio?: string
    serviceTypes?: ProfileServiceType[]
    serviceAttributes?: ServiceAttributes | null
  }) => {
    if (!isAppleAuthSupportedOnCurrentPlatform()) {
      setAuthError('Apple sign in is not available on this platform yet')
      return { ok: false }
    }

    setAuthError(null)

    const safeRole: AppRole = role === 'admin' ? 'client' : role
    const normalizedServiceTypes = normalizeProfileServiceTypes(serviceTypes)
    writeOAuthOnboardingContext({
      role: safeRole,
      primaryService,
      locationAddress,
      shortBio,
      serviceTypes: normalizedServiceTypes,
      serviceAttributes: serviceAttributes ?? null,
    })

    try {
      const redirectTo = getGoogleOAuthRedirectTo()
      writePendingOAuthProvider('apple')
      pendingOAuthProviderRef.current = 'apple'

      const { data, error } = await withTimeout(
        supabase.auth.signInWithOAuth({
          provider: 'apple',
          options: {
            redirectTo,
            skipBrowserRedirect: Capacitor.isNativePlatform(),
          },
        }),
        SESSION_INIT_TIMEOUT_MS,
        'Apple sign in timed out',
      )

      if (error) {
        pendingOAuthProviderRef.current = null
        clearPendingOAuthProvider()
        clearOAuthOnboardingContext()
        setAuthError(error.message)
        return { ok: false }
      }

      if (Capacitor.isNativePlatform()) {
        if (!data?.url) {
          pendingOAuthProviderRef.current = null
          clearPendingOAuthProvider()
          clearOAuthOnboardingContext()
          setAuthError('Could not start Apple sign in')
          return { ok: false }
        }

        await Browser.open({ url: data.url })
      }

      return { ok: true }
    } catch (err) {
      pendingOAuthProviderRef.current = null
      clearPendingOAuthProvider()
      clearOAuthOnboardingContext()
      setAuthError(getErrorMessage(err, 'Failed to sign in with Apple'))
      return { ok: false }
    }
  }, [])

  const signOut = useCallback(async () => {
    profileRequestRef.current += 1

    try {
      await disableCurrentPushTokenForUser(user?.id ?? session?.user?.id ?? null)

      const { error } = await withTimeout(
        supabase.auth.signOut(),
        SESSION_INIT_TIMEOUT_MS,
        'Sign out timed out'
      )

      if (error) {
        setAuthError(error.message)
      } else {
        setAuthError(null)
      }
    } catch (err) {
      setAuthError(getErrorMessage(err, 'Failed to sign out'))
    } finally {
      if (typeof window !== 'undefined') {
        window.sessionStorage.removeItem(SIGNUP_STEP_STORAGE_KEY)
        window.sessionStorage.removeItem('regli:onboarding-wow')
      }
      setProfile(null)
      setProfileReady(false)
      setNeedsOnboarding(false)
      pendingOAuthProviderRef.current = null
      setSession(null)
      setUser(null)
    }
  }, [session?.user?.id, user?.id])

  const completeOnboarding = useCallback(async ({
    role,
    primaryService,
    locationAddress,
    shortBio,
    serviceTypes,
    serviceAttributes,
  }: {
    role: AppRole
    primaryService?: string
    locationAddress?: string
    shortBio?: string
    serviceTypes?: ProfileServiceType[]
    serviceAttributes?: ServiceAttributes | null
  }) => {
    const currentUser = user ?? session?.user ?? null
    if (!currentUser) {
      setAuthError('No authenticated user found')
      return { ok: false }
    }

    setAuthError(null)
    console.log('[provider-onboarding] Finish Setup clicked', {
      userId: currentUser.id,
      role,
    })

    const safeRole: AppRole = role === 'admin' ? 'client' : role
    const normalizedServiceTypes = normalizeProfileServiceTypes(serviceTypes)
    const normalizedProviderCapabilities = safeRole === 'walker'
      ? buildProviderSignupCapabilities({
          serviceAttributes: serviceAttributes ?? null,
          shortBio: shortBio ?? null,
        })
      : null
    const validationOk = safeRole !== 'walker' || (
      hasText(locationAddress) &&
      hasText(shortBio) &&
      normalizedServiceTypes.length > 0 &&
      !!normalizedProviderCapabilities &&
      Object.keys(normalizedProviderCapabilities).length > 0
    )
    console.log('[provider-onboarding] validation result', {
      userId: currentUser.id,
      safeRole,
      validationOk,
      hasLocation: hasText(locationAddress),
      hasShortBio: hasText(shortBio),
      serviceTypeCount: normalizedServiceTypes.length,
      hasCapabilities: !!normalizedProviderCapabilities && Object.keys(normalizedProviderCapabilities).length > 0,
    })

    const profilePayload: Profile = {
      id: currentUser.id,
      email: currentUser.email ?? profile?.email ?? null,
      full_name: getUserDisplayName(currentUser) ?? profile?.full_name ?? null,
      avatar_url: getUserAvatarUrl(currentUser) ?? profile?.avatar_url ?? null,
      role: safeRole,
      preferred_language: profile?.preferred_language ?? getDefaultPreferredLanguage(currentUser),
      short_bio: shortBio ?? null,
      primary_service: primaryService ?? null,
      location_address: locationAddress ?? null,
      service_type: normalizedServiceTypes[0] ?? null,
      service_types: normalizedServiceTypes,
      service_attributes: normalizedProviderCapabilities ?? serviceAttributes ?? null,
    }
    console.log('[provider-onboarding] profile payload', profilePayload)

    try {
      const { error: profileError } = await withTimeout(
        supabase
          .from('profiles')
          .upsert(profilePayload, { onConflict: 'id' }),
        PROFILE_LOAD_TIMEOUT_MS,
        'Profile setup timed out',
      )

      if (profileError) {
        console.log('[provider-onboarding] Supabase save result', {
          stage: 'profile',
          ok: false,
          error: profileError.message,
        })
        setAuthError(profileError.message)
        return { ok: false }
      }
      console.log('[provider-onboarding] Supabase save result', {
        stage: 'profile',
        ok: true,
      })

      if (safeRole === 'walker' && normalizedProviderCapabilities) {
        const providerCapabilityRows = buildProviderCapabilityRows(currentUser.id, normalizedProviderCapabilities)
          .map((row) => ({
            ...row,
            updated_at: new Date().toISOString(),
          }))
        console.log('[provider-onboarding] provider capabilities payload', providerCapabilityRows)

        if (providerCapabilityRows.length > 0) {
          const { error: capabilityError } = await withTimeout(
            supabase
              .from('provider_capabilities')
              .upsert(providerCapabilityRows, { onConflict: 'provider_id,capability_scope' }),
            PROFILE_LOAD_TIMEOUT_MS,
            'Provider capabilities setup timed out',
          )

          if (capabilityError) {
            console.warn('[useAuth] provider_capabilities upsert failed during onboarding:', capabilityError.message)
            console.log('[provider-onboarding] Supabase save result', {
              stage: 'provider_capabilities',
              ok: false,
              error: capabilityError.message,
            })
          } else {
            console.log('[provider-onboarding] Supabase save result', {
              stage: 'provider_capabilities',
              ok: true,
            })
          }
        }
      }

      const refreshedProfile = await loadProfile(currentUser)
      console.log('[provider-onboarding] profile refresh result', {
        userId: currentUser.id,
        refreshed: !!refreshedProfile,
        role: refreshedProfile?.role ?? null,
        locationAddress: refreshedProfile?.location_address ?? null,
        shortBio: refreshedProfile?.short_bio ?? null,
        serviceTypes: refreshedProfile?.service_types ?? null,
      })
      if (!refreshedProfile) {
        setAuthError('We saved your setup, but could not refresh your profile. Please try again.')
        console.log('[provider-onboarding] navigation/app unlock decision', {
          userId: currentUser.id,
          allowDashboard: false,
          reason: 'profile_refresh_failed',
        })
        return { ok: false }
      }

      const refreshedComplete = isProfileOnboardingComplete(refreshedProfile)
      console.log('[provider-onboarding] navigation/app unlock decision', {
        userId: currentUser.id,
        allowDashboard: refreshedComplete,
        needsOnboarding: !refreshedComplete,
      })
      if (!refreshedComplete) {
        setAuthError('Your provider profile is still missing required details. Please review and try again.')
        return { ok: false }
      }

      if (typeof window !== 'undefined') {
        window.sessionStorage.removeItem(SIGNUP_STEP_STORAGE_KEY)
      }
      return { ok: true }
    } catch (err) {
      setAuthError(getErrorMessage(err, 'Failed to complete onboarding'))
      return { ok: false }
    }
  }, [loadProfile, profile, session?.user, user])

  return {
    session,
    user,
    profile,
    profileReady,
    needsOnboarding,
    loading,
    authError,
    appleSignInEnabled: isAppleAuthSupportedOnCurrentPlatform(),
    signUp,
    signIn,
    signInWithGoogle,
    signInWithApple,
    completeOnboarding,
    handleNativeOAuthCallback,
    signOut,
  }
}
