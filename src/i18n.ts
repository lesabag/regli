import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

export const LANGUAGE_STORAGE_KEY = 'regli_language'

type SupportedLanguage = 'en' | 'he'

function getInitialLanguage(): SupportedLanguage {
  if (typeof window !== 'undefined') {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (stored === 'en' || stored === 'he') return stored
  }

  if (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('he')) {
    return 'he'
  }

  return 'en'
}

function applyDocumentLanguage(language: string) {
  if (typeof document === 'undefined') return
  const normalized: SupportedLanguage = language === 'he' ? 'he' : 'en'
  document.documentElement.lang = normalized
  document.documentElement.dir = normalized === 'he' ? 'rtl' : 'ltr'
}

const resources = {
  en: {
    translation: {
      common: {
        language: 'Language',
        cancel: 'Cancel',
        save: 'Save',
        close: 'Close',
        back: 'Back',
        date: 'Date',
        time: 'Time',
        provider: 'Provider',
        client: 'Client',
      },
      menu: {
        menu: 'Menu',
        settings: 'Settings',
        tripHistory: 'Trip history',
        allHistory: 'All history',
        allHistorySubtitle: 'Your previous orders and reviews.',
        futureOrders: 'Future orders',
        futureOrdersSubtitle: 'Scheduled walks waiting to be dispatched.',
        preferredWalkers: 'Preferred walkers',
        preferredWalkersSubtitle: 'Saved walkers for quick reference.',
        walkHistory: 'Walk history',
        walkHistorySubtitle: 'Recent completed orders.',
        noWalkHistory: 'No walk history yet',
        noWalkHistorySubtitle: 'Your completed walks and reviews will appear here.',
        noFutureOrders: 'No future orders.',
        noPreferredWalkers: 'No preferred walkers yet.',
        viewAll: 'View all',
        signOut: 'Sign out',
        remove: 'Remove',
        scheduledWalk: 'Scheduled walk',
        scheduledFor: 'Scheduled for {{time}}',
        findingProviderAround: 'Finding provider around {{time}}',
        estimatedArrivalAround: 'Estimated arrival around {{time}}',
        startsInMinutes_one: 'starts in {{count}} min',
        startsInMinutes_other: 'starts in {{count}} min',
        reviewScore: 'review score',
        favoriteWalker: 'Preferred provider: {{name}}',
        favoriteWalkersCount_one: 'Preferred providers ({{count}})',
        favoriteWalkersCount_other: 'Preferred providers ({{count}})',
        openFutureOrders: 'Open future orders',
        latestTrips: 'Latest trips',
      },
      booking: {
        pickupFrom: 'Pick-up from:',
        durationQuestion: 'How long should we walk?',
        findNearbyProviders: 'Find nearby providers',
        pickup: 'Pickup',
        pickupLocation: 'Pickup location',
        findingLocation: 'Finding your location...',
        dogNamePlaceholder: "Dog's name",
        startHere: 'Start here',
        chooseDuration: 'Choose a duration',
        addPaymentMethod: 'Add payment method',
        schedule: 'Schedule',
        scheduleOrder: 'Schedule order',
        scheduleWalk: 'Schedule walk',
        orderNow: 'Order now',
        bookingLabel: 'BOOK',
        now: 'NOW',
        change: 'Change',
        bookNow: 'BOOK NOW',
        dispatchStartsAutomatically: 'Dispatch starts automatically about 15 min before the walk.',
        startFindingRightAway: 'We’ll start finding a walker right away.',
        priceLockedNow: 'Price locked now · payment visible · auto dispatch later',
        serviceFeeIncluded: 'Service fee included · charged after walk',
        completeHighlightedField: 'Complete the highlighted field to continue',
        scheduling: 'Scheduling...',
        requesting: 'Requesting...',
        loadingPayment: 'Loading payment...',
        addCard: 'Add a card',
        confirmSchedule: 'Confirm schedule',
        findingYourProvider: 'Finding your provider',
        findingYourProviderSubtitle: 'We’ve started matching your scheduled order with nearby providers.',
        pullUp: 'Pull up',
        pullDown: 'Pull down',
        greeting: 'Hi, {{name}}',
        noProvidersAvailable: 'No providers available right now',
        providersBusyRetryLater: 'Nearby providers are busy. Try again or schedule for later.',
        tryAgainSoon: 'Try again in a few minutes',
        fifteenMinutesBefore: '15 min before',
        walkFallback: 'Walk',
      },
      tracking: {
        eta: 'ETA',
        distance: 'Distance',
        gps: 'GPS',
        elapsed: 'Elapsed',
        planned: 'Planned',
        actual: 'Actual',
        onTheWay: 'On the way',
        providerArrived: 'Provider has arrived',
        walkInProgress: 'Walk in progress 🐾',
        readyToStart: "Let's start 🙂",
        readySubtitle: 'Your provider is ready to start the service.',
        startedSubtitle: 'Your service has started.',
        arrivalConfirmationSubtitle: 'Confirm the provider is with you before service starts',
        headingToYou: '{{walkerName}} is heading to you',
        confirmArrival: 'Confirm arrival',
        confirmingArrival: 'Confirming...',
        arrived: 'Arrived',
        here: 'Here',
        live: 'Live',
        delayed: 'Delayed',
        offline: 'Offline',
      },
      completion: {
        completed: 'Completed',
        rateProvider: 'Rate {{name}}',
      },
      dogNameSheet: {
        title: 'Dog name',
        subtitle: 'Pick a previous name quickly or type a new one.',
        addNew: 'Add new',
        typePlaceholder: 'Type dog name',
      },
      firstBooking: {
        checkingPaymentSetup: 'Checking your payment setup',
        readyToBook: 'You’re ready to book',
        almostReady: 'You’re almost ready',
        thisOnlyTakesMoment: 'This only takes a moment.',
        addServiceDetails: 'Add the service details and we’ll find a provider nearby.',
        addPaymentBeforeFirstBooking: 'Add a payment method before your first booking.',
        chargeAfterCompleted: 'You’ll only be charged after the service is completed.',
        checking: 'Checking...',
        startBooking: 'Start booking',
        addPaymentMethod: 'Add payment method',
      },
      tip: {
        addTip: 'Add a tip for {{walkerName}}?',
        optionalSeparate: 'Optional, separate from the walk payment.',
        customAmount: 'Custom amount',
        customPlaceholder: 'Custom',
        send: 'Send',
        noTip: 'No tip',
      },
    },
  },
  he: {
    translation: {
      common: {
        language: 'שפה',
        cancel: 'ביטול',
        save: 'שמירה',
        close: 'סגירה',
        back: 'חזרה',
        date: 'תאריך',
        time: 'שעה',
        provider: 'ספק',
        client: 'לקוח',
      },
      menu: {
        menu: 'תפריט',
        settings: 'הגדרות',
        tripHistory: 'היסטוריית טיולים',
        allHistory: 'כל ההיסטוריה',
        allHistorySubtitle: 'ההזמנות והביקורות הקודמות שלך.',
        futureOrders: 'הזמנות עתידיות',
        futureOrdersSubtitle: 'טיולים מתוזמנים שמחכים לשיגור.',
        preferredWalkers: 'ספקים מועדפים',
        preferredWalkersSubtitle: 'ספקים ששמרת לגישה מהירה.',
        walkHistory: 'היסטוריית טיולים',
        walkHistorySubtitle: 'הזמנות שהושלמו לאחרונה.',
        noWalkHistory: 'אין עדיין היסטוריית טיולים',
        noWalkHistorySubtitle: 'הטיולים והביקורות שהושלמו יופיעו כאן.',
        noFutureOrders: 'אין הזמנות עתידיות.',
        noPreferredWalkers: 'אין עדיין ספקים מועדפים.',
        viewAll: 'לצפייה בהכול',
        signOut: 'התנתקות',
        remove: 'הסרה',
        scheduledWalk: 'טיול מתוזמן',
        scheduledFor: 'מתוזמן ל־{{time}}',
        findingProviderAround: 'נחפש ספק בסביבות {{time}}',
        estimatedArrivalAround: 'הגעה משוערת בסביבות {{time}}',
        startsInMinutes_one: 'מתחיל בעוד דקה',
        startsInMinutes_two: 'מתחיל בעוד {{count}} דקות',
        startsInMinutes_many: 'מתחיל בעוד {{count}} דקות',
        startsInMinutes_other: 'מתחיל בעוד {{count}} דקות',
        reviewScore: 'ציון ביקורות',
        favoriteWalker: 'ספק מועדף: {{name}}',
        favoriteWalkersCount_one: 'ספקים מועדפים ({{count}})',
        favoriteWalkersCount_two: 'ספקים מועדפים ({{count}})',
        favoriteWalkersCount_many: 'ספקים מועדפים ({{count}})',
        favoriteWalkersCount_other: 'ספקים מועדפים ({{count}})',
        openFutureOrders: 'פתיחת ההזמנות העתידיות',
        latestTrips: 'נסיעות אחרונות',
      },
      booking: {
        pickupFrom: 'איסוף מ:',
        durationQuestion: 'כמה זמן הטיול?',
        findNearbyProviders: 'מצאו ספקים קרובים',
        pickup: 'איסוף',
        pickupLocation: 'מיקום איסוף',
        findingLocation: 'מאתרים את המיקום שלך...',
        dogNamePlaceholder: 'שם הכלב/ה',
        startHere: 'מתחילים כאן',
        chooseDuration: 'בחרו משך זמן',
        addPaymentMethod: 'הוסיפו אמצעי תשלום',
        schedule: 'תזמון',
        scheduleOrder: 'הזמנה עתידית',
        scheduleWalk: 'תזמון טיול',
        orderNow: 'הזמן עכשיו',
        bookingLabel: 'הזמנה',
        now: 'עכשיו',
        change: 'שינוי',
        bookNow: 'להזמין עכשיו',
        dispatchStartsAutomatically: 'השיגור יתחיל אוטומטית כ־15 דקות לפני הטיול.',
        startFindingRightAway: 'נתחיל לחפש ספק מיד.',
        priceLockedNow: 'המחיר נשמר עכשיו · התשלום מוצג · השיגור בהמשך',
        serviceFeeIncluded: 'דמי השירות כלולים · החיוב יתבצע אחרי הטיול',
        completeHighlightedField: 'השלימו את השדה המודגש כדי להמשיך',
        scheduling: 'מתזמנים...',
        requesting: 'שולחים בקשה...',
        loadingPayment: 'טוענים תשלום...',
        addCard: 'הוספת כרטיס',
        confirmSchedule: 'אישור תזמון',
        findingYourProvider: 'מאתרים את הספק שלך',
        findingYourProviderSubtitle: 'התחלנו להתאים להזמנה המתוזמנת שלך ספקים קרובים.',
        pullUp: 'משכו למעלה',
        pullDown: 'משכו למטה',
        greeting: 'היי, {{name}}',
        noProvidersAvailable: 'אין כרגע ספקים זמינים',
        providersBusyRetryLater: 'הספקים הקרובים עסוקים כרגע. נסו שוב או תזמנו למועד מאוחר יותר.',
        tryAgainSoon: 'נסו שוב בעוד כמה דקות',
        fifteenMinutesBefore: '15 דקות לפני',
        walkFallback: 'טיול',
      },
      tracking: {
        eta: 'זמן הגעה',
        distance: 'מרחק',
        gps: 'GPS',
        elapsed: 'עבר',
        planned: 'מתוכנן',
        actual: 'בפועל',
        onTheWay: 'בדרך אליך',
        providerArrived: 'הספק הגיע',
        walkInProgress: 'הטיול בעיצומו 🐾',
        readyToStart: 'בואו נתחיל 🙂',
        readySubtitle: 'הספק מוכן להתחיל את השירות.',
        startedSubtitle: 'השירות שלך התחיל.',
        arrivalConfirmationSubtitle: 'אשרו שהספק איתכם לפני תחילת השירות',
        headingToYou: '{{walkerName}} בדרך אליך',
        confirmArrival: 'אישור הגעה',
        confirmingArrival: 'מאשרים...',
        arrived: 'הגיע',
        here: 'כאן',
        live: 'חי',
        delayed: 'בעיכוב',
        offline: 'לא מקוון',
      },
      completion: {
        completed: 'הושלם',
        rateProvider: 'דרגו את {{name}}',
      },
      dogNameSheet: {
        title: 'שם הכלב/ה',
        subtitle: 'בחרו שם קודם או הקלידו שם חדש.',
        addNew: 'הוספת שם חדש',
        typePlaceholder: 'הקלידו שם לכלב/ה',
      },
      firstBooking: {
        checkingPaymentSetup: 'בודקים את הגדרת התשלום שלך',
        readyToBook: 'הכול מוכן להזמנה',
        almostReady: 'כמעט סיימנו',
        thisOnlyTakesMoment: 'זה ייקח רק רגע.',
        addServiceDetails: 'הוסיפו את פרטי השירות ונמצא ספק קרוב.',
        addPaymentBeforeFirstBooking: 'הוסיפו אמצעי תשלום לפני ההזמנה הראשונה.',
        chargeAfterCompleted: 'החיוב יתבצע רק אחרי שהשירות יושלם.',
        checking: 'בודקים...',
        startBooking: 'להתחיל להזמין',
        addPaymentMethod: 'הוספת אמצעי תשלום',
      },
      tip: {
        addTip: 'להוסיף טיפ ל־{{walkerName}}?',
        optionalSeparate: 'אופציונלי, בנפרד מתשלום הטיול.',
        customAmount: 'סכום אחר',
        customPlaceholder: 'סכום אחר',
        send: 'שליחה',
        noTip: 'בלי טיפ',
      },
    },
  },
} as const

const initialLanguage = getInitialLanguage()

void i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: initialLanguage,
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
  })

applyDocumentLanguage(initialLanguage)

i18n.on('languageChanged', (language) => {
  const normalized: SupportedLanguage = language === 'he' ? 'he' : 'en'
  applyDocumentLanguage(normalized)
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized)
  }
})

export default i18n
