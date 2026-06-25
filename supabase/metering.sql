-- ──────────────────────────────────────────────────────────
-- Ankora usage metering + per-user daily rate limiting.
-- Run this ONCE in your Supabase project: SQL Editor → New query → Run.
--
-- Counts each user's messages per day in a table they CANNOT touch directly
-- (RLS on, no policies). All access goes through record_message(), a
-- SECURITY DEFINER function that bypasses RLS but only ever *increments* —
-- so a user can't reset or lower their own count from the browser.
-- ──────────────────────────────────────────────────────────

create table if not exists public.message_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null default current_date,
  count   int  not null default 0,
  primary key (user_id, day)
);

-- Lock the table: with RLS on and NO policies, clients can't read or write it.
-- Only the SECURITY DEFINER function below (which runs as the owner) can.
alter table public.message_usage enable row level security;

-- Atomically check-and-record one message for the current user/day.
-- Returns JSON: { allowed, count, limit }.
create or replace function public.record_message(daily_limit int default 25)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  uid   uuid := auth.uid();
  today date := current_date;
  cur   int;
begin
  if uid is null then
    return json_build_object('allowed', false, 'reason', 'not_authenticated');
  end if;

  select count into cur from public.message_usage where user_id = uid and day = today;
  if cur is null then cur := 0; end if;

  -- Already at/over the cap → reject without incrementing further.
  if cur >= daily_limit then
    return json_build_object('allowed', false, 'reason', 'limit_reached', 'count', cur, 'limit', daily_limit);
  end if;

  insert into public.message_usage (user_id, day, count)
       values (uid, today, 1)
  on conflict (user_id, day)
       do update set count = message_usage.count + 1
    returning count into cur;

  return json_build_object('allowed', true, 'count', cur, 'limit', daily_limit);
end;
$$;

-- Only signed-in users may call it; nobody can call it anonymously.
revoke all on function public.record_message(int) from public;
grant execute on function public.record_message(int) to authenticated;
