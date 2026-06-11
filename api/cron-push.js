import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:hello@addie.app",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

async function sendToSubscriptions(adminClient, userId, payload) {
  const { data: subs } = await adminClient
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("user_id", userId);

  for (const sub of subs || []) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { urgency: 'high' }
      );
    } catch (err) {
      // Subscription expired or unsubscribed — clean it up
      if (err.statusCode === 410 || err.statusCode === 404) {
        await adminClient.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      }
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify cron secret (Vercel sets this automatically in production)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return res.status(500).json({ error: "VAPID keys not configured." });
  }

  const adminClient = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const now = new Date();
  let timersFired = 0;
  let remindersFired = 0;

  // ── 1. Fire elapsed timer alarms ──
  const { data: duePushes } = await adminClient
    .from("pending_pushes")
    .select("id, user_id, title, body, require_interaction")
    .eq("sent", false)
    .lte("send_at", now.toISOString());

  for (const push of duePushes || []) {
    await sendToSubscriptions(adminClient, push.user_id, {
      title: push.title,
      body: push.body,
      requireInteraction: push.require_interaction,
    });
    await adminClient.from("pending_pushes").update({ sent: true }).eq("id", push.id);
    timersFired++;
  }

  // ── 2. Send daily check-in reminders ──
  const { data: usersData } = await adminClient
    .from("user_data")
    .select("user_id, profile")
    .not("profile", "is", null);

  for (const row of usersData || []) {
    const p = row.profile;
    if (!p?.reminderEnabled || !p?.reminderTime || !p?.reminderTz) continue;

    try {
      // Get current time in user's timezone
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: p.reminderTz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(now);
      const localHour = parseInt(parts.find(x => x.type === "hour").value);
      const localMinute = parseInt(parts.find(x => x.type === "minute").value);

      const [rHour, rMin] = p.reminderTime.split(":").map(Number);
      if (localHour !== rHour || localMinute !== rMin) continue;

      // Check if already sent today in user's timezone
      const localDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: p.reminderTz }).format(now);
      if (p.lastReminderDate === localDateStr) continue;

      await sendToSubscriptions(adminClient, row.user_id, {
        title: "🌅 Time for your check-in",
        body: "Addie is here — what's on your plate today?",
        requireInteraction: false,
      });

      // Update lastReminderDate in profile to prevent double-sending today
      await adminClient
        .from("user_data")
        .update({ profile: { ...p, lastReminderDate: localDateStr }, updated_at: now.toISOString() })
        .eq("user_id", row.user_id);

      remindersFired++;
    } catch {}
  }

  return res.status(200).json({ ok: true, timersFired, remindersFired });
}
