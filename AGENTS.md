# AGENT.md

## Overview

Regli is a real-time on-demand services platform (Uber-style), powered by:
- React (Client + Walker apps)
- Supabase (Postgres, RLS, Edge Functions)
- Stripe (payments)

Core system:
- Smart Dispatch (ranking + retries)
- Real-time tracking
- Wallet & payouts

---

## ⚠️ Critical Rules

### 1. RLS – Never create recursion

❌ DO NOT:
```sql
EXISTS (SELECT 1 FROM public.profiles WHERE ...)
````

This causes:
ERROR: 42P17 infinite recursion detected

✅ DO:

* Use simple checks:

```sql
id = auth.uid()
```

* Or use helper function:

```sql
public.is_admin()
```

---

### 2. Migrations must be idempotent

Always write migrations as re-runnable:

```sql
CREATE TABLE IF NOT EXISTS ...
ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...
CREATE INDEX IF NOT EXISTS ...
DROP POLICY IF EXISTS ...; CREATE POLICY ...
```

For realtime:

```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND tablename = 'your_table'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE your_table;
  END IF;
END $$;
```

---

## 🧠 Smart Dispatch System

### Key Tables

* walk_requests
* dispatch_candidates
* dispatch_attempts
* dispatch_events

---

### Dispatch Flow

1. Client creates request → status = open
2. Candidates are generated (ranked)
3. Dispatcher creates attempt (top ranked)
4. Walker receives offer
5. If declined / timeout → next candidate
6. If none left → exhausted

---

### ⚠️ CRITICAL: Cursor Logic

❌ WRONG:

```sql
dc.rank > MAX(dispatch_attempts.attempt_no)
```

This breaks retries and restarts.

✅ CORRECT:

```sql
dc.rank > COALESCE(smart_dispatch_cursor, 0)
```

---

### Dispatch States

idle
dispatching
assigned
exhausted
cancelled

Client MUST handle all states.

---

## 📍 Required Schema Fields

### profiles

```sql
lat DOUBLE PRECISION
lng DOUBLE PRECISION
is_online BOOLEAN
role TEXT
```

---

### walk_requests

```sql
updated_at TIMESTAMPTZ
smart_dispatch_state TEXT
smart_dispatch_cursor INTEGER
smart_dispatch_last_error TEXT
```

---

### dispatch_attempts

```sql
accepted_by_walker_id UUID
accepted_at TIMESTAMPTZ
```

---

## 🔐 RLS Design Pattern

### profiles

```sql
USING (id = auth.uid())
```

### public walkers visibility

```sql
USING (role = 'walker')
```

### admin access

```sql
USING (public.is_admin())
```

---

## ⚙️ Backend Functions

Main functions:

* advance_dispatch_request(uuid)
* process_expired_dispatch_attempts(...)
* start-dispatch (Edge)
* run-scheduled-dispatch (cron)

---

## 🕒 Cron Jobs

Every minute:

* advance-dispatch → DB function
* run-scheduled-dispatch → Edge Function

---

## 🧪 Debugging Playbook

### Check request state

```sql
select id, status, smart_dispatch_state
from walk_requests
order by created_at desc
limit 5;
```

---

### Check candidates

```sql
select * from dispatch_candidates
where request_id = '...';
```

---

### Check attempts

```sql
select * from dispatch_attempts
where request_id = '...';
```

---

### Force dispatch manually

```sql
select * from advance_dispatch_request('REQUEST_ID');
```

---

## 🎯 UX Rules

### Exhausted state

When:

```sql
smart_dispatch_state = 'exhausted'
```

Client MUST show:

No walkers available right now
Try again

---

## 🚀 Development Rules

* Never break existing flow while fixing migrations
* Prefer DB fixes over UI hacks
* Keep Edge functions stateless
* Always test:

  * request
  * dispatch
  * accept
  * retry
  * exhausted

---

## 🧩 Philosophy

AGENT.md = "How not to break the system again"

Not:

* Debug logs
* Temporary fixes
* One-time scripts

```

---

