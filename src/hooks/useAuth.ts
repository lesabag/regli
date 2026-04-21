import { useCallback, useEffect, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../services/supabaseClient'

export type AppRole = 'client' | 'walker' | 'admin'

interface Profile {
  id: string
  email: string | null
  full_name: string | null
  role: AppRole
}

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState<string | null>(null)

  // ✅ יצירה/טעינה של פרופיל
  const loadProfile = useCallback(async (currentUser: User) => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', currentUser.id)
        .maybeSingle()

      if (!error && data) {
        setProfile(data as Profile)
        setAuthError(null)
        return
      }

      // 🔥 יצירה אוטומטית אם לא קיים
      const fallbackProfile: Profile = {
        id: currentUser.id,
        email: currentUser.email ?? null,
        full_name:
          (currentUser.user_metadata?.full_name as string | undefined) ?? null,
        role:
          (currentUser.user_metadata?.role as AppRole | undefined) ?? 'client',
      }

      const { data: insertedProfile, error: insertError } = await supabase
        .from('profiles')
        .upsert(fallbackProfile, { onConflict: 'id' })
        .select()
        .single()

      if (insertError) {
        setAuthError(insertError.message)
        setProfile(null)
        return
      }

      setProfile(insertedProfile as Profile)
      setAuthError(null)
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Failed to load profile')
      setProfile(null)
    }
  }, [])

  useEffect(() => {
    let mounted = true

    const init = async () => {
      try {
        const { data, error } = await supabase.auth.getSession()

        if (!mounted) return

        if (error) {
          setAuthError(error.message)
          return
        }

        const currentSession = data.session
        const currentUser = currentSession?.user ?? null

        setSession(currentSession)
        setUser(currentUser)

        if (currentUser) {
          await loadProfile(currentUser) // פה מותר await
        } else {
          setProfile(null)
        }
      } catch (err) {
        if (!mounted) return
        setAuthError(err instanceof Error ? err.message : 'Failed to initialize session')
        setProfile(null)
      } finally {
        if (mounted) setLoading(false)
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
        setProfile(null)
      }

      setLoading(false)
    })

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [loadProfile])

  const signUp = useCallback(
    async ({
      email,
      password,
      fullName,
      role,
    }: {
      email: string
      password: string
      fullName: string
      role: AppRole
    }) => {
      setAuthError(null)

      const safeRole: AppRole = role === 'admin' ? 'client' : role

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName,
            role: safeRole,
          },
        },
      })

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
      }

      const { error: profileError } = await supabase
        .from('profiles')
        .upsert(profilePayload, { onConflict: 'id' })

      if (profileError) {
        setAuthError(profileError.message)
        return { ok: false }
      }

      await loadProfile(newUser)
      return { ok: true }
    },
    [loadProfile]
  )

  const signIn = useCallback(
    async ({ email, password }: { email: string; password: string }) => {
      setAuthError(null)

      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      })

      if (error) {
        console.log('SIGN IN ERROR:', error.message)
        setAuthError(error.message)
        return { ok: false }
      }

      return { ok: true }
    },
    []
  )

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setProfile(null)
    setSession(null)
    setUser(null)
    setAuthError(null)
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
