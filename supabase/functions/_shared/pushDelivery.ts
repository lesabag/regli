import { resolvePushCopyLanguage } from './pushCopy.ts'

export type PushLanguageResolutionResult = {
  resolvedLanguage: 'en' | 'he'
  source: 'user_metadata' | 'profile' | 'fallback'
}

export function resolvePushLanguage(params: {
  profileLanguage?: string | null
  metadataLanguage?: string | null
  payloadProfileLanguage?: string | null
  appLanguage?: string | null
}): PushLanguageResolutionResult {
  if (params.profileLanguage) {
    return {
      resolvedLanguage: resolvePushCopyLanguage(params.profileLanguage),
      source: 'profile',
    }
  }

  if (params.metadataLanguage) {
    return {
      resolvedLanguage: resolvePushCopyLanguage(params.metadataLanguage),
      source: 'user_metadata',
    }
  }

  return {
    resolvedLanguage: resolvePushCopyLanguage(params.payloadProfileLanguage, params.appLanguage),
    source: 'fallback',
  }
}

export type PushTokenRow = {
  token: string
  user_id: string
  platform: string
}

export type TargetedPushDeliveryPlan = {
  targetUserId: string
  shouldCreateBell: boolean
  shouldAttemptApns: boolean
  iosTokenCount: number
}

export function planTargetedPushDelivery(params: {
  targetUserId: string
  notificationType: string
  createInAppNotification?: boolean
  tokens?: PushTokenRow[] | null
}): TargetedPushDeliveryPlan {
  const tokens = (params.tokens ?? []).filter((row) => row.user_id === params.targetUserId)
  const iosTokenCount = tokens.filter((row) => row.platform === 'ios').length

  return {
    targetUserId: params.targetUserId,
    shouldCreateBell:
      params.createInAppNotification === true || params.notificationType === 'dispute_update',
    shouldAttemptApns: iosTokenCount > 0,
    iosTokenCount,
  }
}
