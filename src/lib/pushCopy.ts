export type PushCopyLanguage = 'en' | 'he'

export type SupportedPushCopyType =
  | 'new_dispatch_offer'
  | 'dispatch_expiring_soon'
  | 'provider_accepted'
  | 'provider_on_the_way'
  | 'provider_arrived'
  | 'service_started'
  | 'service_completed'
  | 'client_confirmation'
  | 'payout_update'
  | 'rating_reminder'
  | 'future_booking_reminder'
  | 'weekly_recurring_booking_reminder'
  | 'scheduled_booking_reminder'

export type PushCopyContext = {
  language?: string | null
  providerName?: string | null
  walkerName?: string | null
  amountText?: string | null
}

export type PushCopy = {
  title: string
  body: string
  language: PushCopyLanguage
}

function normalizePushCopyLanguage(value: string | null | undefined): PushCopyLanguage | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (
    normalized === 'he' ||
    normalized === 'he-il' ||
    normalized === 'iw' ||
    normalized === 'iw-il' ||
    normalized === 'hebrew'
  ) {
    return 'he'
  }
  if (normalized === 'en' || normalized === 'en-us' || normalized === 'en-gb' || normalized === 'english') {
    return 'en'
  }
  return null
}

export function resolvePushCopyLanguage(...values: Array<string | null | undefined>): PushCopyLanguage {
  for (const value of values) {
    const normalized = normalizePushCopyLanguage(value)
    if (normalized) return normalized
  }
  return 'en'
}

function getProviderName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function getPushCopy(
  type: SupportedPushCopyType | string,
  context: PushCopyContext = {},
): PushCopy | null {
  const language = resolvePushCopyLanguage(context.language)
  const providerName = getProviderName(context.providerName ?? context.walkerName)
  const amountText = typeof context.amountText === 'string' ? context.amountText.trim() : ''

  if (language === 'he') {
    switch (type) {
      case 'new_dispatch_offer':
        return {
          language,
          title: 'בקשה חדשה באזור',
          body: 'בקשה חדשה מחכה לתגובה שלך.',
        }
      case 'dispatch_expiring_soon':
        return {
          language,
          title: 'ההצעה עומדת לפוג',
          body: 'כדאי להגיב עכשיו כדי לא לפספס.',
        }
      case 'provider_accepted':
        return {
          language,
          title: 'ההזמנה אושרה',
          body: providerName ? `${providerName} אישר את ההזמנה.` : 'הספק שלך אישר את ההזמנה.',
        }
      case 'provider_on_the_way':
        return {
          language,
          title: 'הספק בדרך אליך',
          body: providerName ? `${providerName} בדרך אליך.` : 'הספק שלך כבר בדרך.',
        }
      case 'provider_arrived':
        return {
          language,
          title: 'הספק הגיע',
          body: providerName ? `${providerName} כבר הגיע.` : 'הספק שלך כבר הגיע.',
        }
      case 'service_started':
        return {
          language,
          title: 'השירות התחיל',
          body: providerName ? `${providerName} התחיל את השירות.` : 'השירות שלך התחיל.',
        }
      case 'service_completed':
        return {
          language,
          title: 'אפשר לאשר סיום',
          body: providerName ? `${providerName} סימן שהשירות הסתיים.` : 'הספק סימן שהשירות הסתיים.',
        }
      case 'client_confirmation':
        return {
          language,
          title: 'הלקוח אישר הגעה',
          body: 'אפשר להתחיל עכשיו.',
        }
      case 'payout_update':
        return {
          language,
          title: amountText ? 'קיבלת תשלום' : 'התשלום אושר',
          body: amountText ? `${amountText} נוספו לארנק שלך.` : 'התשלום בדרך לארנק שלך.',
        }
      case 'rating_reminder':
        return {
          language,
          title: 'איך היה?',
          body: 'נשמח אם תדרג את החוויה.',
        }
      case 'future_booking_reminder':
        return {
          language,
          title: 'יש לך הזמנה קרובה',
          body: 'כדאי לפתוח את האפליקציה ולהתכונן.',
        }
      case 'weekly_recurring_booking_reminder':
        return {
          language,
          title: 'התזכורת השבועית כאן',
          body: 'יש לך הזמנה קבועה שמתחילה בקרוב.',
        }
      case 'scheduled_booking_reminder':
        return {
          language,
          title: 'הגיע הזמן לצאת',
          body: 'ההזמנה הקרובה שלך מתחילה בקרוב.',
        }
      default:
        return null
    }
  }

  switch (type) {
    case 'new_dispatch_offer':
      return {
        language,
        title: 'New request nearby',
        body: 'A new request is waiting for your response.',
      }
    case 'dispatch_expiring_soon':
      return {
        language,
        title: 'Offer expiring soon',
        body: 'Respond now so you do not miss it.',
      }
    case 'provider_accepted':
      return {
        language,
        title: 'Your provider accepted',
        body: providerName ? `${providerName} accepted your request.` : 'Your request was accepted.',
      }
    case 'provider_on_the_way':
      return {
        language,
        title: 'Your provider is on the way',
        body: providerName ? `${providerName} is heading to you now.` : 'Your provider is heading to you now.',
      }
    case 'provider_arrived':
      return {
        language,
        title: 'Your provider has arrived',
        body: providerName ? `${providerName} has arrived.` : 'Your provider has arrived.',
      }
    case 'service_started':
      return {
        language,
        title: 'Your service has started',
        body: providerName ? `${providerName} just got started.` : 'Your service just got started.',
      }
    case 'service_completed':
      return {
        language,
        title: 'Confirm service completion',
        body: providerName ? `${providerName} marked the service complete.` : 'Your provider marked the service complete.',
      }
    case 'client_confirmation':
      return {
        language,
        title: 'Client confirmed arrival',
        body: 'You can start the service now.',
      }
    case 'payout_update':
      return {
        language,
        title: amountText ? 'Payment received' : 'Payout confirmed',
        body: amountText ? `${amountText} was added to your wallet.` : 'Payment is on the way to your wallet.',
      }
    case 'rating_reminder':
      return {
        language,
        title: 'Rate your experience',
        body: 'A quick rating helps the community.',
      }
    case 'future_booking_reminder':
      return {
        language,
        title: 'Upcoming booking',
        body: 'Open the app to get ready.',
      }
    case 'weekly_recurring_booking_reminder':
      return {
        language,
        title: 'Weekly booking reminder',
        body: 'Your recurring booking is coming up soon.',
      }
    case 'scheduled_booking_reminder':
      return {
        language,
        title: 'Time to head out',
        body: 'Your upcoming booking starts soon.',
      }
    default:
      return null
  }
}
