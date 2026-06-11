// ──────────────────────────────────────────────────────────
// Vercel Serverless Function — serve a single calendar event as an
// inline .ics so the device hands it straight to its native calendar.
//
// The earlier client-side approach used an <a download> blob, which on
// iPhone just drops a file in Files that most people never tap. Returning
// the .ics from a real URL with `Content-Type: text/calendar` makes iOS
// Safari open Apple Calendar's "Add Event" sheet directly. Used for the
// Apple option in the in-app calendar chooser (Google/Outlook get their
// own pre-filled web composer URLs and never hit this endpoint).
//
// No auth and no secrets: it only formats user-supplied event fields the
// caller already has. Inputs are length-capped as a basic abuse guard.
// ──────────────────────────────────────────────────────────

const MAX_TITLE = 200;

// Fold to UTC basic format: 20260611T143000Z
function toIcsUtc(d) {
  return d.toISOString().replace(/[-:]|\.\d{3}/g, "");
}
function esc(s) {
  return String(s || "").replace(/([,;\\])/g, "\\$1").replace(/\r?\n/g, "\\n");
}

export default function handler(req, res) {
  try {
    const { title = "Event", start, minutes } = req.query || {};
    const startDate = new Date(start);
    if (isNaN(startDate.getTime())) {
      return res.status(400).send("Invalid start time.");
    }
    const mins = Math.min(Math.max(parseInt(minutes, 10) || 60, 1), 1440);
    const endDate = new Date(startDate.getTime() + mins * 60000);
    const summary = String(title).slice(0, MAX_TITLE);

    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Addie//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:addie-${Date.now()}@addie.app`,
      `DTSTAMP:${toIcsUtc(new Date())}`,
      `DTSTART:${toIcsUtc(startDate)}`,
      `DTEND:${toIcsUtc(endDate)}`,
      `SUMMARY:${esc(summary)}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", 'inline; filename="event.ics"');
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(ics);
  } catch {
    return res.status(500).send("Could not build the calendar event.");
  }
}
