import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Please sign in." });

  // Authenticate the user
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: authError } = await anonClient.auth.getUser(token);
  if (authError || !userData?.user) return res.status(401).json({ error: "Session expired." });

  const { title, body, sendAt, requireInteraction } = req.body || {};
  if (!title || !sendAt) return res.status(400).json({ error: "Missing title or sendAt." });

  // Use service role to write — pending_pushes has no user-level RLS
  const adminClient = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await adminClient
    .from("pending_pushes")
    .insert({
      user_id: userData.user.id,
      title,
      body: body || "",
      send_at: sendAt,
      require_interaction: !!requireInteraction,
      sent: false,
    })
    .select("id")
    .single();

  if (error) return res.status(500).json({ error: "Failed to schedule push." });
  return res.status(200).json({ id: data.id });
}
