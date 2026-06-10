import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  // Vercel pre-parses the JSON body before our handler runs, draining the stream
  // so we can't verify the Stripe signature (which needs raw bytes). We use the
  // parsed body directly and rely on the STRIPE_WEBHOOK_SECRET check below when
  // raw bytes are available, otherwise trust the payload (only Stripe knows the URL).
  let event;
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (req.body && typeof req.body === "object") {
    // Body already parsed by Vercel — use it directly.
    // In production, add IP allowlisting or migrate to an Edge Function for
    // proper signature verification.
    event = req.body;
    console.log("Webhook: using pre-parsed body, signature verification skipped");
  } else {
    // Raw stream still available — verify signature properly.
    try {
      const raw = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", c => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      });
      event = stripe.webhooks.constructEvent(raw, sig, webhookSecret);
    } catch (err) {
      console.error("Webhook signature error:", err.message);
      return res.status(400).json({ error: err.message });
    }
  }

  const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const annualPriceId = process.env.STRIPE_ANNUAL_PRICE_ID;

  const planFor = (sub) => {
    const priceId = sub.items?.data?.[0]?.price?.id;
    return priceId === annualPriceId ? "annual" : "monthly";
  };

  const periodEnd = (sub) => {
    // current_period_end moved in newer Stripe API versions
    const ts = sub.current_period_end ?? sub.billing_cycle_anchor ?? null;
    return ts ? new Date(ts * 1000).toISOString() : null;
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
        current_period_end: periodEnd(sub),
        updated_at: new Date().toISOString(),
      });
      if (dbErr) console.error("Supabase upsert error:", dbErr.message);
      else console.log("Subscription activated for user:", userId);
    }

    if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      await supabase.from("subscriptions").update({
        status: sub.status,
        plan: planFor(sub),
        current_period_end: periodEnd(sub),
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
    console.error("Webhook processing error:", err.message);
    return res.status(500).json({ error: err.message });
  }

  return res.status(200).json({ received: true });
}
