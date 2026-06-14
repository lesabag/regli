import type { CSSProperties } from 'react'

type DeleteAccountModalProps = {
  open: boolean
  isHebrew: boolean
  loading: boolean
  error: string | null
  success: boolean
  onCancel: () => void
  onConfirm: () => void
}

export default function DeleteAccountModal({
  open,
  isHebrew,
  loading,
  error,
  success,
  onCancel,
  onConfirm,
}: DeleteAccountModalProps) {
  if (!open) return null

  return (
    <div style={backdropStyle} onClick={loading ? undefined : onCancel}>
      <div
        style={{
          ...cardStyle,
          direction: isHebrew ? 'rtl' : 'ltr',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={titleStyle}>
          {isHebrew ? 'מחיקת חשבון' : 'Delete account'}
        </div>
        <div style={bodyStyle}>
          {isHebrew
            ? 'מחיקת החשבון היא פעולה קבועה. לאחר המחיקה לא תהיה גישה לחשבון, לפרופיל ולהעדפות השמורות.'
            : 'Deleting your account is permanent. After deletion, you will lose access to your account, profile, and saved preferences.'}
        </div>
        <div style={bodyStyle}>
          {isHebrew
            ? 'רשומות מסוימות של הזמנות ותשלומים עשויות להישמר לצורכי תפעול, ביקורת ועמידה בדרישות חוק, אך הפרטים האישיים שלך יימחקו או יאונונמו ככל האפשר.'
            : 'Some booking and payment records may be retained for operational, audit, and legal purposes, but your personal profile data will be deleted or anonymized where possible.'}
        </div>
        {error ? <div style={errorStyle}>{error}</div> : null}
        {success ? (
          <div style={successStyle}>
            {isHebrew ? 'החשבון נמחק. מתבצע ניתוק...' : 'Account deleted. Signing you out...'}
          </div>
        ) : null}
        <div style={actionsStyle}>
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            style={{
              ...secondaryButtonStyle,
              ...(loading ? disabledButtonStyle : null),
            }}
          >
            {isHebrew ? 'ביטול' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading || success}
            style={{
              ...dangerButtonStyle,
              ...(loading || success ? disabledButtonStyle : null),
            }}
          >
            {loading
              ? (isHebrew ? 'מוחק...' : 'Deleting...')
              : (isHebrew ? 'מחק את החשבון שלי' : 'Delete my account')}
          </button>
        </div>
      </div>
    </div>
  )
}

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 50030,
  background: 'rgba(15, 23, 42, 0.52)',
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
  display: 'grid',
  gap: 12,
  padding: '20px 18px',
  borderRadius: 28,
  background: '#FFFFFF',
  border: '1px solid rgba(226, 232, 240, 0.95)',
  boxShadow: '0 28px 60px rgba(15, 23, 42, 0.22)',
  boxSizing: 'border-box',
}

const titleStyle: CSSProperties = {
  fontSize: 22,
  lineHeight: 1.15,
  fontWeight: 900,
  color: '#7F1D1D',
  letterSpacing: '-0.03em',
}

const bodyStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.7,
  color: '#334155',
}

const errorStyle: CSSProperties = {
  borderRadius: 16,
  background: 'rgba(239, 68, 68, 0.1)',
  color: '#B91C1C',
  padding: '10px 12px',
  fontSize: 13,
  fontWeight: 700,
}

const successStyle: CSSProperties = {
  borderRadius: 16,
  background: 'rgba(34, 197, 94, 0.12)',
  color: '#166534',
  padding: '10px 12px',
  fontSize: 13,
  fontWeight: 700,
}

const actionsStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 10,
  marginTop: 4,
}

const secondaryButtonStyle: CSSProperties = {
  minHeight: 48,
  borderRadius: 18,
  border: '1px solid rgba(203, 213, 225, 0.95)',
  background: '#FFFFFF',
  color: '#0F172A',
  fontSize: 14,
  fontWeight: 800,
  cursor: 'pointer',
}

const dangerButtonStyle: CSSProperties = {
  minHeight: 48,
  borderRadius: 18,
  border: 'none',
  background: 'linear-gradient(180deg, #DC2626 0%, #B91C1C 100%)',
  color: '#FFFFFF',
  fontSize: 14,
  fontWeight: 800,
  cursor: 'pointer',
}

const disabledButtonStyle: CSSProperties = {
  opacity: 0.6,
  cursor: 'default',
}
