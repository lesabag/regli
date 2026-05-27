import { Browser } from '@capacitor/browser'
import { Capacitor } from '@capacitor/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../services/supabaseClient'
import { normalizeProfileServiceTypes, type ProfileServiceType } from '../lib/profileServiceTypes'
import { buildProviderCapabilityRows, buildProviderSignupCapabilities } from '../lib/providerCapabilities'

export type AppRole = 'client' | 'walker' | 'admin'
export type ProfileRole = AppRole | 'provider' | 'customer'

export type ServiceAttributes = Record<string, Record<string, unknown>>

interface Profile {
  id: string
  email: string | null
  full_name: string | null
  avatar_url?: string | null
  role: ProfileRole
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
    service_type: normalizedServiceTypes[0] ?? normalizeProfileServiceTypeFallback(profile.service_type),
    service_types: normalizedServiceTypes,
  }
}

function normalizeProfileServiceTypeFallback(value: Profile['service_type']): ProfileServiceType | null {
  return typeof value === 'string' ? (normalizeProfileServiceTypes(value)[0] ?? null) : value ?? null
}

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const profileRequestRef = useRef(0)

  // ✅ יצירה/טעינה של פרופיל
  const loadProfile = useCallback(async (currentUser: User) => {
    const requestId = profileRequestRef.current + 1
    profileRequestRef.current = requestId
    const fallbackProfile = getFallbackProfile(currentUser)

    const isCurrentRequest = () =>
      mountedRef.current && profileRequestRef.current === requestId

    try {
      console.log('[useAuth] loadProfile:start', {
        requestId,
        userId: currentUser.id,
        email: currentUser.email ?? null,
      })
      const { data, error } = await withTimeout(
        supabase
          .from('profiles')
          .select('*')
          .eq('id', currentUser.id)
          .maybeSingle(),
        PROFILE_LOAD_TIMEOUT_MS,
        'Profile loading timed out'
      )

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

        clearOAuthOnboardingContext()
        const normalizedProfile = normalizeLoadedProfile(nextProfileData)
        console.log('[useAuth] loadProfile:existing-profile', {
          requestId,
          userId: currentUser.id,
          role: normalizedProfile.role,
          serviceType: normalizedProfile.service_type ?? null,
        })
        setProfile(normalizedProfile)
        setAuthError(null)
        return normalizedProfile
      }

      if (error) {
        throw error
      }

      // 🔥 יצירה אוטומטית אם לא קיים
      const { data: insertedProfile, error: insertError } = await withTimeout(
        supabase
          .from('profiles')
          .upsert(fallbackProfile, { onConflict: 'id' })
          .select()
          .single(),
        PROFILE_LOAD_TIMEOUT_MS,
        'Profile setup timed out'
      )

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

      clearOAuthOnboardingContext()
      const normalizedProfile = normalizeLoadedProfile(insertedProfile as Profile)
      console.log('[useAuth] loadProfile:created-profile', {
        requestId,
        userId: currentUser.id,
        role: normalizedProfile.role,
        serviceType: normalizedProfile.service_type ?? null,
      })
      setProfile(normalizedProfile)
      setAuthError(null)
      return normalizedProfile
    } catch (err) {
      if (!isCurrentRequest()) return null

      console.warn('[useAuth] loadProfile:error', {
        requestId,
        userId: currentUser.id,
        message: getErrorMessage(err, 'Failed to load profile'),
      })
      setAuthError(getErrorMessage(err, 'Failed to load profile'))
      setProfile(fallbackProfile)
      return fallbackProfile
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true

    const init = async () => {
      try {
        const url = typeof window !== 'undefined' ? new URL(window.location.href) : null
        const hasOAuthCode = !!url?.searchParams.has('code')
        const oauthError = url?.searchParams.get('error') || url?.searchParams.get('error_description')
        let sessionFromExchange: Session | null = null

        if (hasOAuthCode && url) {
          console.log('[auth-oauth-callback] returned origin:', window.location.origin)
          console.log('[useAuth] session before exchange', {
            currentHref: window.location.href,
          })
          console.log('[auth-oauth-callback] code detected before getSession')
          const { data: exchangeData, error: exchangeError } = await withTimeout(
            supabase.auth.exchangeCodeForSession(window.location.href),
            SESSION_INIT_TIMEOUT_MS,
            'OAuth session exchange timed out',
          )
          sessionFromExchange = exchangeData.session ?? null
          const exchangedUserId = sessionFromExchange?.user?.id ?? null

          if (exchangeError) {
            console.error('[auth-oauth-callback] exchangeCodeForSession failed', {
              message: exchangeError.message,
              userId: exchangedUserId,
            })
            setAuthError(exchangeError.message)
          } else {
            console.log('[auth-oauth-callback] exchange success', {
              userId: exchangedUserId,
            })
            console.log('[auth-oauth-callback] exchange session user:', {
              userId: sessionFromExchange?.user?.id ?? null,
              email: sessionFromExchange?.user?.email ?? null,
            })
          }

          window.history.replaceState({}, document.title, window.location.pathname)
          console.log('[auth-oauth-callback] cleaned URL')
        } else {
          console.log('[auth-oauth-callback] no code in URL')
        }

        if (oauthError) {
          console.error('[auth-oauth-callback] OAuth error detected', oauthError)
          setAuthError(oauthError)
          if (typeof window !== 'undefined') {
            window.history.replaceState({}, document.title, window.location.pathname)
            console.log('[auth-oauth-callback] cleaned callback URL')
          }
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
          return
        }

        const currentSession = data.session ?? sessionFromExchange
        const currentUser = currentSession?.user ?? null

        console.log('[auth-oauth-callback] getSession after exchange:', {
          hasSession: !!data.session,
          userId: data.session?.user?.id ?? sessionFromExchange?.user?.id ?? null,
          email: data.session?.user?.email ?? sessionFromExchange?.user?.email ?? null,
        })

        console.log('[useAuth] init:getSession', {
          hasSession: !!currentSession,
          userId: currentUser?.id ?? null,
          email: currentUser?.email ?? null,
        })

        console.log('[useAuth] current user after initialization', {
          userId: currentUser?.id ?? null,
          email: currentUser?.email ?? null,
          hasSession: !!currentSession,
        })

        if (currentUser) {
          console.log('[auth-oauth-callback] session user found', {
            userId: currentUser.id,
            email: currentUser.email ?? null,
          })
          if (typeof window !== 'undefined') {
            window.sessionStorage.removeItem(SIGNUP_STEP_STORAGE_KEY)
          }
        }

        setSession(currentSession)
        setUser(currentUser)

        if (currentUser) {
          await loadProfile(currentUser) // פה מותר await
        } else {
          profileRequestRef.current += 1
          setProfile(null)
        }
      } catch (err) {
        if (!mountedRef.current) return
        profileRequestRef.current += 1
        setAuthError(getErrorMessage(err, 'Failed to initialize session'))
        setSession(null)
        setUser(null)
        setProfile(null)
      } finally {
        if (mountedRef.current) setLoading(false)
      }
    }

    init()

    // ✅ FIX: בלי await
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, newSession) => {
      const currentUser = newSession?.user ?? null

      console.log('[useAuth] onAuthStateChange', {
        event,
        hasSession: !!newSession,
        userId: currentUser?.id ?? null,
        email: currentUser?.email ?? null,
        currentProfileRequest: profileRequestRef.current,
      })

      setSession(newSession)
      setUser(currentUser)
      setAuthError(null)

      if (currentUser) {
        loadProfile(currentUser) // ❗ בלי await
        if (typeof window !== 'undefined') {
          window.sessionStorage.removeItem(SIGNUP_STEP_STORAGE_KEY)
        }
      } else {
        profileRequestRef.current += 1
        setProfile(null)
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
      const redirectTo = Capacitor.isNativePlatform()
        ? 'regli://auth/callback'
        : `${window.location.origin}/`

      console.log('[auth-oauth] using redirectTo:', window.location.origin)

      console.log('[useAuth] signInWithGoogle:start', {
        role: safeRole,
        redirectTo,
        serviceType: normalizedServiceTypes[0] ?? null,
        native: Capacitor.isNativePlatform(),
      })

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
        clearOAuthOnboardingContext()
        setAuthError(error.message)
        return { ok: false }
      }

      if (Capacitor.isNativePlatform()) {
        if (!data?.url) {
          clearOAuthOnboardingContext()
          setAuthError('Could not start Google sign in')
          return { ok: false }
        }

        await Browser.open({ url: data.url, windowName: '_self' })
      }

      return { ok: true }
    } catch (err) {
      clearOAuthOnboardingContext()
      setAuthError(getErrorMessage(err, 'Failed to sign in with Google'))
      return { ok: false }
    }
  }, [])

  const signOut = useCallback(async () => {
    profileRequestRef.current += 1

    try {
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
      setProfile(null)
      setSession(null)
      setUser(null)
    }
  }, [])

  return {
    session,
    user,
    profile,
    loading,
    authError,
    signUp,
    signIn,
    signInWithGoogle,
    signOut,
  }
}
