interface Job {
  id: string
  title: string
  subtitle: string
  status: string
  statusColor: string
  date: string
}

interface CompactJobListProps {
  jobs: Job[]
  limit?: number
  onViewAll?: () => void
  emptyText?: string
}

export default function CompactJobList({
  jobs,
  limit = 2,
  onViewAll,
  emptyText = 'No recent activity',
}: CompactJobListProps) {
  const visible = jobs.slice(0, limit)

  if (visible.length === 0) {
    return (
      <div style={emptyStyle}>
        <p style={{ margin: 0, fontSize: 14, color: '#94A3B8' }}>{emptyText}</p>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'grid', gap: 8 }}>
        {visible.map((job) => (
          <div key={job.id} style={itemStyle}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: '#0F172A' }}>{job.title}</span>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '2px 7px',
                    borderRadius: 6,
                    background: job.statusColor + '18',
                    color: job.statusColor,
                  }}
                >
                  {job.status}
                </span>
              </div>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: '#94A3B8' }}>{job.subtitle}</p>
            </div>
            <span style={{ fontSize: 12, color: '#CBD5E1', whiteSpace: 'nowrap' }}>{job.date}</span>
          </div>
        ))}
      </div>
      {jobs.length > limit && onViewAll && (
        <button onClick={onViewAll} style={viewAllStyle}>
          View all ({jobs.length})
        </button>
      )}
    </div>
  )
}

const itemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '12px 14px',
  background: '#F8FAFC',
  borderRadius: 14,
}

const emptyStyle: React.CSSProperties = {
  padding: 20,
  textAlign: 'center',
  background: '#FAFBFC',
  borderRadius: 14,
  border: '1px dashed #E2E8F0',
}

const viewAllStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 8,
  padding: '10px 0',
  background: 'none',
  border: 'none',
  color: '#3B82F6',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  textAlign: 'center',
}
