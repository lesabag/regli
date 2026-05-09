import { useEffect, useRef } from 'react'
import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'
import { supabase } from '../services/supabaseClient'

/**
 * Registers for native push notifications and stores the device token in Supabase.
 * Call this hook once from authenticated app surfaces that should receive pushes.
 *
 * On web/non-native platforms this is a no-op.
 */
export function usePushNotifications(userId: string | null) {
  const activeRegistrationKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const platform = Capacitor.getPlatform()
    const isNativePlatform = Capacitor.isNativePlatform()
    const registrationKey = userId ? `${platform}:${userId}` : null
    const listenerHandles: PluginListenerHandle[] = []
    let isActive = true

    console.log('[Push] Hook mounted', {
      userId,
      platform,
      isNativePlatform,
    })

    if (!isNativePlatform) {
      console.log('[Push] Web/non-native platform detected; skipping native push registration safely', {
        userId,
        platform,
      })
      return undefined
    }

    if (!userId) {
      console.log('[Push] Native platform detected but no userId is available yet; waiting to register')
      return undefined
    }

    if (activeRegistrationKeyRef.current === registrationKey) {
      console.log('[Push] Registration already active for this user/platform; skipping duplicate setup', {
        registrationKey,
      })
      return undefined
    }

    activeRegistrationKeyRef.current = registrationKey

    const uid = userId // capture narrowed value for closures

    async function setup() {
      try {
        let permStatus = await PushNotifications.checkPermissions()
        console.log('[Push] Permission check result', {
          userId: uid,
          platform,
          permission: permStatus,
        })

        if (permStatus.receive === 'prompt') {
          permStatus = await PushNotifications.requestPermissions()
          console.log('[Push] Permission request result', {
            userId: uid,
            platform,
            permission: permStatus,
          })
        } else {
          console.log('[Push] Permission request not needed', {
            userId: uid,
            platform,
            permission: permStatus,
          })
        }

        if (permStatus.receive !== 'granted') {
          console.log('[Push] Permission not granted; registration skipped on native platform', {
            userId: uid,
            platform,
            receive: permStatus.receive,
          })
          return
        }

        listenerHandles.push(await PushNotifications.addListener('registration', async (token) => {
          const value = token.value
          console.log('[Push] Registration success token', {
            userId: uid,
            platform,
            token: value,
          })

          if (!value) {
            console.log('[Push] Registration succeeded without a token value; skipping upsert', {
              userId: uid,
              platform,
            })
            return
          }

          await saveToken(uid, value, platform)
        }))

        listenerHandles.push(await PushNotifications.addListener('registrationError', (error) => {
          console.error('[Push] Registration error', {
            userId: uid,
            platform,
            error,
          })
        }))

        listenerHandles.push(await PushNotifications.addListener('pushNotificationReceived', (notification) => {
          console.log('[Push] Received push event', {
            userId: uid,
            platform,
            notification,
          })
          // In-app notifications are already handled by NotificationsBell realtime
          // so we don't need to show anything extra here
        }))

        listenerHandles.push(await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
          console.log('[Push] Push action performed event', {
            userId: uid,
            platform,
            action,
          })
          // The app will open to the walker dashboard naturally via App.tsx routing.
          // The walk_requests realtime subscription in useWalkerFlow will pick up
          // the new request and transition to incoming_request state automatically.
        }))

        if (!isActive) {
          cleanupListeners(listenerHandles)
          return
        }

        console.log('[Push] Calling PushNotifications.register()', {
          userId: uid,
          platform,
        })
        await PushNotifications.register()
      } catch (err) {
        console.error('[Push] Setup error', {
          userId: uid,
          platform,
          error: err,
        })
      }
    }

    setup()

    return () => {
      isActive = false
      if (activeRegistrationKeyRef.current === registrationKey) {
        activeRegistrationKeyRef.current = null
      }

      cleanupListeners(listenerHandles)
    }
  }, [userId])
}

/**
 * Upsert the push token into Supabase.
 * Uses ON CONFLICT to avoid duplicate rows.
 */
async function saveToken(userId: string, token: string, platform: string): Promise<void> {
  const payload = {
    user_id: userId,
    token,
    platform,
    updated_at: new Date().toISOString(),
  }

  console.log('[Push] push_tokens upsert payload', payload)

  const { data, error } = await supabase
    .from('push_tokens')
    .upsert(
      payload,
      { onConflict: 'user_id,token' }
    )
    .select('id,user_id,token,platform,updated_at')

  if (error) {
    console.error('[Push] push_tokens upsert result', {
      ok: false,
      userId,
      platform,
      error,
    })
  } else {
    console.log('[Push] push_tokens upsert result', {
      ok: true,
      userId,
      platform,
      data,
    })
  }
}

function cleanupListeners(handles: PluginListenerHandle[]) {
  for (const handle of handles.splice(0)) {
    try {
      void handle.remove().catch((err) => {
        console.error('[Push] Failed to remove listener', err)
      })
    } catch (err) {
      console.error('[Push] Failed to remove listener', err)
    }
  }
}
