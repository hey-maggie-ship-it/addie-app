-- ──────────────────────────────────────────────────────────
-- Ankora engagement report: one row per user, most recently active first.
-- Read-only. Run any time: Supabase Dashboard → SQL Editor → paste → Run.
--
-- Sources: message_usage (chat messages/day), auth.users (signup, sign-ins),
-- user_data (last board sync, list sizes), subscriptions (plan).
--
-- CAVEAT: api/chat.js only calls record_message() for FREE users, so
-- message columns stop counting once someone subscribes. last_active
-- still works for subscribers via user_data.updated_at / last_sign_in_at.
-- ──────────────────────────────────────────────────────────

with msg as (
  select
    user_id,
    min(day)                                                as first_msg_day,
    max(day)                                                as last_msg_day,
    count(distinct day)                                     as active_days,
    sum(count)                                              as total_msgs,
    count(distinct day) filter (where day >= current_date - 6)  as days_active_7d,
    sum(count)          filter (where day >= current_date - 6)  as msgs_7d,
    count(distinct day) filter (where day >= current_date - 27) as days_active_28d,
    sum(count)          filter (where day >= current_date - 27) as msgs_28d
  from public.message_usage
  group by user_id
)
select
  u.email,
  coalesce(s.status, 'free')                                as plan,
  u.created_at::date                                        as signed_up,
  greatest(m.last_msg_day::timestamptz,
           d.updated_at,
           u.last_sign_in_at)::date                         as last_active,
  current_date - greatest(m.last_msg_day::timestamptz,
                          d.updated_at,
                          u.last_sign_in_at)::date          as days_silent,
  m.total_msgs,
  m.active_days,
  round(m.total_msgs::numeric / nullif(m.active_days, 0), 1) as msgs_per_active_day,
  -- Days used per week, averaged over their tenure since first message
  -- (denominator floors at one week so day-one users don't show 7.0).
  round(m.active_days::numeric * 7
        / greatest(current_date - m.first_msg_day + 1, 7), 1) as days_per_week,
  m.days_active_7d,
  m.msgs_7d,
  m.days_active_28d,
  m.msgs_28d,
  jsonb_array_length(coalesce(d.tasks,   '[]'::jsonb))      as tasks_on_board,
  jsonb_array_length(coalesce(d.grocery, '[]'::jsonb))      as grocery_items
from auth.users u
left join msg m                    on m.user_id = u.id
left join public.user_data d      on d.user_id = u.id
left join public.subscriptions s  on s.user_id = u.id
order by last_active desc nulls last, signed_up desc;
