// ──────────────────────────────────────────────────────────
// Vercel Serverless Function — secure proxy to the Anthropic API.
// The API key lives ONLY here (server-side) and is never sent to the browser.
//
// Requires a signed-in user (Supabase access token as `Authorization: Bearer`).
// Enforces a per-user daily message limit and a payload-size guard so the
// Anthropic bill can't be run up by abuse. The daily limit is the hook a
// future Stripe "is this user subscribed?" check will raise or remove.
//
// Env vars:
//   ANTHROPIC_KEY              secret — never prefix with VITE_
//   VITE_SUPABASE_URL          (also readable server-side) project URL
//   VITE_SUPABASE_ANON_KEY     (also readable server-side) anon/public key
//   FREE_DAILY_MESSAGE_LIMIT   optional, default 25
// ──────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

// Free-tier daily message cap (per user).
const DAILY_LIMIT = parseInt(process.env.FREE_DAILY_MESSAGE_LIMIT || "25", 10);
// Reject a single oversized message (the real cost-abuse vector) — generous.
const MAX_MESSAGE_CHARS = 16000;
// Sanity ceiling for a runaway-long conversation; normal chats won't hit it.
const MAX_CONVERSATION_CHARS = 200000;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const API_KEY = process.env.ANTHROPIC_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: "Server is missing its API key." });
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: "Server is missing its auth config." });
  }

  // ── Require a valid signed-in user ──
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) {
    return res.status(401).json({ error: "Please sign in." });
  }

  // A Supabase client that acts AS the signed-in user, so auth.uid() and RLS
  // apply to the metering call below.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !userData?.user) {
    return res.status(401).json({ error: "Your session expired — please sign in again." });
  }

  try {
    const { system, messages } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "No messages provided." });
    }

    // Guard against a single oversized message (the actual cost-abuse vector).
    const latest = messages[messages.length - 1];
    const latestLen = typeof latest?.content === "string" ? latest.content.length : 0;
    if (latestLen > MAX_MESSAGE_CHARS) {
      return res.status(413).json({ error: "That message is too long — try trimming it down." });
    }
    // Sanity ceiling for a runaway-long conversation (very high; normal chats won't hit it).
    const totalChars = messages.reduce(
      (n, m) => n + (typeof m.content === "string" ? m.content.length : 0),
      0
    );
    if (totalChars > MAX_CONVERSATION_CHARS) {
      return res.status(413).json({ error: 'This conversation has gotten very long — tap "New session" to start fresh.' });
    }

    // ── Per-user daily rate limit (atomic + tamper-proof via SECURITY DEFINER RPC) ──
    // Fails OPEN if the metering function isn't installed yet, so deploying this
    // code before running supabase/metering.sql won't break chat.
    const { data: usage, error: usageError } = await supabase.rpc("record_message", {
      daily_limit: DAILY_LIMIT,
    });
    if (usageError) {
      console.error("Usage metering unavailable (failing open):", usageError.message);
    } else if (usage && usage.allowed === false) {
      return res.status(429).json({
        error: `You've reached today's limit of ${usage.limit} messages. It resets tomorrow.`,
      });
    }

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system,
        messages,
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: data?.error?.message || "Upstream API error.",
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: "Something went wrong." });
  }
}
