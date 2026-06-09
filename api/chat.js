// ──────────────────────────────────────────────────────────
// Vercel Serverless Function — secure proxy to the Anthropic API.
// The API key lives ONLY here (server-side) and is never sent to the browser.
//
// Set ANTHROPIC_KEY in your Vercel project's Environment Variables.
// (Note: NO "VITE_" prefix — that prefix would expose it to the client.)
// ──────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const API_KEY = process.env.ANTHROPIC_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: "Server is missing its API key." });
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
