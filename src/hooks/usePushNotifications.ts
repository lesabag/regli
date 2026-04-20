import { useEffect, useRef } from 'react'
import { Capacitor } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'
import { supabase } from '../services/supabaseClient'

/**
 * Registers for iOS push notifications and stores the APNs token in Supabase.
 * Call this hook once in the walker's screen (or any screen that should receive pushes).
 *
 * On web/non-native platforms this is a no-op.
 */
export function usePushNotifications(userId: string | null) {
  const registeredRef = useRef(false)

  useEffect(() => {
    // Only run on native iOS
    if (!Capacitor.isNativePlatform()) return
    if (!userId) return
    if (registeredRef.current) return
    registeredRef.current = true

    const uid = userId // capture narrowed value for closures

    async function setup() {
      try {
        // Check / request permission
        let permStatus = await PushNotifications.checkPermissions()

        if (permStatus.receive === 'prompt') {
          permStatus = await PushNotifications.requestPermissions()
        }

        if (permStatus.receive !== 'granted') {
          console.log('[Push] Permission not granted:', permStatus.receive)
          return
        }

        // Listen for registration success
        PushNotifications.addListener('registration', async (token) => {
          const value = token.value
          if (!value) return
          console.log('[Push] Token received:', value)
          await saveToken(uid, value)
        })

        // Listen for registration errors
        PushNotifications.addListener('registrationError', (error) => {
          console.error('[Push] Registration error:', error)
        })

        // Handle notification received while app is in foreground
        PushNotifications.addListener('pushNotificationReceived', (notification) => {
          console.log('[Push] Foreground notification:', notification)
          // In-app notifications are already handled by NotificationsBell realtime
          // so we don't need to show anything extra here
        })

        // Handle notification tap (app opened from notification)
        PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
          console.log('[Push] Notification tapped:', action)
          // The app will open to the walker dashboard naturally via App.tsx routing.
          // The walk_requests realtime subscription in useWalkerFlow will pick up
          // the new request and transition to incoming_request state automatically.
        })

        // Register with APNs
        await PushNotifications.register()
      } catch (err) {
        console.error('[Push] Setup error:', err)
      }
    }

    setup()

    return () => {
      PushNotifications.removeAllListeners()
    }
  }, [userId])
}

/**
 * Upsert the push token into Supabase.
 * Uses ON CONFLICT to avoid duplicate rows.
 */
async function saveToken(userId: string, token: string): Promise<void> {
  const { error } = await supabase
    .from('push_tokens')
    .upsert(
      {
        user_id: userId,
        token,
        platform: 'ios',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,token' }
    )

  if (error) {
    console.error('[Push] Failed to save token:', error.message)
  } else {
    console.log('[Push] Token saved for user:', userId)
  }
}
