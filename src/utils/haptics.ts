import type { ImpactStyle, NotificationType } from '@capacitor/haptics'
import { markFirstInteractionAsync } from './firstInteractionPerf'

let _haptics: typeof import('@capacitor/haptics') | null = null
let _hapticsPromise: Promise<typeof import('@capacitor/haptics') | null> | null = null
let _hapticsWarm = false

async function getHaptics() {
  if (_haptics) return _haptics
  if (!_hapticsPromise) {
    _hapticsPromise = import('@capacitor/haptics')
      .then((module) => {
        _haptics = module
        _hapticsWarm = true
        return module
      })
      .catch(() => null)
  }
  const module = await _hapticsPromise
  if (module) {
    _haptics = module
    _hapticsWarm = true
  }
  return module
}

function scheduleHaptic(task: (module: typeof import('@capacitor/haptics')) => Promise<void>) {
  if (!_hapticsWarm) {
    markFirstInteractionAsync('haptics-cold-warmup', 'start')
    void getHaptics()
    return Promise.resolve()
  }

  window.setTimeout(() => {
    void (async () => {
      try {
        markFirstInteractionAsync('haptics', 'start')
        const module = await getHaptics()
        if (module) await task(module)
        markFirstInteractionAsync('haptics', 'end')
      } catch {}
    })()
  }, 0)

  return Promise.resolve()
}

export function warmHapticsBridge() {
  markFirstInteractionAsync('haptics-bridge-warm', 'start')
  void getHaptics()
}

export function hapticLight() {
  return scheduleHaptic(async (module) => {
    await module.Haptics.impact({ style: 'LIGHT' as ImpactStyle })
  })
}

export function hapticMedium() {
  return scheduleHaptic(async (module) => {
    await module.Haptics.impact({ style: 'MEDIUM' as ImpactStyle })
  })
}

export function hapticHeavy() {
  return scheduleHaptic(async (module) => {
    await module.Haptics.impact({ style: 'HEAVY' as ImpactStyle })
  })
}

export function hapticSuccess() {
  return scheduleHaptic(async (module) => {
    await module.Haptics.notification({ type: 'SUCCESS' as NotificationType })
  })
}
