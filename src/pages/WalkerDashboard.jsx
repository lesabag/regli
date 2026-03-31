import { useEffect, useState } from 'react';
import { supabase } from '../services/supabaseClient';

export default function WalkerDashboard() {
  const [openJobs, setOpenJobs] = useState<any[]>([]);
  const [myJobs, setMyJobs] = useState<any[]>([]);

  useEffect(() => {
    fetchAll();
  }, []);

  async function fetchAll() {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { data: open } = await supabase
      .from('walk_requests')
      .select(`*, client:profiles!walk_requests_client_id_fkey(*)`)
      .eq('status', 'open');

    const { data: mine } = await supabase
      .from('walk_requests')
      .select(`*, client:profiles!walk_requests_client_id_fkey(*)`)
      .eq('walker_id', user?.id);

    setOpenJobs(open || []);
    setMyJobs(mine || []);
  }

  async function accept(id: string) {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    await supabase
      .from('walk_requests')
      .update({ status: 'accepted', walker_id: user?.id })
      .eq('id', id);

    fetchAll();
  }

  async function complete(id: string) {
    await supabase
      .from('walk_requests')
      .update({ status: 'completed' })
      .eq('id', id);

    fetchAll();
  }

  async function release(id: string) {
    await supabase
      .from('walk_requests')
      .update({ status: 'open', walker_id: null })
      .eq('id', id);

    fetchAll();
  }

  return (
    <div style={{ padding: 24 }}>
      <h1>Walker Dashboard</h1>

      <h2>Open Jobs</h2>
      {openJobs.map(j => (
        <div key={j.id}>
          #{j.id} - {j.address}
          <button onClick={() => accept(j.id)}>Accept</button>
        </div>
      ))}

      <h2>My Jobs</h2>
      {myJobs.map(j => (
        <div key={j.id}>
          #{j.id} - {j.status}
          <button onClick={() => complete(j.id)}>Complete</button>
          <button onClick={() => release(j.id)}>Release</button>
        </div>
      ))}
    </div>
  );
}
