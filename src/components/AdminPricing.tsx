import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { supabase } from '../services/supabaseClient'
import {
  computeSurge,
  applyMultiplier,
  surgeLabel,
  MAX_MULTIPLIER,
  SURGE_CONFIG,
  type PricingSignals,
  type SurgeLevel,
  type SurgeReason,
} from '../lib/pricing'
import { DURATION_OPTIONS } from '../lib/payments'

/* ── Component ──────────────────────────────────────────────────── */

export default function AdminPricing() {
  const [signals, setSignals] = useState<PricingSignals | null>(null)
  const [multiplier, setMultiplier] = useState(1)
  const [level, setLevel] = useState<SurgeLevel>('normal')
  const [reasons, setReasons] = useState<SurgeReason[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchSignals = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('pricing_signals')
    if (err) { setError(err.message); setLoading(false); return }
    const s = data as unknown as PricingSignals
    setSignals(s)
    const result = computeSurge(s)
    setMultiplier(result.multiplier)
    setLevel(result.level)
    setReasons(result.reasons)
    setError(null)
    setLoading(false)
  }, [])

  useEffect(() => {
    setLoading(true)
    fetchSignals()
    const id = setInterval(fetchSignals, 15_000)
    return () => clearInterval(id)
  }, [fetchSignals])

  /* ── Loading / error ───────────────────────────────────── */

  if (loading && !signals) {
    return (
      <div style={st.shell}>
        <div style={st.loadingText}>Loading pricing data...</div>
      </div>
    )
  }

  if (error && !signals) {
    return (
      <div style={st.shell}>
        <div style={st.headerRow}>
          <h3 style={st.title}>Dynamic Pricing</h3>
          <span style={st.errorBadge}>Error</span>
        </div>
        <div style={{ fontSize: 12, color: '#94A3B8', textAlign: 'center' as const, padding: '8px 0' }}>{error}</div>
      </div>
    )
  }

  if (!signals) return null

  const surgeLbl = surgeLabel(level)
  const isSurging = multiplier > 1

  /* ── Render ────────────────────────────────────────────── */

  return (
    <div style={{
      ...st.shell,
      borderColor: isSurging
        ? (level === 'high' ? '#FECACA' : '#FDE68A')
        : '#E8ECF0',
    }}>
      <div style={st.headerRow}>
        <h3 style={st.title}>Dynamic Pricing</h3>
        {isSurging ? (
          <span style={{
            ...st.surgeBadge,
            background: level === 'high' ? '#DC2626' : '#D97706',
          }}>
            {surgeLbl}
          </span>
        ) : (
          <span style={st.normalBadge}>Normal</span>
        )}
        {error && <span style={st.staleBadge}>Stale</span>}
      </div>

      {/* ── Multiplier display ──────────────────────────────── */}
      <div style={st.multiplierRow}>
        <div style={{
          ...st.multiplierCircle,
          borderColor: isSurging
            ? (level === 'high' ? '#DC2626' : '#D97706')
            : '#16A34A',
        }}>
          <span style={{
            fontSize: 28,
            fontWeight: 900,
            color: isSurging
              ? (level === 'high' ? '#DC2626' : '#D97706')
              : '#16A34A',
            lineHeight: 1,
          }}>
            {multiplier}x
          </span>
          <span style={{ fontSize: 10, color: '#94A3B8', fontWeight: 600 }}>multiplier</span>
        </div>

        {/* Price preview */}
        <div style={st.pricePreview}>
          <SectionLabel>Current Prices</SectionLabel>
          <div style={st.priceGrid}>
            {DURATION_OPTIONS.map((opt) => {
              const adj = applyMultiplier(opt.priceILS, multiplier)
              return (
                <div key={opt.value} style={st.priceCard}>
                  <span style={{ fontSize: 11, color: '#64748B', fontWeight: 600 }}>{opt.label}</span>
                  <span style={{ fontSize: 16, fontWeight: 800, color: '#0F172A' }}>
                    ₪{adj}
                  </span>
                  {isSurging && (
                    <span style={{ fontSize: 10, color: '#94A3B8', textDecoration: 'line-through' }}>
                      ₪{opt.priceILS}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── Supply/demand signals ───────────────────────────── */}
      <SectionLabel style={{ marginTop: 16 }}>Live Signals</SectionLabel>
      <div style={st.signalRow}>
        <SignalPill label="Providers Online" value={signals.providers_online}
          color={signals.providers_online < SURGE_CONFIG.lowProviders.threshold ? '#DC2626' : '#16A34A'} />
        <SignalPill label="Open Requests" value={signals.open_requests}
          color={signals.open_requests > 0 ? '#D97706' : '#94A3B8'} />
        <SignalPill label="Submitted (30m)" value={signals.submitted_recent} />
        <SignalPill label="Matched (30m)" value={signals.matched_recent} />
      </div>

      {/* ── Active surge reasons ────────────────────────────── */}
      {reasons.length > 0 && (
        <>
          <SectionLabel style={{ marginTop: 16 }}>Surge Reasons</SectionLabel>
          <div style={st.reasonList}>
            {reasons.map((r, i) => (
              <div key={i} style={st.reasonCard}>
                <div style={st.reasonTop}>
                  <span style={st.reasonCondition}>{r.condition.replace(/_/g, ' ')}</span>
                  <span style={st.reasonBoost}>+{(r.boost * 100).toFixed(0)}%</span>
                </div>
                <div style={st.reasonDetail}>{r.detail}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Config reference ────────────────────────────────── */}
      <div style={st.configBar}>
        <span style={st.configLabel}>Config:</span>
        <span>Max {MAX_MULTIPLIER}x</span>
        <span style={st.configDot} />
        <span>Low providers &lt;{SURGE_CONFIG.lowProviders.threshold}</span>
        <span style={st.configDot} />
        <span>No-match &gt;{SURGE_CONFIG.highNoMatch.threshold}%</span>
        <span style={st.configDot} />
        <span>Demand ratio &gt;{SURGE_CONFIG.demandExceedsSupply.ratio}x</span>
        <span style={st.configDot} />
        <span>Match &lt;{SURGE_CONFIG.lowMatchRate.threshold}%</span>
      </div>
    </div>
  )
}

/* ── Sub-components ─────────────────────────────────────────────── */

function SectionLabel({ children, style }: { children: string; style?: CSSProperties }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, color: '#94A3B8',
      textTransform: 'uppercase' as const, letterSpacing: 0.6, marginBottom: 8,
      ...style,
    }}>
      {children}
    </div>
  )
}

function SignalPill({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={st.signalPill}>
      <span style={{ fontSize: 16, fontWeight: 800, color: color || '#334155', lineHeight: 1 }}>
        {value}
      </span>
      <span style={{ fontSize: 9, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: 0.3 }}>
        {label}
      </span>
    </div>
  )
}

/* ── Styles ──────────────────────────────────────────────────────── */

const st: Record<string, CSSProperties> = {
  shell: {
    borderRadius: 16,
    background: '#FFFFFF',
    border: '1px solid #E8ECF0',
    boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
    padding: 20,
    marginBottom: 16,
  },
  loadingText: {
    textAlign: 'center',
    color: '#94A3B8',
    fontSize: 13,
    padding: '20px 0',
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 16,
  },
  title: {
    margin: 0,
    fontSize: 16,
    fontWeight: 800,
    color: '#0F172A',
    letterSpacing: -0.3,
  },
  surgeBadge: {
    fontSize: 10,
    fontWeight: 700,
    color: '#FFFFFF',
    padding: '2px 8px',
    borderRadius: 6,
  },
  normalBadge: {
    fontSize: 10,
    fontWeight: 700,
    color: '#166534',
    background: '#DCFCE7',
    padding: '2px 8px',
    borderRadius: 6,
  },
  staleBadge: {
    fontSize: 10,
    fontWeight: 700,
    color: '#D97706',
    background: '#FFFBEB',
    padding: '2px 8px',
    borderRadius: 6,
  },
  errorBadge: {
    fontSize: 10,
    fontWeight: 700,
    color: '#DC2626',
    background: '#FEE2E2',
    padding: '2px 8px',
    borderRadius: 6,
  },

  /* Multiplier */
  multiplierRow: {
    display: 'flex',
    gap: 16,
    alignItems: 'flex-start',
    flexWrap: 'wrap',
  },
  multiplierCircle: {
    width: 90,
    height: 90,
    borderRadius: 45,
    border: '3px solid',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  pricePreview: {
    flex: 1,
    minWidth: 200,
  },
  priceGrid: {
    display: 'flex',
    gap: 8,
  },
  priceCard: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
    padding: '10px 8px',
    borderRadius: 10,
    background: '#F8FAFC',
    border: '1px solid #F1F5F9',
  },

  /* Signals */
  signalRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  },
  signalPill: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
    padding: '8px 12px',
    borderRadius: 10,
    background: '#F8FAFC',
    border: '1px solid #F1F5F9',
    minWidth: 70,
  },

  /* Reasons */
  reasonList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  reasonCard: {
    padding: '8px 12px',
    borderRadius: 8,
    background: '#FFFBEB',
    border: '1px solid #FDE68A',
  },
  reasonTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  reasonCondition: {
    fontSize: 12,
    fontWeight: 700,
    color: '#92400E',
    textTransform: 'capitalize',
  },
  reasonBoost: {
    fontSize: 11,
    fontWeight: 800,
    color: '#D97706',
  },
  reasonDetail: {
    fontSize: 11,
    color: '#78350F',
    marginTop: 2,
  },

  /* Config bar */
  configBar: {
    marginTop: 16,
    padding: '8px 12px',
    borderRadius: 8,
    background: '#F8FAFC',
    border: '1px solid #F1F5F9',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    alignItems: 'center',
    fontSize: 10,
    color: '#64748B',
  },
  configLabel: {
    fontWeight: 700,
    color: '#94A3B8',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginRight: 2,
  },
  configDot: {
    width: 3,
    height: 3,
    borderRadius: 2,
    background: '#CBD5E1',
  },
}
