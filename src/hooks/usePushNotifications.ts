import { useEffect, useRef } from 'react'
import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'
import { supabase } from '../services/supabaseClient'
import {
  buildPushDeepLink,
  emitPushDeepLink,
  FOREGROUND_PUSH_EVENT,
  normalizePushPayload,
  parsePushDeepLink,
  shouldSuppressForegroundPush,
} from '../lib/pushNotifications'

const PUSH_DEVICE_ID_STORAGE_KEY = 'regli:push-device-id'
const PUSH_REGISTRATION_STORAGE_KEY = 'regli:push-registration'

type PushPlatform = 'ios' | 'android' | 'web'

type StoredPushRegistration = {
  userId: string
  token: string
  platform: PushPlatform
  deviceId: string | null
}

function isSupportedNativePushPlatform(platform: string): platform is PushPlatform {
  return platform === 'ios' || platform === 'android'
}

function getStoredPushRegistration(): StoredPushRegistration | null {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(PUSH_REGISTRATION_STORAGE_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as StoredPushRegistration
    if (!parsed?.userId || !parsed?.token) return null
    return parsed
  } catch {
    return null
  }
}

function setStoredPushRegistration(registration: StoredPushRegistration | null) {
  if (typeof window === 'undefined') return
  if (!registration) {
    window.localStorage.removeItem(PUSH_REGISTRATION_STORAGE_KEY)
    return
  }
  window.localStorage.setItem(PUSH_REGISTRATION_STORAGE_KEY, JSON.stringify(registration))
}

function getOrCreatePushDeviceId(): string | null {
  if (typeof window === 'undefined') return null

  const existing = window.localStorage.getItem(PUSH_DEVICE_ID_STORAGE_KEY)
  if (existing) return existing

  const nextValue = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `push-device-${Date.now()}-${Math.random().toString(36).slice(2)}`

  window.localStorage.setItem(PUSH_DEVICE_ID_STORAGE_KEY, nextValue)
  return nextValue
}

function emitForegroundPushEvent(notification: {
  title?: string
  body?: string
  data?: Record<string, unknown>
}) {
  if (typeof window === 'undefined') return
  const payload = normalizePushPayload({
    type: typeof notification.data?.type === 'string' ? notification.data.type : 'new_request',
    title: notification.title,
    body: notification.body,
    deepLink: typeof notification.data?.deepLink === 'string'
      ? notification.data.deepLink
      : buildPushDeepLink(
          typeof notification.data?.type === 'string' ? notification.data.type : 'new_request',
          typeof notification.data?.related_job_id === 'string' ? notification.data.related_job_id : null,
        ),
    related_job_id: typeof notification.data?.related_job_id === 'string'
      ? notification.data.related_job_id
      : null,
    created_at: typeof notification.data?.created_at === 'string'
      ? notification.data.created_at
      : undefined,
  })

  if (shouldSuppressForegroundPush(payload)) return

  window.dispatchEvent(new CustomEvent(FOREGROUND_PUSH_EVENT, { detail: payload }))
}

async function upsertPushToken({
  userId,
  token,
  platform,
  deviceId,
  enabled,
}: {
  userId: string
  token: string
  platform: PushPlatform
  deviceId: string | null
  enabled: boolean
}) {
  const now = new Date().toISOString()
  const payload = {
    user_id: userId,
    token,
    platform,
    device_id: deviceId,
    enabled,
    updated_at: now,
    last_seen_at: now,
  }

  const { error } = await supabase
    .from('push_tokens')
    .upsert(payload, { onConflict: 'user_id,token' })

  if (error) {
    console.error('[Push] push token upsert failed', {
      userId,
      platform,
      enabled,
      message: error.message,
    })
    return false
  }

  if (enabled) {
    setStoredPushRegistration({ userId, token, platform, deviceId })
  }

  return true
}

export async function disableCurrentPushTokenForUser(userId: string | null) {
  if (!userId) return

  const stored = getStoredPushRegistration()
  if (!stored || stored.userId !== userId) return

  const success = await upsertPushToken({
    userId,
    token: stored.token,
    platform: stored.platform,
    deviceId: stored.deviceId,
    enabled: false,
  })

  if (success) {
    setStoredPushRegistration(null)
  }
}

/**
 * Registers for native push notifications and stores the device token in Supabase.
 * On web/non-native platforms this is a no-op.
 */
export function usePushNotifications(userId: string | null) {
  const activeRegistrationKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const platform = Capacitor.getPlatform()
    const isNativePlatform = Capacitor.isNativePlatform()
    const registrationKey = userId ? `${platform}:${userId}` : null

    if (!isNativePlatform || !isSupportedNativePushPlatform(platform)) {
      return undefined
    }

    if (!userId) {
      return undefined
    }
    const listenerHandles: PluginListenerHandle[] = []
    let isActive = true

    if (activeRegistrationKeyRef.current === registrationKey) {
      return undefined
    }

    activeRegistrationKeyRef.current = registrationKey
    const pushPlatform: PushPlatform = platform
    const deviceId = getOrCreatePushDeviceId()
    const uid = userId

    async function setup() {
      try {
        let permission = await PushNotifications.checkPermissions()

        if (permission.receive === 'prompt') {
          permission = await PushNotifications.requestPermissions()
        }

        if (permission.receive !== 'granted') {
          return
        }

        listenerHandles.push(await PushNotifications.addListener('registration', async (token) => {
          if (!token.value || !isActive) return
          await upsertPushToken({
            userId: uid,
            token: token.value,
            platform: pushPlatform,
            deviceId,
            enabled: true,
          })
        }))

        listenerHandles.push(await PushNotifications.addListener('registrationError', (error) => {
          console.error('[Push] native registration failed', {
            userId: uid,
            platform,
            error,
          })
        }))

        listenerHandles.push(await PushNotifications.addListener('pushNotificationReceived', (notification) => {
          emitForegroundPushEvent({
            title: notification.title,
            body: notification.body,
            data: notification.data,
          })
        }))

        listenerHandles.push(await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
          const deepLink = typeof action.notification.data?.deepLink === 'string'
            ? action.notification.data.deepLink
            : null
          const parsed = deepLink ? parsePushDeepLink(deepLink) : null
          if (parsed) {
            emitPushDeepLink(parsed)
          }
        }))

        if (!isActive) {
          cleanupListeners(listenerHandles)
          return
        }

        await PushNotifications.register()
      } catch (error) {
        console.error('[Push] native push setup failed', {
          userId: uid,
          platform,
          error,
        })
      }
    }

    void setup()

    return () => {
      isActive = false
      if (activeRegistrationKeyRef.current === registrationKey) {
        activeRegistrationKeyRef.current = null
      }
      cleanupListeners(listenerHandles)
    }
  }, [userId])
}

function cleanupListeners(handles: PluginListenerHandle[]) {
  for (const handle of handles.splice(0)) {
    try {
      void handle.remove().catch((error) => {
        console.error('[Push] listener cleanup failed', error)
      })
    } catch (error) {
      console.error('[Push] listener cleanup failed', error)
    }
  }
}
