-- ──────────────────────────────────────────────────────────
-- Enable Supabase Realtime for live cross-device sync.
-- Run this ONCE: SQL Editor → New query → Run.
--
-- This adds the user_data table to the realtime publication so changes are
-- pushed to every signed-in device instantly. Row-Level Security still applies,
-- so each user only ever receives their OWN row's changes.
-- ──────────────────────────────────────────────────────────

alter publication supabase_realtime add table public.user_data;
