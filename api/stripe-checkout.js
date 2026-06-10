import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2025-05-28.basil" });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Please sign in." });

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !userData?.user) {
    return res.status(401).json({ error: "Your session expired — please sign in again." });
  }

  const { priceId } = req.body || {};
  if (!priceId) return res.status(400).json({ error: "Missing priceId." });

  const origin = process.env.APP_URL || req.headers.origin || "https://your-app.vercel.app";

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: userData.user.email,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { user_id: userData.user.id },
      success_url: `${origin}?payment=success`,
      cancel_url: `${origin}?payment=canceled`,
      allow_promotion_codes: true,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
