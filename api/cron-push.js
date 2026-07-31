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

// Whole days a task has been sitting in its CURRENT bucket. Prefers movedAt (stamped
// by the app on bucket moves) so a week-old task moved to "today" yesterday counts as
// 1 day, not 7; falls back to the creation timestamp genId embeds in the id
// ("t<ms>x<seq>"). Used to pressure-test a stale "today" task instead of pinging the
// identical "want to start?" every morning. 0 when neither is parseable.
export const taskAgeDays = (t, nowMs = Date.now()) => {
  if (!t) return 0;
  const moved = t.movedAt ? Date.parse(t.movedAt) : NaN;
  const ms = !isNaN(moved) ? moved : parseInt(String(t.id || "").replace(/^\D+/, ""), 10);
  if (isNaN(ms)) return 0;
  return Math.max(0, Math.floor((nowMs - ms) / 864e5));
};

// Build the notification (short teaser) + the opener (Ankora's first chat line,
// the message the app shows when the notification is tapped). Returns null if the
// slot has nothing worth saying.
export function composeNudge(kind, { todayTask, anyTask, todayAgeDays = 0, staleOk = true }) {
  if (kind === "lapse") {
    // Board-aware: if there's something to return to, offer to pick it back up. If the
    // board is empty a "reset" makes no sense — invite them to plan the day instead.
    if (anyTask) {
      return {
        kind,
        title: "👋 No pressure",
        body: `No catch-up, no guilt. Pick "${truncate(anyTask, 30)}" back up?`,
        opener: `Hey, good to see you. No catch-up and no guilt about the gap. "${anyTask}" is still on your board if you want it, we could give it ten quiet minutes together. Or start somewhere completely new, your call.`,
      };
    }
    return {
      kind,
      title: "👋 New day",
      body: "Clean slate. Want to plan today together?",
      opener: `Hey, good to see you. No catch-up and no guilt about the gap, your board's a clean slate. Want to figure out the one thing that would make today feel good and set it up together?`,
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
    // A task that's ridden along on "today" for days doesn't need the same "want to
    // start?" nudge again — it needs pressure-testing. But never daily (staleOk is a
    // cooldown the caller controls): the morning after they answered a pressure-test,
    // they get the normal check-in, not the same interrogation again. Keep the
    // openers decisive — one question, a default move, and a guilt-free out — not a
    // multi-choice quiz an overwhelmed person has to grade themselves against.
    if (staleOk && todayAgeDays >= 7) {
      return {
        kind: "morning",
        stale: true,
        title: "☀️ Still on today",
        body: `"${truncate(todayTask, 34)}" has sat ${todayAgeDays} days. Keep it or let it go?`,
        opener: `Morning. Real talk, said kindly: "${todayTask}" has been on today for ${todayAgeDays} days. My honest read is it's either too big or it's stopped mattering. So let's make it easy — we cut it down to a ten-minute version and start it right now, or you drop it with zero guilt and free up the space. Which one feels true? (And if something else keeps getting in the way, name it and we'll get you unstuck.)`,
      };
    }
    if (staleOk && todayAgeDays >= 3) {
      return {
        kind: "morning",
        stale: true,
        title: "☀️ Morning",
        body: `"${truncate(todayTask, 34)}" has been on today ${todayAgeDays} days. Still worth it?`,
        opener: `Morning. "${todayTask}" has ridden along on today for ${todayAgeDays} days. No judgment, quick gut check: is it still the thing that matters? If yes, let's shrink it to a ten-minute first move this morning. If it's lost its pull, we move it to a real day or let it go, zero guilt. What's your gut say?`,
      };
    }
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
  let staleNudgesFired = 0;   // denominator for the pressure-test tap rate (see response below)

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
      const todayTaskItem = openTasks.find(t => t.bucket === "today") || null;
      const todayTask = todayTaskItem?.text || null;
      const anyTask = (todayTaskItem || openTasks[0])?.text || null;
      const todayAgeDays = todayTaskItem ? taskAgeDays(todayTaskItem, now.getTime()) : 0;
      // Pressure-test cooldown: at most every 3 days. Asking "still worth it?" every
      // single morning after day 3 is nagging, and nagging gets notifications muted.
      const staleGapDays = p.lastStaleNudgeDate
        ? Math.round((Date.parse(localDateStr) - Date.parse(p.lastStaleNudgeDate)) / 864e5)
        : Infinity;
      const staleOk = staleGapDays >= 3;

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
          nudge = composeNudge("morning", { todayTask, anyTask, todayAgeDays, staleOk });
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
            ...(nudge.stale ? { lastStaleNudgeDate: localDateStr } : {}),
            // stale/ageDays ride along purely for analytics: they let the app tag the
            // nudge_opened event so a pressure-test tap is distinguishable from a
            // normal morning tap (pressure-tests are the riskiest copy we send).
            pendingNudge: {
              id: nudgeId, kind: nudge.kind, opener: nudge.opener, createdAt: now.toISOString(),
              stale: !!nudge.stale, ageDays: nudge.stale ? todayAgeDays : 0,
            },
          },
        })
        .eq("user_id", row.user_id);

      nudgesFired++;
      if (nudge.stale) staleNudgesFired++;
    } catch {}
  }

  return res.status(200).json({ ok: true, timersFired, nudgesFired, staleNudgesFired });
}
