import type { ImpactStyle, NotificationType } from '@capacitor/haptics'

let _haptics: typeof import('@capacitor/haptics') | null = null

async function getHaptics() {
  if (!_haptics) {
    try {
      _haptics = await import('@capacitor/haptics')
    } catch {
      return null
    }
  }
  return _haptics
}

export async function hapticLight() {
  try {
    const m = await getHaptics()
    if (m) await m.Haptics.impact({ style: 'LIGHT' as ImpactStyle })
  } catch {}
}

export async function hapticMedium() {
  try {
    const m = await getHaptics()
    if (m) await m.Haptics.impact({ style: 'MEDIUM' as ImpactStyle })
  } catch {}
}

export async function hapticHeavy() {
  try {
    const m = await getHaptics()
    if (m) await m.Haptics.impact({ style: 'HEAVY' as ImpactStyle })
  } catch {}
}

export async function hapticSuccess() {
  try {
    const m = await getHaptics()
    if (m) await m.Haptics.notification({ type: 'SUCCESS' as NotificationType })
  } catch {}
}
