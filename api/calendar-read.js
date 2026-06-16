// ──────────────────────────────────────────────────────────
// Vercel Serverless Function — read a user's subscribed calendar.
//
// The user pastes a private iCal ("secret address") URL in Settings. We fetch
// it server-side (browsers can't, thanks to CORS), parse the upcoming events
// out of the .ics, and return a small list the client can show Addie. This is
// the no-OAuth "middle ground" for calendar READ: works with Google's secret
// iCal address and Apple's public calendar link, no Google verification needed.
//
// Privacy/abuse: only http(s)/webcal URLs, obvious private/loopback hosts are
// blocked (basic SSRF guard), response size + event count are capped, and we
// only ever read — never write. The URL itself is the user's consent.
// ──────────────────────────────────────────────────────────

const WINDOW_DAYS = 7;
const MAX_BYTES = 2_000_000;       // don't ingest huge calendars
const MAX_EVENTS = 60;             // cap what we hand back
const FETCH_TIMEOUT_MS = 8000;

// Block loopback / private / link-local hosts so this can't be used to probe
// the internal network. Not bulletproof (no DNS resolution), but covers the
// obvious cases for a user-supplied URL.
function isBlockedHost(host) {
  const h = (host || "").toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "0.0.0.0" || h === "::1" || h === "[::1]") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;                 // link-local / cloud metadata
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;  // 172.16–31
  return false;
}

// Unfold RFC5545 folded lines (continuation lines start with space/tab).
function unfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}

// Split "DTSTART;TZID=...:20260618T090000" → { name, params, value }
function parseLine(line) {
  const idx = line.indexOf(":");
  if (idx === -1) return null;
  const left = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const [name, ...partParams] = left.split(";");
  const params = {};
  for (const p of partParams) {
    const eq = p.indexOf("=");
    if (eq !== -1) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name: name.toUpperCase(), params, value };
}

function unescapeText(s) {
  return String(s || "").replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}

// Parse a DTSTART/DTEND value into a UTC instant + display metadata.
// floatingOffsetMin: the user's tz offset (minutes, e.g. +540 for JST). Floating
// and TZID times are assumed to be in the user's own timezone — true for almost
// every personal calendar — so we anchor wall-clock components with that offset.
function parseDate(value, params, floatingOffsetMin) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, Y, Mo, D, h, mi, s, z] = m;
  const allDay = params.VALUE === "DATE" || h === undefined;
  if (allDay) {
    // Anchor all-day at local midnight so the calendar date is preserved.
    const utc = Date.UTC(+Y, +Mo - 1, +D, 0, 0, 0) - floatingOffsetMin * 60000;
    return { instant: new Date(utc), allDay: true, wall: { Y:+Y, Mo:+Mo, D:+D } };
  }
  if (z) {
    return { instant: new Date(Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +s)), allDay: false, utc: true };
  }
  // Floating or TZID: treat components as the user's local wall time.
  const utc = Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +s) - floatingOffsetMin * 60000;
  return { instant: new Date(utc), allDay: false };
}

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// Expand a (possibly recurring) event into occurrences whose START falls in
// [windowStart, windowEnd]. Supports the common personal-calendar cases:
// FREQ=DAILY/WEEKLY/MONTHLY with INTERVAL, BYDAY, COUNT, UNTIL. Anything fancier
// just yields the single base occurrence.
function expand(ev, windowStart, windowEnd) {
  const base = ev.start.instant;
  const out = [];
  const push = (d) => { if (d >= windowStart && d <= windowEnd) out.push(d); };

  if (!ev.rrule) { push(base); return out; }

  const r = {};
  for (const part of ev.rrule.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1) r[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase();
  }
  const freq = r.FREQ;
  const interval = Math.max(parseInt(r.INTERVAL, 10) || 1, 1);
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  const until = r.UNTIL ? parseDate(r.UNTIL, {}, 0)?.instant : null;
  const byday = r.BYDAY ? r.BYDAY.split(",").map(d => d.slice(-2)) : null;

  const hardStop = Math.min(windowEnd.getTime(), until ? until.getTime() : Infinity);
  let emitted = 0;
  // Walk day by day from the base date; cheap and bounded by the 7-day window.
  const cursor = new Date(base.getTime());
  const guardEnd = new Date(hardStop + 86400000);
  let stepCount = 0;
  while (cursor <= guardEnd && emitted < count && stepCount < 800) {
    stepCount++;
    let matches = false;
    if (freq === "DAILY") {
      const daysSince = Math.floor((cursor - base) / 86400000);
      matches = daysSince >= 0 && daysSince % interval === 0;
    } else if (freq === "WEEKLY") {
      const weeksSince = Math.floor((cursor - base) / (7 * 86400000));
      const onWeek = weeksSince >= 0 && weeksSince % interval === 0;
      const dow = DAYS[cursor.getUTCDay()];
      matches = onWeek && (byday ? byday.includes(dow) : cursor.getUTCDay() === base.getUTCDay());
    } else if (freq === "MONTHLY") {
      matches = cursor.getUTCDate() === base.getUTCDate();
    }
    if (matches) { emitted++; if (!until || cursor <= until) push(new Date(cursor.getTime())); }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function parseIcs(text, floatingOffsetMin, now) {
  const lines = unfold(text).split("\n");
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") { if (cur && cur.start && cur.summary) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "DTSTART") cur.start = parseDate(p.value, p.params, floatingOffsetMin);
    else if (p.name === "DTEND") cur.end = parseDate(p.value, p.params, floatingOffsetMin);
    else if (p.name === "SUMMARY") cur.summary = unescapeText(p.value).slice(0, 140);
    else if (p.name === "RRULE") cur.rrule = p.value;
  }

  const windowStart = new Date(now.getTime() - 2 * 3600000);          // include things happening right now
  const windowEnd = new Date(now.getTime() + WINDOW_DAYS * 86400000);

  const occurrences = [];
  for (const ev of events) {
    if (!ev.start?.instant) continue;
    for (const when of expand(ev, windowStart, windowEnd)) {
      occurrences.push({ summary: ev.summary, allDay: !!ev.start.allDay, instant: when });
    }
  }
  occurrences.sort((a, b) => a.instant - b.instant);
  return occurrences.slice(0, MAX_EVENTS);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { url, tz, tzOffsetMinutes } = (typeof req.body === "object" && req.body) || {};
    let raw = String(url || "").trim();
    if (!raw) return res.status(400).json({ error: "Missing calendar URL" });
    if (raw.startsWith("webcal://")) raw = "https://" + raw.slice("webcal://".length);

    let parsed;
    try { parsed = new URL(raw); } catch { return res.status(400).json({ error: "That doesn't look like a valid URL" }); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return res.status(400).json({ error: "Only http(s) calendar links are supported" });
    if (isBlockedHost(parsed.hostname)) return res.status(400).json({ error: "That host isn't allowed" });

    // floating/TZID times are assumed to be in the user's own timezone.
    const offset = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(raw, { signal: ctrl.signal, headers: { "User-Agent": "Addie/1.0 (+calendar-read)" }, redirect: "follow" });
    } finally { clearTimeout(timer); }
    if (!resp.ok) return res.status(502).json({ error: `Calendar host returned ${resp.status}` });

    // Read with a byte cap so a giant calendar can't blow up the function.
    const reader = resp.body?.getReader?.();
    let text = "";
    if (reader) {
      const decoder = new TextDecoder();
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_BYTES) { try { await reader.cancel(); } catch {} break; }
        text += decoder.decode(value, { stream: true });
      }
    } else {
      text = (await resp.text()).slice(0, MAX_BYTES);
    }
    if (!/BEGIN:VCALENDAR/i.test(text)) return res.status(422).json({ error: "That link didn't return a calendar (.ics) file" });

    const now = new Date();
    const occ = parseIcs(text, offset, now);

    const fmt = (instant, allDay) => {
      try {
        return new Intl.DateTimeFormat("en-US", {
          timeZone: tz || "UTC",
          weekday: "short", month: "short", day: "numeric",
          ...(allDay ? {} : { hour: "numeric", minute: "2-digit" }),
        }).format(instant);
      } catch {
        return instant.toISOString();
      }
    };

    const events = occ.map(o => ({
      title: o.summary,
      allDay: o.allDay,
      startISO: o.instant.toISOString(),
      when: fmt(o.instant, o.allDay),
    }));

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ events, fetchedAt: now.toISOString() });
  } catch (e) {
    return res.status(500).json({ error: "Couldn't read that calendar right now" });
  }
}
