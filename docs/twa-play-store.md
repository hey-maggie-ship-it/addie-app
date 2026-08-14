# TWA on Google Play — packaging runbook

Wrap the existing PWA as a **Trusted Web Activity**: a thin Android app that opens
`app.ankorahq.com` fullscreen with no browser URL bar. No app rewrite — the TWA just
loads the live site, so your normal `git push` → Vercel deploy flow keeps updating
the "app" content instantly.

**Why bother:** it's the fix for the one thing the PWA can't do — notifications that
**heads-up on the Android lock screen** instead of waiting silently in the shade.
That's your retention lever for a forgetful/ADHD audience, so it's worth it.

**Android only.** iPhone gets nothing from this — iOS still needs Add-to-Home-Screen
and keeps the weaker web-push limits. Any "get the app" CTA needs an Android asterisk.

Claude can't do most of this — it lives in *your* Play Console + Google account and
needs your login, identity verification, and signing keys. This is the click-by-click.
The one repo-side piece (`public/.well-known/assetlinks.json`) is blocked on a
fingerprint that only exists after step 6, so that's a fast-follow Claude does then.

---

## 0. Before you start — have these ready
- **Live app domain:** `https://app.ankorahq.com` (already serving a valid installable
  PWA: manifest, service worker, HTTPS, 192 + 512 maskable icons — all present).
- **Privacy policy URL:** `https://app.ankorahq.com/privacy.html` (already shipped).
- **A credit card** for the one-time $25 Play Console fee.
- **~30–60 min** of hands-on time, then a wait for account verification (and possibly
  the closed-testing window — see the caveat in step 1).

## 1. Google Play Console account
1. https://play.google.com/console → sign up → pay the **$25 one-time** fee.
2. Complete **identity verification** (government ID + address). This can take a day
   or more to clear before you can publish.
3. **CAVEAT — the 14-day closed test.** Google requires **personal** developer
   accounts created after ~Nov 2023 to run a closed test with **12 testers for 14
   continuous days** before you can apply for production. **Organization** accounts are
   exempt. Two implications:
   - If you have/can make the LLC, register as an **organization** and skip this.
   - Otherwise budget ~2 weeks of lead time and line up 12 testers early.
   - Verify the current rule in the Console — Google changes the exact numbers.

## 2. Install the tooling (on your machine)
Node is already installed. Just add Bubblewrap:
```bash
npm i -g @bubblewrap/cli
```
- **The install prints a wall of red `deprecated` / `cleanup` warnings on Windows —
  that's normal, not failure.** As long as the last line says
  `changed NNN packages`, it worked. Confirm with `bubblewrap --version` (it prints
  a logo, then starts first-run setup — see below). One warning may leave an orphaned
  `@bubblewrap\.cli-*` temp folder in the npm global dir; it's harmless junk (a locked
  `.node` file), safe to ignore or delete after a reboot.
- **You do NOT need to install the JDK or Android SDK yourself.** On its **first run**
  (step 3) Bubblewrap asks *"Do you want Bubblewrap to install the JDK?"* and then sets
  up the Android SDK too — answer **Yes** to both. (Only say No to the JDK if you
  already have JDK 17 and want to point Bubblewrap at it.)
- Run Bubblewrap in your **own interactive terminal** — it asks questions, so it can't
  run in a non-interactive/automated shell.

## 3. Generate the Android project
```bash
bubblewrap init --manifest https://app.ankorahq.com/manifest.json
```
It interviews you. The answers that matter:
- **Application ID / package name:** e.g. `com.ankorahq.app`.
  **Permanent — it can never change after the first publish.** Choose deliberately.
- **App name:** Ankora. **Launcher name:** Ankora.
- **Display mode:** `standalone` (matches the manifest).
- **"Include support for push notifications?" → YES.** This adds the notification
  delegation service so web push shows as a real Android notification. Skip it and the
  lock-screen win — the entire reason you're doing this — doesn't happen.
- **Signing key:** let Bubblewrap generate one (creates `android.keystore`).
  🔑 **Back up `android.keystore` and its passwords somewhere safe (password manager).**
  Lose it and you can never ship an update to the app.

## 4. Build
> **DONE on Maggie's machine (2026-07-21).** The environment is already set up and a
> signed AAB + APK were produced. Rebuild with the helper that bakes in the Windows
> workarounds below:
> ```bash
> powershell -ExecutionPolicy Bypass -File "$HOME\ankora-twa\build.ps1"
> ```

```bash
bubblewrap build
```
Produces:
- `app-release-bundle.aab` → what you upload to Play.
- `app-release-signed.apk` → for sideloading onto your own phone to test.

**Bubblewrap-on-Windows gotchas (why plain `bubblewrap build` fails, all handled by
`build.ps1`):**
- Its JDK auto-installer downloaded only the JDK *sources* (no `java.exe`) — install
  Temurin 17 with `winget install EclipseAdoptium.Temurin.17.JDK` instead.
- It hardcodes **build-tools 34.0.0** and only recognizes an SDK laid out with a
  `<sdk>/tools` (or `<sdk>/bin`) folder — not the modern `cmdline-tools/latest`.
- It calls `gradlew.bat` and `jarsigner` as bare names → both the project dir and the
  JDK `bin` must be on `PATH`.
- It runs `java` from an **unquoted** path → point `jdkPath` at the 8.3 short path
  (`C:\PROGRA~1\ECLIPS~1\JDK-17~1.8-H`), which has no spaces.
- Keystore passwords: `build.ps1` lets Bubblewrap prompt, or set
  `BUBBLEWRAP_KEYSTORE_PASSWORD` / `BUBBLEWRAP_KEY_PASSWORD` to skip the prompt.
- Watch out for terminal **type-ahead** — don't paste/type before a prompt fully
  renders; it corrupted the first keystore password and several earlier answers.

## 5. Test on your own Pixel FIRST
1. Transfer the `.apk` to the phone and install it (allow "install from this source").
2. Open it and confirm **two things**:
   - **No browser URL bar.** If a bar shows, Asset Links (step 6) isn't matched yet —
     expected at this point, since you haven't published the fingerprint.
   - A notification actually **heads-up on the lock screen** (the payoff). On Android
     13+ you'll get a runtime notification-permission prompt — accept it.

## 6. Digital Asset Links — the step everyone gets wrong
This is what removes the URL bar by proving the app and the domain belong together.

**The trap:** with **Play App Signing** (the default — keep it), Google **re-signs**
your app with *its own* key. So the SHA-256 in `assetlinks.json` must be **Google's
app-signing fingerprint, not only your local upload key.** Publishing the wrong
fingerprint is the #1 reason the URL bar won't go away.

Order of operations:
1. Upload the `.aab` to Play (step 8) so Google generates its signing key.
2. **Play Console → your app → Release → Setup → App integrity → App signing** — copy
   the **SHA-256 certificate fingerprint** shown there.
3. Build the `assetlinks.json`. Include **both** the Play app-signing fingerprint and
   your local upload-key fingerprint (belt-and-suspenders), e.g. via:
   ```bash
   bubblewrap fingerprint  # helper for managing fingerprints → assetlinks.json
   ```
4. Commit it to the repo at **`public/.well-known/assetlinks.json`** (Vite copies
   `public/` verbatim, so it serves at
   `https://app.ankorahq.com/.well-known/assetlinks.json`). Push → Vercel deploys.
5. Verify it's live and correct:
   ```bash
   curl -s https://app.ankorahq.com/.well-known/assetlinks.json
   ```
6. Reinstall the app — the URL bar should be gone.

→ **Claude does step 3–4 for you once you paste the Play app-signing SHA-256.**

## 7. Store listing assets
Prepare:
- **App icon:** 512×512 PNG.
- **Feature graphic:** 1024×500 PNG.
- **Screenshots:** at least 2 phone screenshots.
- **Short description** (≤80 chars) + **full description** (≤4000 chars) — reuse
  `marketing/launch-copy.md`.
- **Content rating** questionnaire.
- **Data safety form:** declare what you collect — email (auth), user-generated
  content (chat/tasks/notes), and that you use **PostHog** (analytics) and **Sentry**
  (crash/error). Be honest; this is cross-checked against the privacy policy.
- **Privacy policy URL:** `https://app.ankorahq.com/privacy.html`.

## 8. Ship it
1. **Internal testing track** first — upload the `.aab`, add your own email as a
   tester, get an install link **without** waiting for full review. Use this to
   validate the whole flow (no URL bar, lock-screen push) on real installs.
2. If your account is subject to the step-1 closed-test rule, run **closed testing**
   for the required window.
3. **Production** — submit for review. First review for a new app is typically a few
   days and may bounce with follow-ups; budget for one round-trip.

## 9. Updating later
- **App content** (everything the user sees): just `git push` → Vercel. The TWA loads
  the live site, so no Play re-submission for content/feature changes. This is the
  whole point.
- **Native shell** (package config, target SDK bump Google periodically requires,
  new icon): rebuild with Bubblewrap, bump `versionCode`, upload a new `.aab`, submit.
- Always sign updates with the **same** `android.keystore` from step 3.

---

### What's NOT done here / what Claude does
- Claude will create/commit **`public/.well-known/assetlinks.json`** once you paste the
  **Play app-signing SHA-256** from step 6.2 (that's the only blocker — the fingerprint
  doesn't exist until you've uploaded a build).
- Everything else (Play account, Bubblewrap runs, keystore, store listing, review) is
  yours — it needs your login, identity, and signing keys, which Claude can't touch.
