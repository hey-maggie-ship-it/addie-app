-- ──────────────────────────────────────────────────────────
-- Server-side safety net for user_data. Run this ONCE:
-- Supabase Dashboard → SQL Editor → New query → paste this → Run.
--
-- Every time a user's row changes, we stash the PREVIOUS version here first. This
-- gives point-in-time recovery on ANY plan (including free, which has no PITR): if a
-- bad write ever empties a board again, the prior snapshot is one query away. The
-- client guards should stop that from happening, but this makes it non-catastrophic
-- if it ever slips through anyway.
-- ──────────────────────────────────────────────────────────

create table if not exists public.user_data_history (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  tasks      jsonb,
  grocery    jsonb,
  profile    jsonb,
  messages   jsonb,
  sessions   jsonb,
  reminders  jsonb,
  memory     jsonb,
  notes      text,
  row_at     timestamptz,               -- the updated_at of the version being archived
  saved_at   timestamptz not null default now()  -- when we archived it
);

create index if not exists user_data_history_user_saved_idx
  on public.user_data_history (user_id, saved_at desc);

-- Lock it down: same RLS shape as user_data — a user may only read their OWN history.
-- Writes happen only through the SECURITY DEFINER trigger below, never from the client.
alter table public.user_data_history enable row level security;
drop policy if exists "Users read their own history" on public.user_data_history;
create policy "Users read their own history"
  on public.user_data_history
  for select
  using (auth.uid() = user_id);

-- BEFORE UPDATE: archive the OLD row, then prune this user's history to a rolling
-- 30-day window so the table can't grow without bound. Runs as definer so it can
-- insert regardless of the caller's RLS.
create or replace function public.archive_user_data()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_data_history
    (user_id, tasks, grocery, profile, messages, sessions, reminders, memory, notes, row_at)
  values
    (old.user_id, old.tasks, old.grocery, old.profile, old.messages, old.sessions,
     old.reminders, old.memory, old.notes, old.updated_at);

  delete from public.user_data_history
   where user_id = old.user_id
     and saved_at < now() - interval '30 days';

  return new;
end;
$$;

drop trigger if exists trg_archive_user_data on public.user_data;
create trigger trg_archive_user_data
  before update on public.user_data
  for each row
  execute function public.archive_user_data();

-- ── Recovery cheatsheet ──
-- See a user's recent snapshots (most recent first):
--   select id, saved_at, row_at,
--          jsonb_array_length(tasks) as n_tasks,
--          jsonb_array_length(reminders) as n_reminders
--   from public.user_data_history
--   where user_id = '<uuid>'
--   order by saved_at desc;
--
-- Restore a specific snapshot back into the live row:
--   update public.user_data u
--      set tasks = h.tasks, grocery = h.grocery, profile = h.profile,
--          messages = h.messages, sessions = h.sessions, reminders = h.reminders,
--          memory = h.memory, notes = h.notes, updated_at = now()
--     from public.user_data_history h
--    where h.id = <history_id> and u.user_id = h.user_id;
