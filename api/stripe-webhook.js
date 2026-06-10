import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

// Tell Vercel not to pre-parse the body — Stripe needs the raw bytes to verify
// the signature. Without this the stream is already drained and verification fails.
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  // If Vercel already parsed the body (bodyParser config not respected),
  // reconstruct a buffer from it so we can at least attempt processing.
  if (req.body !== undefined) {
    const str = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    return Buffer.from(str);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2025-05-28.basil" });
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  const sig = req.headers["stripe-signature"];
  const rawBody = await readRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    console.error("Raw body length:", rawBody?.length, "Sig present:", !!sig);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const annualPriceId = process.env.STRIPE_ANNUAL_PRICE_ID;
  const planFor = (sub) => {
    const priceId = sub.items?.data?.[0]?.price?.id;
    return priceId === annualPriceId ? "annual" : "monthly";
  };

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.metadata?.user_id;
      if (!userId) {
        console.error("checkout.session.completed: missing user_id in metadata");
        return res.status(400).json({ error: "Missing user_id" });
      }
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      const { error: dbErr } = await supabase.from("subscriptions").upsert({
        user_id: userId,
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
        status: sub.status,
        plan: planFor(sub),
        current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      });
      if (dbErr) console.error("Supabase upsert error:", dbErr.message);
    }

    if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      await supabase.from("subscriptions").update({
        status: sub.status,
        plan: planFor(sub),
        current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("stripe_subscription_id", sub.id);
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      await supabase.from("subscriptions").update({
        status: "canceled",
        updated_at: new Date().toISOString(),
      }).eq("stripe_subscription_id", sub.id);
    }
  } catch (err) {
    console.error("Webhook handler error:", err.message);
    return res.status(500).json({ error: err.message });
  }

  return res.status(200).json({ received: true });
}
