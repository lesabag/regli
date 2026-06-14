import type { CSSProperties } from 'react'
import { getLegalDocumentUrl, type LegalDocumentType } from '../lib/legalAcceptances'

type LegalDocumentModalProps = {
  documentType: LegalDocumentType | null
  isHebrew: boolean
  onClose: () => void
}

function getLegalCopy(isHebrew: boolean, documentType: LegalDocumentType) {
  const isTerms = documentType === 'terms_of_service'
  return {
    title: isTerms
      ? (isHebrew ? 'תנאי השימוש' : 'Terms of Service')
      : (isHebrew ? 'מדיניות הפרטיות' : 'Privacy Policy'),
    close: isHebrew ? 'סגור' : 'Close',
    openInNewTab: isHebrew ? 'פתח בעמוד נפרד' : 'Open in separate page',
  }
}

export default function LegalDocumentModal({
  documentType,
  isHebrew,
  onClose,
}: LegalDocumentModalProps) {
  if (!documentType) return null

  const copy = getLegalCopy(isHebrew, documentType)
  const documentUrl = getLegalDocumentUrl(documentType, isHebrew ? 'he' : 'en')

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div
        style={{
          ...cardStyle,
          direction: isHebrew ? 'rtl' : 'ltr',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={headerStyle}>
          <div style={titleStyle}>{copy.title}</div>
          <a
            href={documentUrl}
            target="_blank"
            rel="noreferrer"
            style={linkStyle}
          >
            {copy.openInNewTab}
          </a>
        </div>
        <div style={frameWrapStyle}>
          <iframe
            title={copy.title}
            src={documentUrl}
            style={frameStyle}
          />
        </div>
        <button type="button" onClick={onClose} style={closeButtonStyle}>{copy.close}</button>
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
  width: 'min(94vw, 860px)',
  maxHeight: 'min(88vh, 820px)',
  overflowY: 'auto',
  display: 'grid',
  gap: 14,
  padding: '20px 18px 18px',
  borderRadius: 28,
  background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, #FFFFFF 100%)',
  border: '1px solid rgba(226, 232, 240, 0.95)',
  boxShadow: '0 28px 60px rgba(15, 23, 42, 0.22)',
  boxSizing: 'border-box',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
}

const titleStyle: CSSProperties = {
  fontSize: 22,
  lineHeight: 1.15,
  fontWeight: 900,
  color: '#0F172A',
  letterSpacing: '-0.03em',
}

const linkStyle: CSSProperties = {
  color: '#2563EB',
  fontSize: 13,
  fontWeight: 800,
  textDecoration: 'none',
  whiteSpace: 'nowrap',
}

const frameWrapStyle: CSSProperties = {
  borderRadius: 22,
  border: '1px solid rgba(226, 232, 240, 0.95)',
  overflow: 'hidden',
  background: '#FFFFFF',
  minHeight: 'min(68vh, 620px)',
}

const frameStyle: CSSProperties = {
  width: '100%',
  minHeight: 'min(68vh, 620px)',
  border: 'none',
  display: 'block',
  background: '#FFFFFF',
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
