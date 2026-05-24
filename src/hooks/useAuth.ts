import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../services/supabaseClient'
import { normalizeProfileServiceTypes, type ProfileServiceType } from '../lib/profileServiceTypes'

export type AppRole = 'client' | 'walker' | 'admin'
export type ProfileRole = AppRole | 'provider' | 'customer'

export type ServiceAttributes = Record<string, Record<string, unknown>>

interface Profile {
  id: string
  email: string | null
  full_name: string | null
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

function getFallbackProfile(currentUser: User): Profile {
  const fallbackServiceTypes = normalizeProfileServiceTypes(currentUser.user_metadata?.service_types)
  return {
    id: currentUser.id,
    email: currentUser.email ?? null,
    full_name:
      (currentUser.user_metadata?.full_name as string | undefined) ?? null,
    role:
      (currentUser.user_metadata?.role as ProfileRole | undefined) ?? 'client',
    short_bio:
      (currentUser.user_metadata?.short_bio as string | undefined) ?? null,
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
        const normalizedProfile = normalizeLoadedProfile(data as Profile)
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

      const normalizedProfile = normalizeLoadedProfile(insertedProfile as Profile)
      setProfile(normalizedProfile)
      setAuthError(null)
      return normalizedProfile
    } catch (err) {
      if (!isCurrentRequest()) return null

      setAuthError(getErrorMessage(err, 'Failed to load profile'))
      setProfile(fallbackProfile)
      return fallbackProfile
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true

    const init = async () => {
      try {
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

        const currentSession = data.session
        const currentUser = currentSession?.user ?? null

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
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      const currentUser = newSession?.user ?? null

      setSession(newSession)
      setUser(currentUser)
      setAuthError(null)

      if (currentUser) {
        loadProfile(currentUser) // ❗ בלי await
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
          service_attributes: serviceAttributes ?? null,
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
    signOut,
  }
}
