import { useCallback, useEffect, useRef, useState } from 'react'

const MIN_DISPLAY_MS = 900
const EXIT_DURATION_MS = 400
const EXIT_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'

interface SplashScreenProps {
  ready: boolean
  authResolved?: boolean
  onDone: () => void
}

export default function SplashScreen({ ready, authResolved = false, onDone }: SplashScreenProps) {
  const [phase, setPhase] = useState<'enter' | 'visible' | 'exit'>('enter')
  const mountTimeRef = useRef(Date.now())
  const calledRef = useRef(false)
  const [progress, setProgress] = useState(0)
  const targetRef = useRef(0)
  const rafRef = useRef(0)
  const doneFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const completeSplash = useCallback(() => {
    if (calledRef.current) return
    calledRef.current = true
    onDone()
  }, [onDone])

  // ── Derive target from real loading milestones ──────────
  useEffect(() => {
    if (ready) {
      targetRef.current = 1
    } else if (authResolved) {
      targetRef.current = Math.max(targetRef.current, 0.55)
    }
  }, [ready, authResolved])

  // Auto-advance: subtle bootstrap feel so it never looks frozen
  useEffect(() => {
    const t1 = setTimeout(() => {
      targetRef.current = Math.max(targetRef.current, 0.1)
    }, 120)
    const t2 = setTimeout(() => {
      targetRef.current = Math.max(targetRef.current, 0.28)
    }, 450)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [])

  // ── Smooth rAF interpolation ────────────────────────────
  useEffect(() => {
    let active = true

    function tick() {
      if (!active) return
      setProgress((prev) => {
        const target = targetRef.current
        const diff = target - prev
        if (Math.abs(diff) < 0.003) return target
        const speed = target >= 1 ? 0.065 : 0.04
        return prev + diff * speed
      })
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      active = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // ── Phase management ────────────────────────────────────

  // Kick entrance on next frame
  useEffect(() => {
    const id = requestAnimationFrame(() => setPhase('visible'))
    return () => cancelAnimationFrame(id)
  }, [])

  // Exit trigger: when ready + min time elapsed
  useEffect(() => {
    if (!ready || calledRef.current) return
    const elapsed = Date.now() - mountTimeRef.current
    const remaining = Math.max(0, MIN_DISPLAY_MS - elapsed)
    const id = setTimeout(() => {
      setPhase('exit')

      if (doneFallbackRef.current) clearTimeout(doneFallbackRef.current)
      doneFallbackRef.current = setTimeout(completeSplash, EXIT_DURATION_MS + 80)
    }, remaining)
    return () => {
      clearTimeout(id)
      if (doneFallbackRef.current) {
        clearTimeout(doneFallbackRef.current)
        doneFallbackRef.current = null
      }
    }
  }, [ready, completeSplash])

  useEffect(() => {
    return () => {
      if (doneFallbackRef.current) {
        clearTimeout(doneFallbackRef.current)
      }
    }
  }, [])

  // After exit animation, call onDone exactly once
  useEffect(() => {
    if (phase !== 'exit') return
    const id = setTimeout(completeSplash, EXIT_DURATION_MS)
    return () => clearTimeout(id)
  }, [phase, completeSplash])

  // ── Derived visual values ───────────────────────────────

  const isExit = phase === 'exit'
  const isVisible = phase === 'visible' || phase === 'exit'
  const p = isExit ? 1 : progress

  // Logo reveal: dim + blurred → sharp + solid
  const logoOpacity = 0.12 + p * 0.88
  const logoBlur = (1 - p) * 8
  const logoScale = 0.96 + p * 0.04

  // Glow intensifies with progress
  const glowIntensity = 0.15 + p * 0.85
  const glowScale = 0.85 + p * 0.15

  // Pulse while still loading and progress is low
  const isPulsing = phase === 'visible' && !ready && progress < 0.8

  // Dots fade out approaching completion
  const dotsOpacity = Math.max(0, 1 - p * 0.9)

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: '#FAFAF8',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: isExit ? 0 : 1,
        transition: isExit
          ? `opacity ${EXIT_DURATION_MS}ms ${EXIT_EASING}`
          : 'none',
        pointerEvents: isExit ? 'none' : 'auto',
      }}
    >
      {/* Radial glow — intensifies with progress */}
      <div
        style={{
          position: 'absolute',
          width: 280,
          height: 280,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(255,205,0,0.08) 0%, transparent 70%)',
          opacity: glowIntensity,
          transform: `scale(${glowScale})`,
          pointerEvents: 'none',
          willChange: 'opacity, transform',
        }}
      />

      {/* Content — morphs away on exit, dissolving into the map beneath */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          transform: isExit ? 'translateY(-14px) scale(0.96)' : 'translateY(0) scale(1)',
          transition: isExit
            ? `transform ${EXIT_DURATION_MS}ms ${EXIT_EASING}`
            : 'none',
        }}
      >
        {/* Progress-driven reveal: opacity + blur + scale */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            opacity: logoOpacity,
            filter: logoBlur > 0.1 ? `blur(${logoBlur}px)` : 'none',
            transform: `scale(${logoScale})`,
            willChange: 'opacity, filter, transform',
          }}
        >
          {/* Pulse wrapper — CSS animation, independent of progress layer */}
          <div
            className={isPulsing ? 'splash-logo-pulse' : undefined}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
            }}
          >
            {/* Icon — entrance stagger 0ms */}
            <div
              style={{
                opacity: isVisible ? 1 : 0,
                transform: isVisible ? 'translateY(0) scale(1)' : 'translateY(14px) scale(0.96)',
                transition:
                  'opacity 0.5s cubic-bezier(0.22, 1, 0.36, 1), transform 0.5s cubic-bezier(0.22, 1, 0.36, 1)',
                marginBottom: 16,
                position: 'relative',
              }}
            >
              <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
                <path
                  d="M26 3C17.16 3 10 10.16 10 19c0 11.25 16 28 16 28s16-16.75 16-28c0-8.84-7.16-16-16-16z"
                  fill="#0B1A2B"
                  fillOpacity="0.06"
                  stroke="#0B1A2B"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
                <ellipse cx="22.5" cy="17.5" rx="2.2" ry="2.5" fill="#0B1A2B" opacity="0.65" />
                <ellipse cx="29.5" cy="17.5" rx="2.2" ry="2.5" fill="#0B1A2B" opacity="0.65" />
                <ellipse cx="19.5" cy="13.2" rx="1.7" ry="2" fill="#0B1A2B" opacity="0.45" />
                <ellipse cx="32.5" cy="13.2" rx="1.7" ry="2" fill="#0B1A2B" opacity="0.45" />
                <ellipse cx="26" cy="22.5" rx="4" ry="3" fill="#0B1A2B" opacity="0.55" />
                <circle cx="26" cy="44" r="2.5" fill="#FFCD00" opacity="0.9" />
              </svg>
            </div>

            {/* Wordmark — entrance stagger 80ms */}
            <h1
              style={{
                margin: 0,
                fontSize: 34,
                fontWeight: 800,
                letterSpacing: -0.8,
                color: '#0B1A2B',
                fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
                opacity: isVisible ? 1 : 0,
                transform: isVisible ? 'translateY(0)' : 'translateY(10px)',
                transition:
                  'opacity 0.5s cubic-bezier(0.22, 1, 0.36, 1) 0.08s, transform 0.5s cubic-bezier(0.22, 1, 0.36, 1) 0.08s',
              }}
            >
              Regli
            </h1>
          </div>
        </div>

        {/* Tagline — entrance stagger 160ms */}
        <p
          style={{
            margin: '8px 0 0',
            fontSize: 12,
            fontWeight: 500,
            color: '#8896AB',
            letterSpacing: 1.6,
            textTransform: 'uppercase',
            fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
            opacity: isVisible ? 1 : 0,
            transform: isVisible ? 'translateY(0)' : 'translateY(6px)',
            transition:
              'opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1) 0.16s, transform 0.45s cubic-bezier(0.22, 1, 0.36, 1) 0.16s',
          }}
        >
          Walks, on demand
        </p>

        {/* Loading dots — entrance stagger 280ms, then fade with progress */}
        <div
          style={{
            marginTop: 32,
            display: 'flex',
            gap: 7,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: isVisible ? 1 : 0,
            transition: 'opacity 0.4s cubic-bezier(0.22, 1, 0.36, 1) 0.28s',
          }}
        >
          <div style={{ display: 'flex', gap: 7, opacity: dotsOpacity }}>
            <span className="splash-dot splash-dot-1" />
            <span className="splash-dot splash-dot-2" />
            <span className="splash-dot splash-dot-3" />
          </div>
        </div>
      </div>
    </div>
  )
}
