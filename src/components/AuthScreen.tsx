import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { AppRole, ServiceAttributes } from '../hooks/useAuth'
import { reverseGeocodeAddress } from '../utils/reverseGeocode'
import {
  getProfileServiceOptions,
  type ProfileServiceType,
} from '../lib/profileServiceTypes'
import welcomeHeroImage from '../assets/onboarding/welcom-hero.jpg'
import providerCharacterImage from '../assets/onboarding/provider-character.jpg'
import customerCharacterImage from '../assets/onboarding/customer-character.jpg'
import mapPreviewImage from '../assets/onboarding/map-preview.jpg'

interface AuthScreenProps {
  onSignIn: (args: { email: string; password: string }) => Promise<{ ok: boolean }>
  onSignUp: (args: {
    email: string
    password: string
    fullName: string
    role: AppRole
    primaryService?: string
    locationAddress?: string
    shortBio?: string
    serviceTypes?: ProfileServiceType[]
    serviceAttributes?: ServiceAttributes | null
  }) => Promise<{ ok: boolean }>
  onGoogleSignIn: (args: {
    role: AppRole
    primaryService?: string
    locationAddress?: string
    shortBio?: string
    serviceTypes?: ProfileServiceType[]
    serviceAttributes?: ServiceAttributes | null
  }) => Promise<{ ok: boolean }>
  onAppleSignIn: (args: {
    role: AppRole
    primaryService?: string
    locationAddress?: string
    shortBio?: string
    serviceTypes?: ProfileServiceType[]
    serviceAttributes?: ServiceAttributes | null
  }) => Promise<{ ok: boolean }>
  onCompleteOnboarding?: (args: {
    role: AppRole
    primaryService?: string
    locationAddress?: string
    shortBio?: string
    serviceTypes?: ProfileServiceType[]
    serviceAttributes?: ServiceAttributes | null
  }) => Promise<{ ok: boolean }>
  appleSignInEnabled: boolean
  authenticatedOnboarding?: boolean
  initialRole?: AppRole
  initialLocationAddress?: string | null
  initialShortBio?: string | null
  initialServiceTypes?: ProfileServiceType[] | null
  initialServiceAttributes?: ServiceAttributes | null
  authError?: string | null
}

type OnboardingMode = 'welcome' | 'signin' | 'signup'
type SignupStep = 'welcome' | 'role' | 'service' | 'location' | 'details' | 'auth'
type ServiceOption = {
  id: ProfileServiceType
  icon: string
  label: string
  description: string
}

type DogSize = 'S' | 'M' | 'L' | 'XL'
type EnergyLevel = 'low' | 'medium' | 'high'
type AgeRange = '1-2' | '2-4' | '5-7' | '7+'
type ProviderExperienceRange = '0_1' | '1_3' | '3_5' | '5_10' | '10_plus'
type ProviderLanguage = 'hebrew' | 'english' | 'russian' | 'arabic' | 'french'

interface DogWalkerAttrs {
  petName: string
  dogSize: DogSize | ''
  energyLevel: EnergyLevel | ''
}

interface BabySitterAttrs {
  numberOfKids: number
  childrenAges: string[]
  specialNotes: string
}

interface ProviderDogWalkerAttrs {
  supportedDogSizes: DogSize[]
  supportedEnergyLevels: EnergyLevel[]
}

interface ProviderBabySitterAttrs {
  supportedAgeRanges: AgeRange[]
}

interface ProviderIdentityAttrs {
  experienceRange: ProviderExperienceRange | ''
  shortBio: string
  languages: ProviderLanguage[]
}

const DOG_SIZE_OPTIONS: { value: DogSize; label: string; desc: string }[] = [
  { value: 'S', label: 'S', desc: '<10kg' },
  { value: 'M', label: 'M', desc: '10–25kg' },
  { value: 'L', label: 'L', desc: '25–40kg' },
  { value: 'XL', label: 'XL', desc: '40kg+' },
]

const ENERGY_OPTIONS: { value: EnergyLevel; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

const AGE_RANGE_OPTIONS: { value: AgeRange; label: string }[] = [
  { value: '1-2', label: '1–2' },
  { value: '2-4', label: '2–4' },
  { value: '5-7', label: '5–7' },
  { value: '7+', label: '7+' },
]

const PROVIDER_EXPERIENCE_OPTIONS: {
  value: ProviderExperienceRange
  label: string
  normalizedYears: number
}[] = [
  { value: '0_1', label: '0–1 years', normalizedYears: 1 },
  { value: '1_3', label: '1–3 years', normalizedYears: 2 },
  { value: '3_5', label: '3–5 years', normalizedYears: 4 },
  { value: '5_10', label: '5–10 years', normalizedYears: 7 },
  { value: '10_plus', label: '10+ years', normalizedYears: 10 },
]

const PROVIDER_LANGUAGE_OPTIONS: {
  value: ProviderLanguage
  label: string
}[] = [
  { value: 'hebrew', label: 'Hebrew' },
  { value: 'english', label: 'English' },
  { value: 'russian', label: 'Russian' },
  { value: 'arabic', label: 'Arabic' },
  { value: 'french', label: 'French' },
]

const PROVIDER_SIGNUP_STEPS: SignupStep[] = ['welcome', 'role', 'service', 'location', 'details', 'auth']
const CLIENT_SIGNUP_STEPS: SignupStep[] = ['welcome', 'role', 'location', 'auth']
const SIGNUP_STEP_STORAGE_KEY = 'regli_signup_step'

function getSignupSteps(role: AppRole): SignupStep[] {
  return role === 'walker' ? PROVIDER_SIGNUP_STEPS : CLIENT_SIGNUP_STEPS
}

function normalizeSignupStepForRole(step: SignupStep, role: AppRole): SignupStep {
  const steps = getSignupSteps(role)
  if (steps.includes(step)) return step
  if (step === 'service') return 'location'
  if (step === 'details') return 'auth'
  return steps[0] ?? 'welcome'
}

function getStepIndex(mode: OnboardingMode, step: SignupStep, signupSteps: SignupStep[]) {
  if (mode === 'signin') return signupSteps.indexOf('auth')
  return signupSteps.indexOf(step)
}

function getStepTitle(mode: OnboardingMode, step: SignupStep, role: AppRole) {
  if (mode === 'signin') return 'Log in'
  if (step === 'role') return 'How will you use Regli?'
  if (step === 'service') {
    return role === 'walker' ? 'What service do you provide?' : 'What service are you looking for?'
  }
  if (step === 'location') return 'Where are you located?'
  if (step === 'details') return 'Tell us more'
  if (step === 'auth') return 'Create your account'
  return 'Welcome'
}

async function reverseGeocodeLocation(lat: number, lng: number): Promise<string> {
  return reverseGeocodeAddress(lat, lng, {
    language: 'en',
    fallbackLabel: 'Current location detected',
  })
}

function getNormalizedExperienceYears(range: ProviderExperienceRange | ''): number {
  return PROVIDER_EXPERIENCE_OPTIONS.find((option) => option.value === range)?.normalizedYears ?? 0
}

function readPersistedSignupStep(): SignupStep | null {
  if (typeof window === 'undefined') return null
  const raw = window.sessionStorage.getItem(SIGNUP_STEP_STORAGE_KEY)
  if (!raw) return null
  if (raw === 'welcome' || raw === 'role' || raw === 'service' || raw === 'location' || raw === 'details' || raw === 'auth') {
    return raw
  }
  return null
}

function writePersistedSignupStep(step: SignupStep) {
  if (typeof window === 'undefined') return
  window.sessionStorage.setItem(SIGNUP_STEP_STORAGE_KEY, step)
}

export default function AuthScreen({
  onSignIn,
  onSignUp,
  onGoogleSignIn,
  onAppleSignIn,
  onCompleteOnboarding,
  appleSignInEnabled,
  authenticatedOnboarding = false,
  initialRole = 'client',
  initialLocationAddress = null,
  initialShortBio = null,
  initialServiceTypes = null,
  initialServiceAttributes = null,
  authError,
}: AuthScreenProps) {
  const [mode, setMode] = useState<OnboardingMode>(() => (
    authenticatedOnboarding ? 'signup' : (readPersistedSignupStep() ? 'signup' : 'welcome')
  ))
  const [signupStep, setSignupStep] = useState<SignupStep>(() => (
    authenticatedOnboarding ? (readPersistedSignupStep() ?? 'role') : (readPersistedSignupStep() ?? 'welcome')
  ))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState<AppRole>(initialRole)
  const [selectedServices, setSelectedServices] = useState<ProfileServiceType[]>(
    () => initialRole === 'walker'
      ? (initialServiceTypes && initialServiceTypes.length > 0 ? initialServiceTypes : ['dog_walker'])
      : ['dog_walker'],
  )
  const [locationLabel, setLocationLabel] = useState(initialLocationAddress || 'Your area')
  const [locationStatus, setLocationStatus] = useState<'placeholder' | 'live' | 'denied' | 'loading'>(
    initialLocationAddress ? 'live' : 'placeholder',
  )
  const [showEmailAuth, setShowEmailAuth] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [googleSubmitting, setGoogleSubmitting] = useState(false)
  const [appleSubmitting, setAppleSubmitting] = useState(false)
  const locationAutoRequestedRef = useRef(false)

  const [dogAttrs, setDogAttrs] = useState<DogWalkerAttrs>({ petName: '', dogSize: '', energyLevel: '' })
  const [sitterAttrs, setSitterAttrs] = useState<BabySitterAttrs>({ numberOfKids: 0, childrenAges: [''], specialNotes: '' })
  const [provDogAttrs, setProvDogAttrs] = useState<ProviderDogWalkerAttrs>({ supportedDogSizes: [], supportedEnergyLevels: [] })
  const [provSitterAttrs, setProvSitterAttrs] = useState<ProviderBabySitterAttrs>({ supportedAgeRanges: [] })
  const [providerIdentity, setProviderIdentity] = useState<ProviderIdentityAttrs>({
    experienceRange:
      typeof initialServiceAttributes?.provider_profile === 'object' &&
      initialServiceAttributes.provider_profile &&
      'experienceRange' in initialServiceAttributes.provider_profile &&
      typeof initialServiceAttributes.provider_profile.experienceRange === 'string'
        ? initialServiceAttributes.provider_profile.experienceRange as ProviderExperienceRange
        : '',
    shortBio: initialShortBio ?? '',
    languages:
      typeof initialServiceAttributes?.provider_profile === 'object' &&
      initialServiceAttributes.provider_profile &&
      'languagesSpoken' in initialServiceAttributes.provider_profile &&
      Array.isArray(initialServiceAttributes.provider_profile.languagesSpoken)
        ? initialServiceAttributes.provider_profile.languagesSpoken.filter(
            (value): value is ProviderLanguage =>
              value === 'hebrew' || value === 'english' || value === 'russian' || value === 'arabic' || value === 'french',
          )
        : [],
  })
  const serviceOptions = useMemo<ServiceOption[]>(
    () => getProfileServiceOptions(false).map((option) => ({
      id: option.value,
      icon: option.icon,
      label: option.label,
      description: option.description,
    })),
    [],
  )
  const signupSteps = useMemo(() => getSignupSteps(role), [role])
  const safeSignupStep = signupStep ?? (mode === 'signup' ? 'role' : 'welcome')

  useEffect(() => {
    if (mode !== 'signup') return
    writePersistedSignupStep(safeSignupStep)
  }, [mode, safeSignupStep])

  useEffect(() => {
    if (mode !== 'signup') return
    const normalizedStep = normalizeSignupStepForRole(safeSignupStep, role)
    if (normalizedStep !== signupStep) {
      setSignupStep(normalizedStep)
    }
  }, [mode, role, safeSignupStep, signupStep])

  const currentStep: SignupStep = mode === 'signin'
    ? 'auth'
    : mode === 'signup'
      ? normalizeSignupStepForRole(safeSignupStep, role)
      : 'welcome'
  const hasNextSignupStep =
    mode === 'signup' && signupSteps.indexOf(currentStep) >= 0 && signupSteps.indexOf(currentStep) < signupSteps.length - 1
  const activeStepIndex = Math.max(0, getStepIndex(mode, currentStep, signupSteps))
  const signupStepNumber = Math.max(1, signupSteps.indexOf(currentStep) + 1)
  const isCreateAccountStep = (mode === 'signin' || mode === 'signup') && currentStep === 'auth'

  const selectedServiceMeta = useMemo(
    () => serviceOptions.find((service) => service.id === selectedServices[0]) ?? serviceOptions[0],
    [selectedServices, serviceOptions],
  )

  const hasDog = selectedServices.includes('dog_walker')
  const hasSitter = selectedServices.includes('baby_sitter')
  const isProvider = role === 'walker'
  const onboardingServiceTypes = isProvider ? selectedServices : []

  const dogValid = isProvider
    ? !hasDog || provDogAttrs.supportedDogSizes.length > 0
    : !hasDog || (dogAttrs.petName.trim().length > 0 && dogAttrs.dogSize !== '' && dogAttrs.energyLevel !== '')
  const sitterValid = isProvider
    ? !hasSitter || provSitterAttrs.supportedAgeRanges.length > 0
    : !hasSitter || (
        sitterAttrs.numberOfKids >= 1 &&
        sitterAttrs.childrenAges.length === sitterAttrs.numberOfKids &&
        sitterAttrs.childrenAges.every((a) => a.trim().length > 0)
      )

  const providerIdentityValid = !isProvider || providerIdentity.experienceRange !== ''

  const canContinue = useMemo(() => {
    if (authenticatedOnboarding && currentStep === 'auth') return true
    if (mode === 'signin') return !!email && !!password
    if (currentStep === 'role') return !!role
    if (currentStep === 'service') return selectedServices.length > 0
    if (currentStep === 'location') return true
    if (currentStep === 'details') return dogValid && sitterValid && providerIdentityValid
    if (currentStep === 'auth') return !!email && !!password && !!fullName.trim()
    return true
  }, [authenticatedOnboarding, currentStep, email, fullName, mode, password, role, selectedServices, dogValid, sitterValid, providerIdentityValid])

  const roleSummary = role === 'walker' ? 'Provider' : 'Customer'

  useEffect(() => {
    document.body.dataset.authOnboarding = 'true'
    const previousBodyOverflow = document.body.style.overflow
    const previousBodyHeight = document.body.style.height
    const previousHtmlOverflow = document.documentElement.style.overflow
    const previousHtmlHeight = document.documentElement.style.height
    document.body.style.overflow = 'hidden'
    document.body.style.height = '100dvh'
    document.documentElement.style.overflow = 'hidden'
    document.documentElement.style.height = '100dvh'
    return () => {
      delete document.body.dataset.authOnboarding
      document.body.style.overflow = previousBodyOverflow
      document.body.style.height = previousBodyHeight
      document.documentElement.style.overflow = previousHtmlOverflow
      document.documentElement.style.height = previousHtmlHeight
    }
  }, [])

  const requestCurrentLocation = () => {
    if (!navigator.geolocation) {
      setLocationStatus('denied')
      setLocationLabel('Your area')
      return
    }

    setLocationStatus('loading')
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords
        const nextLabel = await reverseGeocodeLocation(latitude, longitude)
        setLocationLabel(nextLabel)
        setLocationStatus('live')
      },
      () => {
        setLocationStatus('denied')
        setLocationLabel('Your area')
      },
      {
        enableHighAccuracy: true,
        maximumAge: 60000,
        timeout: 6000,
      },
    )
  }

  useEffect(() => {
    const isLocationStep = mode === 'signup' && currentStep === 'location'
    if (!isLocationStep) {
      locationAutoRequestedRef.current = false
      return
    }
    if (locationAutoRequestedRef.current) return
    locationAutoRequestedRef.current = true
    requestCurrentLocation()
  }, [currentStep, mode])

  const handleUseCurrentLocation = () => {
    requestCurrentLocation()
  }

  const goToSignIn = () => {
    if (authenticatedOnboarding) return
    setMode('signin')
    setSignupStep('auth')
    setShowEmailAuth(false)
  }

  const goToSignup = () => {
    if (authenticatedOnboarding) return
    setMode('signup')
    setSignupStep('role')
    writePersistedSignupStep('role')
    setShowEmailAuth(false)
  }

  const handleBack = () => {
    if (authenticatedOnboarding) {
      const currentIndex = signupSteps.indexOf(signupStep)
      if (currentIndex <= 0) return
      setSignupStep(signupSteps[currentIndex - 1])
      return
    }

    if (mode === 'signin') {
      setMode('welcome')
      return
    }

    const currentIndex = signupSteps.indexOf(signupStep)
    if (currentIndex <= 0) {
      setMode('welcome')
      setSignupStep('welcome')
      return
    }
    setSignupStep(signupSteps[currentIndex - 1])
  }

  const handleContinue = async () => {
    if (!canContinue || submitting) return

    if (mode === 'welcome') {
      goToSignup()
      return
    }

    if (mode === 'signin') {
      setSubmitting(true)
      await onSignIn({ email, password })
      setSubmitting(false)
      return
    }

    if (mode === 'signup') {
      const currentIndex = signupSteps.indexOf(signupStep)
      const nextStep = currentIndex >= 0 ? signupSteps[currentIndex + 1] : null
      if (nextStep) {
        setSignupStep(nextStep)
        return
      }
    }

    if (signupStep === 'details') {
      return
    }

    if (signupStep === 'auth') {
      if (authenticatedOnboarding) {
        setSubmitting(true)
        const result = await onCompleteOnboarding?.({
          role,
          primaryService: isProvider ? selectedServiceMeta.label : undefined,
          locationAddress: locationLabel,
          shortBio: isProvider ? providerIdentity.shortBio.trim() : undefined,
          serviceTypes: onboardingServiceTypes,
          serviceAttributes: buildServiceAttributes(),
        })
        if (result?.ok && typeof window !== 'undefined') {
          window.sessionStorage.setItem(
            'regli:onboarding-wow',
            role === 'walker' ? 'provider' : 'customer',
          )
        }
        setSubmitting(false)
        return
      }

      setSubmitting(true)
      const attrs: ServiceAttributes = {}
      if (isProvider) {
        attrs.provider_profile = {
          experienceRange: providerIdentity.experienceRange,
          experienceYears: getNormalizedExperienceYears(providerIdentity.experienceRange),
          languagesSpoken: providerIdentity.languages,
        }
        if (hasDog && provDogAttrs.supportedDogSizes.length > 0) {
          attrs.dog_walker = {
            supportedDogSizes: provDogAttrs.supportedDogSizes,
            supportedEnergyLevels: provDogAttrs.supportedEnergyLevels,
            experienceYears: getNormalizedExperienceYears(providerIdentity.experienceRange),
          }
        }
        if (hasSitter && provSitterAttrs.supportedAgeRanges.length > 0) {
          attrs.baby_sitter = {
            supportedAgeRanges: provSitterAttrs.supportedAgeRanges,
            experienceYears: getNormalizedExperienceYears(providerIdentity.experienceRange),
          }
        }
      }
      const result = await onSignUp({
        email,
        password,
        fullName: fullName.trim(),
        role,
        primaryService: isProvider ? selectedServiceMeta.label : undefined,
        locationAddress: locationLabel,
        shortBio: isProvider ? providerIdentity.shortBio.trim() : undefined,
        serviceTypes: onboardingServiceTypes,
        serviceAttributes: isProvider && Object.keys(attrs).length > 0 ? attrs : null,
      })
      if (result.ok && typeof window !== 'undefined') {
        window.sessionStorage.setItem(
          'regli:onboarding-wow',
          role === 'walker' ? 'provider' : 'customer',
        )
      }
      setSubmitting(false)
    }
  }

  const buildServiceAttributes = (): ServiceAttributes | null => {
    const attrs: ServiceAttributes = {}
    if (isProvider) {
      attrs.provider_profile = {
        experienceRange: providerIdentity.experienceRange,
        experienceYears: getNormalizedExperienceYears(providerIdentity.experienceRange),
        languagesSpoken: providerIdentity.languages,
      }
      if (hasDog && provDogAttrs.supportedDogSizes.length > 0) {
        attrs.dog_walker = {
          supportedDogSizes: provDogAttrs.supportedDogSizes,
          supportedEnergyLevels: provDogAttrs.supportedEnergyLevels,
          experienceYears: getNormalizedExperienceYears(providerIdentity.experienceRange),
        }
      }
      if (hasSitter && provSitterAttrs.supportedAgeRanges.length > 0) {
        attrs.baby_sitter = {
          supportedAgeRanges: provSitterAttrs.supportedAgeRanges,
          experienceYears: getNormalizedExperienceYears(providerIdentity.experienceRange),
        }
      }
    } else {
      if (hasDog) {
        attrs.dog_walker = {
          dog_name: dogAttrs.petName.trim(),
          dog_size: dogAttrs.dogSize,
          dog_energy: dogAttrs.energyLevel,
        }
      }
      if (hasSitter) {
        attrs.baby_sitter = {
          number_of_kids: sitterAttrs.numberOfKids,
          children_ages: sitterAttrs.childrenAges.map((value) => value.trim()).filter(Boolean),
          notes: sitterAttrs.specialNotes.trim() || null,
        }
      }
    }
    return Object.keys(attrs).length > 0 ? attrs : null
  }

  const handleGoogleContinue = async () => {
    if (googleSubmitting || submitting) return
    setGoogleSubmitting(true)
    if (mode === 'signup' && typeof window !== 'undefined') {
      writePersistedSignupStep(currentStep)
      window.sessionStorage.setItem(
        'regli:onboarding-wow',
        role === 'walker' ? 'provider' : 'customer',
      )
    }

    const result = await onGoogleSignIn({
      role,
      primaryService: isProvider ? selectedServiceMeta.label : undefined,
      locationAddress: mode === 'signup' ? locationLabel : undefined,
      shortBio: isProvider ? providerIdentity.shortBio.trim() : undefined,
      serviceTypes: onboardingServiceTypes,
      serviceAttributes: mode === 'signup' ? buildServiceAttributes() : null,
    })

    if (!result.ok && typeof window !== 'undefined' && mode === 'signup') {
      window.sessionStorage.removeItem('regli:onboarding-wow')
    }
    if (!result.ok) {
      setGoogleSubmitting(false)
    }
  }

  const handleAppleContinue = async () => {
    if (!appleSignInEnabled || appleSubmitting || submitting) return
    setAppleSubmitting(true)
    if (mode === 'signup' && typeof window !== 'undefined') {
      writePersistedSignupStep(currentStep)
      window.sessionStorage.setItem(
        'regli:onboarding-wow',
        role === 'walker' ? 'provider' : 'customer',
      )
    }

    const result = await onAppleSignIn({
      role,
      primaryService: isProvider ? selectedServiceMeta.label : undefined,
      locationAddress: mode === 'signup' ? locationLabel : undefined,
      shortBio: isProvider ? providerIdentity.shortBio.trim() : undefined,
      serviceTypes: onboardingServiceTypes,
      serviceAttributes: mode === 'signup' ? buildServiceAttributes() : null,
    })

    if (!result.ok && typeof window !== 'undefined' && mode === 'signup') {
      window.sessionStorage.removeItem('regli:onboarding-wow')
    }
    if (!result.ok) {
      setAppleSubmitting(false)
    }
  }

  const renderSocialAuthButtons = () => (
    <div style={socialStackStyle}>
      <button
        type="button"
        onClick={() => {
          if (googleSubmitting || submitting) return
          void handleGoogleContinue()
        }}
        aria-busy={googleSubmitting}
        style={{
          ...socialButtonStyle,
          ...googleSocialButtonStyle,
          ...(googleSubmitting ? socialButtonLoadingStyle : null),
        }}
      >
        <span style={socialIconStyle}>G</span>
        <span style={socialLabelStyle}>
          {googleSubmitting ? 'Connecting to Google...' : 'Continue with Google'}
        </span>
      </button>

      <button
        type="button"
        onClick={() => {
          if (!appleSignInEnabled || appleSubmitting || googleSubmitting || submitting) return
          void handleAppleContinue()
        }}
        disabled={!appleSignInEnabled || appleSubmitting}
        aria-busy={appleSubmitting}
        style={{
          ...socialButtonStyle,
          ...(!appleSignInEnabled ? socialButtonDisabledStyle : null),
          ...(appleSubmitting ? socialButtonLoadingStyle : null),
        }}
      >
        <span style={{ ...socialIconStyle, ...appleIconStyle }}></span>
        <span style={socialLabelStyle}>
          {appleSubmitting ? 'Connecting to Apple...' : 'Continue with Apple'}
        </span>
        {!appleSignInEnabled && <span style={comingSoonPillStyle}>Coming soon</span>}
      </button>
    </div>
  )

  const stepTitle = getStepTitle(mode, currentStep, role)
  const shouldShowEmailFields = !authenticatedOnboarding && currentStep === 'auth' && (mode === 'signin' ? showEmailAuth : showEmailAuth)
  const cardIsScrollable = (currentStep === 'auth' && shouldShowEmailFields) || currentStep === 'details'

  return (
    <div style={screenStyle}>
      <style>{`
        @keyframes authStepEnter {
          0% { opacity: 0; transform: translateY(18px); }
          100% { opacity: 1; transform: translateY(0); }
        }

        .auth-step-enter {
          animation: authStepEnter 320ms cubic-bezier(0.22, 1, 0.36, 1);
        }

        body[data-auth-onboarding='true'] iframe[src*="stripe"],
        body[data-auth-onboarding='true'] iframe[name*="__privateStripeFrame"],
        body[data-auth-onboarding='true'] [data-stripe-elements-root],
        body[data-auth-onboarding='true'] [class*="Stripe"],
        body[data-auth-onboarding='true'] [class*="stripe"],
        body[data-auth-onboarding='true'] [id*="Stripe"],
        body[data-auth-onboarding='true'] [id*="stripe"],
        body[data-auth-onboarding='true'] a[href*="stripe.com"] {
          display: none !important;
          visibility: hidden !important;
          pointer-events: none !important;
        }
      `}</style>

      <div style={backgroundStyle}>
        <div style={mapGlowTopStyle} />
        <div style={mapGlowBottomStyle} />
        <div style={mapRoadPrimaryStyle} />
        <div style={mapRoadSecondaryStyle} />
        <div style={mapRoadTertiaryStyle} />
        <div style={routeDotsStyle} />
        <div style={routeMarkerStartStyle}>•</div>
        <div style={routeMarkerEndStyle}>⌂</div>
      </div>

      <div style={shellStyle}>
        <div style={heroStyle}>
          <div style={brandRowStyle}>
            <div style={brandBadgeStyle}>R</div>
            <div>
              <div style={brandNameStyle}>Regli</div>
              <div style={brandSubtitleStyle}>Trusted services, beautifully coordinated.</div>
            </div>
          </div>

          <div style={stepsRowStyle}>
            {signupSteps.map((step, index) => (
              <span
                key={step}
                style={{
                  ...stepDotStyle,
                  ...(index === activeStepIndex ? stepDotActiveStyle : null),
                }}
              />
            ))}
          </div>
        </div>

        <div key={`${mode}-${currentStep}`} className="auth-step-enter" style={cardStyle}>
          <div
            style={{
              ...cardContentStyle,
              ...(cardIsScrollable ? cardContentScrollableStyle : null),
            }}
          >
          {!authenticatedOnboarding && mode === 'welcome' && (
            <>
              <div style={welcomeHeroWrapStyle}>
                <img
                  src={welcomeHeroImage}
                  alt="Premium onboarding welcome illustration"
                  style={welcomeHeroImageStyle}
                  decoding="async"
                  fetchPriority="high"
                />
              </div>
              <div style={eyebrowStyle}>Welcome</div>
              <h1 style={titleStyle}>Book trusted services in minutes</h1>
              <p style={subtitleStyle}>
                Choose a service, confirm your details, and we’ll find a trusted provider nearby.
              </p>

              <div style={featureRowStyle}>
                <div style={featurePillStyle}>📍 Live location ready</div>
                <div style={featurePillStyle}>⚡ Fast booking</div>
                <div style={featurePillStyle}>🤝 Trusted providers</div>
              </div>
            </>
          )}

          {mode === 'signup' && currentStep === 'role' && (
            <>
              <div style={eyebrowStyle}>Step {signupStepNumber}</div>
              <h1 style={titleStyle}>{stepTitle}</h1>
              <div style={optionStackStyle}>
                <RoleCard
                  title="Provider"
                  description="Offer services, get booked, and earn on your time."
                  selected={role === 'walker'}
                  icon="🧑‍💼"
                  imageSrc={providerCharacterImage}
                  imageAlt="Provider onboarding character"
                  onClick={() => {
                    setRole('walker')
                    setSelectedServices((current) => current.length > 0 ? current : ['dog_walker'])
                  }}
                />
                <RoleCard
                  title="Customer"
                  description="Find trusted providers and book services with ease."
                  selected={role === 'client'}
                  icon="✨"
                  imageSrc={customerCharacterImage}
                  imageAlt="Customer onboarding character"
                  onClick={() => {
                    setRole('client')
                    setSelectedServices([])
                  }}
                />
              </div>
            </>
          )}

          {mode === 'signup' && currentStep === 'service' && (
            <>
              <div style={eyebrowStyle}>Step {signupStepNumber}</div>
              <h1 style={titleStyle}>{stepTitle}</h1>
              <p style={subtitleStyle}>
                Pick one primary service for now. You can expand this later in settings.
              </p>
              <div style={serviceGridStyle}>
                {serviceOptions.map((service) => {
                  const selected = selectedServices[0] === service.id
                  return (
                    <button
                      key={service.id}
                      type="button"
                      onClick={() => {
                        setSelectedServices([service.id])
                      }}
                      style={{
                        ...serviceCardStyle,
                        ...(selected ? serviceCardSelectedStyle : null),
                      }}
                    >
                      <span style={serviceEmojiStyle}>{service.icon}</span>
                      <span style={serviceLabelStyle}>{service.label}</span>
                      <span style={serviceDescriptionStyle}>{service.description}</span>
                      {selected ? <span style={checkBadgeStyle}>✓</span> : null}
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {mode === 'signup' && currentStep === 'location' && (
            <>
              <div style={eyebrowStyle}>Step {signupStepNumber}</div>
              <h1 style={titleStyle}>{stepTitle}</h1>
              <p style={subtitleStyle}>
                We’ll use this to tailor nearby availability and a smoother first experience.
              </p>

              <div style={locationCardStyle}>
                <div style={locationMapStyle}>
                  <img
                    src={mapPreviewImage}
                    alt="Map preview"
                    loading="lazy"
                    decoding="async"
                    style={locationPreviewImageStyle}
                  />
                  <div style={locationMapImageOverlayStyle} />
                  <div style={locationMapGridStyle} />
                  <div style={locationMapRouteStyle} />
                  <div style={locationMapPinStyle}>📍</div>
                </div>
                <div style={locationMetaStyle}>
                  <div style={locationLabelTitleStyle}>
                    {locationStatus === 'live'
                      ? 'Current location'
                      : locationStatus === 'loading'
                        ? 'Checking location'
                        : locationStatus === 'denied'
                          ? 'Location unavailable'
                          : 'Location preview'}
                  </div>
                  <div style={locationLabelValueStyle}>{locationLabel}</div>
                  <div style={locationHintStyle}>
                    {locationStatus === 'live'
                      ? 'Using your current location.'
                      : locationStatus === 'loading'
                        ? 'Detecting your location…'
                        : locationStatus === 'denied'
                          ? 'Current location unavailable right now.'
                          : 'A soft map preview helps personalize nearby results.'}
                  </div>
                </div>
              </div>

              <button type="button" onClick={handleUseCurrentLocation} style={secondaryInlineButtonStyle}>
                {locationStatus === 'loading' ? 'Refreshing location...' : 'Use current location'}
              </button>
            </>
          )}

          {mode === 'signup' && currentStep === 'details' && (
            <>
              <div style={eyebrowStyle}>Step {signupStepNumber}</div>
              <h1 style={titleStyle}>{stepTitle}</h1>
              <p style={subtitleStyle}>
                {isProvider
                  ? 'Define your capabilities so we can match you with the right clients.'
                  : 'Help us personalize your experience by sharing a few details.'}
              </p>

              <div style={detailsSectionsStyle}>
                {isProvider ? (
                  <>
                    <div style={providerIdentityCardStyle}>
                      <div style={providerIdentityHeaderStyle}>
                        <div style={providerIdentityTitleStyle}>Build trust quickly</div>
                        <div style={providerIdentitySubtitleStyle}>
                          A few profile basics help clients understand who you are before they book.
                        </div>
                      </div>

                      <div style={detailsFieldBlockStyle}>
                        <label style={labelStyle}>Years of experience</label>
                        <div style={chipRowStyle}>
                          {PROVIDER_EXPERIENCE_OPTIONS.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => setProviderIdentity((prev) => ({ ...prev, experienceRange: option.value }))}
                              style={{
                                ...chipStyle,
                                ...compactChipStyle,
                                ...(providerIdentity.experienceRange === option.value ? chipSelectedStyle : null),
                              }}
                            >
                              <span style={compactChipLabelStyle}>{option.label}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      <div style={detailsFieldBlockStyle}>
                        <label style={labelStyle}>Short bio</label>
                        <textarea
                          value={providerIdentity.shortBio}
                          onChange={(e) => setProviderIdentity((prev) => ({ ...prev, shortBio: e.target.value }))}
                          placeholder="Reliable electrician specializing in residential repairs."
                          rows={2}
                          style={compactTextareaStyle}
                        />
                      </div>

                      <div style={detailsFieldBlockStyle}>
                        <label style={labelStyle}>Languages spoken</label>
                        <div style={chipRowStyle}>
                          {PROVIDER_LANGUAGE_OPTIONS.map((option) => {
                            const selected = providerIdentity.languages.includes(option.value)
                            return (
                              <button
                                key={option.value}
                                type="button"
                                onClick={() => setProviderIdentity((prev) => ({
                                  ...prev,
                                  languages: selected
                                    ? prev.languages.filter((value) => value !== option.value)
                                    : [...prev.languages, option.value],
                                }))}
                                style={{
                                  ...chipStyle,
                                  ...compactChipStyle,
                                  ...(selected ? chipSelectedStyle : null),
                                }}
                              >
                                <span style={compactChipLabelStyle}>{option.label}</span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    </div>

                    {hasDog && (
                      <div style={detailsSectionStyle}>
                        {hasSitter && <div style={detailsSectionLabelStyle}>Dog walking</div>}
                        <div style={detailsFieldBlockStyle}>
                          <label style={labelStyle}>Dog sizes you handle</label>
                          <div style={chipRowStyle}>
                            {DOG_SIZE_OPTIONS.map((opt) => {
                              const selected = provDogAttrs.supportedDogSizes.includes(opt.value)
                              return (
                                <button
                                  key={opt.value}
                                  type="button"
                                  onClick={() => setProvDogAttrs((prev) => ({
                                    ...prev,
                                    supportedDogSizes: selected
                                      ? prev.supportedDogSizes.filter((s) => s !== opt.value)
                                      : [...prev.supportedDogSizes, opt.value],
                                  }))}
                                  style={{
                                    ...chipStyle,
                                    ...(selected ? chipSelectedStyle : null),
                                  }}
                                >
                                  <span style={chipLabelStyle}>{opt.label}</span>
                                  <span style={chipDescStyle}>{opt.desc}</span>
                                </button>
                              )
                            })}
                          </div>
                        </div>

                        <div style={detailsFieldBlockStyle}>
                          <label style={labelStyle}>Energy levels you manage</label>
                          <div style={chipRowStyle}>
                            {ENERGY_OPTIONS.map((opt) => {
                              const selected = provDogAttrs.supportedEnergyLevels.includes(opt.value)
                              return (
                                <button
                                  key={opt.value}
                                  type="button"
                                  onClick={() => setProvDogAttrs((prev) => ({
                                    ...prev,
                                    supportedEnergyLevels: selected
                                      ? prev.supportedEnergyLevels.filter((s) => s !== opt.value)
                                      : [...prev.supportedEnergyLevels, opt.value],
                                  }))}
                                  style={{
                                    ...chipStyle,
                                    ...(selected ? chipSelectedStyle : null),
                                  }}
                                >
                                  <span style={chipLabelStyle}>{opt.label}</span>
                                </button>
                              )
                            })}
                          </div>
                        </div>

                      </div>
                    )}

                    {hasSitter && (
                      <div style={detailsSectionStyle}>
                        {hasDog && <div style={detailsSectionLabelStyle}>Baby sitting</div>}
                        <div style={detailsFieldBlockStyle}>
                          <label style={labelStyle}>Age ranges you cover</label>
                          <div style={chipRowStyle}>
                            {AGE_RANGE_OPTIONS.map((opt) => {
                              const selected = provSitterAttrs.supportedAgeRanges.includes(opt.value)
                              return (
                                <button
                                  key={opt.value}
                                  type="button"
                                  onClick={() => setProvSitterAttrs((prev) => ({
                                    ...prev,
                                    supportedAgeRanges: selected
                                      ? prev.supportedAgeRanges.filter((s) => s !== opt.value)
                                      : [...prev.supportedAgeRanges, opt.value],
                                  }))}
                                  style={{
                                    ...chipStyle,
                                    ...(selected ? chipSelectedStyle : null),
                                  }}
                                >
                                  <span style={chipLabelStyle}>{opt.label}</span>
                                </button>
                              )
                            })}
                          </div>
                        </div>

                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {hasDog && (
                      <div style={detailsSectionStyle}>
                        {hasSitter && <div style={detailsSectionLabelStyle}>Dog walking</div>}
                        <div style={detailsFieldBlockStyle}>
                          <label style={labelStyle}>Pet name</label>
                          <input
                            value={dogAttrs.petName}
                            onChange={(e) => setDogAttrs((prev) => ({ ...prev, petName: e.target.value }))}
                            placeholder="e.g. Boki"
                            style={inputStyle}
                          />
                        </div>

                        <div style={detailsFieldBlockStyle}>
                          <label style={labelStyle}>Dog size</label>
                          <div style={chipRowStyle}>
                            {DOG_SIZE_OPTIONS.map((opt) => (
                              <button
                                key={opt.value}
                                type="button"
                                onClick={() => setDogAttrs((prev) => ({ ...prev, dogSize: opt.value }))}
                                style={{
                                  ...chipStyle,
                                  ...(dogAttrs.dogSize === opt.value ? chipSelectedStyle : null),
                                }}
                              >
                                <span style={chipLabelStyle}>{opt.label}</span>
                                <span style={chipDescStyle}>{opt.desc}</span>
                              </button>
                            ))}
                          </div>
                        </div>

                        <div style={detailsFieldBlockStyle}>
                          <label style={labelStyle}>Energy level</label>
                          <div style={chipRowStyle}>
                            {ENERGY_OPTIONS.map((opt) => (
                              <button
                                key={opt.value}
                                type="button"
                                onClick={() => setDogAttrs((prev) => ({ ...prev, energyLevel: opt.value }))}
                                style={{
                                  ...chipStyle,
                                  ...(dogAttrs.energyLevel === opt.value ? chipSelectedStyle : null),
                                }}
                              >
                                <span style={chipLabelStyle}>{opt.label}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    {hasSitter && (
                      <div style={detailsSectionStyle}>
                        {hasDog && <div style={detailsSectionLabelStyle}>Baby sitting</div>}
                        <div style={detailsFieldBlockStyle}>
                          <label style={labelStyle}>How many children need babysitting?</label>
                          <div style={chipRowStyle}>
                            {[1, 2, 3, 4].map((n) => (
                              <button
                                key={n}
                                type="button"
                                onClick={() => {
                                  setSitterAttrs((prev) => {
                                    const ages = [...prev.childrenAges]
                                    while (ages.length < n) ages.push('')
                                    while (ages.length > n) ages.pop()
                                    return { ...prev, numberOfKids: n, childrenAges: ages }
                                  })
                                }}
                                style={{
                                  ...chipStyle,
                                  ...(sitterAttrs.numberOfKids === n ? chipSelectedStyle : null),
                                }}
                              >
                                <span style={chipLabelStyle}>{n}</span>
                              </button>
                            ))}
                          </div>
                        </div>

                        {sitterAttrs.numberOfKids >= 1 &&
                          sitterAttrs.childrenAges.map((age, i) => (
                            <div key={i} style={detailsFieldBlockStyle}>
                              <label style={labelStyle}>Child {i + 1} age</label>
                              <input
                                value={age}
                                onChange={(e) => {
                                  const val = e.target.value.replace(/[^0-9.]/g, '')
                                  setSitterAttrs((prev) => {
                                    const next = [...prev.childrenAges]
                                    next[i] = val
                                    return { ...prev, childrenAges: next }
                                  })
                                }}
                                placeholder="Age in years"
                                inputMode="numeric"
                                style={inputStyle}
                              />
                            </div>
                          ))
                        }

                        <div style={detailsFieldBlockStyle}>
                          <label style={labelStyle}>Special notes / allergies</label>
                          <textarea
                            value={sitterAttrs.specialNotes}
                            onChange={(e) => setSitterAttrs((prev) => ({ ...prev, specialNotes: e.target.value }))}
                            placeholder="Anything we should know (optional)"
                            rows={3}
                            style={textareaStyle}
                          />
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          {isCreateAccountStep && (
            <>
              <div style={eyebrowStyle}>
                {authenticatedOnboarding ? `Step ${signupStepNumber}` : mode === 'signin' ? 'Welcome back' : `Step ${signupStepNumber}`}
              </div>
              <h1 style={titleStyle}>{stepTitle}</h1>
              <p style={subtitleStyle}>
                {authenticatedOnboarding
                  ? 'Finish your Regli setup to continue.'
                  : mode === 'signin'
                  ? 'Log in to continue where you left off.'
                  : 'Finish setting up your account to start with Regli.'}
              </p>

              {mode === 'signup' && (
                <div style={summaryCardStyle}>
                  <div style={summaryRowStyle}>
                    <span>{roleSummary}</span>
                    <span>
                      {isProvider
                        ? selectedServices.map((value) => serviceOptions.find((service) => service.id === value)?.label).filter(Boolean).join(', ')
                        : 'Ready to book'}
                    </span>
                  </div>
                  <div style={summaryLocationStyle}>{locationLabel}</div>
                </div>
              )}

              {!authenticatedOnboarding && renderSocialAuthButtons()}

              {!authenticatedOnboarding && !shouldShowEmailFields ? (
                <button
                  type="button"
                  onClick={() => setShowEmailAuth(true)}
                  style={secondaryInlineButtonStyle}
                >
                  Use email instead
                </button>
              ) : !authenticatedOnboarding ? (
                <>
                  {mode === 'signup' && (
                    <div style={fieldBlockStyle}>
                      <label style={labelStyle}>Full name</label>
                      <input
                        value={fullName}
                        onChange={(event) => setFullName(event.target.value)}
                        placeholder="Your full name"
                        style={inputStyle}
                      />
                    </div>
                  )}

                  <div style={fieldBlockStyle}>
                    <label style={labelStyle}>Email</label>
                    <input
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="name@example.com"
                      type="email"
                      autoComplete="email"
                      style={inputStyle}
                    />
                  </div>

                  <div style={fieldBlockStyle}>
                    <label style={labelStyle}>Password</label>
                    <input
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="Password"
                      type="password"
                      autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                      style={inputStyle}
                    />
                  </div>
                </>
              ) : null}

              {authError && <div style={authErrorStyle}>{authError}</div>}
            </>
          )}
          </div>
        </div>

        <div style={footerStyle}>
          <div style={buttonRowStyle}>
            {(mode !== 'welcome' || authenticatedOnboarding) && (
              <button type="button" onClick={handleBack} style={secondaryButtonStyle}>
                Back
              </button>
            )}

            {!authenticatedOnboarding && mode === 'welcome' ? (
              <>
                <button type="button" onClick={goToSignIn} style={secondaryButtonStyle}>
                  Log in
                </button>
                <button type="button" onClick={goToSignup} style={primaryButtonStyle}>
                  Get started
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleContinue}
                disabled={currentStep === 'auth'
                  ? (authenticatedOnboarding ? (!canContinue || submitting) : (!showEmailAuth || !canContinue || submitting))
                  : (!canContinue || submitting)}
                style={{
                  ...primaryButtonStyle,
                  ...((currentStep === 'auth'
                    ? (authenticatedOnboarding ? (!canContinue || submitting) : (!showEmailAuth || !canContinue || submitting))
                    : (!canContinue || submitting))
                    ? primaryButtonDisabledStyle
                    : null),
                }}
              >
                {submitting
                  ? 'Please wait...'
                  : authenticatedOnboarding
                    ? (hasNextSignupStep ? 'Next' : 'Finish Setup')
                  : mode === 'signin'
                    ? 'Log in'
                    : currentStep === 'auth'
                      ? 'Create account'
                      : currentStep === 'location'
                        ? 'Continue'
                        : currentStep === 'details'
                          ? 'Continue to account'
                          : 'Continue'}
              </button>
            )}
          </div>

          <div style={bottomHintStyle}>
            {authenticatedOnboarding ? (
              'Complete your profile to unlock the Regli app.'
            ) : mode === 'signin' ? (
              <>
                New to Regli?{' '}
                <button type="button" onClick={goToSignup} style={textLinkStyle}>
                  Get started
                </button>
              </>
            ) : mode === 'signup' && currentStep === 'auth' ? (
              <>
                Already have an account?{' '}
                <button type="button" onClick={goToSignIn} style={textLinkStyle}>
                  Log in
                </button>
              </>
            ) : (
              'Designed for mobile-first booking and provider onboarding.'
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function RoleCard({
  title,
  description,
  selected,
  icon,
  imageSrc,
  imageAlt,
  onClick,
}: {
  title: string
  description: string
  selected: boolean
  icon: string
  imageSrc: string
  imageAlt: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...roleCardStyle,
        ...(selected ? roleCardSelectedStyle : null),
      }}
    >
      <div style={roleCardImageWrapStyle}>
        <img
          src={imageSrc}
          alt={imageAlt}
          loading="lazy"
          decoding="async"
          style={roleCardImageStyle}
        />
      </div>
      <div style={roleCardBodyStyle}>
        <div style={roleCardTopStyle}>
          <div style={roleCardTitleRowStyle}>
            <div style={roleIconStyle}>{icon}</div>
            <div style={roleTitleStyle}>{title}</div>
          </div>
          {selected ? <span style={checkBadgeStyle}>✓</span> : null}
        </div>
        <div style={roleDescriptionStyle}>{description}</div>
      </div>
    </button>
  )
}

const screenStyle: CSSProperties = {
  height: '100dvh',
  maxHeight: '100dvh',
  background: 'linear-gradient(180deg, #EEF4FF 0%, #F7FAFF 28%, #FCFDFF 100%)',
  position: 'relative',
  overflow: 'hidden',
}

const backgroundStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
  pointerEvents: 'none',
}

const mapGlowTopStyle: CSSProperties = {
  position: 'absolute',
  top: -120,
  right: -80,
  width: 280,
  height: 280,
  borderRadius: '50%',
  background: 'radial-gradient(circle, rgba(91,124,250,0.24) 0%, rgba(91,124,250,0.08) 45%, rgba(91,124,250,0) 72%)',
}

const mapGlowBottomStyle: CSSProperties = {
  position: 'absolute',
  left: -120,
  bottom: -100,
  width: 300,
  height: 300,
  borderRadius: '50%',
  background: 'radial-gradient(circle, rgba(255,209,102,0.18) 0%, rgba(255,209,102,0.06) 42%, rgba(255,209,102,0) 74%)',
}

const mapRoadPrimaryStyle: CSSProperties = {
  position: 'absolute',
  top: '16%',
  left: '-8%',
  width: '120%',
  height: 2,
  background: 'rgba(118, 148, 184, 0.20)',
  transform: 'rotate(11deg)',
}

const mapRoadSecondaryStyle: CSSProperties = {
  position: 'absolute',
  top: '36%',
  right: '-10%',
  width: '120%',
  height: 2,
  background: 'rgba(118, 148, 184, 0.14)',
  transform: 'rotate(-14deg)',
}

const mapRoadTertiaryStyle: CSSProperties = {
  position: 'absolute',
  top: '58%',
  left: '-6%',
  width: '112%',
  height: 1,
  background: 'rgba(118, 148, 184, 0.16)',
  transform: 'rotate(8deg)',
}

const routeDotsStyle: CSSProperties = {
  position: 'absolute',
  top: '15%',
  left: '54%',
  width: 132,
  height: 220,
  borderLeft: '3px dotted rgba(91, 124, 250, 0.42)',
  transform: 'rotate(20deg)',
}

const routeMarkerStartStyle: CSSProperties = {
  position: 'absolute',
  top: '19%',
  left: '50%',
  width: 28,
  height: 28,
  borderRadius: '50%',
  background: '#FFFFFF',
  color: '#5B7CFA',
  display: 'grid',
  placeItems: 'center',
  boxShadow: '0 14px 34px rgba(64, 94, 191, 0.16)',
  fontSize: 18,
  fontWeight: 900,
}

const routeMarkerEndStyle: CSSProperties = {
  position: 'absolute',
  top: '41%',
  left: '70%',
  width: 32,
  height: 32,
  borderRadius: '50%',
  background: '#0F172A',
  color: '#FFFFFF',
  display: 'grid',
  placeItems: 'center',
  boxShadow: '0 16px 34px rgba(15, 23, 42, 0.18)',
  fontSize: 15,
}

const shellStyle: CSSProperties = {
  position: 'relative',
  zIndex: 1,
  height: '100dvh',
  maxHeight: '100dvh',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  padding: 'calc(env(safe-area-inset-top, 0px) + 14px) 16px calc(env(safe-area-inset-bottom, 0px) + 14px)',
  gap: 10,
  maxWidth: 460,
  margin: '0 auto',
  boxSizing: 'border-box',
  overflow: 'hidden',
}

const heroStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
}

const brandRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
}

const brandBadgeStyle: CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: 16,
  background: 'linear-gradient(180deg, #0F172A 0%, #243B74 100%)',
  color: '#FFFFFF',
  display: 'grid',
  placeItems: 'center',
  fontSize: 24,
  fontWeight: 900,
  boxShadow: '0 18px 36px rgba(15, 23, 42, 0.18)',
}

const brandNameStyle: CSSProperties = {
  fontSize: 30,
  lineHeight: 1,
  fontWeight: 900,
  color: '#0F172A',
}

const brandSubtitleStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 13,
  lineHeight: 1.45,
  color: '#5B6882',
}

const stepsRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
}

const stepDotStyle: CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 999,
  background: 'rgba(91, 124, 250, 0.16)',
  transition: 'all 180ms ease',
}

const stepDotActiveStyle: CSSProperties = {
  width: 24,
  background: '#5B7CFA',
}

const cardStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  borderRadius: 26,
  background: 'rgba(255,255,255,0.86)',
  backdropFilter: 'blur(16px)',
  border: '1px solid rgba(255,255,255,0.70)',
  boxShadow: '0 24px 60px rgba(45, 68, 126, 0.14)',
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

const cardContentStyle: CSSProperties = {
  display: 'grid',
  gap: 10,
  alignContent: 'start',
  minHeight: 0,
}

const cardContentScrollableStyle: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  paddingRight: 2,
}

const eyebrowStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: '#5B7CFA',
  textTransform: 'uppercase',
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 28,
  lineHeight: 1.04,
  fontWeight: 900,
  color: '#0F172A',
}

const subtitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.45,
  color: '#5E6B83',
}

const welcomeHeroWrapStyle: CSSProperties = {
  width: '100%',
  maxHeight: 156,
  minHeight: 132,
  display: 'grid',
  placeItems: 'center',
  padding: '2px 0 0',
  boxSizing: 'border-box',
}

const welcomeHeroImageStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  maxHeight: 156,
  objectFit: 'contain',
  objectPosition: 'center',
  display: 'block',
}

const featureRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
}

const socialStackStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
}

const socialButtonStyle: CSSProperties = {
  width: '100%',
  minHeight: 52,
  borderRadius: 18,
  border: '1px solid rgba(148, 163, 184, 0.24)',
  background: 'rgba(255,255,255,0.96)',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '0 14px',
  boxSizing: 'border-box',
  textAlign: 'left',
  cursor: 'pointer',
}

const googleSocialButtonStyle: CSSProperties = {
  border: '1px solid rgba(91, 124, 250, 0.18)',
  boxShadow: '0 8px 20px rgba(91, 124, 250, 0.08)',
}

const socialButtonDisabledStyle: CSSProperties = {
  opacity: 1,
  cursor: 'not-allowed',
}

const socialButtonLoadingStyle: CSSProperties = {
  opacity: 0.72,
  cursor: 'wait',
}

const socialIconStyle: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 10,
  background: '#F8FAFC',
  color: '#0F172A',
  display: 'grid',
  placeItems: 'center',
  fontSize: 16,
  fontWeight: 900,
  flexShrink: 0,
}

const appleIconStyle: CSSProperties = {
  fontSize: 18,
}

const socialLabelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  color: '#0F172A',
  fontSize: 14,
  fontWeight: 800,
}

const comingSoonPillStyle: CSSProperties = {
  padding: '6px 9px',
  borderRadius: 999,
  background: 'rgba(91, 124, 250, 0.10)',
  color: '#5B7CFA',
  fontSize: 10,
  fontWeight: 800,
  whiteSpace: 'nowrap',
}

const featurePillStyle: CSSProperties = {
  padding: '8px 11px',
  borderRadius: 999,
  background: 'rgba(255,255,255,0.82)',
  color: '#31405D',
  fontSize: 12,
  fontWeight: 700,
  border: '1px solid rgba(91, 124, 250, 0.14)',
}

const optionStackStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
}

const roleCardStyle: CSSProperties = {
  width: '100%',
  textAlign: 'left',
  border: '1px solid rgba(145, 164, 196, 0.24)',
  background: '#FFFFFF',
  borderRadius: 22,
  padding: 12,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  cursor: 'pointer',
  transition: 'all 180ms ease',
}

const roleCardSelectedStyle: CSSProperties = {
  border: '1px solid rgba(91, 124, 250, 0.52)',
  boxShadow: '0 16px 34px rgba(91, 124, 250, 0.14)',
  background: '#F8FBFF',
}

const roleCardTopStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 10,
}

const roleCardBodyStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'grid',
  gap: 6,
}

const roleCardImageWrapStyle: CSSProperties = {
  width: 84,
  minWidth: 84,
  height: 84,
  borderRadius: 18,
  background: 'linear-gradient(180deg, rgba(239,244,255,0.92) 0%, rgba(248,251,255,0.96) 100%)',
  border: '1px solid rgba(145, 164, 196, 0.14)',
  display: 'grid',
  placeItems: 'center',
  overflow: 'hidden',
}

const roleCardImageStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'contain',
  objectPosition: 'center',
  display: 'block',
}

const roleCardTitleRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
}

const roleIconStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 12,
  background: '#EEF4FF',
  display: 'grid',
  placeItems: 'center',
  fontSize: 16,
  flexShrink: 0,
}

const roleTitleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: '#0F172A',
}

const roleDescriptionStyle: CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.4,
  color: '#5E6B83',
}

const serviceGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 10,
}

const serviceCardStyle: CSSProperties = {
  position: 'relative',
  border: '1px solid rgba(145, 164, 196, 0.22)',
  background: '#FFFFFF',
  borderRadius: 20,
  padding: '14px 12px',
  minHeight: 92,
  display: 'grid',
  alignContent: 'space-between',
  justifyItems: 'start',
  cursor: 'pointer',
  textAlign: 'left',
}

const serviceCardSelectedStyle: CSSProperties = {
  border: '1px solid rgba(91, 124, 250, 0.52)',
  boxShadow: '0 14px 32px rgba(91, 124, 250, 0.14)',
  background: '#F8FBFF',
}

const serviceEmojiStyle: CSSProperties = {
  fontSize: 22,
}

const serviceLabelStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.35,
  fontWeight: 800,
  color: '#0F172A',
}

const serviceDescriptionStyle: CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.45,
  color: '#64748B',
}

const checkBadgeStyle: CSSProperties = {
  display: 'inline-grid',
  placeItems: 'center',
  width: 22,
  height: 22,
  borderRadius: 999,
  background: '#5B7CFA',
  color: '#FFFFFF',
  fontSize: 13,
  fontWeight: 900,
  flexShrink: 0,
}

const locationCardStyle: CSSProperties = {
  display: 'grid',
  gap: 10,
}

const locationMapStyle: CSSProperties = {
  position: 'relative',
  minHeight: 144,
  borderRadius: 24,
  overflow: 'hidden',
  background: 'linear-gradient(180deg, #F4F7FF 0%, #FCFDFF 100%)',
  border: '1px solid rgba(145, 164, 196, 0.20)',
}

const locationPreviewImageStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'contain',
  objectPosition: 'center',
  display: 'block',
}

const locationMapImageOverlayStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(248,251,255,0.22) 100%)',
}

const locationMapGridStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  backgroundImage:
    'linear-gradient(rgba(120,140,176,0.10) 1px, transparent 1px), linear-gradient(90deg, rgba(120,140,176,0.10) 1px, transparent 1px)',
  backgroundSize: '46px 46px',
}

const locationMapRouteStyle: CSSProperties = {
  position: 'absolute',
  left: '38%',
  top: '18%',
  width: 76,
  height: 92,
  borderRight: '4px dotted rgba(91, 124, 250, 0.56)',
  transform: 'rotate(18deg)',
}

const locationMapPinStyle: CSSProperties = {
  position: 'absolute',
  top: '38%',
  left: '57%',
  width: 38,
  height: 38,
  borderRadius: '50%',
  background: '#FFFFFF',
  display: 'grid',
  placeItems: 'center',
  boxShadow: '0 16px 32px rgba(91, 124, 250, 0.18)',
  fontSize: 18,
}

const locationMetaStyle: CSSProperties = {
  display: 'grid',
  gap: 4,
}

const locationLabelTitleStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  textTransform: 'uppercase',
  color: '#5B7CFA',
}

const locationLabelValueStyle: CSSProperties = {
  fontSize: 18,
  lineHeight: 1.2,
  fontWeight: 800,
  color: '#0F172A',
}

const locationHintStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.4,
  color: '#5E6B83',
}

const secondaryInlineButtonStyle: CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(145, 164, 196, 0.24)',
  background: '#FFFFFF',
  color: '#23314F',
  borderRadius: 18,
  minHeight: 44,
  padding: '0 16px',
  fontSize: 14,
  fontWeight: 700,
  cursor: 'pointer',
}

const summaryCardStyle: CSSProperties = {
  borderRadius: 20,
  background: '#F8FBFF',
  border: '1px solid rgba(91, 124, 250, 0.14)',
  padding: 10,
  display: 'grid',
  gap: 4,
}

const summaryRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  fontSize: 13,
  fontWeight: 800,
  color: '#3F4D68',
}

const summaryLocationStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.45,
  color: '#64748B',
}

const fieldBlockStyle: CSSProperties = {
  display: 'grid',
  gap: 4,
}

const labelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: '#23314F',
}

const inputStyle: CSSProperties = {
  width: '100%',
  minHeight: 46,
  borderRadius: 16,
  border: '1px solid rgba(145, 164, 196, 0.24)',
  background: '#FFFFFF',
  padding: '0 14px',
  fontSize: 14,
  color: '#0F172A',
  boxSizing: 'border-box',
  outline: 'none',
}

const authErrorStyle: CSSProperties = {
  borderRadius: 18,
  background: '#FEF2F2',
  color: '#B91C1C',
  fontSize: 13,
  lineHeight: 1.45,
  padding: '10px 12px',
}

const footerStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
}

const buttonRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1.35fr',
  gap: 8,
}

const primaryButtonStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'linear-gradient(180deg, #0F172A 0%, #233B74 100%)',
  color: '#FFFFFF',
  minHeight: 54,
  borderRadius: 20,
  padding: '0 18px',
  fontSize: 16,
  fontWeight: 800,
  cursor: 'pointer',
  boxShadow: '0 18px 36px rgba(15, 23, 42, 0.18)',
}

const primaryButtonDisabledStyle: CSSProperties = {
  cursor: 'not-allowed',
  opacity: 0.45,
  boxShadow: 'none',
}

const secondaryButtonStyle: CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(145, 164, 196, 0.24)',
  background: 'rgba(255,255,255,0.82)',
  color: '#23314F',
  minHeight: 54,
  borderRadius: 20,
  padding: '0 18px',
  fontSize: 15,
  fontWeight: 700,
  cursor: 'pointer',
}

const bottomHintStyle: CSSProperties = {
  textAlign: 'center',
  fontSize: 13,
  lineHeight: 1.5,
  color: '#64748B',
}

const textLinkStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  color: '#3152C8',
  fontWeight: 800,
  padding: 0,
  cursor: 'pointer',
  fontSize: 'inherit',
}

const detailsSectionsStyle: CSSProperties = {
  display: 'grid',
  gap: 18,
}

const providerIdentityCardStyle: CSSProperties = {
  display: 'grid',
  gap: 12,
  padding: '14px 14px 12px',
  borderRadius: 20,
  border: '1px solid rgba(145, 164, 196, 0.18)',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(248,251,255,0.96) 100%)',
  boxShadow: '0 12px 26px rgba(45, 68, 126, 0.08)',
}

const providerIdentityHeaderStyle: CSSProperties = {
  display: 'grid',
  gap: 4,
}

const providerIdentityTitleStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 900,
  color: '#0F172A',
}

const providerIdentitySubtitleStyle: CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.45,
  color: '#64748B',
}

const detailsSectionStyle: CSSProperties = {
  display: 'grid',
  gap: 12,
}

const detailsSectionLabelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: '#5B7CFA',
  textTransform: 'uppercase',
}

const detailsFieldBlockStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
}

const chipRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
}

const chipStyle: CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(145, 164, 196, 0.24)',
  background: '#FFFFFF',
  borderRadius: 14,
  padding: '10px 14px',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 2,
  cursor: 'pointer',
  minWidth: 52,
  transition: 'all 180ms ease',
}

const chipSelectedStyle: CSSProperties = {
  border: '1px solid rgba(91, 124, 250, 0.52)',
  background: '#F0F4FF',
  boxShadow: '0 8px 20px rgba(91, 124, 250, 0.12)',
}

const compactChipStyle: CSSProperties = {
  padding: '9px 12px',
  minWidth: 0,
}

const chipLabelStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: '#0F172A',
}

const compactChipLabelStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.25,
  fontWeight: 800,
  color: '#0F172A',
}

const chipDescStyle: CSSProperties = {
  fontSize: 11,
  color: '#64748B',
  fontWeight: 600,
}

const textareaStyle: CSSProperties = {
  width: '100%',
  minHeight: 72,
  borderRadius: 16,
  border: '1px solid rgba(145, 164, 196, 0.24)',
  background: '#FFFFFF',
  padding: '10px 14px',
  fontSize: 14,
  color: '#0F172A',
  boxSizing: 'border-box',
  outline: 'none',
  resize: 'vertical',
  fontFamily: 'inherit',
}

const compactTextareaStyle: CSSProperties = {
  ...textareaStyle,
  minHeight: 56,
  maxHeight: 80,
  lineHeight: 1.45,
  resize: 'none',
}
