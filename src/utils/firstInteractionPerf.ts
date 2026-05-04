type InteractionEventType = 'pointerdown' | 'touchstart' | 'click'

type InteractionSnapshot = {
  activeElement: string | null
  bodyOverflow: string
  htmlOverflow: string
  topElement: string | null
}

type InteractionState = {
  appStartAt: number
  firstTapAt: number | null
  firstTapTarget: string | null
  cleanup: (() => void) | null
}

declare global {
  interface Window {
    __REGLI_FIRST_INTERACTION_DEBUG__?: InteractionState
  }
}

function isDebugEnabled() {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false
  try {
    return (
      window.location.search.includes('interactionDebug=1') ||
      window.localStorage.getItem('regli:interaction-debug') === '1'
    )
  } catch {
    return false
  }
}

function ensureState(): InteractionState | null {
  if (!isDebugEnabled() || typeof window === 'undefined') return null
  if (!window.__REGLI_FIRST_INTERACTION_DEBUG__) {
    window.__REGLI_FIRST_INTERACTION_DEBUG__ = {
      appStartAt: performance.now(),
      firstTapAt: null,
      firstTapTarget: null,
      cleanup: null,
    }
  }
  return window.__REGLI_FIRST_INTERACTION_DEBUG__
}

function describeElement(element: Element | null): string | null {
  if (!element) return null
  const tag = element.tagName.toLowerCase()
  const id = element.id ? `#${element.id}` : ''
  const role = element.getAttribute('role')
  const rolePart = role ? `[role=${role}]` : ''
  const dataControl = element.getAttribute('data-control')
  const dataControlPart = dataControl ? `[data-control=${dataControl}]` : ''
  const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 48)
  return `${tag}${id}${rolePart}${dataControlPart}${text ? ` "${text}"` : ''}`
}

function getSnapshotFromPoint(clientX?: number, clientY?: number): InteractionSnapshot {
  const activeElement = describeElement(document.activeElement)
  const bodyOverflow = document.body.style.overflow || '(empty)'
  const htmlOverflow = document.documentElement.style.overflow || '(empty)'
  const topElement =
    clientX != null && clientY != null ? describeElement(document.elementFromPoint(clientX, clientY)) : null

  return {
    activeElement,
    bodyOverflow,
    htmlOverflow,
    topElement,
  }
}

function log(message: string, data?: Record<string, unknown>) {
  const state = ensureState()
  if (!state) return
  const now = performance.now()
  const sinceLaunch = Math.round((now - state.appStartAt) * 100) / 100
  const sinceFirstTap =
    state.firstTapAt == null ? null : Math.round((now - state.firstTapAt) * 100) / 100

  console.log(`[interaction-debug +${sinceLaunch}ms${sinceFirstTap != null ? ` / tap +${sinceFirstTap}ms` : ''}] ${message}`, data ?? {})
}

function handleGlobalEvent(type: InteractionEventType, event: Event) {
  const state = ensureState()
  if (!state) return

  const target = event.target instanceof Element ? event.target : null
  const pointerEvent = event instanceof PointerEvent ? event : null
  const touch = event instanceof TouchEvent ? event.touches[0] ?? event.changedTouches[0] : null
  const clientX = pointerEvent?.clientX ?? touch?.clientX
  const clientY = pointerEvent?.clientY ?? touch?.clientY

  if (state.firstTapAt == null && (type === 'pointerdown' || type === 'touchstart' || type === 'click')) {
    state.firstTapAt = performance.now()
    state.firstTapTarget = describeElement(target)
  }

  log(`global ${type}`, {
    target: describeElement(target),
    snapshot: getSnapshotFromPoint(clientX, clientY),
  })
}

export function initFirstInteractionPerf() {
  const state = ensureState()
  if (!state || state.cleanup) return

  const onPointerDown = (event: Event) => handleGlobalEvent('pointerdown', event)
  const onTouchStart = (event: Event) => handleGlobalEvent('touchstart', event)
  const onClick = (event: Event) => handleGlobalEvent('click', event)

  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
  window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
  window.addEventListener('click', onClick, { capture: true, passive: true })

  let observer: PerformanceObserver | null = null
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      observer = new PerformanceObserver((list) => {
        const debugState = ensureState()
        if (!debugState) return
        const now = performance.now()
        const withinLaunchWindow = now - debugState.appStartAt <= 5000
        const withinFirstTapWindow =
          debugState.firstTapAt != null && now - debugState.firstTapAt <= 3000
        if (!withinLaunchWindow && !withinFirstTapWindow) return

        for (const entry of list.getEntries()) {
          if (entry.duration < 50) continue
          log('longtask', {
            name: entry.name,
            startTime: Math.round(entry.startTime * 100) / 100,
            duration: Math.round(entry.duration * 100) / 100,
          })
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {}
  }

  log('instrumentation ready')

  state.cleanup = () => {
    window.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions)
    window.removeEventListener('touchstart', onTouchStart, { capture: true } as EventListenerOptions)
    window.removeEventListener('click', onClick, { capture: true } as EventListenerOptions)
    observer?.disconnect()
    state.cleanup = null
  }
}

export function disposeFirstInteractionPerf() {
  const state = ensureState()
  state?.cleanup?.()
}

export function markFirstInteractionHandler(label: string, extra?: Record<string, unknown>) {
  log(`handler ${label}`, extra)
}

export function markFirstInteractionVisual(label: string, extra?: Record<string, unknown>) {
  log(`visual ${label}`, extra)
}

export function markFirstInteractionAsync(label: string, phase: 'start' | 'end', extra?: Record<string, unknown>) {
  log(`async ${label} ${phase}`, extra)
}
