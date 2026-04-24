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
    normalized === 'dog_walk' ||
    normalized === 'dog-walk' ||
    normalized === 'quick' ||
    normalized === 'standard' ||
    normalized === 'energy'
  ) {
    return 'dog'
  }

  if (
    normalized === 'babysitter' ||
    normalized === 'babysitting' ||
    normalized === 'sitter' ||
    normalized === 'childcare'
  ) {
    return 'babysitter'
  }

  if (
    normalized === 'handyman' ||
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

  if (kind === 'dog') {
    return {
      startAction: 'Start Walk',
      completeAction: 'Complete Walk',
      startedPast: 'Walk started',
      completedPast: 'Walk completed',
      activeTitle: 'Active walk',
      completedTitle: 'Walk completed',
      itemLabel: 'walk',
    }
  }

  if (kind === 'babysitter') {
    return {
      startAction: 'Start Session',
      completeAction: 'Complete Session',
      startedPast: 'Session started',
      completedPast: 'Session completed',
      activeTitle: 'Active session',
      completedTitle: 'Session completed',
      itemLabel: 'session',
    }
  }

  if (kind === 'handyman') {
    return {
      startAction: 'Start Job',
      completeAction: 'Complete Job',
      startedPast: 'Job started',
      completedPast: 'Job completed',
      activeTitle: 'Active job',
      completedTitle: 'Job completed',
      itemLabel: 'job',
    }
  }

  return {
    startAction: 'Start Service',
    completeAction: 'Complete Service',
    startedPast: 'Service started',
    completedPast: 'Service completed',
    activeTitle: 'Service in progress',
    completedTitle: 'Service completed',
    itemLabel: 'service',
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
