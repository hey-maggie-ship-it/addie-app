// Stripe webhook handler — keeps the `subscriptions` table in Supabase in sync.
// Must receive the raw request body for signature verification, so body parsing
// is disabled via the exported config object.
//
// Env vars:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET        from Stripe Dashboard → Webhooks → signing secret
//   STRIPE_ANNUAL_PRICE_ID       used to detect which plan was purchased
//   SUPABASE_SERVICE_ROLE_KEY    writes bypass RLS

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  const sig = req.headers["stripe-signature"];
  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  // Use the service-role key so writes bypass RLS.
  const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const annualPriceId = process.env.STRIPE_ANNUAL_PRICE_ID;

  const planFor = (sub) => {
    const priceId = sub.items?.data?.[0]?.price?.id;
    return priceId === annualPriceId ? "annual" : "monthly";
  };

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.metadata?.user_id;
    if (!userId) {
      console.error("checkout.session.completed: missing user_id in metadata");
      return res.status(400).json({ error: "Missing user_id" });
    }
    const sub = await stripe.subscriptions.retrieve(session.subscription);
    await supabase.from("subscriptions").upsert({
      user_id: userId,
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
      status: sub.status,
      plan: planFor(sub),
      current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    });
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

  return res.status(200).json({ received: true });
}
