# Ankora Paid Ads Playbook

_Google Search, tiny budget, plus the "What's your stuck style?" quiz funnel. Last updated 2026-07-31._

The goal at this budget is **learning speed, not ROI**. Every dollar buys an answer to "does this message make this audience click and sign up," not customers yet. Read results as signal.

---

## TL;DR: who does what

| # | Task | Owner | Status |
|---|------|-------|--------|
| 1 | GA4 tag on all pages | 🤖 me (code) | ✅ Done |
| 2 | `sign_up` conversion event fires on new signup | 🤖 me (code) | ✅ Done |
| 3 | Quiz page built + tested (`/quiz/`) | 🤖 me (code) | ✅ Done |
| 4 | Mark `sign_up` as a key event in GA4 | 👤 you (console) | ⬜ To do |
| 5 | Link Google Ads ↔ GA4 and import the conversion | 👤 you (console) | ⬜ To do |
| 6 | Filter internal (localhost) traffic in GA4 | 👤 you (console) | ⬜ To do |
| 7 | Build the Search campaign (settings, keywords, negatives, ads) | 👤 you (console) | ⬜ To do, all assets below |
| 8 | Deploy the quiz (git push / Vercel) | 👤 you (or ask me to prep the commit) | ⬜ To do |
| 9 | Budget + geo decided: $10/day, US + English | 👤 you | ✅ Done |
| 10 | (Later) A/B the quiz vs the static landing as the ad destination | 🤖 me (code) | ⬜ After #7 converts |
| 11 | (Optional) `og-quiz.jpg` share card | 👤 you (design) | ⬜ Nice-to-have |

**Short version:** the code is done. The rest is console clicks in GA4 and Google Ads (only you can do those, they're tied to your accounts), plus deploying the quiz. Everything you need to paste is in the appendices.

---

## 0. Where things stand (verified today)

- **GA4 is live** on all 9 landing pages + the app, measurement ID `G-KVSZ6CD1EY`.
- **The conversion already fires.** `trackSignupConversion` in `src/App.jsx` sends the GA4 `sign_up` event, but only for a genuinely new account (created within 10 min + a `localStorage` guard), so returning logins and reloads don't inflate it. This is the event you'll import into Google Ads.
- **No cross-domain linker needed.** The `_ga` and `_gcl_au` cookies are written on `.ankorahq.com`, so the ad click's gclid survives the `ankorahq.com` → `app.ankorahq.com` hop automatically (both share the measurement ID).
- **The quiz page is built and tested** at `landing/quiz/index.html`. Scoring, the tiebreaker, result rendering, and the utm-tagged handoff to the app all verified working.

---

## 1. Your steps (console + account, only you can do these)

### A. Finish conversion tracking first (~15 min)

Do this **before** turning on ads, or Google is bidding blind.

1. **Mark `sign_up` as a key event.** GA4 → Admin → Events (or Key events). Wait until you see `sign_up` appear (do one real signup to trigger it if needed), then toggle it to a key event.
2. **Link Google Ads to GA4.** GA4 → Admin → Product links → Google Ads links → Link your Ads account.
3. **Import the conversion.** Google Ads → Goals → Conversions → New conversion action → Import → Google Analytics 4 → pick `sign_up`. Set it as a **Primary** conversion action.
4. **Filter internal traffic** (one localhost pageview polluted the property on 7/31). GA4 → Admin → Data Streams → your stream → Configure tag settings → Define internal traffic (add your IP), then Admin → Data Filters → activate the "Internal Traffic" filter.
5. **Sanity check.** GA4 → Reports → Realtime. Click an app CTA from the landing and confirm it stays **one session** (not a new session with `ankorahq.com` as referrer). If it splits, tell me and I'll wire GA4 cross-domain, but with the shared cookie it shouldn't.

### B. Build the Search campaign

All keyword lists, negatives, and ad copy are in the appendices, ready to paste.

**Campaign settings:**
- New campaign → objective **Sales** (or "Create without a goal") → type **Search**.
- **Uncheck "Search Network partners" and "Display Network."** Both waste small budgets.
- Bidding: start **Maximize clicks with a max CPC limit** (~$2.00), or Manual CPC. Do **not** start on Maximize conversions, it needs conversion history you don't have yet. Switch to Maximize conversions / target CPA after ~15-30 conversions.
- Locations: **United States**. Languages: **English**. Set "Presence: people in your targeted locations" (not "presence or interest").
- Budget: **$10/day** (about $300/mo). These keywords are low-volume, so it may underspend some days. That's fine, don't force it higher.
- At $10/day, run **Ad group 1 + 2 only** (Appendix A) so each gets enough spend to gather signal. Add AG3-5 later, or when you raise the budget.

### C. Deploy the quiz

The quiz lives at `landing/quiz/index.html`, the same static pattern as the guides (`landing/guides/.../index.html` serve at `/guides/...`), so it deploys to **`ankorahq.com/quiz/`** with no routing changes. Just push and let Vercel build. After deploy, load `https://ankorahq.com/quiz/` and confirm it renders and a result CTA lands on the app. (Ask me if you want me to prep the commit.)

### D. Budget + geo (decided)

- **Budget: $10/day** (about $300/mo). At this level, run **Ad group 1 + 2 only** to start so each gets enough spend. Add AG3-5 later, or when the budget grows.
- **Geo: United States, English.**
- Reality check at $10/day: a ~$2 max CPC is roughly 5 clicks a day, so ~150 clicks a month. That is enough to learn from, not enough to scale on. Patience on the 10-14 day window matters more here, not less.

---

## 2. My steps (code / files)

- ✅ **Quiz page** built, styled to match the landing, wired with GA4 + PostHog + utm handoff, and verified.
- ✅ **GA4 tag + `sign_up` conversion** already in the codebase (done earlier today).
- ⬜ **A/B the quiz as the ad destination** vs the static landing, once Ad group 1 is converting. I'll wire this so PostHog reports which destination wins.
- ⬜ **(If you want)** prep the deploy commit for the quiz, or a quiz-specific share card layout.

---

## 3. Launch checklist

1. ⬜ `sign_up` marked as key event (1A.1)
2. ⬜ Google Ads ↔ GA4 linked, conversion imported as Primary (1A.2-3)
3. ⬜ Internal traffic filtered (1A.4)
4. ⬜ Realtime shows landing → app as one session (1A.5)
5. ⬜ Quiz deployed and loading at `ankorahq.com/quiz/` (1C)
6. ⬜ Campaign built: Search only, partners + Display off (1B)
7. ⬜ Negative keyword list added (Appendix B)
8. ⬜ Ad groups 1 + 2 live with RSAs (Appendix A + C)
9. ⬜ Fire one test signup, confirm the conversion records in Google Ads (can take a few hours)

## 4. What to watch, and when to judge

- **Let it run 10-14 days untouched.** Too little daily spend never exits the learning phase, and reacting on day 2 just adds noise.
- **Judge on cost per signup, not clicks.** A cheap click that never signs up is worse than a pricier one that does.
- **Weekly:** open the **Search Terms report** and add junk queries as negatives (this is where small budgets leak).
- **Green light to scale:** when Ad group 1 (solution-aware) shows a workable cost per signup, that's the signal to (a) A/B the quiz as the destination, and (b) open Instagram for demand-gen.

---

## Appendix A: Ad groups, keywords, destinations

Match types: `[exact]`, `"phrase"`. Start with AG1 + AG2.

**AG1. ADHD coach / app** (solution-aware, highest intent) → `https://ankorahq.com/`
```
[adhd coach app]
"adhd coach app"
"adhd accountability app"
"ai adhd coach"
"app to help me start tasks"
"app that tells me what to do next"
"adhd focus app"
```

**AG2. Can't start / task paralysis** → `https://ankorahq.com/guides/why-you-cant-start-tasks/` (A/B vs `/stuck`)
```
"task paralysis"
"how to overcome task paralysis"
"adhd task paralysis"
"can't start tasks"
"can't make myself do anything"
"paralyzed by my to do list"
```

**AG3. Procrastination / boring tasks** → `https://ankorahq.com/guides/task-paralysis-vs-procrastination/`
```
"how to stop procrastinating adhd"
"how to do boring tasks adhd"
"how to make myself do boring tasks"
"adhd procrastination help"
```

**AG4. Body doubling / accountability** → `https://ankorahq.com/guides/what-is-body-doubling/`
```
"body doubling app"
"virtual body doubling"
"adhd body doubling"
"body double for work"
```

**AG5. Overwhelm / mental load** (optional) → `https://ankorahq.com/stuck` (or `/quiz/` once live)
```
"too much to do overwhelmed"
"brain dump app"
"get everything out of my head"
"how to deal with mental load"
```

## Appendix B: Negative keywords (campaign-level shared list, add day one)

```
free, crack, torrent, pdf, reddit, meaning, definition, symptoms, test, quiz,
diagnosis, "do i have", "is it adhd", medication, adderall, vyvanse, jobs, salary,
movie, film, prosthetic, stunt, actor, child, children, kids, meme, book, youtube
```
Notes: `movie/film/stunt/actor/prosthetic` kill the film meaning of "body doubling." `quiz/test/diagnosis` searchers want self-diagnosis, not a purchase, so exclude them here even though you have a quiz (that's for social + as an ad landing, not for capturing "adhd quiz" search traffic).

## Appendix C: Ad copy (Responsive Search Ads)

Google limits: headlines **≤30 chars**, descriptions **≤90 chars**. Aim for ~10 headlines + 3-4 descriptions per ad group (it mixes them). Keep the voice: no em-dashes, "to-do" hyphenated, warm and direct. All of the below are within limits.

**Shared headlines (reuse in every ad group):**
```
One Clear Next Step
Not a To-Do List. A Coach.
For ADHD Brains
Free to Start, $5/mo Pro
It Remembers How You Work
Get Unstuck in 10 Minutes
Works on Any Device
```

**AG1 (ADHD coach/app) headlines:**
```
Start the Thing You Avoid
AI Coach That Gets You Going
Your Anti-Freeze Coach
Stop Rewriting the Same List
```
**AG1 descriptions:**
```
Tell Ankora the thing you're dreading. Get one small step you can start right now.
Not another to-do list. A coach that gets you moving and stays with you.
Dump the overwhelm, get one clear next step, and keep going. Free, 25 messages a day.
```

**AG2 (task paralysis) headlines:**
```
Frozen on a Task? Start Here
Break the Wall Into One Step
When You Can't Begin
Meet Your Anti-Freeze Coach
```
**AG2 descriptions:**
```
When the task feels massive, Ankora hands you one step small enough to start.
For the brain that freezes on a task it can't begin. First ten minutes, handled.
Not another to-do list. One next step, then a coach that stays with you.
```

**AG3 (procrastination/boring) headlines:**
```
Make the Boring Task a Game
Do the Task You Keep Dodging
Beat Boring-Task Avoidance
```
**AG3 descriptions:**
```
The boring task loses to the easy one. Ankora makes it a 5-minute race.
Turn the task you keep dodging into a quick win, then keep the momentum.
```

**AG4 (body doubling) headlines:**
```
Body Doubling On Demand
Someone in It With You
Focus Company for Real Work
```
**AG4 descriptions:**
```
Body doubling without scheduling a call. Ankora sits with you and keeps you going.
Start together, stay on task. A focus partner that remembers how you work.
```

**AG5 (overwhelm/mental load) headlines:**
```
Too Much to Do? Start Here
Get It Out of Your Head
One Next Move, Not the Pile
```
**AG5 descriptions:**
```
Dump everything swirling in your head. Ankora hands back the one thing to do next.
Stop being the household's RAM. Capture it all in one place and get reminded.
```

## Appendix D: Quiz reference

**File:** `landing/quiz/index.html` → deploys to `ankorahq.com/quiz/`.

**The four stuck styles** (each maps to a real demo example + feature):

| Type | Pattern | Ankora handoff |
|------|---------|----------------|
| The Freezer | One big task feels like a wall | First-step breakdown |
| The Flooded | Too many things at once, shutdown | One next move / regroup |
| The Magpie | Boring loses to easy/interesting | 5-minute timer game |
| The Juggler | Holds it all in their head | Capture + reminders + memory |

**Scoring:** tally across 7 questions, highest wins; ties broken by the Q5 answer ("what would help most"), then a fixed priority order.

**Tracking (already wired):**
- PostHog events: `quiz_start`, `quiz_answer`, `quiz_result`, `quiz_cta_click`, `quiz_share_click`.
- Person property `quiz_archetype` rides the shared `.ankorahq.com` distinct_id into the app, so the quiz → signup funnel is splittable by stuck style in PostHog.
- Result CTAs are tagged `utm_source=quiz&utm_medium=quiz&utm_campaign=<archetype>`.
- GA4: fires a `quiz_complete` event with the archetype.

**Two ways to use it:**
1. As the **ad destination**, A/B'd against the static landing (quiz funnels usually out-convert static pages; people who answered 7 questions are invested by signup).
2. As a **shareable TikTok / IG asset** ("I'm a Freezer, what are you?"). The result screen has a native share button.
