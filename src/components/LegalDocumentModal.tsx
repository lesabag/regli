import type { CSSProperties } from 'react'
import type { LegalDocumentType } from '../lib/legalAcceptances'

type LegalDocumentModalProps = {
  documentType: LegalDocumentType | null
  isHebrew: boolean
  onClose: () => void
}

function getLegalCopy(isHebrew: boolean, documentType: LegalDocumentType) {
  const isTerms = documentType === 'terms_of_service'

  return {
    badge: isHebrew ? 'טיוטת השקה' : 'Launch placeholder',
    title: isTerms
      ? (isHebrew ? 'תנאי השימוש' : 'Terms of Service')
      : (isHebrew ? 'מדיניות הפרטיות' : 'Privacy Policy'),
    body: isTerms
      ? (
          isHebrew
            ? 'זהו נוסח זמני להשקה עבור תנאי השימוש של Regli. לפני השקה ציבורית יוחלף כאן נוסח משפטי מלא ומעודכן.'
            : 'This is a temporary launch placeholder for Regli’s Terms of Service. Final legal copy will replace this before public launch.'
        )
      : (
          isHebrew
            ? 'זהו נוסח זמני להשקה עבור מדיניות הפרטיות של Regli. לפני השקה ציבורית יוחלף כאן נוסח פרטיות מלא ומעודכן.'
            : 'This is a temporary launch placeholder for Regli’s Privacy Policy. Final privacy language will replace this before public launch.'
        ),
    extra: isTerms
      ? (
          isHebrew
            ? 'בהמשך השימוש ב־Regli המשתמשים מאשרים כי הזמנות, תשלומים ואחריות החשבון כפופים לתנאי השימוש הסופיים של Regli לאחר פרסומם.'
            : 'By continuing with Regli, users acknowledge that bookings, payments, and account responsibilities are governed by Regli’s final Terms of Service once published.'
        )
      : (
          isHebrew
            ? 'Regli אוספת רק את המידע הדרוש להפעלת הזמנות, תשלומים, התאמות ספקים ותמיכה. הנוסח הסופי יפרט את מדיניות השמירה, העיבוד והמחיקה.'
            : 'Regli collects only the information needed to run bookings, payments, matching, and support. Final policy language will describe retention, processing, and deletion in detail.'
        ),
    close: isHebrew ? 'סגור' : 'Close',
  }
}

export default function LegalDocumentModal({
  documentType,
  isHebrew,
  onClose,
}: LegalDocumentModalProps) {
  if (!documentType) return null

  const copy = getLegalCopy(isHebrew, documentType)
  const textAlign: CSSProperties['textAlign'] = isHebrew ? 'right' : 'left'

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div
        style={{
          ...cardStyle,
          direction: isHebrew ? 'rtl' : 'ltr',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ ...badgeStyle, alignSelf: isHebrew ? 'flex-end' : 'flex-start' }}>
          {copy.badge}
        </div>
        <div style={{ ...titleStyle, textAlign }}>{copy.title}</div>
        <div style={{ ...bodyStyle, textAlign }}>{copy.body}</div>
        <div style={{ ...bodyStyle, textAlign }}>{copy.extra}</div>
        <button type="button" onClick={onClose} style={closeButtonStyle}>
          {copy.close}
        </button>
      </div>
    </div>
  )
}

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 50020,
  background: 'rgba(15, 23, 42, 0.45)',
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
  boxSizing: 'border-box',
}

const cardStyle: CSSProperties = {
  width: 'min(92vw, 460px)',
  maxHeight: 'min(82vh, 680px)',
  overflowY: 'auto',
  display: 'grid',
  gap: 12,
  padding: '20px 18px',
  borderRadius: 28,
  background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, #FFFFFF 100%)',
  border: '1px solid rgba(226, 232, 240, 0.95)',
  boxShadow: '0 28px 60px rgba(15, 23, 42, 0.22)',
  boxSizing: 'border-box',
}

const badgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 28,
  padding: '0 12px',
  borderRadius: 999,
  background: 'rgba(37, 99, 235, 0.1)',
  color: '#1D4ED8',
  fontSize: 12,
  fontWeight: 800,
}

const titleStyle: CSSProperties = {
  fontSize: 22,
  lineHeight: 1.15,
  fontWeight: 900,
  color: '#0F172A',
  letterSpacing: '-0.03em',
}

const bodyStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.7,
  color: '#334155',
}

const closeButtonStyle: CSSProperties = {
  marginTop: 4,
  width: '100%',
  minHeight: 48,
  borderRadius: 18,
  border: 'none',
  background: '#0F172A',
  color: '#FFFFFF',
  fontSize: 15,
  fontWeight: 800,
  cursor: 'pointer',
}
