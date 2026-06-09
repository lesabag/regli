import type { SupportedLanguage } from '../i18n'
import { LANGUAGE_STORAGE_KEY, normalizeSupportedLanguage } from '../i18n'
import { supabase } from '../services/supabaseClient'

export type LegalDocumentType = 'terms_of_service' | 'privacy_policy'
export type LegalAcceptanceRole = 'client' | 'walker' | 'admin'

export type PendingLegalAcceptanceContext = {
  language: SupportedLanguage
  role: LegalAcceptanceRole
  source:
    | 'email_signup'
    | 'google_oauth_signup'
    | 'apple_oauth_signup'
    | 'authenticated_onboarding'
  accountOwnerNoticeShown?: boolean
}

export const LEGAL_DOCUMENT_VERSIONS: Record<LegalDocumentType, string> = {
  terms_of_service: '2026-06-launch-v1',
  privacy_policy: '2026-06-launch-v1',
}

const PENDING_LEGAL_ACCEPTANCES_STORAGE_KEY = 'regli:pending-legal-acceptances'

function resolveAcceptanceLanguage(preferred: SupportedLanguage): SupportedLanguage {
  if (typeof document !== 'undefined') {
    const fromDocument = normalizeSupportedLanguage(document.documentElement.lang)
    if (fromDocument) return fromDocument
  }

  if (typeof window !== 'undefined') {
    const fromStorage = normalizeSupportedLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY))
    if (fromStorage) return fromStorage
  }

  return preferred
}

function buildLegalAcceptanceMetadata(context: PendingLegalAcceptanceContext) {
  return {
    source: context.source,
    role: context.role,
    account_owner_notice_shown: context.accountOwnerNoticeShown === true,
    platform: typeof navigator !== 'undefined' ? navigator.platform : 'unknown',
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
  }
}

export function getLegalDocumentUrl(documentType: LegalDocumentType): string {
  return documentType === 'terms_of_service'
    ? '/terms-of-service.html'
    : '/privacy-policy.html'
}

export function queuePendingLegalAcceptances(context: PendingLegalAcceptanceContext) {
  if (typeof window === 'undefined') return
  window.sessionStorage.setItem(PENDING_LEGAL_ACCEPTANCES_STORAGE_KEY, JSON.stringify({
    ...context,
    language: resolveAcceptanceLanguage(context.language),
  }))
}

export function readPendingLegalAcceptances(): PendingLegalAcceptanceContext | null {
  if (typeof window === 'undefined') return null
  const raw = window.sessionStorage.getItem(PENDING_LEGAL_ACCEPTANCES_STORAGE_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as PendingLegalAcceptanceContext
    if (
      !parsed ||
      (parsed.role !== 'client' && parsed.role !== 'walker' && parsed.role !== 'admin') ||
      (parsed.language !== 'en' && parsed.language !== 'he')
    ) {
      return null
    }
    return {
      ...parsed,
      role: parsed.role === 'admin' ? 'client' : parsed.role,
    }
  } catch {
    return null
  }
}

export function clearPendingLegalAcceptances() {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(PENDING_LEGAL_ACCEPTANCES_STORAGE_KEY)
}

export async function recordLegalAcceptances(
  userId: string,
  context: PendingLegalAcceptanceContext,
): Promise<{ ok: boolean; error?: string }> {
  const acceptedAt = new Date().toISOString()
  const metadata = buildLegalAcceptanceMetadata(context)

  const rows = (Object.keys(LEGAL_DOCUMENT_VERSIONS) as LegalDocumentType[]).map((documentType) => ({
    user_id: userId,
    document_type: documentType,
    document_version: LEGAL_DOCUMENT_VERSIONS[documentType],
    language: context.language,
    accepted_at: acceptedAt,
    metadata,
  }))

  const { error } = await supabase
    .from('legal_acceptances')
    .upsert(rows, {
      onConflict: 'user_id,document_type,document_version',
      ignoreDuplicates: true,
    })

  if (error) {
    return { ok: false, error: error.message }
  }

  return { ok: true }
}

export async function flushPendingLegalAcceptances(userId: string): Promise<{ ok: boolean; error?: string }> {
  const pendingContext = readPendingLegalAcceptances()
  if (!pendingContext) return { ok: true }

  const result = await recordLegalAcceptances(userId, pendingContext)
  if (result.ok) {
    clearPendingLegalAcceptances()
  }
  return result
}
