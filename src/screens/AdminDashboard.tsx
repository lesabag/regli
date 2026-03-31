import { useEffect, useMemo, useState } from 'react';
import { supabase, invokeEdgeFunction } from '../services/supabaseClient';
import NotificationsBell from '../components/NotificationsBell';

type Profile = {
  id: string;
  full_name: string | null;
  email: string | null;
  role: 'admin' | 'walker' | 'client' | null;
  created_at: string | null;
  stripe_connect_account_id: string | null;
  stripe_connect_onboarding_complete: boolean;
  payouts_enabled: boolean;
  charges_enabled: boolean;
  live_payouts_enabled: boolean;
};

type JobProfile = {
  id: string;
  full_name: string | null;
  email: string | null;
};

type RatingRow = {
  id: string;
  job_id: string;
  from_user_id: string;
  to_user_id: string;
  rating: number;
  review: string | null;
  created_at: string;
};

type PayoutRequestRow = {
  id: string;
  walker_id: string;
  amount: number;
  status: 'pending' | 'approved' | 'paid' | 'rejected';
  note: string | null;
  created_at: string;
  processed_at: string | null;
  walker?: JobProfile | null;
};

type WalkRequest = {
  id: string;
  created_at: string | null;
  status: 'awaiting_payment' | 'open' | 'accepted' | 'completed' | 'cancelled' | string;
  dog_name: string | null;
  location: string | null;
  address: string | null;
  notes: string | null;
  price: number | null;
  platform_fee: number | null;
  walker_earnings: number | null;
  client_id: string | null;
  walker_id: string | null;
  payment_status: 'unpaid' | 'authorized' | 'paid' | 'failed' | 'refunded' | null;
  paid_at: string | null;
  stripe_payment_intent_id: string | null;
  client?: JobProfile | null;
  walker?: JobProfile | null;
};

type WalletRow = {
  walker_id: string;
  available_balance: number;
  pending_balance: number;
  total_earned: number;
  updated_at: string;
  walker?: JobProfile | null;
};

type WalkerPayoutRow = {
  id: string;
  walker_id: string;
  job_id: string;
  gross_amount: number;
  platform_fee: number;
  net_amount: number;
  currency: string;
  status: 'pending' | 'processing' | 'transferred' | 'in_transit' | 'paid_out' | 'failed' | 'reversed' | 'refunded';
  stripe_transfer_id: string | null;
  stripe_payout_id: string | null;
  failure_reason: string | null;
  retry_count: number | null;
  available_at: string | null;
  created_at: string;
  updated_at: string;
  walker?: JobProfile | null;
};

interface AdminDashboardProps {
  profile?: {
    id: string
    email: string | null
    full_name: string | null
    role: 'admin' | 'walker' | 'client'
  }
  onSignOut?: () => Promise<void>
}

/* ── Status transition map ────────────────────────────────────── */

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  awaiting_payment: ['open', 'cancelled'],
  open:             ['accepted', 'cancelled'],
  accepted:         ['completed', 'open', 'cancelled'],
  completed:        [],           // terminal — no admin override
  cancelled:        ['open'],     // re-open only
};

function getAllowedTransitions(current: string): string[] {
  return ALLOWED_TRANSITIONS[current] ?? [];
}

/* ── Problem filter presets ───────────────────────────────────── */

type ProblemPreset = {
  label: string;
  match: (j: WalkRequest) => boolean;
  desc: string;
};

const STUCK_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

const PROBLEM_PRESETS: ProblemPreset[] = [
  {
    label: 'Failed Payments',
    desc: 'Jobs where the payment failed',
    match: (j) => j.payment_status === 'failed',
  },
  {
    label: 'Open — No Walker',
    desc: 'Open jobs with no walker assigned',
    match: (j) => j.status === 'open' && !j.walker_id,
  },
  {
    label: 'Stuck Accepted',
    desc: 'Accepted over 2 hours ago',
    match: (j) =>
      j.status === 'accepted' &&
      !!j.created_at &&
      Date.now() - new Date(j.created_at).getTime() > STUCK_THRESHOLD_MS,
  },
  {
    label: 'Authorized — Not Captured',
    desc: 'Payment reserved but not yet captured',
    match: (j) => j.payment_status === 'authorized' && j.status !== 'completed',
  },
  {
    label: 'Pending Payouts',
    desc: 'Payout requests awaiting admin action',
    match: () => false, // handled specially — scrolls to payout section
  },
];

/* ── Helpers ──────────────────────────────────────────────────── */

function isToday(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function fmtILS(amount: number): string {
  return `${amount.toFixed(2)} ILS`;
}

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtTime(value: string): string {
  return new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/* ── Main Component ───────────────────────────────────────────── */

export default function AdminDashboard(_props: AdminDashboardProps) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [jobs, setJobs] = useState<WalkRequest[]>([]);
  const [ratings, setRatings] = useState<RatingRow[]>([]);
  const [payoutRequests, setPayoutRequests] = useState<PayoutRequestRow[]>([]);
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [walkerPayouts, setWalkerPayouts] = useState<WalkerPayoutRow[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(true);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [loadingPayouts, setLoadingPayouts] = useState(true);
  const [loadingWallets, setLoadingWallets] = useState(true);
  const [loadingTransfers, setLoadingTransfers] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [clientFilter, setClientFilter] = useState('all');
  const [walkerFilter, setWalkerFilter] = useState('all');
  const [paymentStatusFilter, setPaymentStatusFilter] = useState('all');
  const [payoutStatusFilter, setPayoutStatusFilter] = useState('all');

  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [activeProblemFilter, setActiveProblemFilter] = useState<string | null>(null);

  const ratingsByJobId = useMemo(() => {
    const map = new Map<string, RatingRow[]>();
    ratings.forEach((r) => {
      const arr = map.get(r.job_id) || [];
      arr.push(r);
      map.set(r.job_id, arr);
    });
    return map;
  }, [ratings]);

  // Per-walker aggregated ratings (ratings received by walkers)
  const walkerRatingStats = useMemo(() => {
    const map = new Map<string, { count: number; sum: number; latest: RatingRow | null }>();
    // Only count ratings TO walkers (to_user_id is the walker)
    const walkerIds = new Set(profiles.filter((p) => p.role === 'walker').map((p) => p.id));
    ratings.forEach((r) => {
      if (!walkerIds.has(r.to_user_id)) return;
      const existing = map.get(r.to_user_id) || { count: 0, sum: 0, latest: null };
      existing.count += 1;
      existing.sum += r.rating;
      if (!existing.latest || r.created_at > existing.latest.created_at) {
        existing.latest = r;
      }
      map.set(r.to_user_id, existing);
    });
    return map;
  }, [ratings, profiles]);

  const payoutByJobId = useMemo(() => {
    const map = new Map<string, WalkerPayoutRow>();
    walkerPayouts.forEach((p) => map.set(p.job_id, p));
    return map;
  }, [walkerPayouts]);

  const transferStats = useMemo(() => {
    let totalTransferred = 0;
    let totalPaidOut = 0;
    let totalFailed = 0;
    let inTransit = 0;
    let processing = 0;
    let retryQueue = 0;
    let stuckProcessing = 0;
    let refundedCount = 0;
    let finalFailureCount = 0;

    const stuckThresholdMs = 15 * 60 * 1000; // 15 minutes

    walkerPayouts.forEach((p) => {
      totalTransferred += p.net_amount;
      if (p.status === 'paid_out') totalPaidOut += p.net_amount;
      else if (p.status === 'failed' || p.status === 'reversed' || p.status === 'refunded') totalFailed += p.net_amount;
      else if (p.status === 'transferred' || p.status === 'in_transit') inTransit += p.net_amount;
      else if (p.status === 'processing') {
        processing += p.net_amount;
        // Check if stuck (processing for >15 min)
        if (Date.now() - new Date(p.updated_at).getTime() > stuckThresholdMs) {
          stuckProcessing++;
        }
      }

      if (p.status === 'refunded') refundedCount++;
      if (p.status === 'failed' && (p.retry_count ?? 0) >= 5) finalFailureCount++;
    });

    const failedCount = walkerPayouts.filter((p) => p.status === 'failed').length;
    retryQueue = failedCount;

    return { totalTransferred, totalPaidOut, totalFailed, inTransit, processing, retryQueue, stuckProcessing, refundedCount, finalFailureCount, count: walkerPayouts.length };
  }, [walkerPayouts]);

  const profileNameById = useMemo(() => {
    const map = new Map<string, string>();
    profiles.forEach((p) => {
      map.set(p.id, p.full_name || p.email || p.id);
    });
    return map;
  }, [profiles]);

  useEffect(() => {
    fetchProfiles();
    fetchJobs();
    fetchRatings();
    fetchPayoutRequests();
    fetchWallets();
    fetchWalkerPayouts();

    const channel = supabase
      .channel('admin-dashboard-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'walk_requests' },
        () => fetchJobs()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'profiles' },
        () => {
          fetchProfiles();
          fetchJobs();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ratings' },
        () => fetchRatings()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'payout_requests' },
        () => fetchPayoutRequests()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'walker_wallets' },
        () => fetchWallets()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'walker_payouts' },
        () => fetchWalkerPayouts()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  async function fetchProfiles() {
    setLoadingProfiles(true);
    setError('');

    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, email, role, created_at, stripe_connect_account_id, stripe_connect_onboarding_complete, payouts_enabled, charges_enabled, live_payouts_enabled')
      .order('created_at', { ascending: false });

    if (error) {
      setError(error.message);
      setLoadingProfiles(false);
      return;
    }

    setProfiles((data as Profile[]) || []);
    setLoadingProfiles(false);
  }

  async function fetchJobs() {
    setLoadingJobs(true);
    setError('');

    const { data, error } = await supabase
      .from('walk_requests')
      .select(`
        id,
        created_at,
        status,
        dog_name,
        location,
        address,
        notes,
        price,
        platform_fee,
        walker_earnings,
        client_id,
        walker_id,
        payment_status,
        paid_at,
        stripe_payment_intent_id,
        client:profiles!walk_requests_client_id_fkey (
          id,
          full_name,
          email
        ),
        walker:profiles!walk_requests_walker_id_fkey (
          id,
          full_name,
          email
        )
      `)
      .order('created_at', { ascending: false });

    if (error) {
      setError(error.message);
      setLoadingJobs(false);
      return;
    }

    const normalized = (data || []).map((row: Record<string, unknown>) => ({
      ...row,
      client: Array.isArray(row.client) ? (row.client as JobProfile[])[0] || null : row.client,
      walker: Array.isArray(row.walker) ? (row.walker as JobProfile[])[0] || null : row.walker,
    }));
    setJobs(normalized as WalkRequest[]);
    setLoadingJobs(false);
  }

  async function fetchRatings() {
    const { data, error } = await supabase
      .from('ratings')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to fetch ratings', error.message);
      return;
    }
    setRatings((data as RatingRow[]) || []);
  }

  async function fetchPayoutRequests() {
    setLoadingPayouts(true);

    const { data, error } = await supabase
      .from('payout_requests')
      .select('*, walker:profiles!payout_requests_walker_id_fkey(id, full_name, email)')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to fetch payout requests', error.message);
      setLoadingPayouts(false);
      return;
    }

    const normalized = (data || []).map((row: Record<string, unknown>) => ({
      ...row,
      walker: Array.isArray(row.walker) ? (row.walker as JobProfile[])[0] || null : row.walker,
    }));

    setPayoutRequests(normalized as PayoutRequestRow[]);
    setLoadingPayouts(false);
  }

  async function fetchWallets() {
    setLoadingWallets(true);

    const { data, error } = await supabase
      .from('walker_wallets')
      .select('*, walker:profiles!walker_wallets_walker_id_fkey(id, full_name, email)')
      .order('total_earned', { ascending: false });

    if (error) {
      console.error('Failed to fetch wallets', error.message);
      setLoadingWallets(false);
      return;
    }

    const normalized = (data || []).map((row: Record<string, unknown>) => ({
      ...row,
      walker: Array.isArray(row.walker) ? (row.walker as JobProfile[])[0] || null : row.walker,
    }));

    setWallets(normalized as WalletRow[]);
    setLoadingWallets(false);
  }

  async function fetchWalkerPayouts() {
    setLoadingTransfers(true);

    const { data, error } = await supabase
      .from('walker_payouts')
      .select('*, walker:profiles!walker_payouts_walker_id_fkey(id, full_name, email)')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to fetch walker payouts', error.message);
      setLoadingTransfers(false);
      return;
    }

    const normalized = (data || []).map((row: Record<string, unknown>) => ({
      ...row,
      walker: Array.isArray(row.walker) ? (row.walker as JobProfile[])[0] || null : row.walker,
    }));

    setWalkerPayouts(normalized as WalkerPayoutRow[]);
    setLoadingTransfers(false);
  }

  async function handlePayoutStatusChange(payoutId: string, nextStatus: string) {
    const needsProcessedAt = nextStatus === 'approved' || nextStatus === 'paid' || nextStatus === 'rejected';

    const updatePayload: Record<string, unknown> = { status: nextStatus };
    if (needsProcessedAt) {
      updatePayload.processed_at = new Date().toISOString();
    }

    const { error } = await supabase
      .from('payout_requests')
      .update(updatePayload)
      .eq('id', payoutId);

    if (error) {
      alert(error.message);
      return;
    }

    fetchPayoutRequests();
  }

  async function handleToggleLivePayouts(userId: string, currentValue: boolean) {
    const nextValue = !currentValue;
    const confirmMsg = nextValue
      ? 'Enable live Stripe payouts for this walker? Transfers will be created for their completed jobs.'
      : 'Disable live payouts for this walker? New transfers will be skipped.';
    if (!window.confirm(confirmMsg)) return;

    const { error } = await supabase
      .from('profiles')
      .update({ live_payouts_enabled: nextValue })
      .eq('id', userId);

    if (error) {
      alert(error.message);
      return;
    }
    fetchProfiles();
  }

  async function handleRoleChange(userId: string, nextRole: string) {
    const { error } = await supabase
      .from('profiles')
      .update({ role: nextRole })
      .eq('id', userId);

    if (error) {
      alert(error.message);
      return;
    }

    fetchProfiles();
  }

  async function handleDeleteProfile(userId: string) {
    const confirmed = window.confirm('Delete this profile?');
    if (!confirmed) return;

    const { error } = await supabase
      .from('profiles')
      .delete()
      .eq('id', userId);

    if (error) {
      alert(error.message);
      return;
    }

    fetchProfiles();
  }

  async function handleDeleteJob(jobId: string) {
    const confirmed = window.confirm('Delete this job? This cannot be undone.');
    if (!confirmed) return;

    const { error } = await supabase
      .from('walk_requests')
      .delete()
      .eq('id', jobId);

    if (error) {
      alert(error.message);
      return;
    }

    fetchJobs();
  }

  const [actionLoading, setActionLoading] = useState<string | null>(null);

  async function handleRetryTransfer(jobId: string) {
    if (!window.confirm('Retry the failed transfer for this job?')) return;
    setActionLoading(jobId);
    try {
      const { data, error: fnErr } = await invokeEdgeFunction<{ success?: boolean; error?: string }>('create-transfer', {
        body: { jobId },
      });
      if (fnErr) {
        alert(`Retry failed: ${fnErr}`);
      } else if (!data?.success) {
        alert(`Retry failed: ${data?.error || 'Unknown error'}`);
      } else {
        fetchWalkerPayouts();
      }
    } catch (err) {
      alert(`Retry failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRecoverStuck() {
    if (!window.confirm('Recover all stuck processing payouts? This will check Stripe for existing transfers and reset others to failed with retry.')) return;
    setActionLoading('recover');
    try {
      const { data, error: fnErr } = await invokeEdgeFunction<{ recovered?: number; repaired?: number; failedWithRetry?: number; failedFinal?: number; error?: string }>('recover-stuck-payouts', {
        body: {},
      });
      if (fnErr) {
        alert(`Recovery failed: ${fnErr}`);
      } else if (data?.error) {
        alert(`Recovery failed: ${data.error}`);
      } else {
        alert(`Recovery complete: ${data?.repaired ?? 0} repaired, ${data?.failedWithRetry ?? 0} retried, ${data?.failedFinal ?? 0} final failures`);
        fetchWalkerPayouts();
      }
    } catch (err) {
      alert(`Recovery failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleStatusTransition(jobId: string, currentStatus: string, nextStatus: string) {
    const allowed = getAllowedTransitions(currentStatus);
    if (!allowed.includes(nextStatus)) {
      alert(`Cannot transition from "${currentStatus}" to "${nextStatus}".`);
      return;
    }

    const confirmMsg =
      nextStatus === 'cancelled'
        ? 'Cancel this job? The walker and client will be affected.'
        : nextStatus === 'open' && currentStatus === 'accepted'
        ? 'Reset this job to open? The assigned walker will be removed.'
        : `Change status from "${currentStatus}" to "${nextStatus}"?`;

    if (!window.confirm(confirmMsg)) return;

    const updatePayload: Record<string, unknown> = { status: nextStatus };

    // Clear walker when resetting to open
    if (nextStatus === 'open') {
      updatePayload.walker_id = null;
    }

    const { error } = await supabase
      .from('walk_requests')
      .update(updatePayload)
      .eq('id', jobId);

    if (error) {
      alert(error.message);
      return;
    }

    fetchJobs();
  }

  /* ── Problem filter logic ──────────────────────────────────── */

  function handleProblemChipClick(label: string) {
    if (label === 'Pending Payouts') {
      // Scroll to payout section and set filter
      setPayoutStatusFilter('pending');
      document.getElementById('section-payouts')?.scrollIntoView({ behavior: 'smooth' });
      setActiveProblemFilter(label);
      return;
    }

    if (activeProblemFilter === label) {
      setActiveProblemFilter(null);
    } else {
      setActiveProblemFilter(label);
    }
    // Reset dropdown filters when using problem chips
    setStatusFilter('all');
    setPaymentStatusFilter('all');
    setClientFilter('all');
    setWalkerFilter('all');
    setSearch('');
  }

  /* ── Derived data ──────────────────────────────────────────── */

  const walkerProfiles = useMemo(() => {
    return profiles.filter((p) => p.role === 'walker');
  }, [profiles]);

  const clientOptions = useMemo(() => {
    const map = new Map<string, string>();
    jobs.forEach((job) => {
      if (job.client?.id) {
        map.set(job.client.id, job.client.full_name || job.client.email || job.client.id);
      }
    });
    return Array.from(map.entries()).map(([id, label]) => ({ id, label }));
  }, [jobs]);

  const walkerOptions = useMemo(() => {
    const map = new Map<string, string>();
    jobs.forEach((job) => {
      if (job.walker?.id) {
        map.set(job.walker.id, job.walker.full_name || job.walker.email || job.walker.id);
      }
    });
    return Array.from(map.entries()).map(([id, label]) => ({ id, label }));
  }, [jobs]);

  const problemCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const preset of PROBLEM_PRESETS) {
      if (preset.label === 'Pending Payouts') {
        counts[preset.label] = payoutRequests.filter((p) => p.status === 'pending').length;
      } else {
        counts[preset.label] = jobs.filter(preset.match).length;
      }
    }
    return counts;
  }, [jobs, payoutRequests]);

  const filteredJobs = useMemo(() => {
    // If a problem filter is active (and it's not the payout one), use it instead of dropdown filters
    const activePreset = activeProblemFilter
      ? PROBLEM_PRESETS.find((p) => p.label === activeProblemFilter && p.label !== 'Pending Payouts')
      : null;

    if (activePreset) {
      const term = search.trim().toLowerCase();
      return jobs.filter((job) => {
        const matchesPreset = activePreset.match(job);
        const matchesSearch =
          !term ||
          String(job.dog_name || '').toLowerCase().includes(term) ||
          String(job.client?.full_name || '').toLowerCase().includes(term) ||
          String(job.walker?.full_name || '').toLowerCase().includes(term);
        return matchesPreset && matchesSearch;
      });
    }

    const term = search.trim().toLowerCase();

    return jobs.filter((job) => {
      const matchesSearch =
        !term ||
        String(job.id).toLowerCase().includes(term) ||
        String(job.dog_name || '').toLowerCase().includes(term) ||
        String(job.status || '').toLowerCase().includes(term) ||
        String(job.location || '').toLowerCase().includes(term) ||
        String(job.address || '').toLowerCase().includes(term) ||
        String(job.notes || '').toLowerCase().includes(term) ||
        String(job.client?.full_name || '').toLowerCase().includes(term) ||
        String(job.client?.email || '').toLowerCase().includes(term) ||
        String(job.walker?.full_name || '').toLowerCase().includes(term) ||
        String(job.walker?.email || '').toLowerCase().includes(term) ||
        String(job.payment_status || '').toLowerCase().includes(term);

      const matchesStatus = statusFilter === 'all' || job.status === statusFilter;
      const matchesClient = clientFilter === 'all' || job.client_id === clientFilter;
      const matchesWalker = walkerFilter === 'all' || job.walker_id === walkerFilter;
      const matchesPaymentStatus = paymentStatusFilter === 'all' || job.payment_status === paymentStatusFilter;

      return matchesSearch && matchesStatus && matchesClient && matchesWalker && matchesPaymentStatus;
    });
  }, [jobs, search, statusFilter, clientFilter, walkerFilter, paymentStatusFilter, activeProblemFilter]);

  const filteredPayouts = useMemo(() => {
    if (payoutStatusFilter === 'all') return payoutRequests;
    return payoutRequests.filter((pr) => pr.status === payoutStatusFilter);
  }, [payoutRequests, payoutStatusFilter]);

  const stats = useMemo(() => {
    const todayJobs = jobs.filter((j) => isToday(j.created_at));
    const todayCompleted = jobs.filter((j) => j.status === 'completed' && isToday(j.paid_at));
    const todayPaid = jobs.filter((j) => j.payment_status === 'paid' && isToday(j.paid_at));
    const todayUsers = profiles.filter((p) => isToday(p.created_at));

    return {
      total: jobs.length,
      open: jobs.filter((j) => j.status === 'open').length,
      accepted: jobs.filter((j) => j.status === 'accepted').length,
      completed: jobs.filter((j) => j.status === 'completed').length,
      cancelled: jobs.filter((j) => j.status === 'cancelled').length,
      paid: jobs.filter((j) => j.payment_status === 'paid').length,
      totalRevenue: jobs
        .filter((j) => j.payment_status === 'paid')
        .reduce((sum, j) => sum + (j.price || 0), 0),
      platformFees: jobs
        .filter((j) => j.payment_status === 'paid')
        .reduce((sum, j) => sum + (j.platform_fee || 0), 0),
      walkerEarnings: jobs
        .filter((j) => j.payment_status === 'paid')
        .reduce((sum, j) => sum + (j.walker_earnings || 0), 0),
      pendingPayouts: payoutRequests.filter((p) => p.status === 'pending').length,
      avgRating: ratings.length > 0
        ? Math.round((ratings.reduce((s, r) => s + r.rating, 0) / ratings.length) * 10) / 10
        : 0,
      totalUsers: profiles.length,
      totalClients: profiles.filter((p) => p.role === 'client').length,
      totalWalkers: walkerProfiles.length,
      walkersReady: walkerProfiles.filter((p) => p.payouts_enabled && p.charges_enabled).length,
      walkersLivePayouts: walkerProfiles.filter((p) => p.live_payouts_enabled).length,
      // Today metrics
      todayJobs: todayJobs.length,
      todayCompleted: todayCompleted.length,
      todayRevenue: todayPaid.reduce((sum, j) => sum + (j.price || 0), 0),
      todayPlatformFees: todayPaid.reduce((sum, j) => sum + (j.platform_fee || 0), 0),
      todayNewUsers: todayUsers.length,
    };
  }, [jobs, ratings, payoutRequests, profiles, walkerProfiles]);

  async function handleLogout() {
    await supabase.auth.signOut();
    window.location.reload();
  }

  return (
    <div style={st.page}>
      {/* ── Top bar ─────────────────────────────────────────── */}
      <div style={st.topBar}>
        <div>
          <h1 style={st.title}>Operations Dashboard</h1>
          <p style={st.subtitle}>Real-time business overview</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <NotificationsBell variant="dark" />
          <button style={st.btnOutline} onClick={handleLogout}>Logout</button>
        </div>
      </div>

      {error ? <div style={st.error}>{error}</div> : null}

      {/* ── KPI Cards ───────────────────────────────────────── */}
      <section style={st.kpiSection}>
        {/* All-time row */}
        <div style={st.kpiRow}>
          <KpiCard label="Total Jobs" value={stats.total} color="#3B82F6" />
          <KpiCard label="Open" value={stats.open} color="#0EA5E9" />
          <KpiCard label="Accepted" value={stats.accepted} color="#F59E0B" />
          <KpiCard label="Completed" value={stats.completed} color="#10B981" />
          <KpiCard label="Total Paid" value={stats.paid} color="#8B5CF6" />
        </div>
        {/* Revenue row */}
        <div style={st.kpiRow}>
          <KpiCard label="Total Revenue" value={fmtILS(stats.totalRevenue)} color="#10B981" large />
          <KpiCard label="Platform Fees" value={fmtILS(stats.platformFees)} color="#3B82F6" large />
          <KpiCard label="Walker Earnings" value={fmtILS(stats.walkerEarnings)} color="#F59E0B" large />
          <KpiCard label="Pending Payouts" value={stats.pendingPayouts} color={stats.pendingPayouts > 0 ? '#EF4444' : '#94A3B8'} large hint="Payout requests awaiting admin action" />
        </div>
        {/* Today row */}
        <div style={st.kpiRow}>
          <KpiCard label="Jobs Today" value={stats.todayJobs} color="#6366F1" today />
          <KpiCard label="Completed Today" value={stats.todayCompleted} color="#10B981" today />
          <KpiCard label="Revenue Today" value={fmtILS(stats.todayRevenue)} color="#10B981" today />
          <KpiCard label="Fees Today" value={fmtILS(stats.todayPlatformFees)} color="#3B82F6" today />
          <KpiCard label="New Users Today" value={stats.todayNewUsers} color="#8B5CF6" today />
        </div>
        {/* Users row */}
        <div style={st.kpiRow}>
          <KpiCard label="Users" value={stats.totalUsers} color="#6366F1" />
          <KpiCard label="Clients" value={stats.totalClients} color="#0EA5E9" />
          <KpiCard label="Walkers" value={stats.totalWalkers} color="#F59E0B" />
          <KpiCard label="Walkers Ready" value={stats.walkersReady} color="#10B981" hint="Onboarding complete + payouts + charges enabled" />
          <KpiCard label="Live Payouts" value={stats.walkersLivePayouts} color={stats.walkersLivePayouts > 0 ? '#6D28D9' : '#94A3B8'} hint="Walkers with live Stripe transfers enabled" />
          <KpiCard label="Avg Rating" value={stats.avgRating > 0 ? `${stats.avgRating} / 5` : '-'} color="#F59E0B" />
        </div>
        {/* Payout health row */}
        <div style={st.kpiRow}>
          <KpiCard label="Total Transfers" value={transferStats.count} color="#6366F1" />
          <KpiCard label="In Transit" value={fmtILS(transferStats.inTransit)} color="#6D28D9" hint="Transferred to Stripe, awaiting bank payout" />
          <KpiCard label="Paid Out" value={fmtILS(transferStats.totalPaidOut)} color="#10B981" />
          <KpiCard label="Failed / Retry Queue" value={transferStats.retryQueue} color={transferStats.retryQueue > 0 ? '#DC2626' : '#94A3B8'} hint="Failed transfers awaiting retry" />
          <KpiCard label="Processing" value={fmtILS(transferStats.processing)} color={transferStats.processing > 0 ? '#C2410C' : '#94A3B8'} hint="Currently being created" />
        </div>
        {/* Operational health row */}
        <div style={st.kpiRow}>
          <KpiCard label="Stuck Processing" value={transferStats.stuckProcessing} color={transferStats.stuckProcessing > 0 ? '#DC2626' : '#94A3B8'} hint="Processing >15 min — may need recovery" />
          <KpiCard label="Refunded" value={transferStats.refundedCount} color={transferStats.refundedCount > 0 ? '#C2410C' : '#94A3B8'} hint="Transfers where charge was refunded" />
          <KpiCard label="Final Failures" value={transferStats.finalFailureCount} color={transferStats.finalFailureCount > 0 ? '#991B1B' : '#94A3B8'} hint="Failed after 5 retries — needs manual intervention" />
        </div>
      </section>

      {/* ── Problem Chips ───────────────────────────────────── */}
      <section style={{ ...st.section, padding: '16px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Quick filters
          </span>
          {PROBLEM_PRESETS.map((preset) => {
            const count = problemCounts[preset.label] || 0;
            const isActive = activeProblemFilter === preset.label;
            return (
              <button
                key={preset.label}
                title={preset.desc}
                onClick={() => handleProblemChipClick(preset.label)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 14px',
                  borderRadius: 999,
                  border: isActive ? '2px solid #0F172A' : '1px solid #E2E8F0',
                  background: isActive ? '#0F172A' : count > 0 ? '#FFF7ED' : '#F8FAFC',
                  color: isActive ? '#FFFFFF' : count > 0 ? '#C2410C' : '#94A3B8',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                {preset.label}
                <span style={{
                  background: isActive ? 'rgba(255,255,255,0.2)' : count > 0 ? '#FED7AA' : '#E2E8F0',
                  color: isActive ? '#FFFFFF' : count > 0 ? '#9A3412' : '#94A3B8',
                  borderRadius: 999,
                  padding: '1px 7px',
                  fontSize: 11,
                  fontWeight: 800,
                }}>
                  {count}
                </span>
              </button>
            );
          })}
          {activeProblemFilter && (
            <button
              onClick={() => { setActiveProblemFilter(null); setPayoutStatusFilter('all'); }}
              style={{
                padding: '6px 12px',
                borderRadius: 999,
                border: '1px solid #E2E8F0',
                background: '#FFFFFF',
                color: '#64748B',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Clear
            </button>
          )}
        </div>
      </section>

      {/* ── Jobs ────────────────────────────────────────────── */}
      <section style={st.section}>
        <div style={st.sectionHeader}>
          <h2 style={st.sectionTitle}>Jobs</h2>
          <button style={st.btnOutline} onClick={fetchJobs}>Refresh</button>
        </div>

        <div style={st.filtersRow}>
          <input
            style={{ ...st.input, flex: 2 }}
            type="text"
            placeholder="Search by dog name, client, walker, status..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setActiveProblemFilter(null); }}
          />
          <select style={st.select} value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setActiveProblemFilter(null); }}>
            <option value="all">All statuses</option>
            <option value="awaiting_payment">Awaiting Payment</option>
            <option value="open">Open</option>
            <option value="accepted">Accepted</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select style={st.select} value={paymentStatusFilter} onChange={(e) => { setPaymentStatusFilter(e.target.value); setActiveProblemFilter(null); }}>
            <option value="all">All payments</option>
            <option value="unpaid">Unpaid</option>
            <option value="authorized">Authorized</option>
            <option value="paid">Paid</option>
            <option value="failed">Failed</option>
            <option value="refunded">Refunded</option>
          </select>
          <select style={st.select} value={clientFilter} onChange={(e) => { setClientFilter(e.target.value); setActiveProblemFilter(null); }}>
            <option value="all">All clients</option>
            {clientOptions.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
          <select style={st.select} value={walkerFilter} onChange={(e) => { setWalkerFilter(e.target.value); setActiveProblemFilter(null); }}>
            <option value="all">All walkers</option>
            {walkerOptions.map((w) => (
              <option key={w.id} value={w.id}>{w.label}</option>
            ))}
          </select>
        </div>

        {loadingJobs ? (
          <p style={{ color: '#94A3B8', padding: 20 }}>Loading jobs...</p>
        ) : (
          <div style={st.tableWrap}>
            <table style={st.table}>
              <thead>
                <tr>
                  <th style={st.th}>Dog</th>
                  <th style={st.th}>Client</th>
                  <th style={st.th}>Walker</th>
                  <th style={st.th}>Status</th>
                  <th style={st.th}>Payment</th>
                  <th style={st.th}>Price</th>
                  <th style={st.th}>Created</th>
                  <th style={st.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.map((job) => {
                  const isExpanded = expandedJobId === job.id;
                  const allowed = getAllowedTransitions(job.status);

                  return (
                    <tr key={job.id} style={{ cursor: 'pointer' }} onClick={() => setExpandedJobId(isExpanded ? null : job.id)}>
                      <td style={st.td}>
                        <div style={{ fontWeight: 600 }}>{job.dog_name || '-'}</div>
                        <div style={st.muted}>{job.location || job.address || ''}</div>
                      </td>
                      <td style={st.td}>
                        <div>{job.client?.full_name || '-'}</div>
                        <div style={st.muted}>{job.client?.email || ''}</div>
                      </td>
                      <td style={st.td}>
                        <div>{job.walker?.full_name || '-'}</div>
                        <div style={st.muted}>{job.walker?.email || ''}</div>
                      </td>
                      <td style={st.td}>
                        <span style={statusBadge(job.status)}>{job.status}</span>
                      </td>
                      <td style={st.td}>
                        <span style={paymentBadge(job.payment_status || 'unpaid')}>
                          {job.payment_status || 'unpaid'}
                        </span>
                      </td>
                      <td style={st.td}>
                        <strong>{job.price != null ? fmtILS(job.price) : '-'}</strong>
                      </td>
                      <td style={st.td}>
                        <div>{job.created_at ? fmtDate(job.created_at) : '-'}</div>
                        <div style={st.muted}>{job.created_at ? fmtTime(job.created_at) : ''}</div>
                      </td>
                      <td style={st.td} onClick={(e) => e.stopPropagation()}>
                        {allowed.length > 0 ? (
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                            {allowed.includes('open') && (
                              <button style={st.btnSmOutline} onClick={() => handleStatusTransition(job.id, job.status, 'open')}>
                                Reset to Open
                              </button>
                            )}
                            {allowed.includes('accepted') && (
                              <button style={st.btnSmOutline} onClick={() => handleStatusTransition(job.id, job.status, 'accepted')}>
                                Accept
                              </button>
                            )}
                            {allowed.includes('completed') && (
                              <button style={st.btnSuccess} onClick={() => handleStatusTransition(job.id, job.status, 'completed')}>
                                Complete
                              </button>
                            )}
                            {allowed.includes('cancelled') && (
                              <button style={st.btnDanger} onClick={() => handleStatusTransition(job.id, job.status, 'cancelled')}>
                                Cancel
                              </button>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: '#94A3B8', fontSize: 12 }}>
                            {job.status === 'completed' ? 'Final' : 'No actions'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {/* Expanded detail row */}
                {filteredJobs.map((job) => {
                  if (expandedJobId !== job.id) return null;
                  const jobRatings = ratingsByJobId.get(job.id) || [];
                  return (
                    <tr key={`${job.id}-detail`}>
                      <td colSpan={8} style={{ ...st.td, background: '#F8FAFC', padding: '16px 24px' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 16, fontSize: 13 }}>
                          <div>
                            <span style={st.detailLabel}>Job ID</span>
                            <span style={{ fontSize: 11, color: '#64748B', wordBreak: 'break-all' }}>{job.id}</span>
                          </div>
                          <div>
                            <span style={st.detailLabel}>Platform Fee</span>
                            <span>{job.platform_fee != null ? fmtILS(job.platform_fee) : '-'}</span>
                          </div>
                          <div>
                            <span style={st.detailLabel}>Walker Earnings</span>
                            <span>{job.walker_earnings != null ? fmtILS(job.walker_earnings) : '-'}</span>
                          </div>
                          <div>
                            <span style={st.detailLabel}>Paid At</span>
                            <span>{job.paid_at ? new Date(job.paid_at).toLocaleString() : '-'}</span>
                          </div>
                          <div style={{ gridColumn: '1 / -1' }}>
                            <span style={st.detailLabel}>Stripe Payment Intent</span>
                            <span style={{ fontSize: 11, color: '#64748B', wordBreak: 'break-all' }}>
                              {job.stripe_payment_intent_id || '-'}
                            </span>
                          </div>
                          {(() => {
                            const tp = payoutByJobId.get(job.id);
                            return (
                              <>
                                <div>
                                  <span style={st.detailLabel}>Transfer Status</span>
                                  {tp ? (
                                    <span style={transferBadge(tp.status)}>{tp.status}</span>
                                  ) : (
                                    <span style={{ color: '#94A3B8', fontSize: 12 }}>
                                      {job.payment_status === 'paid' ? 'No transfer yet' : '-'}
                                    </span>
                                  )}
                                </div>
                                <div>
                                  <span style={st.detailLabel}>Transfer ID</span>
                                  <span style={{ fontSize: 11, color: '#64748B', wordBreak: 'break-all' }}>
                                    {tp?.stripe_transfer_id || '-'}
                                  </span>
                                </div>
                                <div>
                                  <span style={st.detailLabel}>Payout ID</span>
                                  <span style={{ fontSize: 11, color: '#64748B', wordBreak: 'break-all' }}>
                                    {tp?.stripe_payout_id || '-'}
                                  </span>
                                </div>
                                {tp?.failure_reason && (
                                  <div style={{ gridColumn: '1 / -1' }}>
                                    <span style={st.detailLabel}>Failure Reason</span>
                                    <span style={{ color: '#DC2626', fontSize: 12 }}>{tp.failure_reason}</span>
                                  </div>
                                )}
                              </>
                            );
                          })()}
                          <div style={{ gridColumn: '1 / 3' }}>
                            <span style={st.detailLabel}>Notes</span>
                            <span>{job.notes || '-'}</span>
                          </div>
                          <div style={{ gridColumn: '3 / 5' }}>
                            <span style={st.detailLabel}>Ratings</span>
                            {jobRatings.length === 0 ? (
                              <span style={{ color: '#94A3B8' }}>No ratings</span>
                            ) : (
                              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                                {jobRatings.map((r) => (
                                  <div key={r.id}>
                                    <span style={{ color: '#F59E0B', fontWeight: 700 }}>{'★'.repeat(r.rating)}</span>
                                    <span style={{ color: '#D1D5DB' }}>{'★'.repeat(5 - r.rating)}</span>
                                    <span style={{ marginLeft: 6, color: '#64748B' }}>
                                      {profileNameById.get(r.from_user_id) || 'User'}
                                    </span>
                                    {r.review && (
                                      <div style={{ color: '#64748B', fontSize: 12, marginTop: 2 }}>
                                        {r.review.length > 100 ? r.review.slice(0, 100) + '...' : r.review}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          {/* Quick actions in detail row */}
                          <div style={{ gridColumn: '1 / -1', borderTop: '1px solid #E2E8F0', paddingTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                              Admin actions
                            </span>
                            {getAllowedTransitions(job.status).includes('open') && (
                              <button style={st.btnSmOutline} onClick={() => handleStatusTransition(job.id, job.status, 'open')}>
                                Reset to Open
                              </button>
                            )}
                            {getAllowedTransitions(job.status).includes('cancelled') && (
                              <button style={{ ...st.btnDanger, fontSize: 11, padding: '4px 10px' }} onClick={() => handleStatusTransition(job.id, job.status, 'cancelled')}>
                                Cancel Job
                              </button>
                            )}
                            <button style={{ ...st.btnDanger, fontSize: 11, padding: '4px 10px' }} onClick={() => handleDeleteJob(job.id)}>
                              Delete Job
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {!filteredJobs.length && (
                  <tr>
                    <td style={{ ...st.td, textAlign: 'center', color: '#94A3B8', padding: 32 }} colSpan={8}>
                      {activeProblemFilter ? `No jobs matching "${activeProblemFilter}" filter.` : 'No jobs match the current filters.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Payout Requests ─────────────────────────────────── */}
      <section id="section-payouts" style={st.section}>
        <div style={st.sectionHeader}>
          <div>
            <h2 style={st.sectionTitle}>Payout Requests</h2>
            <p style={st.hint}>Pending requests require admin review before funds are released.</p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <select
              style={{ ...st.select, width: 'auto' }}
              value={payoutStatusFilter}
              onChange={(e) => setPayoutStatusFilter(e.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="paid">Paid</option>
              <option value="rejected">Rejected</option>
            </select>
            <button style={st.btnOutline} onClick={fetchPayoutRequests}>Refresh</button>
          </div>
        </div>

        {loadingPayouts ? (
          <p style={{ color: '#94A3B8', padding: 20 }}>Loading payout requests...</p>
        ) : (
          <div style={st.tableWrap}>
            <table style={st.table}>
              <thead>
                <tr>
                  <th style={st.th}>Walker</th>
                  <th style={st.th}>Amount</th>
                  <th style={st.th}>Status</th>
                  <th style={st.th}>Note</th>
                  <th style={st.th}>Requested</th>
                  <th style={st.th}>Processed</th>
                  <th style={st.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredPayouts.map((pr) => (
                  <tr key={pr.id}>
                    <td style={st.td}>
                      <div style={{ fontWeight: 600 }}>{pr.walker?.full_name || profileNameById.get(pr.walker_id) || '-'}</div>
                      <div style={st.muted}>{pr.walker?.email || ''}</div>
                    </td>
                    <td style={st.td}>
                      <strong>{fmtILS(pr.amount)}</strong>
                    </td>
                    <td style={st.td}>
                      <span style={payoutBadge(pr.status)}>{pr.status}</span>
                    </td>
                    <td style={st.td}>{pr.note || '-'}</td>
                    <td style={st.td}>
                      <div>{fmtDate(pr.created_at)}</div>
                      <div style={st.muted}>{fmtTime(pr.created_at)}</div>
                    </td>
                    <td style={st.td}>
                      {pr.processed_at ? (
                        <>
                          <div>{fmtDate(pr.processed_at)}</div>
                          <div style={st.muted}>{fmtTime(pr.processed_at)}</div>
                        </>
                      ) : '-'}
                    </td>
                    <td style={st.td}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {pr.status === 'pending' && (
                          <>
                            <button style={st.btnSuccess} onClick={() => handlePayoutStatusChange(pr.id, 'approved')}>Approve</button>
                            <button style={st.btnDanger} onClick={() => handlePayoutStatusChange(pr.id, 'rejected')}>Reject</button>
                          </>
                        )}
                        {pr.status === 'approved' && (
                          <button style={st.btnSuccess} onClick={() => handlePayoutStatusChange(pr.id, 'paid')}>Mark Paid</button>
                        )}
                        {(pr.status === 'paid' || pr.status === 'rejected') && (
                          <span style={{ color: '#94A3B8', fontSize: 13 }}>-</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {!filteredPayouts.length && (
                  <tr>
                    <td style={{ ...st.td, textAlign: 'center', color: '#94A3B8', padding: 32 }} colSpan={7}>
                      No payout requests match the current filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Stripe Transfers ──────────────────────────────── */}
      <section style={st.section}>
        <div style={st.sectionHeader}>
          <div>
            <h2 style={st.sectionTitle}>Stripe Transfers</h2>
            <p style={st.hint}>
              Transfers from platform to walker Stripe accounts.
              Transferred: {fmtILS(transferStats.totalTransferred)} |
              In transit: {fmtILS(transferStats.inTransit)} |
              Paid out: {fmtILS(transferStats.totalPaidOut)} |
              Failed: {fmtILS(transferStats.totalFailed)}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {transferStats.stuckProcessing > 0 && (
              <button
                style={{ ...st.btnDanger, opacity: actionLoading === 'recover' ? 0.6 : 1 }}
                disabled={actionLoading === 'recover'}
                onClick={handleRecoverStuck}
              >
                {actionLoading === 'recover' ? 'Recovering...' : `Recover Stuck (${transferStats.stuckProcessing})`}
              </button>
            )}
            <button style={st.btnOutline} onClick={fetchWalkerPayouts}>Refresh</button>
          </div>
        </div>

        {loadingTransfers ? (
          <p style={{ color: '#94A3B8', padding: 20 }}>Loading transfers...</p>
        ) : walkerPayouts.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#94A3B8', padding: 32, fontSize: 14 }}>
            No transfers yet. Transfers are created when payments are captured.
          </div>
        ) : (
          <div style={st.tableWrap}>
            <table style={st.table}>
              <thead>
                <tr>
                  <th style={st.th}>Walker</th>
                  <th style={st.th}>Job</th>
                  <th style={st.th}>Gross</th>
                  <th style={st.th}>Fee</th>
                  <th style={st.th}>Net</th>
                  <th style={st.th}>Status</th>
                  <th style={st.th}>Transfer ID</th>
                  <th style={st.th}>Created</th>
                  <th style={st.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {walkerPayouts.map((wp) => (
                  <tr key={wp.id}>
                    <td style={st.td}>
                      <div style={{ fontWeight: 600 }}>{wp.walker?.full_name || profileNameById.get(wp.walker_id) || '-'}</div>
                      <div style={st.muted}>{wp.walker?.email || ''}</div>
                    </td>
                    <td style={st.td}>
                      <span style={{ fontSize: 11, color: '#64748B', wordBreak: 'break-all' }}>{wp.job_id.slice(0, 8)}...</span>
                    </td>
                    <td style={st.td}>{fmtILS(wp.gross_amount)}</td>
                    <td style={st.td}><span style={{ color: '#64748B' }}>{fmtILS(wp.platform_fee)}</span></td>
                    <td style={st.td}><strong style={{ color: '#10B981' }}>{fmtILS(wp.net_amount)}</strong></td>
                    <td style={st.td}>
                      <span style={transferBadge(wp.status)}>{wp.status}</span>
                      {wp.failure_reason && (
                        <div style={{ fontSize: 10, color: '#DC2626', marginTop: 2 }}>{wp.failure_reason}</div>
                      )}
                      {wp.retry_count != null && wp.retry_count > 0 && (
                        <div style={{ fontSize: 10, color: '#64748B', marginTop: 1 }}>Retries: {wp.retry_count}/5</div>
                      )}
                    </td>
                    <td style={st.td}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontSize: 11, color: '#64748B', wordBreak: 'break-all' }}>
                          {wp.stripe_transfer_id || '-'}
                        </span>
                        {wp.stripe_payout_id && (
                          <span style={{ fontSize: 10, color: '#94A3B8', wordBreak: 'break-all' }}>
                            Payout: {wp.stripe_payout_id}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={st.td}>
                      <div>{fmtDate(wp.created_at)}</div>
                      <div style={st.muted}>{fmtTime(wp.created_at)}</div>
                    </td>
                    <td style={st.td}>
                      {wp.status === 'failed' && (
                        <button
                          style={{ ...st.btnSmOutline, opacity: actionLoading === wp.job_id ? 0.6 : 1 }}
                          disabled={actionLoading === wp.job_id}
                          onClick={() => handleRetryTransfer(wp.job_id)}
                        >
                          {actionLoading === wp.job_id ? 'Retrying...' : 'Retry'}
                        </button>
                      )}
                      {wp.status !== 'failed' && (
                        <span style={{ color: '#94A3B8', fontSize: 12 }}>-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Walker Ratings ──────────────────────────────────── */}
      {walkerRatingStats.size > 0 && (
        <section style={st.section}>
          <div style={st.sectionHeader}>
            <h2 style={st.sectionTitle}>Walker Ratings</h2>
          </div>
          <div style={st.tableWrap}>
            <table style={st.table}>
              <thead>
                <tr>
                  <th style={st.th}>Walker</th>
                  <th style={st.th}>Avg Rating</th>
                  <th style={st.th}>Reviews</th>
                  <th style={st.th}>Latest Review</th>
                </tr>
              </thead>
              <tbody>
                {Array.from(walkerRatingStats.entries())
                  .sort((a, b) => b[1].count - a[1].count)
                  .map(([walkerId, stats]) => {
                    const avg = Math.round((stats.sum / stats.count) * 10) / 10;
                    const walkerProfile = profiles.find((p) => p.id === walkerId);
                    const name = walkerProfile?.full_name || walkerProfile?.email || walkerId.slice(0, 8);
                    const latestReview = stats.latest?.review;
                    const snippet = latestReview
                      ? latestReview.length > 80 ? latestReview.slice(0, 80) + '...' : latestReview
                      : null;

                    return (
                      <tr key={walkerId}>
                        <td style={st.td}>
                          <span style={{ fontWeight: 600 }}>{name}</span>
                        </td>
                        <td style={st.td}>
                          <span style={{ color: '#F59E0B', marginRight: 4 }}>★</span>
                          <span style={{ fontWeight: 700 }}>{avg}</span>
                          <span style={{ color: '#94A3B8', marginLeft: 2 }}>/ 5</span>
                        </td>
                        <td style={st.td}>
                          <span style={{ fontWeight: 600 }}>{stats.count}</span>
                        </td>
                        <td style={{ ...st.td, maxWidth: 300, color: '#64748B', fontSize: 13 }}>
                          {snippet ? (
                            <span style={{ fontStyle: 'italic' }}>&ldquo;{snippet}&rdquo;</span>
                          ) : (
                            <span style={{ color: '#CBD5E1' }}>No written reviews</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Walker Wallets ──────────────────────────────────── */}
      <section style={st.section}>
        <div style={st.sectionHeader}>
          <h2 style={st.sectionTitle}>Walker Wallets</h2>
          <button style={st.btnOutline} onClick={fetchWallets}>Refresh</button>
        </div>

        {loadingWallets ? (
          <p style={{ color: '#94A3B8', padding: 20 }}>Loading wallets...</p>
        ) : wallets.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#94A3B8', padding: 32, fontSize: 14 }}>
            No wallet data yet. Wallets are created when walkers complete paid jobs.
          </div>
        ) : (
          <div style={st.tableWrap}>
            <table style={st.table}>
              <thead>
                <tr>
                  <th style={st.th}>Walker</th>
                  <th style={st.th}>Available Balance</th>
                  <th style={st.th}>Pending Balance</th>
                  <th style={st.th}>Total Earned</th>
                  <th style={st.th}>Last Updated</th>
                </tr>
              </thead>
              <tbody>
                {wallets.map((w) => (
                  <tr key={w.walker_id}>
                    <td style={st.td}>
                      <div style={{ fontWeight: 600 }}>{w.walker?.full_name || profileNameById.get(w.walker_id) || '-'}</div>
                      <div style={st.muted}>{w.walker?.email || ''}</div>
                    </td>
                    <td style={st.td}>
                      <strong style={{ color: '#10B981' }}>{fmtILS(w.available_balance)}</strong>
                    </td>
                    <td style={st.td}>
                      <span style={{ color: '#F59E0B' }}>{fmtILS(w.pending_balance)}</span>
                    </td>
                    <td style={st.td}>
                      <strong>{fmtILS(w.total_earned)}</strong>
                    </td>
                    <td style={st.td}>
                      <div>{fmtDate(w.updated_at)}</div>
                      <div style={st.muted}>{fmtTime(w.updated_at)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Users ───────────────────────────────────────────── */}
      <section style={st.section}>
        <div style={st.sectionHeader}>
          <h2 style={st.sectionTitle}>Users</h2>
          <button style={st.btnOutline} onClick={fetchProfiles}>Refresh</button>
        </div>

        {loadingProfiles ? (
          <p style={{ color: '#94A3B8', padding: 20 }}>Loading users...</p>
        ) : (
          <div style={st.tableWrap}>
            <table style={st.table}>
              <thead>
                <tr>
                  <th style={st.th}>Name</th>
                  <th style={st.th}>Email</th>
                  <th style={st.th}>Role</th>
                  <th style={st.th}>Stripe Connect</th>
                  <th style={st.th}>Created</th>
                  <th style={st.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile) => (
                  <tr key={profile.id}>
                    <td style={st.td}>{profile.full_name || '-'}</td>
                    <td style={st.td}>{profile.email || '-'}</td>
                    <td style={st.td}>
                      <select
                        style={st.selectSm}
                        value={profile.role || 'client'}
                        onChange={(e) => handleRoleChange(profile.id, e.target.value)}
                      >
                        <option value="admin">admin</option>
                        <option value="walker">walker</option>
                        <option value="client">client</option>
                      </select>
                    </td>
                    <td style={st.td}>
                      {profile.role === 'walker' ? (
                        <div style={{ display: 'grid', gap: 6 }}>
                          <ConnectStatusCell profile={profile} />
                          <button
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '3px 10px',
                              borderRadius: 999,
                              border: 'none',
                              fontSize: 11,
                              fontWeight: 700,
                              cursor: 'pointer',
                              background: profile.live_payouts_enabled ? '#DCFCE7' : '#F1F5F9',
                              color: profile.live_payouts_enabled ? '#166534' : '#94A3B8',
                            }}
                            onClick={() => handleToggleLivePayouts(profile.id, profile.live_payouts_enabled)}
                          >
                            {profile.live_payouts_enabled ? 'Live payouts ON' : 'Live payouts OFF'}
                          </button>
                        </div>
                      ) : (
                        <span style={{ color: '#94A3B8', fontSize: 13 }}>-</span>
                      )}
                    </td>
                    <td style={st.td}>
                      {profile.created_at ? (
                        <>
                          <div>{fmtDate(profile.created_at)}</div>
                          <div style={st.muted}>{fmtTime(profile.created_at)}</div>
                        </>
                      ) : '-'}
                    </td>
                    <td style={st.td}>
                      <button
                        style={st.btnDanger}
                        onClick={() => handleDeleteProfile(profile.id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
                {!profiles.length && (
                  <tr>
                    <td style={{ ...st.td, textAlign: 'center', color: '#94A3B8', padding: 32 }} colSpan={6}>
                      No users found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/* ── Helper Components ───────────────────────────────────────── */

function KpiCard({ label, value, color, large, today, hint }: {
  label: string;
  value: string | number;
  color: string;
  large?: boolean;
  today?: boolean;
  hint?: string;
}) {
  return (
    <div style={{
      flex: 1,
      minWidth: large ? 180 : 120,
      padding: large ? '20px 24px' : '16px 20px',
      borderRadius: 16,
      background: today ? '#F0F4FF' : '#FFFFFF',
      border: today ? '1px solid #C7D2FE' : '1px solid #E2E8F0',
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      position: 'relative' as const,
    }}>
      {today && (
        <div style={{
          position: 'absolute',
          top: 8,
          right: 12,
          fontSize: 10,
          fontWeight: 700,
          color: '#6366F1',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}>
          Today
        </div>
      )}
      <div style={{
        fontSize: large ? 28 : 24,
        fontWeight: 800,
        color,
        lineHeight: 1.2,
      }}>
        {value}
      </div>
      <div style={{
        marginTop: 6,
        fontSize: 13,
        fontWeight: 500,
        color: '#64748B',
      }}>
        {label}
      </div>
      {hint && (
        <div style={{
          marginTop: 4,
          fontSize: 11,
          color: '#94A3B8',
          lineHeight: 1.3,
        }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function ConnectStatusCell({ profile }: { profile: Profile }) {
  if (!profile.stripe_connect_account_id) {
    return <span style={connectBadge('none')}>Not connected</span>;
  }

  if (!profile.stripe_connect_onboarding_complete) {
    return (
      <div style={{ display: 'grid', gap: 4 }}>
        <span style={connectBadge('incomplete')}>Onboarding incomplete</span>
        <span style={{ fontSize: 11, color: '#94A3B8' }}>
          {profile.stripe_connect_account_id.slice(0, 16)}...
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <span style={connectBadge('complete')}>Onboarded</span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
        <span style={connectMiniDot(profile.payouts_enabled)}>
          {profile.payouts_enabled ? 'Payouts' : 'No payouts'}
        </span>
        <span style={connectMiniDot(profile.charges_enabled)}>
          {profile.charges_enabled ? 'Charges' : 'No charges'}
        </span>
      </div>
      <span style={{ fontSize: 11, color: '#94A3B8' }}>
        {profile.stripe_connect_account_id.slice(0, 16)}...
      </span>
    </div>
  );
}

/* ── Badge helpers ────────────────────────────────────────────── */

function connectBadge(state: 'none' | 'incomplete' | 'complete'): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-block',
    padding: '3px 10px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 700,
  };
  if (state === 'none') return { ...base, background: '#F1F5F9', color: '#94A3B8' };
  if (state === 'incomplete') return { ...base, background: '#FEF3C7', color: '#92400E' };
  return { ...base, background: '#DCFCE7', color: '#166534' };
}

function connectMiniDot(enabled: boolean): React.CSSProperties {
  return {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 999,
    fontSize: 10,
    fontWeight: 600,
    background: enabled ? '#DCFCE7' : '#FEF2F2',
    color: enabled ? '#166534' : '#991B1B',
  };
}

function statusBadge(status: string): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-block',
    padding: '4px 10px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    whiteSpace: 'nowrap',
  };
  if (status === 'awaiting_payment') return { ...base, background: '#FFF7ED', color: '#C2410C' };
  if (status === 'open') return { ...base, background: '#E0F2FE', color: '#075985' };
  if (status === 'accepted') return { ...base, background: '#FEF3C7', color: '#92400E' };
  if (status === 'completed') return { ...base, background: '#DCFCE7', color: '#166534' };
  if (status === 'cancelled') return { ...base, background: '#FEE2E2', color: '#991B1B' };
  return base;
}

function paymentBadge(status: string): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-block',
    padding: '4px 10px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    whiteSpace: 'nowrap',
  };
  if (status === 'unpaid') return { ...base, background: '#F1F5F9', color: '#64748B' };
  if (status === 'authorized') return { ...base, background: '#EDE9FE', color: '#6D28D9' };
  if (status === 'paid') return { ...base, background: '#DCFCE7', color: '#166534' };
  if (status === 'failed') return { ...base, background: '#FEE2E2', color: '#991B1B' };
  if (status === 'refunded') return { ...base, background: '#FEF3C7', color: '#92400E' };
  return base;
}

function payoutBadge(status: string): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-block',
    padding: '4px 10px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    whiteSpace: 'nowrap',
  };
  if (status === 'pending') return { ...base, background: '#FEF3C7', color: '#92400E' };
  if (status === 'approved') return { ...base, background: '#E0F2FE', color: '#075985' };
  if (status === 'paid') return { ...base, background: '#DCFCE7', color: '#166534' };
  if (status === 'rejected') return { ...base, background: '#FEE2E2', color: '#991B1B' };
  return base;
}

function transferBadge(status: string): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-block',
    padding: '4px 10px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    whiteSpace: 'nowrap',
  };
  if (status === 'pending') return { ...base, background: '#FEF3C7', color: '#92400E' };
  if (status === 'processing') return { ...base, background: '#FFF7ED', color: '#C2410C' };
  if (status === 'transferred') return { ...base, background: '#E0F2FE', color: '#075985' };
  if (status === 'in_transit') return { ...base, background: '#EDE9FE', color: '#6D28D9' };
  if (status === 'paid_out') return { ...base, background: '#DCFCE7', color: '#166534' };
  if (status === 'failed') return { ...base, background: '#FEE2E2', color: '#991B1B' };
  if (status === 'reversed') return { ...base, background: '#FEE2E2', color: '#991B1B' };
  if (status === 'refunded') return { ...base, background: '#FEF2F2', color: '#991B1B' };
  return base;
}

/* ── Styles ───────────────────────────────────────────────────── */

const st: Record<string, React.CSSProperties> = {
  page: {
    padding: '24px 32px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    background: '#F8FAFC',
    minHeight: '100svh',
  },
  topBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 28,
  },
  title: {
    margin: 0,
    fontSize: 26,
    fontWeight: 800,
    color: '#0F172A',
  },
  subtitle: {
    margin: '4px 0 0',
    fontSize: 14,
    color: '#64748B',
    fontWeight: 400,
  },
  kpiSection: {
    marginBottom: 28,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  kpiRow: {
    display: 'flex',
    gap: 12,
    flexWrap: 'wrap',
  },
  section: {
    marginBottom: 28,
    padding: 24,
    borderRadius: 20,
    background: '#FFFFFF',
    border: '1px solid #E2E8F0',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  sectionTitle: {
    margin: 0,
    fontSize: 18,
    fontWeight: 700,
    color: '#0F172A',
  },
  hint: {
    margin: '4px 0 0',
    fontSize: 12,
    color: '#94A3B8',
    fontWeight: 400,
  },
  filtersRow: {
    display: 'flex',
    gap: 10,
    marginBottom: 16,
    flexWrap: 'wrap',
  },
  tableWrap: {
    overflowX: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
  },
  th: {
    textAlign: 'left',
    padding: '10px 14px',
    borderBottom: '2px solid #E2E8F0',
    fontSize: 12,
    fontWeight: 700,
    color: '#64748B',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '12px 14px',
    borderBottom: '1px solid #F1F5F9',
    verticalAlign: 'top',
    fontSize: 14,
  },
  muted: {
    fontSize: 12,
    color: '#94A3B8',
    marginTop: 2,
  },
  detailLabel: {
    display: 'block',
    fontSize: 11,
    fontWeight: 700,
    color: '#94A3B8',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    marginBottom: 4,
  },
  input: {
    padding: '10px 14px',
    borderRadius: 12,
    border: '1px solid #E2E8F0',
    fontSize: 14,
    outline: 'none',
    background: '#FFFFFF',
  },
  select: {
    padding: '10px 14px',
    borderRadius: 12,
    border: '1px solid #E2E8F0',
    fontSize: 14,
    outline: 'none',
    background: '#FFFFFF',
    flex: 1,
    minWidth: 130,
  },
  selectSm: {
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid #E2E8F0',
    fontSize: 13,
    outline: 'none',
    background: '#FFFFFF',
  },
  btnOutline: {
    padding: '8px 16px',
    borderRadius: 10,
    border: '1px solid #E2E8F0',
    background: '#FFFFFF',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    color: '#0F172A',
  },
  btnSmOutline: {
    padding: '5px 10px',
    borderRadius: 8,
    border: '1px solid #E2E8F0',
    background: '#FFFFFF',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    color: '#0F172A',
  },
  btnDanger: {
    padding: '6px 12px',
    borderRadius: 8,
    border: 'none',
    background: '#FEE2E2',
    color: '#DC2626',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
  },
  btnSuccess: {
    padding: '6px 12px',
    borderRadius: 8,
    border: 'none',
    background: '#DCFCE7',
    color: '#166534',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
  },
  error: {
    marginBottom: 16,
    padding: 14,
    borderRadius: 14,
    background: '#FEE2E2',
    color: '#991B1B',
    fontSize: 14,
  },
};
