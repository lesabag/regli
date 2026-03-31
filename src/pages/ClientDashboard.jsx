import { useEffect, useState } from 'react';
import { supabase } from '../services/supabaseClient';

export default function ClientDashboard() {
  const [jobs, setJobs] = useState<any[]>([]);
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [scheduled, setScheduled] = useState('');

  useEffect(() => {
    fetchJobs();
  }, []);

  async function fetchJobs() {
    const { data } = await supabase
      .from('walk_requests')
      .select(`
        *,
        walker:profiles!walk_requests_walker_id_fkey(*)
      `)
      .order('created_at', { ascending: false });

    setJobs(data || []);
  }

  async function createJob() {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    await supabase.from('walk_requests').insert([
      {
        client_id: user?.id,
        status: 'open',
        address,
        notes,
        scheduled_at: scheduled,
        duration_minutes: 30,
        price: 50,
      },
    ]);

    fetchJobs();
  }

  async function cancelJob(id: string) {
    await supabase
      .from('walk_requests')
      .update({ status: 'cancelled' })
      .eq('id', id);

    fetchJobs();
  }

  return (
    <div style={{ padding: 24 }}>
      <h1>Client Dashboard</h1>

      <input placeholder="Address" onChange={e => setAddress(e.target.value)} />
      <input placeholder="Datetime" onChange={e => setScheduled(e.target.value)} />
      <textarea placeholder="Notes" onChange={e => setNotes(e.target.value)} />
      <button onClick={createJob}>Create</button>

      {jobs.map(j => (
        <div key={j.id} style={{ border: '1px solid #ccc', marginTop: 10, padding: 10 }}>
          #{j.id} - {j.status}
          <div>{j.address}</div>
          <div>Walker: {j.walker?.full_name}</div>

          {(j.status === 'open' || j.status === 'accepted') && (
            <button onClick={() => cancelJob(j.id)}>Cancel</button>
          )}
        </div>
      ))}
    </div>
  );
}
