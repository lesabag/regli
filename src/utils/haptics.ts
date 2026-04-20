import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'

export async function hapticLight() {
  try {
    await Haptics.impact({ style: ImpactStyle.Light })
  } catch {}
}

export async function hapticMedium() {
  try {
    await Haptics.impact({ style: ImpactStyle.Medium })
  } catch {}
}

export async function hapticHeavy() {
  try {
    await Haptics.impact({ style: ImpactStyle.Heavy })
  } catch {}
}

export async function hapticSuccess() {
  try {
    await Haptics.notification({ type: NotificationType.Success })
  } catch {}
}
