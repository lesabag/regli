import assert from 'node:assert/strict'
import test from 'node:test'

import { getPushCopy as getClientPushCopy } from '../src/lib/pushCopy.ts'
import { buildPushDeepLink as buildClientPushDeepLink, normalizePushPayload } from '../src/lib/pushNotifications.ts'
import { getPushCopy as getServerPushCopy } from '../supabase/functions/_shared/pushCopy.ts'
import { buildPushDeepLink as buildServerPushDeepLink, buildPushEnvelope } from '../supabase/functions/_shared/pushNotifications.ts'

const copyCases = [
  {
    type: 'new_dispatch_offer',
    context: { language: 'en', serviceType: 'dog_walker' },
    expected: {
      title: '🚶 New request nearby',
      body: 'A client is looking for dog walking. Open Regli to accept.',
    },
  },
  {
    type: 'new_dispatch_offer',
    context: { language: 'he', serviceType: 'baby_sitter' },
    expected: {
      title: '🚶 הזמנה חדשה באזור שלך',
      body: 'לקוח מחפש בייביסיטר. פתחו את Regli כדי לקבל את ההזמנה.',
    },
  },
  {
    type: 'provider_arrived',
    context: { language: 'en' },
    expected: {
      title: '👋 Arrival confirmed',
      body: 'You can start the service now.',
    },
  },
  {
    type: 'provider_arrived',
    context: { language: 'he' },
    expected: {
      title: '👋 הלקוח אישר שהגעת',
      body: 'אפשר להתחיל את השירות.',
    },
  },
  {
    type: 'service_completed',
    context: { language: 'en' },
    expected: {
      title: '🎉 Service completed',
      body: 'The service was completed successfully and the customer was updated.',
    },
  },
  {
    type: 'service_completed',
    context: { language: 'he' },
    expected: {
      title: '🎉 שירות הושלם',
      body: 'העבודה הסתיימה בהצלחה, הלקוח עודכן.',
    },
  },
  {
    type: 'client_confirmation',
    context: { language: 'en' },
    expected: {
      title: 'You can start ✅',
      body: 'The client confirmed arrival. You can start the service now.',
    },
  },
  {
    type: 'client_confirmation',
    context: { language: 'he' },
    expected: {
      title: 'אפשר להתחיל ✅',
      body: 'הלקוח אישר הגעה. אפשר להתחיל את השירות עכשיו.',
    },
  },
  {
    type: 'five_star_rating',
    context: { language: 'en' },
    expected: {
      title: '⭐ You received 5 stars',
      body: 'Great work! Your new rating was added to your profile.',
    },
  },
  {
    type: 'five_star_rating',
    context: { language: 'he' },
    expected: {
      title: '⭐ קיבלת דירוג 5',
      body: 'עבודה מעולה! הדירוג החדש נוסף לפרופיל שלך.',
    },
  },
  {
    type: 'rating_reminder',
    context: { language: 'en', ratingText: '4' },
    expected: {
      title: '⭐ You received 4 stars',
      body: 'Great work! Your new rating was added to your profile.',
    },
  },
  {
    type: 'rating_reminder',
    context: { language: 'he', ratingText: '4' },
    expected: {
      title: '⭐ קיבלת דירוג 4',
      body: 'עבודה מעולה! הדירוג החדש נוסף לפרופיל שלך.',
    },
  },
  {
    type: 'tip_received',
    context: { language: 'en', amountText: '₪25' },
    expected: {
      title: 'You received a tip ₪25 🎁',
      body: 'The client added a tip for your service. Great work!',
    },
  },
  {
    type: 'tip_received',
    context: { language: 'he', amountText: '₪25' },
    expected: {
      title: 'קיבלת טיפ ₪25 🎁',
      body: 'הלקוח הוסיף טיפ על השירות. כל הכבוד!',
    },
  },
  {
    type: 'payment_received',
    context: { language: 'en', amountText: '₪64' },
    expected: {
      title: 'Payment received ₪64 💰',
      body: 'Your earnings were sent to your payout account.',
    },
  },
  {
    type: 'payment_received',
    context: { language: 'he', amountText: '₪64' },
    expected: {
      title: 'קיבלת תשלום ₪64 💰',
      body: 'הרווחים הועברו לחשבון התשלומים שלך.',
    },
  },
  {
    type: 'dispute_update',
    context: { language: 'en', disputeEventType: 'provider_issue' as const },
    expected: {
      title: 'New provider issue',
      body: 'A provider reported an issue that needs review.',
    },
  },
  {
    type: 'dispute_update',
    context: { language: 'he', disputeEventType: 'provider_issue' as const },
    expected: {
      title: 'דיווח חדש מספק',
      body: 'ספק דיווח על בעיה שממתינה לבדיקה.',
    },
  },
  {
    type: 'dispute_update',
    context: { language: 'en', disputeEventType: 'client_completion_dispute' as const },
    expected: {
      title: 'New dispute to review',
      body: 'A client reported an issue after service completion.',
    },
  },
  {
    type: 'dispute_update',
    context: { language: 'he', disputeEventType: 'client_completion_dispute' as const },
    expected: {
      title: 'דיווח חדש לבדיקה',
      body: 'לקוח דיווח על בעיה לאחר סיום השירות.',
    },
  },
] as const

for (const testCase of copyCases) {
  test(`push copy parity for ${testCase.type} (${testCase.context.language})`, () => {
    const clientCopy = getClientPushCopy(testCase.type, testCase.context)
    const serverCopy = getServerPushCopy(testCase.type, testCase.context)

    assert.deepEqual(clientCopy, {
      language: testCase.context.language,
      ...testCase.expected,
    })
    assert.deepEqual(serverCopy, clientCopy)
  })
}

test('booking-related push types build booking deep links consistently', () => {
  const jobId = 'job-123'

  assert.equal(buildClientPushDeepLink('provider_arrived', jobId), 'regli://booking/job-123')
  assert.equal(buildClientPushDeepLink('service_completed', jobId), 'regli://booking/job-123')
  assert.equal(buildClientPushDeepLink('rating_reminder', jobId), 'regli://booking/job-123')
  assert.equal(buildClientPushDeepLink('five_star_rating', jobId), 'regli://booking/job-123')
  assert.equal(buildClientPushDeepLink('dispute_update', jobId), 'regli://booking/job-123')

  assert.equal(buildServerPushDeepLink('provider_arrived', jobId), 'regli://booking/job-123')
  assert.equal(buildServerPushDeepLink('service_completed', jobId), 'regli://booking/job-123')
  assert.equal(buildServerPushDeepLink('rating_reminder', jobId), 'regli://booking/job-123')
  assert.equal(buildServerPushDeepLink('five_star_rating', jobId), 'regli://booking/job-123')
  assert.equal(buildServerPushDeepLink('dispute_update', jobId), 'regli://booking/job-123')
})

test('tip_received uses wallet deep links consistently', () => {
  assert.equal(buildClientPushDeepLink('tip_received', 'job-123'), 'regli://wallet')
  assert.equal(buildServerPushDeepLink('tip_received', 'job-123'), 'regli://wallet')
})

test('new dispatch offers keep dispatch deep links', () => {
  assert.equal(buildClientPushDeepLink('new_dispatch_offer', 'attempt-1'), 'regli://dispatch/attempt-1')
  assert.equal(buildServerPushDeepLink('new_dispatch_offer', 'attempt-1'), 'regli://dispatch/attempt-1')
})

test('server envelope preserves tip_received type and booking dispute deep link', () => {
  const tipEnvelope = buildPushEnvelope({
    type: 'tip_received',
    title: 'tip',
    body: 'body',
    relatedJobId: 'job-1',
  })
  const disputeEnvelope = buildPushEnvelope({
    type: 'dispute_update',
    title: 'dispute',
    body: 'body',
    relatedJobId: 'job-2',
  })

  assert.equal(tipEnvelope.type, 'tip_received')
  assert.equal(disputeEnvelope.deepLink, 'regli://booking/job-2')
})

test('client normalized rating reminder is not a please-rate prompt regression', () => {
  const payload = normalizePushPayload({
    type: 'rating_reminder',
    title: getClientPushCopy('rating_reminder', { language: 'en', ratingText: '4' })?.title,
    body: getClientPushCopy('rating_reminder', { language: 'en', ratingText: '4' })?.body,
    relatedJobId: 'job-3',
  })

  assert.equal(payload.title, '⭐ You received 4 stars')
  assert.equal(payload.body, 'Great work! Your new rating was added to your profile.')
  assert.notEqual(payload.title, 'Please rate')
})
