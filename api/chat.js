// ──────────────────────────────────────────────────────────
// Vercel Serverless Function — secure proxy to the Anthropic API.
// The API key lives ONLY here (server-side) and is never sent to the browser.
//
// Requires a signed-in user: the browser sends the Supabase access token as
// `Authorization: Bearer <token>`, which we verify before calling Anthropic.
// This is also where the payments phase will later check "is this user a
// paying subscriber?" before allowing the request.
//
// Env vars:
//   ANTHROPIC_KEY            secret — never prefix with VITE_
//   VITE_SUPABASE_URL        (also readable server-side) project URL
//   VITE_SUPABASE_ANON_KEY   (also readable server-side) anon/public key
// ──────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const API_KEY = process.env.ANTHROPIC_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: "Server is missing its API key." });
  }

  // ── Require a valid signed-in user ──
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: "Server is missing its auth config." });
  }
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) {
    return res.status(401).json({ error: "Please sign in." });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !userData?.user) {
    return res.status(401).json({ error: "Your session expired — please sign in again." });
  }

  try {
    const { system, messages } = req.body || {};

    // Basic guard against malformed requests.
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "No messages provided." });
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
      // Surface a clean error without leaking internals.
      return res.status(upstream.status).json({
        error: data?.error?.message || "Upstream API error.",
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: "Something went wrong." });
  }
}
