import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../services/supabaseClient'

import AdminAlerts from '../components/AdminAlerts'
import AdminSupplyDemand from '../components/AdminSupplyDemand'
import AdminStuckRequests from '../components/AdminStuckRequests'
import AdminKpiPanel from '../components/AdminKpiPanel'
import AdminPricing from '../components/AdminPricing'
import AdminRecentFailures from '../components/AdminRecentFailures'
import AdminRetention from '../components/AdminRetention'
import MatchingDebugV2 from '../components/MatchingDebugV2'
import AdminDispatchLive from '../components/AdminDispatchLive'

type Tab =
  | 'overview'
  | 'dispatch'
  | 'alerts'
  | 'matching'
  | 'supply'
  | 'pricing'
  | 'stuck'
  | 'failures'
  | 'retention'

type TimeRange = 'today' | 'week' | 'all'
type AdminAccessState = 'checking' | 'allowed' | 'denied'

export default function AdminDashboard() {
  const [tab, setTab] = useState<Tab>('overview')
  const [timeRange, setTimeRange] = useState<TimeRange>('today')
  const [loggingOut, setLoggingOut] = useState(false)

  const [accessState, setAccessState] = useState<AdminAccessState>('checking')
  const [authEmail, setAuthEmail] = useState<string | null>(null)
  const [accessError, setAccessError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function checkAdminAccess() {
      try {
        setAccessError(null)
        setAccessState('checking')

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser()

        if (userError || !user) {
          if (!cancelled) {
            setAccessState('denied')
            window.location.replace('/')
          }
          return
        }

        if (!cancelled) {
          setAuthEmail(user.email ?? null)
        }

        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('id, is_admin')
          .eq('id', user.id)
          .maybeSingle()

        if (profileError) {
          if (!cancelled) {
            setAccessError(profileError.message)
            setAccessState('denied')
          }
          return
        }

        if (!profile?.is_admin) {
          if (!cancelled) {
            setAccessState('denied')
            window.location.replace('/')
          }
          return
        }

        if (!cancelled) {
          setAccessState('allowed')
        }
      } catch (err) {
        if (!cancelled) {
          setAccessError(err instanceof Error ? err.message : 'Failed to verify admin access')
          setAccessState('denied')
        }
      }
    }

    void checkAdminAccess()

    return () => {
      cancelled = true
    }
  }, [])

  async function handleLogout() {
    try {
      setLoggingOut(true)
      const { error } = await supabase.auth.signOut()
      if (error) {
        console.error('[Admin] logout failed:', error)
        setLoggingOut(false)
        return
      }
      window.location.href = '/'
    } catch (err) {
      console.error('[Admin] logout failed:', err)
      setLoggingOut(false)
    }
  }

  const headerSubtitle = useMemo(() => {
    if (authEmail) return `Regli Operations · ${authEmail}`
    return 'Regli Operations'
  }, [authEmail])

  if (accessState === 'checking') {
    return (
      <div style={pageStyle}>
        <div style={centerCardStyle}>
          <div style={spinnerStyle} />
          <div style={checkingTitleStyle}>Checking admin access...</div>
          <div style={checkingSubtitleStyle}>Verifying your session and permissions</div>
        </div>
      </div>
    )
  }

  if (accessState === 'denied') {
    return (
      <div style={pageStyle}>
        <div style={centerCardStyle}>
          <div style={deniedIconStyle}>⛔</div>
          <div style={deniedTitleStyle}>Admin access denied</div>
          <div style={deniedSubtitleStyle}>
            {accessError || 'You do not have permission to open this page.'}
          </div>
          <button
            type="button"
            onClick={() => {
              window.location.href = '/'
            }}
            style={backBtnStyle}
          >
            Back home
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={screenStyle}>
      <div style={topBarStyle}>
        <div>
          <h1 style={titleStyle}>Admin Dashboard</h1>
          <div style={subtitleStyle}>{headerSubtitle}</div>
        </div>

        <button
          type="button"
          onClick={handleLogout}
          disabled={loggingOut}
          style={{
            ...logoutBtnStyle,
            opacity: loggingOut ? 0.7 : 1,
            cursor: loggingOut ? 'not-allowed' : 'pointer',
          }}
        >
          {loggingOut ? 'Logging out...' : 'Logout'}
        </button>
      </div>

      <div style={controlsRowStyle}>
        <div style={tabsRowStyle}>
          <TabButton label="Overview" active={tab === 'overview'} onClick={() => setTab('overview')} />
          <TabButton label="Dispatch" active={tab === 'dispatch'} onClick={() => setTab('dispatch')} />
          <TabButton label="Alerts" active={tab === 'alerts'} onClick={() => setTab('alerts')} />
          <TabButton label="Matching" active={tab === 'matching'} onClick={() => setTab('matching')} />
          <TabButton label="Supply" active={tab === 'supply'} onClick={() => setTab('supply')} />
          <TabButton label="Pricing" active={tab === 'pricing'} onClick={() => setTab('pricing')} />
          <TabButton label="Stuck" active={tab === 'stuck'} onClick={() => setTab('stuck')} />
          <TabButton label="Failures" active={tab === 'failures'} onClick={() => setTab('failures')} />
          <TabButton label="Retention" active={tab === 'retention'} onClick={() => setTab('retention')} />
        </div>

        <div style={rangeRowStyle}>
          <RangeButton label="Today" active={timeRange === 'today'} onClick={() => setTimeRange('today')} />
          <RangeButton label="Week" active={timeRange === 'week'} onClick={() => setTimeRange('week')} />
          <RangeButton label="All" active={timeRange === 'all'} onClick={() => setTimeRange('all')} />
        </div>
      </div>

      <div style={contentStyle}>
        {tab === 'overview' && (
          <>
            <AdminKpiPanel timeRange={timeRange} />
            <AdminAlerts />
          </>
        )}

        {tab === 'dispatch' && <AdminDispatchLive />}
        {tab === 'alerts' && <AdminAlerts />}
        {tab === 'matching' && <MatchingDebugV2 />}
        {tab === 'supply' && <AdminSupplyDemand timeRange={timeRange} />}
        {tab === 'pricing' && <AdminPricing />}
        {tab === 'stuck' && <AdminStuckRequests />}
        {tab === 'failures' && <AdminRecentFailures />}
        {tab === 'retention' && <AdminRetention timeRange={timeRange} />}
      </div>
    </div>
  )
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...tabBtnStyle,
        ...(active ? tabBtnActiveStyle : {}),
      }}
    >
      {label}
    </button>
  )
}

function RangeButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...rangeBtnStyle,
        ...(active ? rangeBtnActiveStyle : {}),
      }}
    >
      {label}
    </button>
  )
}

const screenStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: '100vh',
  background: '#F8FAFC',
}

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  background: '#F8FAFC',
  padding: 20,
  boxSizing: 'border-box',
}

const topBarStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 16,
  padding: '16px 20px',
  borderBottom: '1px solid #E2E8F0',
  background: '#FFFFFF',
}

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 28,
  fontWeight: 800,
  color: '#0F172A',
}

const subtitleStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 14,
  color: '#64748B',
}

const logoutBtnStyle: React.CSSProperties = {
  background: '#0F172A',
  color: '#FFFFFF',
  border: 'none',
  borderRadius: 10,
  padding: '10px 14px',
  fontSize: 14,
  fontWeight: 700,
}

const controlsRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
  padding: '16px 20px 12px',
}

const tabsRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
}

const tabBtnStyle: React.CSSProperties = {
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  borderRadius: 10,
  padding: '8px 14px',
  fontWeight: 700,
  cursor: 'pointer',
  color: '#334155',
}

const tabBtnActiveStyle: React.CSSProperties = {
  background: '#0F172A',
  color: '#FFFFFF',
  border: '1px solid #0F172A',
}

const rangeRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
}

const rangeBtnStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  cursor: 'pointer',
  color: '#334155',
  fontWeight: 600,
}

const rangeBtnActiveStyle: React.CSSProperties = {
  background: '#DBEAFE',
  color: '#1D4ED8',
  border: '1px solid #BFDBFE',
}

const contentStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '0 20px 20px',
  display: 'grid',
  gap: 16,
}

const centerCardStyle: React.CSSProperties = {
  maxWidth: 460,
  margin: '120px auto 0',
  background: '#FFFFFF',
  border: '1px solid #E2E8F0',
  borderRadius: 18,
  padding: '28px 24px',
  boxShadow: '0 8px 30px rgba(15, 23, 42, 0.06)',
  textAlign: 'center',
}

const spinnerStyle: React.CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: '50%',
  border: '3px solid #E2E8F0',
  borderTop: '3px solid #0F172A',
  margin: '0 auto 14px',
  animation: 'adminSpin 0.9s linear infinite',
}

const checkingTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: '#0F172A',
}

const checkingSubtitleStyle: React.CSSProperties = {
  fontSize: 14,
  color: '#64748B',
  marginTop: 8,
}

const deniedIconStyle: React.CSSProperties = {
  fontSize: 28,
  marginBottom: 10,
}

const deniedTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: '#0F172A',
}

const deniedSubtitleStyle: React.CSSProperties = {
  fontSize: 14,
  color: '#64748B',
  marginTop: 8,
  lineHeight: 1.5,
}

const backBtnStyle: React.CSSProperties = {
  marginTop: 18,
  border: 'none',
  borderRadius: 10,
  background: '#0F172A',
  color: '#FFFFFF',
  fontWeight: 700,
  padding: '10px 14px',
  cursor: 'pointer',
}
