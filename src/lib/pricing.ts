/**
 * Dynamic Pricing Engine V1
 *
 * Computes a surge multiplier based on real-time supply/demand signals.
 * All logic is pure — no side effects, no external calls.
 *
 * Rules (V1):
 *  - Never reduce below 1.0 (no discounts)
 *  - Never exceed MAX_MULTIPLIER
 *  - Each condition adds an independent boost
 *  - Final multiplier = clamp(sum of boosts, 1.0, MAX_MULTIPLIER)
 */

/* ── Configurable constants ────────────────────────────────────── */

/** Absolute cap on surge multiplier. */
export const MAX_MULTIPLIER = 1.5

/** Conditions and their boosts / thresholds. */
export const SURGE_CONFIG = {
  /** Provider availability: fewer online → higher surge */
  lowProviders: {
    threshold: 2,        // providers online below this
    boost: 0.15,         // per-step boost
    criticalThreshold: 0, // zero providers = max boost
    criticalBoost: 0.3,
  },
  /** No-match rate: high unmatched % → surge */
  highNoMatch: {
    threshold: 25,       // % above which surge starts
    mildBoost: 0.1,      // 25–50%
    highBoost: 0.2,      // 50%+
  },
  /** Open requests exceeding provider count */
  demandExceedsSupply: {
    ratio: 2,            // open_requests / providers_online
    boost: 0.1,
    highRatio: 4,
    highBoost: 0.2,
  },
  /** Low match rate */
  lowMatchRate: {
    threshold: 50,       // % below which surge starts
    boost: 0.1,
  },
} as const

/* ── Types ──────────────────────────────────────────────────────── */

/** Supply/demand snapshot used to compute pricing. */
export interface PricingSignals {
  providers_online: number
  open_requests: number
  /** Recent submitted requests (last 30 min) */
  submitted_recent: number
  /** Recent matched requests (last 30 min) */
  matched_recent: number
}

export type SurgeLevel = 'normal' | 'mild' | 'high'

export interface SurgeReason {
  condition: string
  detail: string
  boost: number
}

export interface PricingResult {
  multiplier: number
  level: SurgeLevel
  reasons: SurgeReason[]
  adjustedPriceILS: number
  basePriceILS: number
}

/* ── Core engine ───────────────────────────────────────────────── */

export function computeSurge(signals: PricingSignals): {
  multiplier: number
  level: SurgeLevel
  reasons: SurgeReason[]
} {
  const reasons: SurgeReason[] = []
  let totalBoost = 0

  const { providers_online, open_requests, submitted_recent, matched_recent } = signals
  const cfg = SURGE_CONFIG

  // 1. Low provider availability
  if (providers_online <= cfg.lowProviders.criticalThreshold && open_requests > 0) {
    const boost = cfg.lowProviders.criticalBoost
    totalBoost += boost
    reasons.push({
      condition: 'no_providers',
      detail: `No providers online with ${open_requests} open request(s)`,
      boost,
    })
  } else if (providers_online > 0 && providers_online < cfg.lowProviders.threshold) {
    const boost = cfg.lowProviders.boost
    totalBoost += boost
    reasons.push({
      condition: 'low_providers',
      detail: `Only ${providers_online} provider(s) online`,
      boost,
    })
  }

  // 2. High no-match rate
  if (submitted_recent >= 5) {
    const unmatched = Math.max(0, submitted_recent - matched_recent)
    const noMatchRate = Math.round((unmatched / submitted_recent) * 100)
    if (noMatchRate >= cfg.highNoMatch.threshold) {
      const boost = noMatchRate >= 50 ? cfg.highNoMatch.highBoost : cfg.highNoMatch.mildBoost
      totalBoost += boost
      reasons.push({
        condition: 'high_nomatch',
        detail: `No-match rate ${noMatchRate}% (${unmatched} of ${submitted_recent})`,
        boost,
      })
    }
  }

  // 3. Demand exceeds supply
  if (providers_online > 0 && open_requests > providers_online * cfg.demandExceedsSupply.ratio) {
    const ratio = open_requests / providers_online
    const boost = ratio > cfg.demandExceedsSupply.highRatio
      ? cfg.demandExceedsSupply.highBoost
      : cfg.demandExceedsSupply.boost
    totalBoost += boost
    reasons.push({
      condition: 'demand_exceeds_supply',
      detail: `${open_requests} open requests vs ${providers_online} providers (${ratio.toFixed(1)}x)`,
      boost,
    })
  }

  // 4. Low match rate (different from no-match — looks at overall matching efficiency)
  if (submitted_recent >= 5) {
    const matchRate = Math.round((matched_recent / submitted_recent) * 100)
    if (matchRate < cfg.lowMatchRate.threshold && matchRate > 0) {
      const boost = cfg.lowMatchRate.boost
      totalBoost += boost
      reasons.push({
        condition: 'low_match_rate',
        detail: `Match rate ${matchRate}% (below ${cfg.lowMatchRate.threshold}%)`,
        boost,
      })
    }
  }

  // Clamp: never below 1.0, never above MAX_MULTIPLIER
  const multiplier = Math.min(MAX_MULTIPLIER, Math.round((1 + totalBoost) * 100) / 100)

  const level: SurgeLevel =
    multiplier >= 1.3 ? 'high' :
    multiplier >= 1.1 ? 'mild' :
    'normal'

  return { multiplier, level, reasons }
}

/** Apply multiplier to a base price, rounding to nearest ILS. */
export function applyMultiplier(basePriceILS: number, multiplier: number): number {
  const clamped = Math.min(MAX_MULTIPLIER, Math.max(1, multiplier))
  return Math.round(basePriceILS * clamped)
}

/** Compute full pricing result for a given base price. */
export function computePricing(basePriceILS: number, signals: PricingSignals): PricingResult {
  const { multiplier, level, reasons } = computeSurge(signals)
  return {
    multiplier,
    level,
    reasons,
    basePriceILS,
    adjustedPriceILS: applyMultiplier(basePriceILS, multiplier),
  }
}

/** Human-readable surge label for UI. */
export function surgeLabel(level: SurgeLevel): string {
  if (level === 'high') return 'High demand pricing'
  if (level === 'mild') return 'Busy pricing'
  return ''
}
