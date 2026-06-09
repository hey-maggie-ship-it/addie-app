// ──────────────────────────────────────────────────────────
// Supabase browser client.
//
// These two values are PUBLIC by design and safe to ship to the browser:
//   - VITE_SUPABASE_URL       your project URL
//   - VITE_SUPABASE_ANON_KEY  the anon/public key
// Security comes from Row-Level Security (RLS) policies in the database,
// which restrict every row to its owning user. (Contrast with the Anthropic
// key, which is secret and lives only in api/chat.js.)
// ──────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true, // needed for the magic-link callback
  },
});
