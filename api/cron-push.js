import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

// Afternoon "how did it go?" check-back fires at this local hour (24h). Override
// per-deploy with NUDGE_CHECKBACK_HOUR if 3pm turns out wrong for the audience.
const CHECKBACK_HOUR = parseInt(process.env.NUDGE_CHECKBACK_HOUR || "15", 10);
// Cron runs every minute; a 5-minute window means a missed run still fires once.
const SLOT_WINDOW_MIN = 5;

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:hello@ankorahq.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

async function sendToSubscriptions(adminClient, userId, payload) {
  const { data: subs } = await adminClient
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("user_id", userId);

  let delivered = 0;
  for (const sub of subs || []) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { urgency: 'high' }
      );
      delivered++;
    } catch (err) {
      // Subscription expired or unsubscribed — clean it up
      if (err.statusCode === 410 || err.statusCode === 404) {
        await adminClient.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      }
    }
  }
  return delivered;
}

// ── Nudge helpers (exported for unit tests) ─────────────────────────────────────
export const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
export const withinWindow = (currentMins, targetMins) =>
  currentMins >= targetMins && currentMins < targetMins + SLOT_WINDOW_MIN;
// Re-engagement backoff: nudge a lapsed user on days 2 and 4, then weekly. Never
// daily — pinging every day trains a forgetful user to mute or uninstall.
export const isLapseDay = (days) => days === 2 || days === 4 || (days >= 7 && (days - 7) % 7 === 0);

// Build the notification (short teaser) + the opener (Ankora's first chat line,
// the message the app shows when the notification is tapped). Returns null if the
// slot has nothing worth saying.
export function composeNudge(kind, { todayTask, anyTask }) {
  if (kind === "lapse") {
    return {
      kind,
      title: "👋 No pressure",
      body: "No catch-up needed. Want a 10-minute reset?",
      opener: anyTask
        ? `Hey, good to see you. No catch-up and no guilt about the gap. If you want, we can take just one thing, maybe "${anyTask}", and give it ten quiet minutes together. Or start somewhere completely new, your call.`
        : `Hey, good to see you. No catch-up and no guilt about the gap. Want to pick one small thing and give it ten quiet minutes together?`,
    };
  }
  if (kind === "checkback") {
    if (!todayTask) return null;
    return {
      kind,
      title: "👋 How'd it go?",
      body: `How did "${truncate(todayTask, 42)}" go?`,
      opener: `Hey, checking in like I said I would. Earlier "${todayTask}" was on your list for today. How did it go? No wrong answer here, whether it's done, half-done, or hasn't happened yet.`,
    };
  }
  // morning check-in
  if (todayTask) {
    return {
      kind: "morning",
      title: "☀️ Morning",
      body: `"${truncate(todayTask, 42)}" is on today. Want to start there?`,
      opener: `Morning. You've got "${todayTask}" on today's list. Want to make one tiny start on that, or is something else pulling at you first?`,
    };
  }
  if (anyTask) {
    return {
      kind: "morning",
      title: "☀️ Morning",
      body: `"${truncate(anyTask, 42)}" is still on your board.`,
      opener: `Morning. "${anyTask}" is still sitting on your board. Want to give it a real shot today, or clear the deck and pick something fresh?`,
    };
  }
  return {
    kind: "morning",
    title: "☀️ Morning",
    body: "What's one thing that'd make today feel like a win?",
    opener: `Morning, blank slate today. What's the one thing that, if you got it done, would make today feel good?`,
  };
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
  let nudgesFired = 0;

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

  // ── 2. Proactive nudges: content-aware morning check-in, afternoon
  //       "how did it go?" check-back, and a gentle lapse re-engagement. ──
  const { data: usersData } = await adminClient
    .from("user_data")
    .select("user_id, profile, tasks, updated_at")
    .not("profile", "is", null);

  for (const row of usersData || []) {
    const p = row.profile;
    // reminderEnabled is the master opt-in for ALL proactive pings.
    if (!p?.reminderEnabled || !p?.reminderTime || !p?.reminderTz) continue;

    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: p.reminderTz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(now);
      const localHour = parseInt(parts.find(x => x.type === "hour").value);
      const localMinute = parseInt(parts.find(x => x.type === "minute").value);
      const currentMins = localHour * 60 + localMinute;
      const localDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: p.reminderTz }).format(now);

      // Days since the user last touched the app, measured in whole local days.
      // We rely on updated_at reflecting REAL activity, which is why the profile
      // writes below deliberately do NOT bump updated_at.
      const activeDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: p.reminderTz })
        .format(new Date(row.updated_at || now));
      const daysSinceActive = Math.round(
        (Date.parse(localDateStr) - Date.parse(activeDateStr)) / 864e5
      );

      const openTasks = Array.isArray(row.tasks) ? row.tasks.filter(t => t && !t.done) : [];
      const todayTask = openTasks.find(t => t.bucket === "today")?.text || null;
      const anyTask = (openTasks.find(t => t.bucket === "today") || openTasks[0])?.text || null;

      const [rHour, rMin] = p.reminderTime.split(":").map(Number);
      const morningMins = rHour * 60 + rMin;
      const checkbackMins = CHECKBACK_HOUR * 60;

      let nudge = null;
      let guardField = null;

      // Morning slot: lapsed users get the re-engagement (on backoff days),
      // active users get a content-aware check-in. One per day either way.
      if (withinWindow(currentMins, morningMins) && p.lastReminderDate !== localDateStr) {
        if (daysSinceActive >= 2) {
          if (isLapseDay(daysSinceActive)) nudge = composeNudge("lapse", { todayTask, anyTask });
        } else {
          nudge = composeNudge("morning", { todayTask, anyTask });
        }
        guardField = "lastReminderDate";
      }
      // Afternoon check-back: only for users active today who still have an open
      // "today" task, so it never nags on a day they didn't plan anything.
      else if (
        withinWindow(currentMins, checkbackMins) &&
        p.lastCheckbackDate !== localDateStr &&
        daysSinceActive === 0 &&
        todayTask
      ) {
        nudge = composeNudge("checkback", { todayTask, anyTask });
        guardField = "lastCheckbackDate";
      }

      if (!nudge) continue;

      const nudgeId = "n" + now.getTime();
      await sendToSubscriptions(adminClient, row.user_id, {
        title: nudge.title,
        body: nudge.body,
        requireInteraction: false,
        tag: "ankora-nudge",       // a newer nudge replaces an older unopened one
        url: "/?n=1",              // signal only — no personal data in the URL
      });

      // Stash the opener so the app can start the conversation with Ankora as the
      // initiator, and set the once-a-day guard. updated_at is intentionally left
      // untouched so lapse detection keeps working.
      await adminClient
        .from("user_data")
        .update({
          profile: {
            ...p,
            [guardField]: localDateStr,
            pendingNudge: { id: nudgeId, kind: nudge.kind, opener: nudge.opener, createdAt: now.toISOString() },
          },
        })
        .eq("user_id", row.user_id);

      nudgesFired++;
    } catch {}
  }

  return res.status(200).json({ ok: true, timersFired, nudgesFired });
}
