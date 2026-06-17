export type PushCopyLanguage = 'en' | 'he'

export type PushRecipientRole = 'client' | 'provider'

export type SupportedPushCopyType =
  | 'new_dispatch_offer'
  | 'dispatch_expiring_soon'
  | 'dispute_update'
  | 'provider_accepted'
  | 'provider_on_the_way'
  | 'provider_arrived'
  | 'service_started'
  | 'service_completed'
  | 'client_confirmation'
  | 'five_star_rating'
  | 'payment_received'
  | 'tip_received'
  | 'payout_update'
  | 'rating_reminder'
  | 'future_booking_reminder'
  | 'weekly_recurring_booking_reminder'
  | 'scheduled_booking_reminder'

export type PushCopyContext = {
  language?: string | null
  recipientRole?: PushRecipientRole | string | null
  providerName?: string | null
  walkerName?: string | null
  amountText?: string | null
  ratingText?: string | null
  serviceType?: string | null
  disputeEventType?: 'client_completion_dispute' | 'provider_issue' | null
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

export function normalizePushRecipientRole(
  value: string | null | undefined,
): PushRecipientRole | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'client') return 'client'
  if (normalized === 'provider' || normalized === 'walker') return 'provider'
  return null
}

function getProviderName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function getServiceLabel(serviceType: string | null | undefined, language: PushCopyLanguage): string {
  switch (serviceType?.trim()) {
    case 'dog_walker':
      return language === 'he' ? 'טיול לכלב' : 'dog walking'
    case 'baby_sitter':
      return language === 'he' ? 'בייביסיטר' : 'babysitting'
    default:
      return language === 'he' ? 'שירות' : 'help'
  }
}

function getTrimmedContextValue(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function getPushCopy(
  type: SupportedPushCopyType | string,
  context: PushCopyContext = {},
): PushCopy | null {
  const language = resolvePushCopyLanguage(context.language)
  getProviderName(context.providerName ?? context.walkerName)
  const amountText = getTrimmedContextValue(context.amountText)
  const ratingText = getTrimmedContextValue(context.ratingText)
  const serviceLabel = getServiceLabel(context.serviceType, language)
  const disputeEventType = context.disputeEventType ?? null
  const recipientRole = normalizePushRecipientRole(context.recipientRole)
  const isClient = recipientRole === 'client'

  if (language === 'he') {
    switch (type) {
      case 'new_dispatch_offer':
        return {
          language,
          title: 'הזמנה חדשה באזור שלך 🚶',
          body: `לקוח מחפש ${serviceLabel}. פתחו את Regli כדי לקבל את ההזמנה.`,
        }
      case 'dispatch_expiring_soon':
        return {
          language,
          title: 'ההצעה עומדת לפוג',
          body: 'כדאי להגיב עכשיו כדי לא לפספס.',
        }
      case 'dispute_update':
        if (disputeEventType === 'client_completion_dispute') {
          return {
            language,
            title: 'דיווח חדש לבדיקה',
            body: 'לקוח דיווח על בעיה לאחר סיום השירות.',
          }
        }
        if (disputeEventType === 'provider_issue') {
          return {
            language,
            title: 'דיווח חדש מספק',
            body: 'ספק דיווח על בעיה שממתינה לבדיקה.',
          }
        }
        return {
          language,
          title: 'עדכון על מחלוקת',
          body: 'נדרש טיפול מצד הצוות.',
        }
      case 'provider_accepted':
        if (isClient) {
          return {
            language,
            title: 'הספק אישר את ההזמנה 👋',
            body: 'מצאנו לך ספק. נעדכן אותך בהמשך.',
          }
        }
        return {
          language,
          title: 'בדרך ללקוח 🚗',
          body: 'הלקוח עודכן שאתה בדרך.',
        }
      case 'provider_on_the_way':
        if (isClient) {
          return {
            language,
            title: 'הספק בדרך אליך 🚗',
            body: 'הספק בדרך למיקום השירות.',
          }
        }
        return {
          language,
          title: 'בדרך ללקוח 🚗',
          body: 'הלקוח עודכן שאתה בדרך.',
        }
      case 'provider_arrived':
        if (isClient) {
          return {
            language,
            title: 'הספק הגיע 📍',
            body: 'הספק הגיע למיקום השירות.',
          }
        }
        return {
          language,
          title: 'הלקוח אישר שהגעת 👋',
          body: 'אפשר להתחיל את השירות.',
        }
      case 'service_started':
        if (isClient) {
          return {
            language,
            title: 'השירות התחיל ▶️',
            body: 'השירות שלך התחיל. נעדכן אותך כשהוא יסתיים.',
          }
        }
        return {
          language,
          title: 'השירות התחיל ▶️',
          body: 'בהצלחה! נעדכן את הלקוח בסיום השירות.',
        }
      case 'service_completed':
        if (isClient) {
          return {
            language,
            title: 'השירות הושלם 🎉',
            body: 'השירות הסתיים בהצלחה. אפשר להשאיר דירוג וטיפ.',
          }
        }
        return {
          language,
          title: 'השירות הושלם 🎉',
          body: 'השירות הסתיים בהצלחה.',
        }
      case 'client_confirmation':
        return {
          language,
          title: 'אפשר להתחיל ✅',
          body: 'הלקוח אישר הגעה. אפשר להתחיל את השירות עכשיו.',
        }
      case 'five_star_rating':
        return {
          language,
          title: 'קיבלת דירוג 5 ⭐',
          body: 'עבודה מעולה! הדירוג החדש נוסף לפרופיל שלך.',
        }
      case 'tip_received':
        return {
          language,
          title: amountText ? `קיבלת טיפ ${amountText} 🎁` : 'קיבלת טיפ 🎁',
          body: 'הלקוח הוסיף טיפ על השירות. כל הכבוד!',
        }
      case 'payment_received':
      case 'payout_update':
        return {
          language,
          title: amountText ? `קיבלת תשלום ${amountText} 💰` : 'קיבלת תשלום 💰',
          body: 'הרווחים הועברו לחשבון התשלומים שלך.',
        }
      case 'rating_reminder':
        return {
          language,
          title: ratingText ? `קיבלת דירוג ${ratingText} ⭐` : 'קיבלת דירוג חדש ⭐',
          body: 'עבודה מעולה! הדירוג החדש נוסף לפרופיל שלך.',
        }
      case 'future_booking_reminder':
        return {
          language,
          title: 'הזמנה עתידית מתקרבת 📅',
          body: 'אל תשכח, יש לך שירות מתוכנן בקרוב.',
        }
      case 'weekly_recurring_booking_reminder':
        return {
          language,
          title: 'תזכורת לשירות קבוע 🔁',
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
        title: 'New request nearby 🚶',
        body: `A client is looking for ${serviceLabel}. Open Regli to accept.`,
      }
    case 'dispatch_expiring_soon':
      return {
        language,
        title: 'Offer expiring soon',
        body: 'Respond now so you do not miss it.',
      }
    case 'dispute_update':
      if (disputeEventType === 'client_completion_dispute') {
        return {
          language,
          title: 'New dispute to review',
          body: 'A client reported an issue after service completion.',
        }
      }
      if (disputeEventType === 'provider_issue') {
        return {
          language,
          title: 'New provider issue',
          body: 'A provider reported an issue that needs review.',
        }
      }
      return {
        language,
        title: 'Dispute update',
        body: 'A booking issue needs review.',
      }
    case 'provider_accepted':
      if (isClient) {
        return {
          language,
          title: 'Your provider accepted 👋',
          body: "We found you a provider. We'll keep you posted.",
        }
      }
      return {
        language,
        title: 'On your way 🚗',
        body: "The customer has been notified that you're on the way.",
      }
    case 'provider_on_the_way':
      if (isClient) {
        return {
          language,
          title: 'Your provider is on the way 🚗',
          body: 'The provider is heading to the service location.',
        }
      }
      return {
        language,
        title: 'On your way 🚗',
        body: "The customer has been notified that you're on the way.",
      }
    case 'provider_arrived':
      if (isClient) {
        return {
          language,
          title: 'Your provider arrived 📍',
          body: 'The provider has arrived at the service location.',
        }
      }
      return {
        language,
        title: 'Arrival confirmed 👋',
        body: 'You can start the service now.',
      }
    case 'service_started':
      if (isClient) {
        return {
          language,
          title: 'Service started ▶️',
          body: "Your service has started. We'll notify you when it's complete.",
        }
      }
      return {
        language,
        title: 'Service started ▶️',
        body: "Good luck! We'll notify the customer when it's complete.",
      }
    case 'service_completed':
      if (isClient) {
        return {
          language,
          title: 'Service completed 🎉',
          body: 'The service ended successfully. You can leave a rating and tip.',
        }
      }
      return {
        language,
        title: 'Service completed 🎉',
        body: 'The service was completed successfully.',
      }
    case 'client_confirmation':
      return {
        language,
        title: 'You can start ✅',
        body: 'The client confirmed arrival. You can start the service now.',
      }
    case 'five_star_rating':
      return {
        language,
        title: 'You received 5 stars ⭐',
        body: 'Great work! Your new rating was added to your profile.',
      }
    case 'tip_received':
      return {
        language,
        title: amountText ? `You received a tip ${amountText} 🎁` : 'You received a tip 🎁',
        body: 'The client added a tip for your service. Great work!',
      }
    case 'payment_received':
    case 'payout_update':
      return {
        language,
        title: amountText ? `Payment received ${amountText} 💰` : 'Payment received 💰',
        body: 'Your earnings were sent to your payout account.',
      }
    case 'rating_reminder':
      return {
        language,
        title: ratingText ? `You received ${ratingText} stars ⭐` : 'You received a rating ⭐',
        body: 'Great work! Your new rating was added to your profile.',
      }
    case 'future_booking_reminder':
      return {
        language,
        title: 'Upcoming booking reminder 📅',
        body: "Don't forget, you have a scheduled service coming up soon.",
      }
    case 'weekly_recurring_booking_reminder':
      return {
        language,
        title: 'Weekly service reminder 🔁',
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
}
