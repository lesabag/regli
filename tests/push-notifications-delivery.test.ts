import assert from 'node:assert/strict'
import test from 'node:test'

import { planTargetedPushDelivery, resolvePushLanguage } from '../supabase/functions/_shared/pushDelivery.ts'

test('target profile language wins over client app language', () => {
  const result = resolvePushLanguage({
    profileLanguage: 'he',
    metadataLanguage: 'en',
    payloadProfileLanguage: null,
    appLanguage: 'en',
  })

  assert.deepEqual(result, {
    resolvedLanguage: 'he',
    source: 'profile',
  })
})

test('falls back to English when no language sources exist', () => {
  const result = resolvePushLanguage({
    profileLanguage: null,
    metadataLanguage: null,
    payloadProfileLanguage: null,
    appLanguage: null,
  })

  assert.deepEqual(result, {
    resolvedLanguage: 'en',
    source: 'fallback',
  })
})

test('admin dispute delivery creates bell even without push tokens', () => {
  const adminId = 'admin-123'
  const plan = planTargetedPushDelivery({
    targetUserId: adminId,
    notificationType: 'dispute_update',
    createInAppNotification: false,
    tokens: [],
  })

  assert.equal(plan.targetUserId, adminId)
  assert.equal(plan.shouldCreateBell, true)
  assert.equal(plan.shouldAttemptApns, false)
  assert.equal(plan.iosTokenCount, 0)
})

test('no APNS attempt is made when target user has no ios push tokens', () => {
  const plan = planTargetedPushDelivery({
    targetUserId: 'admin-456',
    notificationType: 'dispute_update',
    tokens: [
      { token: 'web-token', user_id: 'admin-456', platform: 'web' },
      { token: 'other-user-token', user_id: 'someone-else', platform: 'ios' },
    ],
  })

  assert.equal(plan.shouldCreateBell, true)
  assert.equal(plan.shouldAttemptApns, false)
  assert.equal(plan.iosTokenCount, 0)
})

test('targeted notification with ios token attempts APNS and preserves bell requirement when requested', () => {
  const plan = planTargetedPushDelivery({
    targetUserId: 'walker-1',
    notificationType: 'tip_received',
    createInAppNotification: true,
    tokens: [
      { token: 'ios-token', user_id: 'walker-1', platform: 'ios' },
    ],
  })

  assert.equal(plan.targetUserId, 'walker-1')
  assert.equal(plan.shouldCreateBell, true)
  assert.equal(plan.shouldAttemptApns, true)
  assert.equal(plan.iosTokenCount, 1)
})
