import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../services/supabaseClient'

type AppRole = 'client' | 'walker' | 'admin'

interface HomeScreenProps {
  profile: {
    id: string
    email: string | null
    full_name: string | null
    role: AppRole
  }
  onSignOut: () => Promise<void>
}

interface WalkRequestRow {
  id: string
  client_id: string
  walker_id: string | null
  status: 'open' | 'accepted' | 'completed'
  dog_name: string | null
  location: string | null
  created_at: string | null
}

interface ProfileRow {
  id: string
  email: string | null
  full_name: string | null
  role: AppRole
}

export default function HomeScreen({
  profile,
  onSignOut,
}: HomeScreenProps) {
  const [dogName, setDogName] = useState('')
  const [location, setLocation] = useState('')
  const [loading, setLoading] = useState(false)
  const [jobsLoading, setJobsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [requests, setRequests] = useState<WalkRequestRow[]>([])
  const [profiles, setProfiles] = useState<ProfileRow[]>([])

  const clientName = profile.full_name || profile.email || 'Client'

  const walkerNameById = useMemo(() => {
    const map = new Map<string, string>()

    profiles.forEach((item) => {
      map.set(item.id, item.full_name || item.email || 'Unknown walker')
    })

    return map
  }, [profiles])

  const loadProfiles = async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, role')

    if (error) {
      setError(error.message)
      return
    }

    setProfiles((data as ProfileRow[]) || [])
  }

  const loadMyRequests = async () => {
    setJobsLoading(true)

    const { data, error } = await supabase
      .from('walk_requests')
      .select('id, client_id, walker_id, status, dog_name, location, created_at')
      .eq('client_id', profile.id)
      .order('created_at', { ascending: false })

    if (error) {
      setError(error.message)
      setRequests([])
      setJobsLoading(false)
      return
    }

    setRequests((data as WalkRequestRow[]) || [])
    setJobsLoading(false)
  }

  useEffect(() => {
    loadProfiles()
    loadMyRequests()

    const requestsChannel = supabase
      .channel(`client-walk-requests-${profile.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'walk_requests',
          filter: `client_id=eq.${profile.id}`,
        },
        async () => {
          await loadProfiles()
          await loadMyRequests()
        }
      )
      .subscribe()

    const profilesChannel = supabase
      .channel(`client-profiles-${profile.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'profiles',
        },
        () => {
          loadProfiles()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(requestsChannel)
      supabase.removeChannel(profilesChannel)
    }
  }, [profile.id])

  const handleCreateRequest = async () => {
    setError(null)
    setSuccessMessage(null)

    if (!dogName.trim() || !location.trim()) {
      setError('Please fill dog name and location.')
      return
    }

    setLoading(true)

    const { error } = await supabase.from('walk_requests').insert({
      client_id: profile.id,
      dog_name: dogName.trim(),
      location: location.trim(),
      status: 'open',
    })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    setDogName('')
    setLocation('')
    setSuccessMessage('Walk request created successfully.')
    setLoading(false)

    await loadProfiles()
    await loadMyRequests()
  }

  return (
    <div
      style={{
        minHeight: '100svh',
        background: '#F3F6FB',
        padding: '32px 20px',
        fontFamily: 'Inter, system-ui, sans-serif',
        color: '#001A33',
      }}
    >
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div
          style={{
            background: '#001A33',
            color: '#FFFFFF',
            borderRadius: 28,
            padding: 28,
            boxShadow: '0 18px 40px rgba(0, 26, 51, 0.16)',
            display: 'flex',
            justifyContent: 'space-between',
            gap: 16,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div style={{ fontSize: 14, opacity: 0.8, marginBottom: 10 }}>
              Regli Client Portal
            </div>
            <h1 style={{ margin: 0, fontSize: 32 }}>
              Welcome, {clientName}
            </h1>
            <p style={{ margin: '10px 0 0', opacity: 0.9 }}>
              Create a walk request and track your dog walks.
            </p>
          </div>

          <button
            type="button"
            onClick={onSignOut}
            style={logoutButtonStyle}
          >
            Logout
          </button>
        </div>

        {error && <MessageBox text={error} kind="error" />}
        {successMessage && <MessageBox text={successMessage} kind="success" />}

        <div
          style={{
            marginTop: 24,
            display: 'grid',
            gridTemplateColumns: '0.95fr 1.05fr',
            gap: 20,
          }}
        >
          <div style={cardStyle}>
            <h2 style={sectionTitleStyle}>Create Walk Request</h2>

            <div style={{ display: 'grid', gap: 14 }}>
              <div>
                <label style={labelStyle}>Dog name</label>
                <input
                  value={dogName}
                  onChange={(e) => setDogName(e.target.value)}
                  placeholder="e.g. Rocky"
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={labelStyle}>Location</label>
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. Tel Aviv, Dizengoff 20"
                  style={inputStyle}
                />
              </div>

              <button
                type="button"
                onClick={handleCreateRequest}
                disabled={loading}
                style={{
                  ...primaryButtonStyle,
                  opacity: loading ? 0.7 : 1,
                  cursor: loading ? 'not-allowed' : 'pointer',
                }}
              >
                {loading ? 'Creating...' : 'Create request'}
              </button>
            </div>
          </div>

          <div style={cardStyle}>
            <h2 style={sectionTitleStyle}>My Requests</h2>

            {jobsLoading ? (
              <div style={mutedTextStyle}>Loading requests...</div>
            ) : requests.length === 0 ? (
              <div style={mutedTextStyle}>No walk requests yet.</div>
            ) : (
              <div style={{ display: 'grid', gap: 14 }}>
                {requests.map((request) => (
                  <div key={request.id} style={listCardStyle}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 12,
                        alignItems: 'flex-start',
                        flexWrap: 'wrap',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 18, fontWeight: 800 }}>
                          {request.dog_name || 'Unnamed dog'}
                        </div>
                        <div style={{ fontSize: 14, color: '#64748B', marginTop: 6 }}>
                          {request.location || '-'}
                        </div>
                      </div>

                      <StatusBadge status={request.status} />
                    </div>

                    <div
                      style={{
                        marginTop: 12,
                        fontSize: 13,
                        color: '#64748B',
                        display: 'grid',
                        gap: 6,
                      }}
                    >
                      <div>Created: {formatDate(request.created_at)}</div>
                      <div>
                        Walker:{' '}
                        {request.walker_id
                          ? walkerNameById.get(request.walker_id) || 'Unknown walker'
                          : 'Not assigned yet'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function MessageBox({
  text,
  kind,
}: {
  text: string
  kind: 'error' | 'success'
}) {
  const isError = kind === 'error'

  return (
    <div
      style={{
        marginTop: 20,
        borderRadius: 18,
        padding: 14,
        background: isError ? '#FEF2F2' : '#ECFDF3',
        color: isError ? '#B91C1C' : '#166534',
        border: `1px solid ${isError ? '#FECACA' : '#BBF7D0'}`,
      }}
    >
      {text}
    </div>
  )
}

function StatusBadge({
  status,
}: {
  status: 'open' | 'accepted' | 'completed'
}) {
  const styles = {
    open: { bg: '#DBEAFE', color: '#1D4ED8', text: 'Waiting for walker' },
    accepted: { bg: '#FEF3C7', color: '#92400E', text: 'In progress' },
    completed: { bg: '#DCFCE7', color: '#166534', text: 'Finished' },
  }[status]

  return (
    <span
      style={{
        borderRadius: 999,
        padding: '6px 10px',
        fontSize: 12,
        fontWeight: 800,
        background: styles.bg,
        color: styles.color,
      }}
    >
      {styles.text}
    </span>
  )
}

function formatDate(value: string | null) {
  if (!value) return '-'
  return new Date(value).toLocaleString()
}

const cardStyle: React.CSSProperties = {
  background: '#FFFFFF',
  borderRadius: 24,
  padding: 24,
  boxShadow: '0 10px 24px rgba(15, 23, 42, 0.06)',
  border: '1px solid #E8EEF5',
}

const listCardStyle: React.CSSProperties = {
  borderRadius: 18,
  padding: 16,
  background: '#F8FBFF',
  border: '1px solid #E6EEF8',
}

const sectionTitleStyle: React.CSSProperties = {
  margin: '0 0 18px',
  fontSize: 22,
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 8,
  fontWeight: 700,
  fontSize: 14,
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  border: '1px solid #D7E0EA',
  borderRadius: 14,
  padding: '12px 14px',
  fontSize: 14,
  outline: 'none',
  boxSizing: 'border-box',
}

const primaryButtonStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: 14,
  padding: '12px 16px',
  background: '#001A33',
  color: '#FFFFFF',
  fontWeight: 800,
}

const logoutButtonStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: 16,
  padding: '12px 18px',
  background: '#FFFFFF',
  color: '#001A33',
  fontWeight: 700,
  cursor: 'pointer',
}

const mutedTextStyle: React.CSSProperties = {
  color: '#64748B',
}
