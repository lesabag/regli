import assert from 'node:assert/strict'
import test from 'node:test'

import i18n from '../src/i18n.ts'
import { getServiceLabels } from '../src/utils/serviceLifecycle.ts'
import { formatDurationFromMinutes, formatElapsedDurationFromSeconds } from '../src/utils/serviceTiming.ts'

test('service lifecycle labels localize to Hebrew for provider/client cards', async () => {
  const previousLanguage = i18n.resolvedLanguage
  await i18n.changeLanguage('he')

  try {
    const defaultLabels = getServiceLabels(null)
    const dogLabels = getServiceLabels('dog_walker')

    assert.equal(defaultLabels.activeTitle, 'השירות פעיל כעת')
    assert.equal(defaultLabels.completedTitle, 'השירות הושלם')
    assert.equal(dogLabels.activeTitle, 'הטיול פעיל כעת')
    assert.equal(dogLabels.completeAction, 'סיים טיול')
  } finally {
    await i18n.changeLanguage(previousLanguage || 'en')
  }
})

test('shared duration helpers localize Hebrew card units', async () => {
  const previousLanguage = i18n.resolvedLanguage
  await i18n.changeLanguage('he')

  try {
    assert.equal(formatDurationFromMinutes(60), '1 שעה')
    assert.equal(formatDurationFromMinutes(30), '30 דק׳')
    assert.equal(formatElapsedDurationFromSeconds(9), '9 שניות')
    assert.equal(formatElapsedDurationFromSeconds(3600), '1 שעה')
  } finally {
    await i18n.changeLanguage(previousLanguage || 'en')
  }
})

test('shared duration helpers keep English card units unchanged', async () => {
  const previousLanguage = i18n.resolvedLanguage
  await i18n.changeLanguage('en')

  try {
    assert.equal(formatDurationFromMinutes(60), '1 h')
    assert.equal(formatDurationFromMinutes(30), '30 min')
    assert.equal(formatElapsedDurationFromSeconds(9), '9 sec')
    assert.equal(formatElapsedDurationFromSeconds(3660), '1 h 1 min')
  } finally {
    await i18n.changeLanguage(previousLanguage || 'en')
  }
})
