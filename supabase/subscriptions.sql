-- Run this in your Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Creates the subscriptions table and sets up RLS so users can read their own
-- row, but only the service-role key (used by the Stripe webhook) can write.

create table if not exists public.subscriptions (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id   text unique,
  stripe_subscription_id text unique,
  status               text not null default 'free',  -- 'active' | 'canceled' | 'past_due' etc.
  plan                 text,                           -- 'monthly' | 'annual'
  current_period_end   timestamptz,
  updated_at           timestamptz default now()
);

alter table public.subscriptions enable row level security;

-- Users can only read their own subscription row.
create policy "Users can view own subscription"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- No insert/update/delete policies for regular users — only the service-role
-- key (used in stripe-webhook.js) can write. This prevents users from
-- granting themselves a free subscription.
