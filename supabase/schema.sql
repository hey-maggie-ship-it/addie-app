-- ──────────────────────────────────────────────────────────
-- Addie database schema. Run this ONCE in your Supabase project:
-- Supabase Dashboard → SQL Editor → New query → paste this → Run.
--
-- One row per user holds their task board, grocery list, and profile.
-- Row-Level Security guarantees each user can only read/write their own row.
-- ──────────────────────────────────────────────────────────

create table if not exists public.user_data (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  tasks      jsonb not null default '[]'::jsonb,
  grocery    jsonb not null default '[]'::jsonb,
  profile    jsonb,
  updated_at timestamptz not null default now()
);

-- Lock the table down so it is NOT publicly readable.
alter table public.user_data enable row level security;

-- A single policy covering select / insert / update / delete:
-- a user may only touch the row whose user_id matches their auth id.
drop policy if exists "Users manage their own data" on public.user_data;
create policy "Users manage their own data"
  on public.user_data
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
