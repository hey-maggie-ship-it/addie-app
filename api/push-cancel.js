import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Please sign in." });

  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: authError } = await anonClient.auth.getUser(token);
  if (authError || !userData?.user) return res.status(401).json({ error: "Session expired." });

  const { pushId } = req.body || {};
  if (!pushId) return res.status(400).json({ error: "Missing pushId." });

  const adminClient = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await adminClient
    .from("pending_pushes")
    .update({ sent: true })
    .eq("id", pushId)
    .eq("user_id", userData.user.id) // Ensure users can only cancel their own pushes
    .eq("sent", false);

  if (error) return res.status(500).json({ error: "Failed to cancel push." });
  return res.status(200).json({ ok: true });
}
