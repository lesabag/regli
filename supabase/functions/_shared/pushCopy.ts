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
  | 'five_star_rating'
  | 'tip_received'
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
  serviceType?: string | null
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

function getServiceEmoji(serviceType: string | null | undefined): string {
  switch (serviceType?.trim()) {
    case 'dog_walker':
      return '🐾'
    case 'baby_sitter':
      return '👶'
    default:
      return '🤝'
  }
}

export function getPushCopy(
  type: SupportedPushCopyType | string,
  context: PushCopyContext = {},
): PushCopy | null {
  try {
    const language = resolvePushCopyLanguage(context.language)
    getProviderName(context.providerName ?? context.walkerName)
    const amountText = typeof context.amountText === 'string' ? context.amountText.trim() : ''
    const serviceEmoji = getServiceEmoji(context.serviceType)

    if (language === 'he') {
      switch (type) {
        case 'new_dispatch_offer':
          return {
            language,
            title: `${serviceEmoji} בקשה חדשה בקרבתך`,
            body: 'לקוח חדש מחפש עזרה עכשיו.',
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
            title: '🎉 קיבלת את הבקשה',
            body: 'הלקוח בחר בך לביצוע השירות.',
          }
        case 'provider_on_the_way':
          return {
            language,
            title: '🚗 בדרך ללקוח',
            body: 'הלקוח עודכן שאתה בדרך.',
          }
        case 'provider_arrived':
          return {
            language,
            title: '👋 הלקוח אישר שהגעת',
            body: 'אפשר להתחיל את השירות.',
          }
        case 'service_started':
          return {
            language,
            title: '▶️ השירות התחיל',
            body: 'בהצלחה! אנחנו נעדכן את הלקוח בסיום השירות.',
          }
        case 'service_completed':
          return {
            language,
            title: '🎉 שירות הושלם',
            body: 'העבודה הסתיימה בהצלחה, הלקוח עודכן.',
          }
        case 'client_confirmation':
          return {
            language,
            title: 'הלקוח אישר הגעה',
            body: 'אפשר להתחיל עכשיו.',
          }
        case 'five_star_rating':
          return {
            language,
            title: '🌟 קיבלת 5 כוכבים!',
            body: 'עבודה מצוינת! המשך כך.',
          }
        case 'tip_received':
        case 'payout_update':
          return {
            language,
            title: '🎁 קיבלת טיפ',
            body: amountText ? `${amountText} נוספו לארנק שלך.` : 'נוסף טיפ לארנק שלך.',
          }
        case 'rating_reminder':
          return {
            language,
            title: '⭐ קיבלת דירוג חדש',
            body: 'הלקוח דירג את השירות שלך.',
          }
        case 'future_booking_reminder':
          return {
            language,
            title: '📅 הזמנה עתידית מתקרבת',
            body: 'אל תשכח, יש לך שירות מתוכנן בקרוב.',
          }
        case 'weekly_recurring_booking_reminder':
          return {
            language,
            title: '🔁 תזכורת לשירות קבוע',
            body: 'השירות השבועי שלך יתחיל בקרוב.',
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
          title: `${serviceEmoji} New request nearby`,
          body: 'A new customer is looking for help right now.',
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
          title: '🎉 You got the request',
          body: 'The customer chose you for this service.',
        }
      case 'provider_on_the_way':
        return {
          language,
          title: '🚗 On your way',
          body: "The customer has been notified that you're on the way.",
        }
      case 'provider_arrived':
        return {
          language,
          title: '👋 Arrival confirmed',
          body: 'You can start the service now.',
        }
      case 'service_started':
        return {
          language,
          title: '▶️ Service started',
          body: "Good luck! We'll notify the customer when it's completed.",
        }
      case 'service_completed':
        return {
          language,
          title: '🎉 Service completed',
          body: 'The service was completed successfully and the customer was updated.',
        }
      case 'client_confirmation':
        return {
          language,
          title: 'Client confirmed arrival',
          body: 'You can start the service now.',
        }
      case 'five_star_rating':
        return {
          language,
          title: '🌟 You received 5 stars!',
          body: 'Excellent work. Keep it up.',
        }
      case 'tip_received':
      case 'payout_update':
        return {
          language,
          title: '🎁 You received a tip',
          body: amountText ? `${amountText} was added to your wallet.` : 'A tip was added to your wallet.',
        }
      case 'rating_reminder':
        return {
          language,
          title: '⭐ You received a new rating',
          body: 'The customer rated your service.',
        }
      case 'future_booking_reminder':
        return {
          language,
          title: '📅 Upcoming booking reminder',
          body: "Don't forget, you have a scheduled service coming up soon.",
        }
      case 'weekly_recurring_booking_reminder':
        return {
          language,
          title: '🔁 Weekly service reminder',
          body: 'Your recurring weekly service starts soon.',
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
  } catch {
    return null
  }
}
