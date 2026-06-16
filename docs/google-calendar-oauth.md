# Google Calendar OAuth — verification runbook

This is the **long-pole** for native Google Calendar read (the `calendar.readonly`
scope is "sensitive," so Google requires OAuth verification before the public can
use it). Start this clock early; building the code is the easy part.

Claude can't submit this for you — it lives in *your* Google Cloud account and
needs your login + org. This is the click-by-click so you can start it in ~30 min.

---

## 0. Before you start — have these ready
- The **live production domain** for Addie (verification needs a real homepage +
  privacy policy on a domain you own; `*.vercel.app` is risky — use the custom domain).
- The existing **Privacy Policy** and **Terms** pages (you already ship
  `/privacy.html` and `/terms.html` — make sure the privacy policy explicitly says
  you access Google Calendar data, read-only, to show upcoming events, and that you
  don't sell it). Google reviewers read this.

## 1. Google Cloud project
1. https://console.cloud.google.com → create a project (e.g. "Addie").
2. **APIs & Services → Library → Google Calendar API → Enable.**

## 2. OAuth consent screen
1. **APIs & Services → OAuth consent screen.**
2. User type: **External** → Create.
3. App info:
   - App name: **Addie**
   - User support email: your support address
   - App logo: Addie icon (square PNG, <1MB) — a logo triggers a stricter brand
     review but looks legit; optional at first.
   - App domain → Application home page: `https://<your-domain>`
   - Privacy policy URL: `https://<your-domain>/privacy.html`
   - Terms of service URL: `https://<your-domain>/terms.html`
   - Authorized domains: `<your-domain>`
   - Developer contact email.
4. **Scopes → Add:** `https://www.googleapis.com/auth/calendar.readonly`
   (read-only — do NOT add write scopes; they make review much harder).
5. **Test users:** add your own + the two iPhone testers' Google emails. While
   "Testing," only these ~100 users can connect, and they'll see an "unverified
   app" warning — that's fine for testing and needs **no review**.

## 3. OAuth client credentials
1. **APIs & Services → Credentials → Create credentials → OAuth client ID.**
2. Application type: **Web application.**
3. Authorized redirect URI: `https://<your-domain>/api/google-oauth-callback`
   (the serverless callback we'll add when we build the OAuth path).
4. Save the **Client ID** and **Client secret** → these go in Vercel env vars
   (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) when we wire it up.

## 4. Submit for verification (this starts the clock)
1. Back on the OAuth consent screen, click **Publish app** → confirm.
2. Google will prompt to **prepare for verification**. You'll need:
   - A **demo video** (screen recording) showing the OAuth consent flow and exactly
     how Addie uses the calendar data. Reviewers require this for sensitive scopes.
   - A written **scope justification**: *"Addie reads the user's upcoming events
     (calendar.readonly) solely to show them in-app and help the user plan their
     day. Data is not stored long-term, not shared, and not sold."*
3. Submit. **Sensitive-scope review is typically days to a few weeks** and may come
   back with follow-up questions — budget for back-and-forth.

## 5. While you wait
- The app works for your **test users** immediately (unverified-app warning screen).
- The **.ics subscription path is already shipped** (no OAuth needed) — that's the
  launch version. Treat verified Google OAuth as a fast-follow that upgrades the
  experience (auto-connect, private calendars, recurrence handled by Google).

---

### What's NOT done here
The serverless OAuth endpoints (`/api/google-oauth-start`, `/api/google-oauth-callback`),
token storage in Supabase, and the "Connect Google Calendar" button are still to be
built — but none of that can ship to the public until step 4 passes, which is why we
start the clock now and launch on .ics.
