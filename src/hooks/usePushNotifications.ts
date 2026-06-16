import { useEffect, useRef } from 'react'
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
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
type PushTokenEnvironment = 'sandbox' | 'production'
type PushInstallSource = 'xcode_debug' | 'testflight' | 'app_store' | 'unknown'

type NativePushRegistrationInfo = {
  apnsEnvironment?: PushTokenEnvironment | null
  installSource?: PushInstallSource | null
  buildConfiguration?: 'debug' | 'release' | 'unknown' | null
  isDebugBuild?: boolean | null
}

type RegliBuildInfoPlugin = {
  getPushRegistrationInfo(): Promise<NativePushRegistrationInfo>
}

type StoredPushRegistration = {
  userId: string
  token: string
  platform: PushPlatform
  deviceId: string | null
  environment: PushTokenEnvironment
  installSource: PushInstallSource
}

const RegliBuildInfo = registerPlugin<RegliBuildInfoPlugin>('RegliBuildInfo')

function isSupportedNativePushPlatform(platform: string): platform is PushPlatform {
  return platform === 'ios' || platform === 'android'
}

function getStoredPushRegistration(): StoredPushRegistration | null {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(PUSH_REGISTRATION_STORAGE_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<StoredPushRegistration>
    if (!parsed?.userId || !parsed?.token) return null
    const parsedPlatform = parsed.platform
    const platform: PushPlatform =
      parsedPlatform === 'ios' || parsedPlatform === 'android' || parsedPlatform === 'web'
        ? parsedPlatform
        : 'ios'
    return {
      userId: parsed.userId,
      token: parsed.token,
      platform,
      deviceId: parsed.deviceId ?? null,
      environment: normalizePushTokenEnvironment(parsed.environment, platform),
      installSource: normalizePushInstallSource(parsed.installSource),
    }
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

function normalizePushTokenEnvironment(
  value: unknown,
  platform: PushPlatform,
): PushTokenEnvironment {
  if (platform === 'ios') {
    return value === 'sandbox' ? 'sandbox' : 'production'
  }

  return 'production'
}

function normalizePushInstallSource(value: unknown): PushInstallSource {
  return value === 'xcode_debug'
    || value === 'testflight'
    || value === 'app_store'
    ? value
    : 'unknown'
}

async function getNativePushRegistrationInfo(
  platform: PushPlatform,
): Promise<{
  environment: PushTokenEnvironment
  installSource: PushInstallSource
  buildConfiguration: 'debug' | 'release' | 'unknown'
  isDebugBuild: boolean
}> {
  if (platform !== 'ios' || !Capacitor.isNativePlatform()) {
    return {
      environment: 'production',
      installSource: 'unknown',
      buildConfiguration: 'unknown',
      isDebugBuild: false,
    }
  }

  try {
    const info = await RegliBuildInfo.getPushRegistrationInfo()
    const buildConfiguration =
      info.buildConfiguration === 'debug' || info.buildConfiguration === 'release'
        ? info.buildConfiguration
        : 'unknown'

    return {
      environment: normalizePushTokenEnvironment(info.apnsEnvironment, platform),
      installSource: normalizePushInstallSource(info.installSource),
      buildConfiguration,
      isDebugBuild: info.isDebugBuild === true || buildConfiguration === 'debug',
    }
  } catch (error) {
    console.warn('[Push] native push registration info unavailable', {
      platform,
      error,
    })
    return {
      environment: 'production',
      installSource: 'unknown',
      buildConfiguration: 'unknown',
      isDebugBuild: false,
    }
  }
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
  environment,
  installSource,
  enabled,
}: {
  userId: string
  token: string
  platform: PushPlatform
  deviceId: string | null
  environment: PushTokenEnvironment
  installSource: PushInstallSource
  enabled: boolean
}) {
  const now = new Date().toISOString()
  const payload = {
    user_id: userId,
    token,
    platform,
    device_id: deviceId,
    environment,
    install_source: installSource,
    enabled,
    updated_at: now,
    last_seen_at: now,
  }

  if (deviceId) {
    const { error: disableEnvError } = await supabase
      .from('push_tokens')
      .update({
        enabled: false,
        updated_at: now,
      })
      .eq('user_id', userId)
      .eq('platform', platform)
      .eq('device_id', deviceId)
      .neq('environment', environment)

    if (disableEnvError) {
      console.warn('[Push] conflicting token environment cleanup failed', {
        userId,
        platform,
        environment,
        deviceId,
        message: disableEnvError.message,
      })
    }
  }

  const { error } = await supabase
    .from('push_tokens')
    .upsert(payload, { onConflict: 'user_id,token,platform,environment' })

  if (error) {
    console.error('[Push] push token upsert failed', {
      userId,
      platform,
      environment,
      installSource,
      enabled,
      message: error.message,
    })
    return false
  }

  if (enabled) {
    setStoredPushRegistration({ userId, token, platform, deviceId, environment, installSource })
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
    environment: stored.environment,
    installSource: stored.installSource,
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
        const registrationInfo = await getNativePushRegistrationInfo(pushPlatform)
        let permission = await PushNotifications.checkPermissions()

        if (permission.receive === 'prompt') {
          permission = await PushNotifications.requestPermissions()
        }

        if (permission.receive !== 'granted') {
          return
        }

        listenerHandles.push(await PushNotifications.addListener('registration', async (token) => {
          if (!token.value || !isActive) return
          console.log('[Push] native registration received', {
            userId: uid,
            platform: pushPlatform,
            environment: registrationInfo.environment,
            installSource: registrationInfo.installSource,
            buildConfiguration: registrationInfo.buildConfiguration,
            isDebugBuild: registrationInfo.isDebugBuild,
            deviceId,
            tokenPrefix: token.value.slice(0, 8),
          })
          await upsertPushToken({
            userId: uid,
            token: token.value,
            platform: pushPlatform,
            deviceId,
            environment: registrationInfo.environment,
            installSource: registrationInfo.installSource,
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
