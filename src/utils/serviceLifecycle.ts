import i18n from '../i18n.ts'

export type ServicePhase =
  | 'idle'
  | 'searching'
  | 'on_the_way'
  | 'arrived_pending_confirmation'
  | 'arrival_confirmed'
  | 'in_progress'
  | 'completed'
  | 'cancelled'

type JobLike = {
  status?: string | null
  booking_timing?: 'asap' | 'scheduled' | null
  dispatch_state?: 'queued' | 'dispatched' | 'expired' | 'cancelled' | null
  provider_arrived_at?: string | null
  client_arrival_confirmed_at?: string | null
  service_started_at?: string | null
  service_completed_at?: string | null
}

export type ServiceLabels = {
  startAction: string
  completeAction: string
  startedPast: string
  completedPast: string
  activeTitle: string
  completedTitle: string
  itemLabel: string
}

function normalizeServiceKind(serviceType: string | null | undefined): 'default' | 'dog' | 'babysitter' | 'handyman' {
  const normalized = (serviceType || '').trim().toLowerCase()
  if (!normalized) return 'default'

  if (
    normalized === 'dog' ||
    normalized === 'walk' ||
    normalized === 'dog_walker' ||
    normalized === 'dogwalker' ||
    normalized === 'dog_walk' ||
    normalized === 'dog-walk' ||
    normalized === 'dog_walking' ||
    normalized === 'quick' ||
    normalized === 'standard' ||
    normalized === 'energy'
  ) {
    return 'dog'
  }

  if (
    normalized === 'babysitter' ||
    normalized === 'baby_sitter' ||
    normalized === 'babysitting' ||
    normalized === 'sitter' ||
    normalized === 'childcare'
  ) {
    return 'babysitter'
  }

  if (
    normalized === 'handyman' ||
    normalized === 'locksmith' ||
    normalized === 'cleaning' ||
    normalized === 'handy' ||
    normalized === 'job' ||
    normalized === 'maintenance' ||
    normalized === 'helper'
  ) {
    return 'handyman'
  }

  return 'default'
}

export function getServiceLabels(serviceType: string | null | undefined): ServiceLabels {
  const kind = normalizeServiceKind(serviceType)
  const isHebrew = i18n.resolvedLanguage === 'he'

  if (kind === 'dog') {
    return {
      startAction: isHebrew ? 'התחל טיול' : 'Start Walk',
      completeAction: isHebrew ? 'סיים טיול' : 'Complete Walk',
      startedPast: isHebrew ? 'הטיול התחיל' : 'Walk started',
      completedPast: isHebrew ? 'הטיול הושלם' : 'Walk completed',
      activeTitle: isHebrew ? 'הטיול פעיל כעת' : 'Active walk',
      completedTitle: isHebrew ? 'הטיול הושלם' : 'Walk completed',
      itemLabel: isHebrew ? 'טיול' : 'walk',
    }
  }

  if (kind === 'babysitter') {
    return {
      startAction: isHebrew ? 'התחל סשן' : 'Start Session',
      completeAction: isHebrew ? 'סיים סשן' : 'Complete Session',
      startedPast: isHebrew ? 'הסשן התחיל' : 'Session started',
      completedPast: isHebrew ? 'הסשן הושלם' : 'Session completed',
      activeTitle: isHebrew ? 'הסשן פעיל כעת' : 'Active session',
      completedTitle: isHebrew ? 'הסשן הושלם' : 'Session completed',
      itemLabel: isHebrew ? 'סשן' : 'session',
    }
  }

  if (kind === 'handyman') {
    return {
      startAction: isHebrew ? 'התחל עבודה' : 'Start Job',
      completeAction: isHebrew ? 'סיים עבודה' : 'Complete Job',
      startedPast: isHebrew ? 'העבודה התחילה' : 'Job started',
      completedPast: isHebrew ? 'העבודה הושלמה' : 'Job completed',
      activeTitle: isHebrew ? 'העבודה פעילה כעת' : 'Active job',
      completedTitle: isHebrew ? 'העבודה הושלמה' : 'Job completed',
      itemLabel: isHebrew ? 'עבודה' : 'job',
    }
  }

  return {
    startAction: isHebrew ? 'התחל שירות' : 'Start Service',
    completeAction: isHebrew ? 'סיים שירות' : 'Complete Service',
    startedPast: isHebrew ? 'השירות התחיל' : 'Service started',
    completedPast: isHebrew ? 'השירות הושלם' : 'Service completed',
    activeTitle: isHebrew ? 'השירות פעיל כעת' : 'Service in progress',
    completedTitle: isHebrew ? 'השירות הושלם' : 'Service completed',
    itemLabel: isHebrew ? 'שירות' : 'service',
  }
}

export function getServicePhase(job: JobLike | null): ServicePhase {
  if (!job) return 'idle'

  if (job.status === 'completed') return 'completed'
  if (job.status === 'cancelled') return 'cancelled'

  if (job.status === 'open' || job.status === 'awaiting_payment') {
    if (job.booking_timing === 'scheduled' && job.dispatch_state !== 'dispatched') {
      return 'idle'
    }
    return 'searching'
  }

  if (job.status !== 'accepted') return 'idle'

  if (job.booking_timing === 'scheduled' && job.dispatch_state !== 'dispatched') {
    return 'idle'
  }

  if (job.service_started_at) return 'in_progress'
  if (job.client_arrival_confirmed_at) return 'arrival_confirmed'
  if (job.provider_arrived_at) return 'arrived_pending_confirmation'
  return 'on_the_way'
}
