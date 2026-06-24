// ──────────────────────────────────────────────────────────
// ANKORA — A thinking partner for overwhelmed high achievers · v3
// The Anthropic API key now lives server-side in /api/chat.js.
// Set ANTHROPIC_KEY (NOT VITE_ANTHROPIC_KEY) in your Vercel env vars.
// ──────────────────────────────────────────────────────────

import { useState, useRef, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient";
import posthog from "posthog-js";

const STORAGE_KEY = "addie-app-state-v1";
const TIMER_KEY = "addie-timer-v1";
const PROFILE_KEY = "addie-profile-v1";
const MIGRATED_KEY = "addie-migrated-v1"; // which account this device has already merged its local data into
const IDLE_RESET_MS = 60 * 60 * 1000;
// How many past sessions to show inline on the home screen before "See all"
// hands off to the full archive overlay — keeps the landing from scrolling forever.
const HOME_RECENT_LIMIT = 4;

// Read this device's locally-stored data (the pre-accounts data, or offline cache).
function readLocalData() {
  let tasks = [], grocery = [], profile = null, messages = [], reminders = [], memory = [], notes = "";
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) { const s = JSON.parse(raw); if (Array.isArray(s.tasks)) tasks = s.tasks; if (Array.isArray(s.grocery)) grocery = s.grocery; if (Array.isArray(s.messages)) messages = s.messages; if (Array.isArray(s.reminders)) reminders = s.reminders; if (Array.isArray(s.memory)) memory = s.memory; if (typeof s.notes === "string") notes = s.notes; }
  } catch {}
  try {
    const praw = window.localStorage.getItem(PROFILE_KEY);
    if (praw) profile = JSON.parse(praw);
  } catch {}
  return { tasks, grocery, profile, messages, reminders, memory, notes };
}

// Union two lists of {id,...} items, keeping every unique id. On id collision,
// the "primary" list's version wins (so already-synced cloud edits aren't undone).
function mergeById(primary = [], secondary = []) {
  const seen = new Set((primary || []).map(i => i.id));
  return [...(primary || []), ...(secondary || []).filter(i => !seen.has(i.id))];
}

function profileHasContent(p) {
  return !!(p && (p.style || p.pattern || (p.context && p.context.trim())));
}

// Stable string snapshot of the synced data, used to dedupe saves and to
// ignore the echo of our own writes coming back over Realtime.
function snapshotJson(tasks, grocery, profile, messages = [], sessions = [], reminders = [], memory = [], notes = "") {
  return JSON.stringify({ tasks: tasks||[], grocery: grocery||[], profile: profile||null, messages: messages||[], sessions: sessions||[], reminders: reminders||[], memory: memory||[], notes: notes||"" });
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// First-launch onboarding — quick, skippable. Seeds Addie's tone; she adapts from there.
const ONBOARD_STYLE = [
  { value: "direct", label: "Cut to the chase", hint: "Give me the answer, skip the preamble" },
  { value: "explore", label: "Talk it through first", hint: "Help me think out loud before deciding" },
];
const ONBOARD_PATTERN = [
  { value: "starting",  label: "Getting started",     emoji: "🚧" },
  { value: "finishing", label: "Finishing things",    emoji: "🏁" },
  { value: "volume",    label: "Too much at once",    emoji: "🌀" },
  { value: "time",      label: "Losing track of time", emoji: "⏳" },
];

const PROFILE_LABELS = {
  style:   Object.fromEntries(ONBOARD_STYLE.map(o => [o.value, o.label])),
  pattern: Object.fromEntries(ONBOARD_PATTERN.map(o => [o.value, o.label])),
};

const STARTERS = [
  { icon: "🌅", label: "Morning check-in", prompt: "Morning check-in" },
  { icon: "🧠", label: "Brain dump", prompt: "I need to brain dump everything on my mind." },
  { icon: "🚧", label: "I'm stuck", prompt: "I've been staring at a task and can't start. Help." },
  { icon: "🌀", label: "I'm overwhelmed", prompt: "Everything feels urgent. I don't know where to begin." },
  { icon: "🌙", label: "Wind-down", prompt: "Help me wind down and close out the day." },
  { icon: "💭", label: "Help me figure this out", prompt: "I want to figure something out and could use your take. Let me explain what's going on." },
];

const MAX_TODAY = 3;
const TIMER_PRESETS = [10, 15, 25, 45];

// Stable fingerprint of a suggestion chip. Used both to dedupe re-suggested cards
// against what's already waiting AND to remember which cards the user already
// confirmed/skipped, so an identical re-suggestion from the model doesn't reappear.
const suggestionSig = (s) => `${s.type}|${s.targetId||""}|${s.text||s.title||""}|${s.when||""}|${s.minutes||""}`;

const BUCKET_STYLE = {
  today:  { bg: "#FEF2F2", text: "#B91C1C", label: "Today" },
  week:   { bg: "#FFFBEB", text: "#92400E", label: "This week" },
  parked: { bg: "#F3F4F6", text: "#4B5563", label: "Parked" },
};

const C = {
  bg: "#ffffff", bg2: "#F9FAFB", border: "#9CA3AF", borderLt: "#E5E7EB",
  text: "#111827", text2: "#6B7280", text3: "#9CA3AF",
  // Brand indigo-purple (the logo's night sky) is the primary color. The "blue*"
  // token NAMES are kept so all existing UI inherits it, but the VALUES are now the
  // brand purple. Real iMessage blue lives on in `bubble` for chat bubbles only.
  blue: "#2D2553", blueBg: "#EDEBF5", blueText: "#2D2553", blueBorder: "#CFC9E6",
  bubble: "#0B84FE",
  // Sunset orange accent (the logo's horizon). accentText is the darker shade that
  // stays readable as small text or white-on-orange fills.
  accent: "#E07848", accentBg: "#FFF0E7", accentText: "#B45129", accentBorder: "#F5C4B3",
  green: "#059669", greenBg: "#D1FAE5", greenText: "#065F46",
  danger: "#DC2626", dangerBg: "#FEF2F2",
  indigo: "#4F46E5", indigoBg: "#EEF2FF", indigoLight: "#6366F1",
};

function buildProfileBlock(profile) {
  if (!profile) return "";
  const parts = [];
  if (profile.style)   parts.push(`- Prefers: ${profile.style === "direct" ? "directness — cut to the chase, lead with the answer, keep preamble short" : "thinking it through — talk things out before landing on a decision"}`);
  if (profile.pattern) {
    const map = {
      starting:  "getting started — the hardest part for them is beginning. Offer the smallest possible first step and time-boxing.",
      finishing: "finishing — they start strong but stall before the end. Help them close loops and define 'done'.",
      volume:    "too much at once — they get overwhelmed by volume. Help them triage to one thing at a time.",
      time:      "time blindness — they lose track of time. Be concrete about durations and gently surface timers.",
    };
    parts.push(`- Struggles most with: ${map[profile.pattern]}`);
  }
  if (profile.context && profile.context.trim()) parts.push(`- Context / what's on their plate: ${profile.context.trim()}`);
  if (!parts.length) return "";
  return `\n\nUSER PROFILE (from onboarding — use to shape your tone and suggestions from the first message):\n${parts.join("\n")}\n\nADAPT OVER TIME: This profile is a starting point, not a cage. If the user gives a clear signal mid-conversation — "you're being too wordy," "just tell me what to do," "slow down," visible frustration — honor it and adjust your style for the rest of the session. Don't silently re-profile them on a whim; respond to explicit cues. They can change these preferences anytime in Settings.`;
}

function buildSystemPrompt(tasks, grocery, profile, memory = [], notes = "", calendar = []) {
  const now = new Date();
  const fmtFull = (d) => d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const fmtISO  = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate()+1);
  const fmtClock = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const tzName = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "local time"; } })();
  const localIso = `${fmtISO(now)}T${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  const todayDate = `${fmtFull(now)} (${fmtISO(now)})`;
  const tomorrowDate = `${fmtFull(tomorrow)} (${fmtISO(tomorrow)})`;
  const today  = tasks.filter(t => t.bucket === "today"  && !t.done);
  const week   = tasks.filter(t => t.bucket === "week"   && !t.done);
  const parked = tasks.filter(t => t.bucket === "parked" && !t.done);
  // "Done today" must mean done TODAY — not every task ever completed. Tasks
  // stamp completedAt when checked off; anything without it (or from a prior
  // day) is excluded so morning check-ins don't recycle yesterday's wins.
  const todayStr = fmtISO(now);
  const done   = tasks.filter(t => t.done && t.completedAt && fmtISO(new Date(t.completedAt)) === todayStr);
  const gItems = grocery.filter(g => !g.checked);
  const withNext = tasks.filter(t => t.nextStep && !t.done);
  const memList = (memory || []).filter(m => m && m.text);
  const memoryBlock = memList.length
    ? `\n\nWHAT YOU'VE LEARNED ABOUT THIS USER (durable memory carried across every session — use it to personalize naturally; do NOT recite it back like a list or announce that you remember):\n${memList.map(m => `- ${m.text}`).join("\n")}`
    : "";
  // The user's freeform notepad — only included when they've opted in via Settings.
  const notesBlock = (profile?.notesReadable && notes && notes.trim())
    ? `\n\nTHE USER'S NOTEPAD (they've chosen to let you read this — their own freeform notes; reference it when relevant, don't recite it back wholesale or treat every line as a task):\n${notes.trim()}`
    : "";
  // Upcoming calendar events the user subscribed Addie to (read-only, next 7 days).
  const calList = (calendar || []).filter(e => e && e.title);
  const calendarBlock = calList.length
    ? `\n\nUSER'S UPCOMING CALENDAR (next 7 days, read from their subscribed calendar — use it to understand what's going on in their life and plan realistically around it; do NOT list it back unless asked, and you can't edit it):\n${calList.map(e => `- ${e.when}: ${e.title}`).join("\n")}`
    : "";

  return `You are Ankora, a warm, direct, no-nonsense thinking partner for overwhelmed high achievers — including people with ADHD. Your job is to help them regroup, get clear on what matters now, and maintain momentum. Not a task manager, not a therapist.

Right now it is ${fmtClock(now)} (${tzName}; current local datetime ${localIso}). Today is ${todayDate}. Tomorrow is ${tomorrowDate}.${buildProfileBlock(profile)}${memoryBlock}${notesBlock}${calendarBlock}

Be DECISIVE when someone needs an answer or is ready to act — give your best take in one shot rather than dragging a question across many turns. One clarifying question is fine; three is too many.

But READ THE MOMENT — decisiveness is not the same as being blunt or transactional. When someone is struggling, venting, frustrated, or overwhelmed, slow down and meet them there first: acknowledge how it feels, dig a little deeper to understand what's really going on, and normalize it ("this is really common — a lot of people hit exactly this wall"). Then, when they're ready, help break it into a small, manageable next step. The empathy and the decisiveness work together: understand first, then point the way. Don't rush a struggling person toward a solution before they feel heard, and don't over-explain to someone who just wants a quick answer.

LIVE DATE & TIME: You know the current local date AND clock time (stated at the top). You can and MUST compute any relative date or time yourself from them — "tomorrow," "this Friday," "next Monday," "in 3 days," "next week," "end of the month," "in 2 minutes," "in an hour," "this afternoon," "tonight." NEVER say or imply you don't know the current time or date, and never ask the user what it is — you have everything needed to work it out. When emitting a calendar event or reminder, resolve it to a concrete datetime by anchoring on the current local datetime stated above (e.g. "in 2 minutes" = that datetime plus two minutes).

NEVER guess external facts you don't know — store hours, prices, someone else's appointment time, a venue's address. (This is different from the current clock time and relative dates, which you DO know and CAN compute from the values stated above.) "Memorial Day" is the last Monday of May; "July 4th" is July 4th; never substitute one for another. If an external fact isn't stated and you can't derive it, ask rather than fabricate.

CURRENT TASK MEMORY:
Today (max 3): ${today.length ? today.map(t=>`"${t.text}" [id:${t.id}]${t.nextStep?` [next:"${t.nextStep}"]`:""}`).join(", ") : "empty"}
This week: ${week.length ? week.map(t=>`"${t.text}" [id:${t.id}]${t.nextStep?` [next:"${t.nextStep}"]`:""}`).join(", ") : "empty"}
Parked: ${parked.length ? parked.map(t=>`"${t.text}" [id:${t.id}]`).join(", ") : "empty"}
Done today: ${done.length ? done.map(t=>`"${t.text}"`).join(", ") : "none"}

TASKS WITH PENDING NEXT STEPS:
${withNext.length ? withNext.map(t=>`- "${t.text}" → next: "${t.nextStep}" [id:${t.id}]`).join("\n") : "none"}

GROCERY: ${gItems.length ? gItems.map(g=>`"${g.text}"${g.store?` (from ${g.store})`:""} [id:${g.id}]`).join(", ") : "Empty"}
SLOT COUNT (authoritative): Today has ${today.length} of ${MAX_TODAY} task slots filled, leaving ${Math.max(0, MAX_TODAY-today.length)} open${today.length>=MAX_TODAY?" (Today is FULL)":""}. If the user asks how many slots are left, state exactly this open number. Do NOT recompute or estimate it yourself, and do not contradict it.

When the user explicitly says they finished or completed something on the board, MARK IT DONE via the SUGGESTIONS block — don't just verbally acknowledge. NEVER suggest type:complete for something the user said they didn't do, couldn't start, skipped, or hasn't done yet.

MOVING A TASK BETWEEN BUCKETS: When the user wants to move an existing task to a different bucket — "move the research 3D class task to today," "bump this to this week," "park that" — use type:move with the task's [id] and the target bucket (today/week/parked). Do NOT express a move as a type:nextstep (a next step is a concrete action, never "move to today") and do NOT recreate the task with type:task. Copy the [id] from CURRENT TASK MEMORY.

TASKS vs NEXT STEPS: A task on the board is the thing the user wants done (e.g. "Plan Q3 offsite"). A "next step" is the single concrete action that moves that task forward right now (e.g. "Email venue for availability"). When the user describes the immediate action for a task ALREADY on the board, attach it with type:nextstep to that task's id — do NOT create a brand-new task for it. Only use type:task when it's genuinely a new, separate thing not represented on the board. Before adding a task, check CURRENT TASK MEMORY above — if it's the same as or a sub-action of something already there, use nextstep instead.

A focus timer exists. When someone's stuck starting something, casually offer time-boxing ("want to give this 15 minutes?"). When the user asks you to start a timer, include a type:timer suggestion in the SUGGESTIONS block.

CALENDAR HANDOFF: When the user asks to schedule something or a specific date+time emerges, you MUST include a type:calendar suggestion in the SUGGESTIONS block. This is the ONLY way an event reaches their calendar — you cannot add it yourself. NEVER claim it's "done," "added," "scheduled," or "on your calendar" in prose without emitting the type:calendar line in the SAME reply; saying so without the suggestion is a broken promise to the user. If they asked for it, emit it now — don't wait to be asked twice. Only concrete date+time qualifies (not vague stuff like "later today"). Resolve relative dates to a concrete date and always use the correct current year (${new Date().getFullYear()} unless the user clearly means a different year).

REMINDERS: When the user asks to be reminded of something at a future time or rough period ("remind me to call mom tomorrow night," "nudge me about the deposit mid next week afternoon"), include a type:reminder suggestion. A reminder sends a push notification at that time — it is NOT a calendar event and NOT a board task. Resolve any vague/relative time to a concrete local datetime, choosing a sensible specific hour: morning≈09:00, afternoon≈14:00, evening≈19:00, "mid next week"≈the coming Wednesday. Only use type:reminder when there is a time to fire at; use type:calendar for events with a place/duration, and type:task for to-dos with no specific reminder time. As with calendar, NEVER claim you've set a reminder in prose without emitting the type:reminder line in the same reply.

REMEMBERING THE USER: You build a lasting understanding of this person across sessions. Whenever you learn a durable fact about WHO THIS PERSON IS or the life they're living, capture it with a type:remember suggestion — don't be shy about it. This explicitly includes stable life context: where they live ("lives in Okinawa"), their job or role, the important people in their life (partner, kids, pets, boss by name), their time zone or working hours, health or accessibility needs, and ongoing constraints. It also includes meaningful goals ("training for an October marathon"), recurring struggles ("email is the overwhelm trigger"), important people or hard deadlines ("Q3 board deck is the make-or-break"), and stable working preferences ("focuses best early morning"). If the user states a fact about themselves that would still be true next week and would help you help them, save it — a single durable fact like where they live is worth remembering even from a passing mention. It saves silently and quietly; you do NOT need to announce it or ask permission. Guidelines: only durable facts about the PERSON, not fleeting state, today's mood, or anything already captured as a task/grocery/reminder. Keep each memory one short, self-contained sentence. Do NOT re-save something already shown in WHAT YOU'VE LEARNED ABOUT THIS USER above.

UPDATING vs CREATING: When the user wants to CHANGE something already on the board or grocery list — reword it, swap it, correct it, retime it, narrow or expand its scope ("make that 2% milk not whole," "change 'call dentist' to 'book dentist for cleaning'," "actually that task is about the Q3 deck not Q2") — EDIT the existing item in place by its [id]. Use type:replace for an existing TASK and type:grocery-replace for an existing GROCERY item. type:replace can also update the next step via next:"…". Copy the [id] exactly from CURRENT TASK MEMORY / GROCERY above. You CAN edit a task — never tell the user to delete it and add a new one, and never delete-then-recreate it yourself; that loses its history and makes them do extra work. Editing is always one type:replace. Do NOT emit type:task or type:grocery (which create brand-new items) when the user is modifying something that already exists. Only create new when it's genuinely a new, separate item.

SUGGESTION FORMAT:

SUGGESTIONS:
- type:task | bucket:today | "task text"
- type:task | bucket:week | "task text"
- type:task | bucket:parked | "task text"
- type:grocery | "item name"
- type:grocery | "item name" | store:"store or place"
- type:grocery-replace | id:GROCERY_ID | "new item name"
- type:grocery-replace | id:GROCERY_ID | "new item name" | store:"store or place"
- type:grocery-remove | id:GROCERY_ID
- type:replace | id:TASK_ID | "updated task text"
- type:replace | id:TASK_ID | "updated task text" | next:"what comes after"
- type:nextstep | id:TASK_ID | "next step text"
- type:move | id:TASK_ID | bucket:today
- type:complete | id:TASK_ID
- type:calendar | "event title" | when:"YYYY-MM-DDTHH:MM" | minutes:60
- type:reminder | "what to remind them about" | when:"YYYY-MM-DDTHH:MM"
- type:timer | minutes:15 | label:"what the timer is for"
- type:remember | "one short durable fact about the user"

Rules: Before emitting any suggestion, CHECK CURRENT TASK MEMORY, GROCERY, and Done today above. Never re-suggest adding a task or grocery item that's already listed there, and never suggest type:complete for something already in Done today — those actions are already taken. When the user is picking a conversation back up later, assume the suggestions you offered earlier were acted on; don't re-offer the same add/complete/reminder again unless they ask. Emit AS MANY suggestions as the conversation genuinely calls for — there is no fixed limit. If the user lists six things to add, emit six. If they ask for three calendar events, emit three. Don't pad with suggestions they didn't ask for, and don't artificially trim ones they did. Never use type:replace/grocery-replace if the new text is the same as or nearly identical to the existing item. If Today is full, suggest week. Omit the entire SUGGESTIONS block if nothing to add.

ADVICE MODE: Sometimes the user just wants to think something through. Engage substantively, give ADHD-aware advice, don't pivot to tasks unless something concrete genuinely emerges.

STYLE: Warm, direct, short paragraphs. Bold one key action with **bold**. No "just do X." No shame. Acknowledge wins. Smallest physical first step when stuck.`;
}

export default function Ankora() {
  const [tab, setTab] = useState("chat");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);
  const [lastActivity, setLastActivity] = useState(Date.now());
  const [tasks, setTasks] = useState([]);
  const [grocery, setGrocery] = useState([]);
  const [pending, setPending] = useState([]);
  const [toast, setToast] = useState(null);
  const [newTask, setNewTask] = useState("");
  const [newBucket, setNewBucket] = useState("today");
  const [newGrocery, setNewGrocery] = useState("");
  const [newStore, setNewStore] = useState("");
  const [newMemory, setNewMemory] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [menuId, setMenuId] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const [timer, setTimer] = useState(null);
  const [pastExpanded, setPastExpanded] = useState(false);
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [parkedExpanded, setParkedExpanded] = useState(true);
  const [timerAlert, setTimerAlert] = useState(false);
  const [notifPermission, setNotifPermission] = useState("default");
  const [profile, setProfile] = useState(null);          // { style, pattern, context }
  const [onboarded, setOnboarded] = useState(true);      // assume true until hydration says otherwise
  const [onboardDraft, setOnboardDraft] = useState({ style: "", pattern: "", context: "" });
  const [showSettings, setShowSettings] = useState(false);
  // ── Auth + cloud sync ──
  const [session, setSession] = useState(null);     // Supabase session, or null when signed out
  const [authLoading, setAuthLoading] = useState(true);
  const [cloudLoaded, setCloudLoaded] = useState(false); // true once this user's row is fetched
  const [authEmail, setAuthEmail] = useState("");
  const [authSent, setAuthSent] = useState(false);  // OTP sent → show code entry
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpVerifying, setOtpVerifying] = useState(false);
  const [authMode, setAuthMode] = useState("code");        // "code" | "password" — sign-in method on the login screen
  const [authPassword, setAuthPassword] = useState("");    // password entered on the login screen
  const [newPassword, setNewPassword] = useState("");      // set/change password from Settings
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState("");
  const [subscription, setSubscription] = useState(null); // null=unknown, 'free', 'active'
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState("annual");   // which plan is highlighted in the upgrade modal
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [reminders, setReminders] = useState([]);          // chat-scheduled push reminders
  const [remindersExpanded, setRemindersExpanded] = useState(true);
  const [memory, setMemory] = useState([]);                // durable facts Addie learns about the user
  const [notes, setNotes] = useState("");                  // freeform personal notepad (synced, private to user)
  const [calEvents, setCalEvents] = useState([]);          // upcoming events read from a subscribed iCal URL
  const [calStatus, setCalStatus] = useState("idle");      // idle | loading | ok | error
  const [calError, setCalError] = useState("");
  const [calendarApp, setCalendarApp] = useState(() => { try { return window.localStorage.getItem("addie-calendar-app") || ""; } catch { return ""; } }); // remembered per-device calendar choice
  const [pendingCal, setPendingCal] = useState(null);      // event awaiting a calendar-app pick (chooser open when set)
  const [viewingSession, setViewingSession] = useState(null);
  const [showHistory, setShowHistory] = useState(false);   // history overlay during active chat
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearBackup, setClearBackup] = useState(null);   // snapshot for undo after clearing
  const [customMin, setCustomMin] = useState("");          // custom timer length input
  const [timerLabel, setTimerLabel] = useState("");        // optional name for a self-started timer
  const [installPrompt, setInstallPrompt] = useState(null);// captured beforeinstallprompt event
  const [showInstall, setShowInstall] = useState(false);   // show "add to home screen" banner
  const [showNotifHelp, setShowNotifHelp] = useState(false);// expand notif fix-it steps
  const bottomRef = useRef(null);
  const taRef = useRef(null);
  const timerRef = useRef(null);
  const bodyScrollRef = useRef(null);
  const chatScrollRef = useRef(null);
  const wakeLockRef = useRef(null);
  const pendingPushIdRef = useRef(null);
  const alarmLoopRef = useRef(null);
  // Signatures of suggestion cards the user has acted on (confirmed or skipped)
  // in the current conversation, so the model re-suggesting the same thing won't
  // make a handled card pop back up. Reset when the conversation resets.
  const actedSigsRef = useRef(new Set());
  // Store the absolute end time so backgrounding doesn't affect accuracy
  const timerEndTimeRef = useRef(null);
  // JSON of the last data we synced (saved or received), to dedupe + ignore echoes.
  const lastSyncedRef = useRef(null);

  // Detect platform for backup alarm link
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isAndroid = /Android/.test(navigator.userAgent);
  const isStandalone = typeof window !== "undefined" && !!(window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone);

  // Once notifications are denied, browsers can't re-prompt or open settings for
  // the user — so give exact, platform- and install-aware steps to fix it by hand.
  const notifFixSteps = () => {
    if (isIOS && !isStandalone) return {
      lead: "On iPhone, alarms only work once Ankora is added to your Home Screen:",
      steps: ["Tap the Share button in your browser bar", "Choose 'Add to Home Screen'", "Open Ankora from the new icon, then tap Allow when asked"],
    };
    if (isIOS) return {
      lead: "Re-enable notifications in your iPhone Settings:",
      steps: ["Open the Settings app", "Scroll down and tap Ankora", "Turn on Allow Notifications"],
    };
    if (isAndroid && isStandalone) return {
      lead: "Re-enable notifications for the Ankora app:",
      steps: ["Press and hold the Ankora icon, then tap App info (ⓘ)", "Tap Notifications", "Turn notifications on"],
    };
    if (isAndroid) return {
      lead: "Re-enable notifications in Chrome:",
      steps: ["Tap the icon to the left of the web address", "Tap Permissions → Notifications", "Choose Allow, then reload the page"],
    };
    return {
      lead: "Re-enable notifications in your browser:",
      steps: ["Click the icon to the left of the web address (lock or tune)", "Set Notifications to Allow", "Reload the page"],
    };
  };
  const renderNotifSteps = (color = "#92400E") => {
    const { lead, steps } = notifFixSteps();
    return (
      <>
        <p style={{ margin:"0 0 4px", fontSize:12, color, lineHeight:1.45, fontWeight:600 }}>{lead}</p>
        <ol style={{ margin:0, paddingLeft:18 }}>
          {steps.map((s, i) => <li key={i} style={{ fontSize:12, color, lineHeight:1.5 }}>{s}</li>)}
        </ol>
      </>
    );
  };

  // Install-to-home-screen prompt (PWA). Android/Chrome fires beforeinstallprompt;
  // iOS has no such event, so we show manual Share→Add to Home Screen instructions.
  useEffect(() => {
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone;
    let dismissed = false;
    try { dismissed = window.localStorage.getItem("addie_install_dismissed") === "1"; } catch {}
    if (standalone || dismissed) return;
    const onBIP = (e) => { e.preventDefault(); setInstallPrompt(e); setShowInstall(true); };
    window.addEventListener("beforeinstallprompt", onBIP);
    if (isIOS) setShowInstall(true);
    return () => window.removeEventListener("beforeinstallprompt", onBIP);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const doInstall = async () => {
    if (!installPrompt) return;
    try { installPrompt.prompt(); await installPrompt.userChoice; } catch {}
    setInstallPrompt(null); setShowInstall(false);
  };
  const dismissInstall = () => {
    setShowInstall(false);
    try { window.localStorage.setItem("addie_install_dismissed", "1"); } catch {}
  };

  // Play a tone via WebAudio — works on foreground user-gesture contexts
  const playTone = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const playNote = (freq, start, duration) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = "sine";
        gain.gain.setValueAtTime(0, ctx.currentTime + start);
        gain.gain.linearRampToValueAtTime(0.4, ctx.currentTime + start + 0.02);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + start + duration);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + duration + 0.05);
      };
      // Three-note chime: C5 → E5 → G5
      playNote(523, 0,    0.25);
      playNote(659, 0.28, 0.25);
      playNote(784, 0.56, 0.5);
      // Repeat once
      playNote(523, 1.2,  0.25);
      playNote(659, 1.48, 0.25);
      playNote(784, 1.76, 0.5);
    } catch {}
  };

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.tasks) setTasks(s.tasks);
        if (s.grocery) setGrocery(s.grocery);
        if (s.messages) setMessages(s.messages);
        if (Array.isArray(s.sessions)) setSessions(s.sessions);
        // Drop reminders more than a day past so the list doesn't grow forever.
        if (Array.isArray(s.reminders)) setReminders(s.reminders.filter(r => new Date(r.when).getTime() > Date.now() - 864e5));
        if (Array.isArray(s.memory)) setMemory(s.memory);
        if (typeof s.notes === "string") setNotes(s.notes);
        if (s.lastActivity) setLastActivity(s.lastActivity);
        // If there's a recent, unfinished conversation, drop the user straight back
        // into it instead of the welcome screen + "Continue where you left off".
        // After a long gap (idle), fall back to the fresh-start landing view.
        const recentConvo = Array.isArray(s.messages) && s.messages.length > 0
          && s.lastActivity && (Date.now() - s.lastActivity <= IDLE_RESET_MS);
        setStarted(!!recentConvo);
        setPastExpanded(!!recentConvo);
      }
    } catch {}
    try {
      const praw = window.localStorage.getItem(PROFILE_KEY);
      if (praw) {
        const p = JSON.parse(praw);
        setProfile(p);
        setOnboarded(true);
      } else {
        setOnboarded(false);   // first launch — show onboarding card
      }
    } catch { setOnboarded(false); }
    if ("Notification" in window) setNotifPermission(Notification.permission);
    setHydrated(true);

    // Handle return from Stripe Checkout
    const params = new URLSearchParams(window.location.search);
    if (params.get("payment") === "success" || params.get("payment") === "canceled") {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  // Register service worker on mount (needed for background push)
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  // When user signs in and already has notification permission, resubscribe push
  useEffect(() => {
    if (session?.user?.id && notifPermission === "granted") subscribeToPush();
  }, [session?.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!hydrated) return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tasks, grocery, messages, sessions, reminders, memory, notes, lastActivity })); } catch {}
  }, [tasks, grocery, messages, sessions, reminders, memory, notes, lastActivity, hydrated]);

  // ── Keep the Android/iOS back gesture INSIDE the app. ──
  // Pixel gesture-nav fires the browser's Back on edge swipes, which exits a PWA.
  // We seed a history entry and, on Back, close the top overlay or fall back to the
  // chat home. Only a deliberate double-back from the bare home screen exits.
  const backUiRef = useRef({});
  backUiRef.current = { tab, showSettings, showHistory, viewingSession, showUpgrade, showClearConfirm, pendingCal, showInstall };
  const lastHomeBackRef = useRef(0);
  useEffect(() => {
    const reseed = () => { try { window.history.pushState({ addie: 1 }, ""); } catch {} };
    reseed();
    const onPop = () => {
      const u = backUiRef.current;
      if (u.pendingCal)       { setPendingCal(null);       reseed(); return; }
      if (u.showClearConfirm) { setShowClearConfirm(false); reseed(); return; }
      if (u.showInstall)      { setShowInstall(false);      reseed(); return; }
      if (u.showUpgrade)      { setShowUpgrade(false);      reseed(); return; }
      if (u.viewingSession)   { setViewingSession(null);    reseed(); return; }
      if (u.showHistory)      { setShowHistory(false);      reseed(); return; }
      if (u.showSettings)     { setShowSettings(false);     reseed(); return; }
      if (u.tab !== "chat")   { setTab("chat");             reseed(); return; }
      // Bare home: require a second back within 2s to actually exit the app.
      if (Date.now() - lastHomeBackRef.current < 2000) return; // let it exit (no reseed)
      lastHomeBackRef.current = Date.now();
      showToast("Swipe back again to exit");
      reseed();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auth: track the Supabase session ──
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      setAuthLoading(false);
      if (s?.user) {
        posthog.identify(s.user.id, { email: s.user.email });
        if (event === "SIGNED_IN") posthog.capture("signed_in");
      } else if (event === "SIGNED_OUT") {
        posthog.reset();
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // ── Cloud load: when a user signs in, pull their data from Supabase. ──
  // If they have no cloud row yet (first sign-in), migrate whatever is in
  // localStorage up to the cloud once, then treat the cloud as the source of truth.
  useEffect(() => {
    if (!session) { setCloudLoaded(false); return; }
    let cancelled = false;
    (async () => {
      const [{ data, error }, { data: subData }] = await Promise.all([
        supabase.from("user_data").select("tasks, grocery, profile, messages, sessions, reminders, memory").eq("user_id", session.user.id).maybeSingle(),
        supabase.from("subscriptions").select("status").eq("user_id", session.user.id).maybeSingle(),
      ]);
      if (cancelled) return;

      if (error) {
        // Network/permission issue — fall back to whatever loaded from localStorage
        // so the app still works offline. We'll sync again on the next change.
        showToast("Couldn't reach the cloud — working offline");
        setCloudLoaded(true);
        return;
      }

      const cloudTasks    = Array.isArray(data?.tasks)    ? data.tasks    : [];
      const cloudGrocery  = Array.isArray(data?.grocery)  ? data.grocery  : [];
      const cloudProfile  = data?.profile || null;
      const cloudMessages = Array.isArray(data?.messages) ? data.messages : [];
      const cloudSessions = Array.isArray(data?.sessions) ? data.sessions : [];
      const cloudReminders = Array.isArray(data?.reminders) ? data.reminders : [];
      const cloudMemory = Array.isArray(data?.memory) ? data.memory : [];
      const cloudNotes = typeof data?.notes === "string" ? data.notes : "";

      // Has THIS device already contributed its local data to THIS account?
      let alreadyMigrated = false;
      try { alreadyMigrated = window.localStorage.getItem(MIGRATED_KEY) === session.user.id; } catch {}

      if (alreadyMigrated && data) {
        // Normal case: cloud is the source of truth for this device.
        setTasks(cloudTasks);
        setGrocery(cloudGrocery);
        if (cloudMessages.length > 0) setMessages(cloudMessages);
        setSessions(cloudSessions);
        setReminders(cloudReminders);
        setMemory(cloudMemory);
        setNotes(cloudNotes);
        if (cloudProfile) { setProfile(cloudProfile); setOnboarded(true); }
        else { setProfile(null); setOnboarded(false); }
        lastSyncedRef.current = snapshotJson(cloudTasks, cloudGrocery, cloudProfile, cloudMessages, cloudSessions, cloudReminders, cloudMemory, cloudNotes);
      } else {
        // First time this device signs into this account → merge its local data
        // into the cloud so nothing on this device is lost (union by id). Each
        // device does this exactly once, then syncs normally afterward.
        const local = readLocalData();
        const mergedTasks    = mergeById(cloudTasks, local.tasks);
        const mergedGrocery  = mergeById(cloudGrocery, local.grocery);
        const mergedProfile  = profileHasContent(cloudProfile) ? cloudProfile
                             : (profileHasContent(local.profile) ? local.profile : (cloudProfile || local.profile));
        // Migrate local messages to cloud on first sign-in if cloud is empty
        const mergedMessages = cloudMessages.length > 0 ? cloudMessages : (local.messages || []);
        const mergedSessions = cloudSessions;
        const mergedReminders = mergeById(cloudReminders, local.reminders);
        const mergedMemory = mergeById(cloudMemory, local.memory);
        // Notes are a single freeform string, not a list — keep cloud if it has
        // content, otherwise adopt whatever this device had locally.
        const mergedNotes = cloudNotes.trim() ? cloudNotes : (local.notes || "");

        setTasks(mergedTasks);
        setGrocery(mergedGrocery);
        if (mergedMessages.length > 0) setMessages(mergedMessages);
        setSessions(mergedSessions);
        setReminders(mergedReminders);
        setMemory(mergedMemory);
        setNotes(mergedNotes);
        if (mergedProfile) { setProfile(mergedProfile); setOnboarded(true); }
        else { setProfile(null); setOnboarded(false); }

        const { error: upErr } = await supabase.from("user_data").upsert({
          user_id: session.user.id,
          tasks: mergedTasks, grocery: mergedGrocery, profile: mergedProfile,
          messages: mergedMessages, sessions: mergedSessions, reminders: mergedReminders, memory: mergedMemory, notes: mergedNotes,
          updated_at: new Date().toISOString(),
        });
        if (!upErr) {
          try { window.localStorage.setItem(MIGRATED_KEY, session.user.id); } catch {}
        }
        lastSyncedRef.current = snapshotJson(mergedTasks, mergedGrocery, mergedProfile, mergedMessages, mergedSessions, mergedReminders, mergedMemory, mergedNotes);
      }
      setSubscription(subData?.status === "active" ? "active" : "free");
      setCloudLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [session?.user?.id]);

  // ── Cloud save: push tasks/grocery/profile up whenever they change. ──
  // Debounced to batch edits; ALSO flushed immediately when the app is hidden
  // (mobile browsers can freeze a pending timer and lose the write otherwise).
  // A ref holds the latest snapshot so out-of-render flushes never go stale.
  const latestRef = useRef({ tasks, grocery, profile, messages, sessions, reminders, memory, notes });
  useEffect(() => { latestRef.current = { tasks, grocery, profile, messages, sessions, reminders, memory, notes }; }, [tasks, grocery, profile, messages, sessions, reminders, memory, notes]);

  const saveToCloud = useCallback(() => {
    if (!session || !cloudLoaded) return;
    const d = latestRef.current;
    const json = snapshotJson(d.tasks, d.grocery, d.profile, d.messages, d.sessions, d.reminders, d.memory, d.notes);
    if (json === lastSyncedRef.current) return; // nothing changed since last sync (incl. our own echoes)
    lastSyncedRef.current = json;
    supabase.from("user_data").upsert({
      user_id: session.user.id,
      tasks: d.tasks, grocery: d.grocery, profile: d.profile, messages: d.messages, sessions: d.sessions, reminders: d.reminders, memory: d.memory, notes: d.notes,
      updated_at: new Date().toISOString(),
    }).then(({ error }) => {
      if (error) {
        console.warn("Cloud save failed:", error.message);
        showToast("Sync failed — changes saved on this device");
      }
    });
  }, [session, cloudLoaded]);

  // Debounced save on change.
  useEffect(() => {
    if (!session || !cloudLoaded) return;
    const t = setTimeout(saveToCloud, 500);
    return () => clearTimeout(t);
  }, [tasks, grocery, profile, messages, sessions, reminders, memory, notes, session, cloudLoaded, saveToCloud]);

  // Mobile-safe: save immediately when the app is hidden/closed.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "hidden") saveToCloud(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", saveToCloud);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", saveToCloud);
    };
  }, [saveToCloud]);

  // ── Live sync: apply changes pushed from this user's OTHER devices in real time. ──
  useEffect(() => {
    if (!session || !cloudLoaded) return;
    const channel = supabase
      .channel(`user_data:${session.user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "user_data", filter: `user_id=eq.${session.user.id}` },
        (payload) => {
          const row = payload.new;
          if (!row) return;
          const rTasks    = Array.isArray(row.tasks)    ? row.tasks    : [];
          const rGrocery  = Array.isArray(row.grocery)  ? row.grocery  : [];
          const rMessages = Array.isArray(row.messages) ? row.messages : [];
          const rSessions = Array.isArray(row.sessions) ? row.sessions : [];
          const rReminders = Array.isArray(row.reminders) ? row.reminders : [];
          const rMemory   = Array.isArray(row.memory)    ? row.memory    : [];
          const rNotes    = typeof row.notes === "string" ? row.notes : "";
          const rProfile  = row.profile || null;
          const incoming = snapshotJson(rTasks, rGrocery, rProfile, rMessages, rSessions, rReminders, rMemory, rNotes);
          // Ignore our own echo / anything identical to what we already have.
          if (incoming === lastSyncedRef.current) return;
          lastSyncedRef.current = incoming;
          setTasks(rTasks);
          setGrocery(rGrocery);
          if (rMessages.length > 0) setMessages(rMessages);
          setSessions(rSessions);
          setReminders(rReminders);
          setMemory(rMemory);
          setNotes(rNotes);
          if (rProfile) { setProfile(rProfile); setOnboarded(true); }
          else { setProfile(null); setOnboarded(false); }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [session?.user?.id, cloudLoaded]);

  const sendMagicLink = async () => {
    const email = authEmail.trim();
    if (!email || authBusy) return;
    setAuthBusy(true); setAuthError("");
    // emailRedirectTo keeps magic-link working on desktop/Android as a fallback.
    // On iOS PWA, users enter the 6-digit code instead (avoids Safari isolation issue).
    // Requires "Email OTP" enabled in Supabase Auth → Providers → Email settings.
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setAuthBusy(false);
    if (error) setAuthError(error.message);
    else { setAuthSent(true); setOtpCode(""); }
  };

  const verifyOtpCode = async () => {
    const email = authEmail.trim();
    const code = otpCode.trim();
    if (!email || code.length !== 6 || otpVerifying) return;
    setOtpVerifying(true); setAuthError("");
    const { error } = await supabase.auth.verifyOtp({ email, token: code, type: "email" });
    setOtpVerifying(false);
    if (error) setAuthError("Code didn't work — double-check it or request a new one.");
    // On success, onAuthStateChange fires and sets session automatically.
  };

  const passwordSignIn = async () => {
    const email = authEmail.trim();
    if (!email || !authPassword || authBusy) return;
    setAuthBusy(true); setAuthError("");
    const { error } = await supabase.auth.signInWithPassword({ email, password: authPassword });
    setAuthBusy(false);
    if (error) setAuthError("That email and password didn't match. Try again, or use a sign-in code instead.");
    // On success, onAuthStateChange fires and sets the session automatically.
  };

  // Set/change the account password from Settings. Saves immediately (separate from profile Save).
  const saveNewPassword = async () => {
    if (newPassword.length < 8 || pwBusy) return;
    setPwBusy(true); setPwMsg("");
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setPwBusy(false);
    if (error) setPwMsg(error.message);
    else { setNewPassword(""); setPwMsg("Password saved — you can use it to sign in next time."); }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setCloudLoaded(false);
    setSubscription(null);
    setTasks([]); setGrocery([]); setProfile(null);
    setStarted(false); setPending([]); setAuthSent(false); setAuthEmail(""); setOtpCode("");
    setAuthMode("code"); setAuthPassword(""); actedSigsRef.current = new Set();
  };

  const startCheckout = async (priceId) => {
    if (upgradeBusy) return;
    if (!priceId) {
      showToast("Checkout isn't configured yet — check VITE_STRIPE price ID env vars");
      return;
    }
    setUpgradeBusy(true);
    try {
      const res = await fetch("/api/stripe-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ priceId }),
      });
      const data = await res.json();
      if (data.url) { window.location.href = data.url; return; }
      showToast(data.error || "Something went wrong — please try again");
    } catch { showToast("Connection error — please try again"); }
    setUpgradeBusy(false);
  };

  const openBillingPortal = async () => {
    try {
      const res = await fetch("/api/stripe-portal", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (data.url) { window.open(data.url, "_blank"); return; }
      showToast("Could not open billing portal — try again");
    } catch { showToast("Connection error — please try again"); }
  };

  // ── Fix 1: Smart chat scroll — bottom if mid-convo, top if idle ──
  useEffect(() => {
    if (tab === "chat") {
      if (started && messages.length > 0) {
        // Mid-convo: scroll to bottom
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      } else {
        // Idle/starter: scroll to top
        setTimeout(() => { if (chatScrollRef.current) chatScrollRef.current.scrollTop = 0; }, 50);
      }
    }
    if (tab !== "chat" && bodyScrollRef.current) {
      bodyScrollRef.current.scrollTop = 0;
    }
  }, [tab]);

  // Scroll to bottom when new messages arrive during active convo
  useEffect(() => {
    if (started && messages.length > 0 && tab === "chat") {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, loading, pending]);

  // Entering active chat (e.g. "Continue where you left off") → jump to the bottom.
  useEffect(() => {
    if (started && tab === "chat" && messages.length > 0) {
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "auto" }), 60);
    }
  }, [started, pastExpanded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the running/paused timer so it survives a full app close (not just
  // a minimize). Stores the absolute end time + the scheduled push id so we can
  // restore the countdown and still cancel the backup push.
  useEffect(() => {
    if (!hydrated) return;
    try {
      if (timer && !timer.done) {
        window.localStorage.setItem(TIMER_KEY, JSON.stringify({
          label: timer.label, total: timer.total, remaining: timer.remaining,
          running: timer.running, endTime: timerEndTimeRef.current, pushId: pendingPushIdRef.current,
        }));
      } else {
        window.localStorage.removeItem(TIMER_KEY);
      }
    } catch {}
  }, [timer, hydrated]);

  // Restore a persisted timer on launch.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(TIMER_KEY);
      if (!raw) return;
      const t = JSON.parse(raw);
      pendingPushIdRef.current = t.pushId || null;
      if (t.running && t.endTime) {
        const remaining = Math.round((t.endTime - Date.now()) / 1000);
        if (remaining > 0) {
          timerEndTimeRef.current = t.endTime;
          setTimer({ label: t.label || "", total: t.total, remaining, running: true, done: false });
        } else {
          window.localStorage.removeItem(TIMER_KEY); // already elapsed while closed; the push fired
        }
      } else if (!t.running && t.remaining > 0) {
        setTimer({ label: t.label || "", total: t.total, remaining: t.remaining, running: false, done: false });
      }
    } catch {}
  }, []);

  // ── Fix 3: Background-safe timer using end timestamp ──
  useEffect(() => {
    if (timer && timer.running) {
      timerRef.current = setTimeout(() => {
        const remaining = Math.max(0, Math.round((timerEndTimeRef.current - Date.now()) / 1000));
        if (remaining <= 0) {
          setTimer(t => t ? { ...t, remaining: 0, running: false, done: true } : null);
          triggerTimerAlert();
        } else {
          setTimer(t => t ? { ...t, remaining } : null);
        }
      }, 500);
      return () => clearTimeout(timerRef.current);
    }
  }, [timer]);

  // Re-sync timer when app comes back to foreground
  useEffect(() => {
    const onVis = async () => {
      if (document.visibilityState === "visible") {
        if (timer && timer.running && timerEndTimeRef.current) {
          const remaining = Math.max(0, Math.round((timerEndTimeRef.current - Date.now()) / 1000));
          if (remaining <= 0) {
            setTimer(t => t ? { ...t, remaining: 0, running: false, done: true } : null);
            setTimerAlert(true);
            // visibilitychange IS a user gesture context on most Android Chrome — play sound
            playTone();
            try { navigator.vibrate?.([300, 100, 300, 100, 500, 100, 500]); } catch {}
          } else {
            setTimer(t => t ? { ...t, remaining } : null);
          }
        }
        if (timer && !wakeLockRef.current) await requestWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [timer]);

  const requestWakeLock = async () => {
    try { if ("wakeLock" in navigator) wakeLockRef.current = await navigator.wakeLock.request("screen"); } catch {}
  };
  const releaseWakeLock = async () => {
    try { await wakeLockRef.current?.release(); } catch {}
    wakeLockRef.current = null;
  };

  const subscribeToPush = async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (!session) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const sub = existing || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(import.meta.env.VITE_VAPID_PUBLIC_KEY || ""),
      });
      await fetch("/api/push-subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
    } catch {}
  };

  const requestNotifPermission = async () => {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      const result = await Notification.requestPermission();
      setNotifPermission(result);
      if (result === "granted") subscribeToPush();
    } else if (Notification.permission === "granted") {
      subscribeToPush();
    }
  };

  const fireNotification = (label) => {
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("⏰ Time's up!", {
          body: label || "Your focus timer has ended.",
          icon: "/icon-192.png",
          requireInteraction: true,
          vibrate: [300, 100, 300, 100, 500],
        });
      }
    } catch {}
    try { navigator.vibrate?.([300, 100, 300, 100, 500, 100, 500]); } catch {}
  };

  // Loop the chime (~3s cadence) until the user dismisses the alarm
  const startAlarmLoop = () => {
    stopAlarmLoop();
    playTone();
    alarmLoopRef.current = setInterval(playTone, 3000);
  };
  const stopAlarmLoop = () => {
    if (alarmLoopRef.current) { clearInterval(alarmLoopRef.current); alarmLoopRef.current = null; }
  };

  const triggerTimerAlert = () => {
    setTimerAlert(true);
    fireNotification(timer?.label || "");
    startAlarmLoop();
  };

  const dismissTimerAlert = () => {
    stopAlarmLoop();
    setTimerAlert(false);
    clearTimer();
  };

  const showToast = (m) => { setToast(m); setTimeout(() => setToast(null), 4000); };

  const startTimer = async (min, label) => {
    await requestNotifPermission();
    await requestWakeLock();
    timerEndTimeRef.current = Date.now() + min * 60 * 1000;
    setTimer({ label: label || "", total: min*60, remaining: min*60, running: true, done: false });
    setMenuId(null); setTab("timer");
    // Schedule a server-side push as backup for when the app is backgrounded/closed
    if (session && Notification.permission === "granted") {
      const sendAt = new Date(timerEndTimeRef.current).toISOString();
      fetch("/api/push-schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ title: "⏰ Time's up!", body: label || "Your focus timer has ended.", sendAt, requireInteraction: true }),
      }).then(r => r.json()).then(d => { if (d.id) pendingPushIdRef.current = d.id; }).catch(() => {});
    }
  };
  const pauseTimer = () => {
    clearTimeout(timerRef.current);
    setTimer(t => t ? { ...t, running: false } : null);
  };
  const resumeTimer = () => {
    // Recalculate end time based on current remaining
    setTimer(t => {
      if (!t) return null;
      timerEndTimeRef.current = Date.now() + t.remaining * 1000;
      return { ...t, running: true, done: false };
    });
  };
  const clearTimer = () => {
    clearTimeout(timerRef.current);
    stopAlarmLoop();
    timerEndTimeRef.current = null;
    setTimer(null);
    releaseWakeLock();
    setTimerAlert(false);
    if (pendingPushIdRef.current && session) {
      fetch("/api/push-cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ pushId: pendingPushIdRef.current }),
      }).catch(() => {});
      pendingPushIdRef.current = null;
    }
  };
  const fmtTime = (s) => `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;

  // Open an event in the user's chosen calendar app with a PRE-FILLED "create
  // event" screen — Google/Outlook get their web composer URL, Apple gets an
  // inline .ics from /api/calendar (so iPhone pops Calendar's add sheet instead
  // of downloading a file). The choice is remembered per device; the first time,
  // we show a chooser. Returns true if a flow was opened/queued.
  const openInCalendar = (app, evt) => {
    try {
      const start = new Date(evt.when);
      if (isNaN(start.getTime())) return false;
      const mins = evt.minutes || 60;
      const end = new Date(start.getTime() + mins * 60000);
      const utc = (d) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");
      const title = evt.title || "Event";
      if (app === "google") {
        const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${utc(start)}/${utc(end)}`;
        window.open(url, "_blank", "noopener");
      } else if (app === "outlook") {
        const url = `https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent&subject=${encodeURIComponent(title)}&startdt=${encodeURIComponent(start.toISOString())}&enddt=${encodeURIComponent(end.toISOString())}`;
        window.open(url, "_blank", "noopener");
      } else { // apple / default — inline .ics hands off to the native calendar
        const url = `/api/calendar?title=${encodeURIComponent(title)}&start=${encodeURIComponent(start.toISOString())}&minutes=${mins}`;
        window.location.href = url;
      }
      return true;
    } catch { return false; }
  };

  // Remember the picked app (per device) and route this event to it.
  const chooseCalendarApp = (app) => {
    setCalendarApp(app);
    try { window.localStorage.setItem("addie-calendar-app", app); } catch {}
    const evt = pendingCal;
    setPendingCal(null);
    if (evt) {
      const ok = openInCalendar(app, evt);
      showToast(ok ? "Opening your calendar…" : "Couldn't open calendar");
    }
  };

  // Entry point from a confirmed type:calendar suggestion.
  const addToCalendar = (title, whenIso, minutes) => {
    const evt = { title, when: whenIso, minutes };
    if (calendarApp) return openInCalendar(calendarApp, evt); // already chose on this device
    setPendingCal(evt); // first time → show the chooser
    return true;
  };
  const fmtCalDate = (iso) => {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch { return iso; }
  };

  // Schedule a chat-requested reminder: store it for the Board section AND book a
  // server-side push (via the same pending_pushes infra timers use) so it fires
  // even when the app is closed.
  const scheduleReminder = async (text, whenIso) => {
    const when = new Date(whenIso);
    if (isNaN(when.getTime()) || when.getTime() < Date.now() + 30000) {
      showToast("That reminder time has already passed");
      return;
    }
    posthog.capture("reminder_scheduled");
    const rid = "r" + Date.now();
    setReminders(prev => [{ id: rid, text, when: when.toISOString(), pushId: null, createdAt: new Date().toISOString(), done: false }, ...prev]);
    showToast("Reminder set");
    if (Notification.permission !== "granted") await requestNotifPermission();
    if (session && Notification.permission === "granted") {
      try {
        const res = await fetch("/api/push-schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ title: "⏰ Reminder", body: text, sendAt: when.toISOString(), requireInteraction: true }),
        });
        const data = await res.json();
        if (data?.id) setReminders(prev => prev.map(r => r.id === rid ? { ...r, pushId: data.id } : r));
      } catch {}
    }
  };

  // Durable memory: Addie saves these silently as she learns about the user.
  const MEMORY_CAP = 50;
  const addMemory = (text) => {
    const t = (text || "").trim();
    if (!t) return false;
    const norm = (s) => s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
    let added = false;
    setMemory(prev => {
      if (prev.some(m => norm(m.text) === norm(t))) return prev; // dedupe near-identical
      added = true;
      return [{ id: "m" + Date.now(), text: t, createdAt: new Date().toISOString() }, ...prev].slice(0, MEMORY_CAP);
    });
    return added;
  };
  const deleteMemory = (id) => setMemory(prev => prev.filter(m => m.id !== id));

  const cancelReminder = (id) => {
    const r = reminders.find(x => x.id === id);
    setReminders(prev => prev.filter(x => x.id !== id));
    if (r?.pushId && session) {
      fetch("/api/push-cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ pushId: r.pushId }),
      }).catch(() => {});
    }
  };

  // Fetch the user's subscribed calendar (if they've set one) so Addie can see
  // what's coming up. Times are read in the user's own timezone.
  const refreshCalendar = useCallback(async (urlOverride) => {
    const url = (urlOverride !== undefined ? urlOverride : profile?.calendarUrl) || "";
    if (!url.trim()) { setCalEvents([]); setCalStatus("idle"); setCalError(""); return; }
    setCalStatus("loading"); setCalError("");
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const tzOffsetMinutes = -new Date().getTimezoneOffset(); // e.g. JST → +540
      const res = await fetch("/api/calendar-read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), tz, tzOffsetMinutes }),
      });
      const data = await res.json();
      if (!res.ok) { setCalStatus("error"); setCalError(data?.error || "Couldn't read that calendar"); return; }
      setCalEvents(Array.isArray(data.events) ? data.events : []);
      setCalStatus("ok");
    } catch {
      setCalStatus("error"); setCalError("Couldn't reach the calendar");
    }
  }, [profile?.calendarUrl]);

  // Refresh on load and whenever the subscribed URL changes, then every 30 min.
  useEffect(() => {
    if (!profile?.calendarUrl) { setCalEvents([]); setCalStatus("idle"); return; }
    refreshCalendar();
    const t = setInterval(() => refreshCalendar(), 30 * 60 * 1000);
    return () => clearInterval(t);
  }, [profile?.calendarUrl, refreshCalendar]);

  const parseSuggestions = (text) => {
    // The SUGGESTIONS block is always last. Be tolerant of markdown/spacing around
    // the header (**SUGGESTIONS:**, trailing spaces, etc.) — a header we fail to
    // match used to dump all the raw "- type:..." lines into the chat bubble.
    const hdr = text.match(/(?:^|\n)[ \t>*_]*SUGGESTIONS[ \t*_:]*\n/i);
    if (!hdr) return { clean: text, suggestions: [] };
    const clean = text.slice(0, hdr.index).trim();
    const body = text.slice(hdr.index + hdr[0].length);
    const suggestions = body.split("\n")
      .map(s => s.trim())
      .filter(s => /type:/i.test(s))
      .map((raw, i) => {
      // Normalize each line to a leading "- " bullet so the matchers below are stable.
      const l = ("- " + raw.replace(/^[-*•\s]+/, "")).replace(/^- - /, "- ");
      const mem = l.match(/- type:remember \| "(.+)"/);
      if (mem) return { id: "s"+Date.now()+i, type: "remember", text: mem[1] };
      const tim = l.match(/- type:timer \| minutes:(\d+)(?: \| label:"([^"]*)")?/);
      if (tim) return { id: "s"+Date.now()+i, type: "timer", minutes: parseInt(tim[1]), label: tim[2] || "" };
      const cal = l.match(/- type:calendar \| "(.+)" \| when:"([^"]+)"(?: \| minutes:(\d+))?/);
      if (cal) return { id: "s"+Date.now()+i, type: "calendar", title: cal[1], when: cal[2], minutes: cal[3] ? parseInt(cal[3]) : 60 };
      const rem = l.match(/- type:reminder \| "(.+)" \| when:"([^"]+)"/);
      if (rem) return { id: "s"+Date.now()+i, type: "reminder", text: rem[1], when: rem[2] };
      const comp = l.match(/- type:complete \| id:(\S+)/);
      if (comp) return { id: "s"+Date.now()+i, type: "complete", targetId: comp[1] };
      const grm = l.match(/- type:grocery-remove \| id:(\S+)/);
      if (grm) return { id: "s"+Date.now()+i, type: "grocery-remove", targetId: grm[1] };
      const grs = l.match(/- type:grocery-replace \| id:(\S+) \| "(.+)" \| store:"(.+)"/);
      if (grs) return { id: "s"+Date.now()+i, type: "grocery-replace", targetId: grs[1], text: grs[2], store: grs[3] };
      const grp = l.match(/- type:grocery-replace \| id:(\S+) \| "(.+)"/);
      if (grp) return { id: "s"+Date.now()+i, type: "grocery-replace", targetId: grp[1], text: grp[2] };
      const gs = l.match(/- type:grocery \| "(.+)" \| store:"(.+)"/);
      if (gs) return { id: "s"+Date.now()+i, type: "grocery", text: gs[1], store: gs[2] };
      const g = l.match(/- type:grocery \| "(.+)"/);
      if (g) return { id: "s"+Date.now()+i, type: "grocery", text: g[1] };
      const ns = l.match(/- type:nextstep \| id:(\S+) \| "(.+)"/);
      if (ns) return { id: "s"+Date.now()+i, type: "nextstep", targetId: ns[1], text: ns[2] };
      const rn = l.match(/- type:replace \| id:(\S+) \| "(.+)" \| next:"(.+)"/);
      if (rn) return { id: "s"+Date.now()+i, type: "replace", targetId: rn[1], text: rn[2], nextStep: rn[3] };
      const r = l.match(/- type:replace \| id:(\S+) \| "(.+)"/);
      if (r) return { id: "s"+Date.now()+i, type: "replace", targetId: r[1], text: r[2] };
      const mv = l.match(/- type:move \| id:(\S+) \| bucket:(today|week|parked)/);
      if (mv) return { id: "s"+Date.now()+i, type: "move", targetId: mv[1], bucket: mv[2] };
      const t = l.match(/- type:task \| bucket:(today|week|parked) \| "(.+)"/);
      if (t) return { id: "s"+Date.now()+i, type: "task", bucket: t[1], text: t[2] };
      return null;
    }).filter(Boolean);
    return { clean, suggestions };
  };

  // Archive a finished conversation into the read-only history list.
  const archiveMessages = (msgs) => {
    if (!msgs || msgs.length === 0) return;
    const firstUser = msgs.find(m => m.role === "user");
    const starter = firstUser ? STARTERS.find(s => s.prompt === firstUser.content) : null;
    const ts = parseInt((msgs[0]?.id || "").replace(/^\D+/, "") || String(Date.now()), 10);
    const rawTitle = firstUser?.content?.trim() || "";
    const autoTitle = starter?.label || (rawTitle ? rawTitle.slice(0, 48) + (rawTitle.length > 48 ? "…" : "") : null);
    setSessions(prev => [{
      id: "s" + Date.now(),
      startedAt: new Date(isNaN(ts) ? Date.now() : ts).toISOString(),
      label: autoTitle,
      messages: msgs,
    }, ...prev].slice(0, 30));
  };

  const startNewSession = () => {
    archiveMessages(messages);
    setMessages([]); setStarted(false); setPastExpanded(false); setPending([]); setShowHistory(false);
    actedSigsRef.current = new Set();
  };

  // User-written note on an archived conversation, so they can find it later.
  const setSessionNote = (id, note) => {
    const trimmed = (note || "").slice(0, 80);
    setSessions(prev => prev.map(s => s.id === id ? { ...s, note: trimmed } : s));
    setViewingSession(v => (v && v.id === id ? { ...v, note: trimmed } : v));
  };

  // Resume an archived conversation: pull it back out of history and make it the
  // active chat again. Archives whatever's currently active first so nothing is lost.
  // (Replays the stored messages as-is — cheap for normal-length chats. A summarized
  // path for very long histories would be the future Pro upgrade.)
  const resumeSession = (sess) => {
    if (!sess) return;
    if (messages.length > 0) archiveMessages(messages);
    setSessions(prev => prev.filter(s => s.id !== sess.id));
    setMessages(sess.messages || []);
    setStarted(true); setPastExpanded(true);
    setPending([]); actedSigsRef.current = new Set();
    setLastActivity(Date.now());
    setViewingSession(null); setShowHistory(false); setTab("chat");
  };

  const sendMessage = async (userText) => {
    if (!userText.trim() || loading) return;
    posthog.capture("message_sent");
    // Starting a brand-new message from the landing screen (not continuing the
    // previous chat) → archive the old conversation so it doesn't expand inline.
    let base = messages;
    if (!started && !pastExpanded && messages.length > 0) {
      archiveMessages(messages);
      base = [];
      actedSigsRef.current = new Set();   // fresh conversation → forget prior acted cards
      setPending([]);                     // and drop any leftover cards from the archived convo
    }
    const next = [...base, { role: "user", content: userText, id: "u"+Date.now() }];
    // NOTE: we intentionally do NOT clear pending here. Un-acted cards persist across
    // messages within a conversation; they're only removed by Confirm/Skip/Clear-all,
    // and re-suggested duplicates / already-handled cards are filtered in the merge below.
    setMessages(next); setInput(""); setLoading(true); setStarted(true); setLastActivity(Date.now());
    if (taRef.current) { taRef.current.style.height = "auto"; }
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ system: buildSystemPrompt(tasks, grocery, profile, memory, notes, calEvents), messages: next.map(m => ({ role: m.role, content: m.content })) }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        if (res.status === 429 && data.upgrade) {
          setMessages([...next, { role: "assistant", content: data.error, id: "e"+Date.now(), upgrade: true }]);
          setLoading(false);
          return;
        }
        setMessages([...next, { role: "assistant", content: data.error || "Something went wrong.", id: "e"+Date.now() }]);
        setLoading(false);
        return;
      }
      const raw = data.content?.find(b => b.type === "text")?.text || "Something went wrong.";
      const { clean, suggestions } = parseSuggestions(raw);
      setMessages([...next, { role: "assistant", content: clean, id: "a"+Date.now() }]);
      // Memories apply silently (no confirmation chip) — Addie just remembers.
      const remembers = suggestions.filter(s => s.type === "remember");
      const chips = suggestions.filter(s => s.type !== "remember");
      let saved = 0;
      remembers.forEach(s => { if (addMemory(s.text)) saved++; });
      if (saved > 0) showToast(saved > 1 ? `✓ Ankora will remember those` : `✓ Ankora will remember that`);
      // Keep any cards the user hasn't acted on yet (they may have navigated away)
      // and append this reply's new ones, skipping duplicates of what's already waiting.
      if (chips.length) setPending(prev => {
        const seen = new Set(prev.map(suggestionSig));
        // Skip duplicates of what's already waiting AND anything the user already
        // confirmed/skipped this conversation (model sometimes re-suggests done work).
        return [...prev, ...chips.filter(c => {
          const sg = suggestionSig(c);
          return !seen.has(sg) && !actedSigsRef.current.has(sg);
        })];
      });
    } catch { setMessages([...next, { role: "assistant", content: "Connection issue. Take a breath — try again.", id: "e"+Date.now() }]); }
    setLoading(false);
  };

  const confirm = (s) => {
    if (s.type === "grocery") { setGrocery(p => [...p, { id:"g"+Date.now(), text:s.text, checked:false, store:s.store||"" }]); showToast(`Added: ${s.text}`); }
    else if (s.type === "grocery-replace") {
      const exists = grocery.some(g => g.id === s.targetId);
      if (exists) { setGrocery(p => p.map(g => g.id===s.targetId ? {...g, text:s.text, store:s.store!==undefined?s.store:g.store} : g)); showToast("Item updated"); }
      else { setGrocery(p => [...p, { id:"g"+Date.now(), text:s.text, checked:false, store:s.store||"" }]); showToast(`Added: ${s.text}`); }
    }
    else if (s.type === "grocery-remove") { setGrocery(p => p.filter(g => g.id!==s.targetId)); showToast("Item removed"); }
    else if (s.type === "replace") {
      const exists = tasks.some(t => t.id === s.targetId);
      if (exists) { setTasks(p => p.map(t => t.id===s.targetId ? {...t, text:s.text, nextStep:s.nextStep||t.nextStep} : t)); showToast("Task updated"); }
      else { const n = tasks.filter(t=>t.bucket==="today"&&!t.done).length; const b = n>=MAX_TODAY?"week":"today"; setTasks(p => [...p, {id:"t"+Date.now(), text:s.text, bucket:b, nextStep:s.nextStep||"", done:false}]); showToast(`Added to ${BUCKET_STYLE[b].label}`); }
    }
    else if (s.type === "nextstep") { setTasks(p => p.map(t => t.id===s.targetId ? {...t, nextStep:s.text} : t)); showToast("Next step saved"); }
    else if (s.type === "complete") {
      const t = tasks.find(t => t.id === s.targetId);
      setTasks(p => p.map(t => t.id===s.targetId ? {...t, done:true, completedAt:new Date().toISOString()} : t));
      showToast(`✓  ${t?.text || "Done"}`);
    }
    else if (s.type === "move") {
      const n = tasks.filter(t=>t.bucket==="today"&&!t.done).length;
      const b = s.bucket==="today" && n>=MAX_TODAY ? "week" : s.bucket;
      setTasks(p => p.map(t => t.id===s.targetId ? {...t, bucket:b} : t));
      showToast(b!==s.bucket ? `Today's full — moved to ${BUCKET_STYLE[b].label}` : `Moved to ${BUCKET_STYLE[b].label}`);
    }
    else if (s.type === "timer") { startTimer(s.minutes, s.label); }
    else if (s.type === "calendar") {
      // If an app is already chosen we open it now (with its own toast); otherwise
      // addToCalendar opens the chooser and we stay quiet until they pick.
      const hadChoice = !!calendarApp;
      const ok = addToCalendar(s.title, s.when, s.minutes);
      if (hadChoice) showToast(ok ? "Opening your calendar…" : "Couldn't open calendar");
    }
    else if (s.type === "reminder") { scheduleReminder(s.text, s.when); }
    else if (s.type === "remember") { addMemory(s.text); }
    else { const n = tasks.filter(t=>t.bucket==="today"&&!t.done).length; const b = s.bucket==="today"&&n>=MAX_TODAY?"week":s.bucket; setTasks(p => [...p, {id:"t"+Date.now(), text:s.text, bucket:b, done:false}]); showToast(`Added to ${BUCKET_STYLE[b].label}`); }
    actedSigsRef.current.add(suggestionSig(s));   // remember it so a re-suggestion doesn't reappear
    setPending(p => p.filter(x => x.id !== s.id));
  };
  const dismiss = (id) => setPending(p => {
    const c = p.find(x => x.id === id);
    if (c) actedSigsRef.current.add(suggestionSig(c));   // skipped cards shouldn't come back either
    return p.filter(x => x.id !== id);
  });
  const completeTask = (id) => { const t = tasks.find(t=>t.id===id); setTasks(p => p.map(t => t.id===id?{...t,done:true,completedAt:new Date().toISOString()}:t)); setMenuId(null); showToast(`✓  ${t?.text}`); };
  const deleteTask = (id) => { setTasks(p => p.filter(t => t.id!==id)); setMenuId(null); };
  const moveTask = (id, b) => { setTasks(p => p.map(t => t.id===id?{...t,bucket:b}:t)); setMenuId(null); };
  const startEdit = (t) => { setEditingId(t.id); setEditText(t.text); setMenuId(null); };
  const saveEdit = (id) => { if (editText.trim()) setTasks(p => p.map(t => t.id===id?{...t,text:editText.trim()}:t)); setEditingId(null); setEditText(""); };
  const cancelEdit = () => { setEditingId(null); setEditText(""); };
  const addManualTask = () => {
    if (!newTask.trim()) return;
    const n = tasks.filter(t=>t.bucket==="today"&&!t.done).length;
    const b = newBucket==="today"&&n>=MAX_TODAY?"week":newBucket;
    setTasks(p => [...p, {id:"t"+Date.now(), text:newTask.trim(), bucket:b, done:false}]);
    setNewTask(""); showToast(`Added to ${BUCKET_STYLE[b].label}`);
  };
  const addGroceryItem = () => {
    if (!newGrocery.trim()) return;
    setGrocery(p => [...p, {id:"g"+Date.now(), text:newGrocery.trim(), checked:false, store:newStore.trim()}]);
    setNewGrocery(""); setNewStore("");
  };
  const toggleGrocery = (id) => setGrocery(p => p.map(g => g.id===id?{...g,checked:!g.checked}:g));
  const deleteGrocery = (id) => setGrocery(p => p.filter(g => g.id!==id));
  const clearChecked = () => setGrocery(p => p.filter(g => !g.checked));
  const doClearAll = () => {
    setClearBackup({ tasks, grocery, memory, notes });   // snapshot board + grocery + memory + notes so the user can undo
    setTasks([]); setGrocery([]); setMessages([]); setReminders([]); setMemory([]); setNotes(""); setStarted(false); setPending([]); actedSigsRef.current = new Set();
    try{window.localStorage.removeItem(STORAGE_KEY);}catch{}
    setShowClearConfirm(false); setShowSettings(false);
    showToast("Data cleared");
  };
  const undoClear = () => {
    if (!clearBackup) return;
    setTasks(clearBackup.tasks || []); setGrocery(clearBackup.grocery || []); setMemory(clearBackup.memory || []); setNotes(clearBackup.notes || "");
    setClearBackup(null);
    showToast("Board & grocery restored");
  };

  // ── Onboarding / profile ──
  const persistProfile = (p) => { try { window.localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch {} };
  const finishOnboarding = () => {
    const p = { style: onboardDraft.style, pattern: onboardDraft.pattern, context: onboardDraft.context.trim() };
    setProfile(p); persistProfile(p); setOnboarded(true);
    if (p.style || p.pattern || p.context) showToast("Got it — Ankora's tuned to you");
  };
  const skipOnboarding = () => {
    const p = { style: "", pattern: "", context: "" };
    setProfile(p); persistProfile(p); setOnboarded(true);
  };
  const saveSettings = () => {
    const p = {
      style: onboardDraft.style,
      pattern: onboardDraft.pattern,
      context: onboardDraft.context.trim(),
      reminderEnabled: onboardDraft.reminderEnabled || false,
      reminderTime: onboardDraft.reminderTime || "09:00",
      reminderTz: onboardDraft.reminderTz || Intl.DateTimeFormat().resolvedOptions().timeZone,
      notesReadable: onboardDraft.notesReadable || false,
      calendarUrl: (onboardDraft.calendarUrl || "").trim(),
    };
    setProfile(p); persistProfile(p); setShowSettings(false); showToast("Preferences saved");
  };
  const openSettings = () => {
    setOnboardDraft({
      style: profile?.style || "",
      pattern: profile?.pattern || "",
      context: profile?.context || "",
      reminderEnabled: profile?.reminderEnabled || false,
      reminderTime: profile?.reminderTime || "09:00",
      reminderTz: profile?.reminderTz || Intl.DateTimeFormat().resolvedOptions().timeZone,
      notesReadable: profile?.notesReadable || false,
      calendarUrl: profile?.calendarUrl || "",
    });
    setShowSettings(true);
  };

  const editInputRef = useRef(null);
  const editCaretRef = useRef(null);
  useEffect(() => {
    if (editingId && editInputRef.current && editCaretRef.current !== null) {
      const pos = editCaretRef.current;
      editInputRef.current.setSelectionRange(pos, pos);
    }
  }, [editText, editingId]);

  // ── Fix 2: Enter = line break. Send is button only. ──
  const handleKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const fmtText = (t) => t.split(/(\*\*[^*]+\*\*)/).map((p,i) => p.startsWith("**")&&p.endsWith("**") ? <strong key={i} style={{fontWeight:600}}>{p.slice(2,-2)}</strong> : p);
  const renderContent = (t) => t.split("\n").filter(Boolean).map((line,i) => <p key={i} style={{margin:"0 0 5px",lineHeight:1.5}}>{fmtText(line)}</p>);

  const todayTasks  = tasks.filter(t => t.bucket==="today"  && !t.done);
  const weekTasks   = tasks.filter(t => t.bucket==="week"   && !t.done);
  const parkedTasks = tasks.filter(t => t.bucket==="parked" && !t.done);
  const doneTasks   = tasks.filter(t => t.done);
  // Only reminders that haven't fired yet — once one has been sent it's "completed"
  // and shouldn't keep taking up space on the board.
  const upcomingReminders = reminders.filter(r => !r.done && new Date(r.when).getTime() > Date.now());
  const activeTasks = tasks.filter(t => !t.done).length;
  const unchecked   = grocery.filter(g => !g.checked);
  const checked     = grocery.filter(g => g.checked);
  const timerPct    = timer && timer.total>0 ? (timer.remaining/timer.total)*100 : 0;
  const idleNow     = Date.now() - lastActivity > IDLE_RESET_MS;

  // ── Home-screen "Continue" pill + capped Recent list ──
  // Always surface the LAST conversation as a prominent Continue pill: the active
  // un-archived chat if one exists, otherwise the most-recent archived session.
  // The remaining history shows below the starters, capped — "See all" hands off
  // to the full archive overlay so the landing never scrolls forever.
  const hasActiveConvo = messages.length > 0 && !pastExpanded;
  const continueSess   = hasActiveConvo ? null : (sessions.length > 0 ? sessions[0] : null);
  const homeRecent     = hasActiveConvo ? sessions : sessions.slice(1);

  // ── Fix 5: More vertical padding in chat input ──
  const fieldStyle = { display:"block", width:"100%", height:46, minHeight:46, fontSize:16, padding:"0 14px", borderRadius:10, border:`1.5px solid ${C.border}`, backgroundColor:C.bg, color:C.text, fontFamily:"inherit", outline:"none", boxSizing:"border-box", appearance:"none", WebkitAppearance:"none" };
  const btnStyle = { display:"inline-flex", alignItems:"center", justifyContent:"center", height:46, padding:"0 22px", fontSize:14, borderRadius:10, border:`1.5px solid ${C.blueBorder}`, backgroundColor:C.blueBg, color:C.blueText, cursor:"pointer", fontWeight:600, flexShrink:0, boxSizing:"border-box" };

  const Badge = ({ children, bg, color }) => (
    <span style={{ fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:20, backgroundColor:bg, color, flexShrink:0 }}>{children}</span>
  );

  const TaskRow = ({ task }) => {
    const editing = editingId === task.id;
    const open = menuId === task.id;
    return (
      <div style={{ borderBottom:`1px solid ${C.borderLt}`, position:"relative" }}>
        <div style={{ display:"flex", alignItems:"flex-start", gap:12, padding:"13px 0" }}>
          <div onClick={() => completeTask(task.id)} role="button" tabIndex={0}
            onKeyDown={e => (e.key==="Enter"||e.key===" ")&&completeTask(task.id)}
            style={{ marginTop:2, width:22, height:22, borderRadius:"50%", border:`2px solid ${C.text2}`, backgroundColor:"transparent", cursor:"pointer", flexShrink:0, boxSizing:"border-box" }} />
          <div style={{ flex:1, minWidth:0 }}>
            {editing ? (
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                <input ref={editInputRef} autoFocus value={editText}
                  onChange={e => { editCaretRef.current = e.target.selectionStart; setEditText(e.target.value); }}
                  onKeyDown={e => { if(e.key==="Enter")saveEdit(task.id); if(e.key==="Escape")cancelEdit(); }}
                  style={{ ...fieldStyle, height:42, minHeight:42 }} />
                <div style={{ display:"flex", gap:8 }}>
                  <span onClick={() => saveEdit(task.id)} role="button" style={{ ...btnStyle, height:38 }}>Save</span>
                  <span onClick={cancelEdit} role="button" style={{ display:"inline-flex", alignItems:"center", height:38, padding:"0 18px", fontSize:13, borderRadius:8, border:`1.5px solid ${C.borderLt}`, color:C.text2, cursor:"pointer" }}>Cancel</span>
                </div>
              </div>
            ) : (
              <>
                <span style={{ fontSize:14.5, color:C.text, lineHeight:1.5 }}>{task.text}</span>
                {task.nextStep && <p style={{ margin:"4px 0 0", fontSize:12.5, color:C.text3 }}>→ Next: {task.nextStep}</p>}
              </>
            )}
          </div>
          {!editing && (
            <span onClick={(e) => { e.stopPropagation(); setMenuId(open?null:task.id); }} role="button"
              style={{ padding:"4px 12px", borderRadius:8, border:`1.5px solid ${C.border}`, backgroundColor:open?C.blueBg:C.bg2, cursor:"pointer", color:open?C.blueText:C.text, flexShrink:0, fontSize:18, fontWeight:700, lineHeight:1, height:30, display:"flex", alignItems:"center" }}>•••</span>
          )}
        </div>
        {open && (
          <div style={{ position:"absolute", right:0, top:44, zIndex:10, backgroundColor:C.bg, border:`1.5px solid ${C.border}`, borderRadius:12, boxShadow:"0 6px 20px rgba(0,0,0,0.12)", overflow:"hidden", minWidth:180 }}>
            {[
              { label:"Edit", fn:() => startEdit(task) },
              { label:"Start 15-min timer", fn:() => startTimer(15, task.text) },
              { label:"Start 25-min timer", fn:() => startTimer(25, task.text) },
              ...(task.bucket!=="today" && todayTasks.length<MAX_TODAY ? [{ label:"Move to Today", fn:() => moveTask(task.id,"today") }] : []),
              ...(task.bucket!=="week"   ? [{ label:"Move to This week", fn:() => moveTask(task.id,"week") }] : []),
              ...(task.bucket!=="parked" ? [{ label:"Park it", fn:() => moveTask(task.id,"parked") }] : []),
              { label:"Delete", fn:() => deleteTask(task.id), danger:true },
            ].map((it,i) => (
              <div key={i} onClick={it.fn} role="button"
                style={{ padding:"12px 16px", borderBottom:`1px solid ${C.borderLt}`, cursor:"pointer", fontSize:14, color:it.danger?C.danger:C.text, fontWeight:it.danger?500:400 }}>{it.label}</div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const BucketSection = ({ label, items, bucket, collapsible }) => {
    const { bg, text } = BUCKET_STYLE[bucket];
    const expanded = !collapsible || parkedExpanded;
    return (
      <div style={{ marginBottom:24 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
          <Badge bg={bg} color={text}>{label}</Badge>
          {bucket==="today" && <span style={{ fontSize:12, color:items.length>=MAX_TODAY?C.danger:C.text3, fontWeight:items.length>=MAX_TODAY?600:400 }}>{items.length}/{MAX_TODAY}</span>}
          {collapsible && items.length>0 && <span style={{ fontSize:12, color:C.text3 }}>{items.length}</span>}
          {collapsible && items.length>0 && (
            <span onClick={() => setParkedExpanded(v=>!v)} role="button"
              style={{ marginLeft:"auto", fontSize:12, color:C.text2, fontWeight:600, cursor:"pointer" }}>{expanded ? "Hide" : "Show"}</span>
          )}
        </div>
        {items.length===0
          ? <p style={{ fontSize:13, color:C.text3, margin:0, fontStyle:"italic" }}>Nothing here yet</p>
          : expanded
            ? items.map(t => <TaskRow key={t.id} task={t} />)
            : null}
      </div>
    );
  };

  const loadingScreen = (msg) => <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100svh", fontFamily:"system-ui,sans-serif", color:C.text3 }}>{msg}</div>;

  if (authLoading) return loadingScreen("Loading…");

  // ── Not signed in → passwordless (magic-link) sign-in ──
  if (!session) return (
    <div style={{ display:"flex", flexDirection:"column", height:"100svh", maxWidth:720, margin:"0 auto", fontFamily:"system-ui,-apple-system,sans-serif", backgroundColor:C.bg }}>
      <div style={{ flex:1, display:"flex", flexDirection:"column", justifyContent:"center", padding:"24px 26px", maxWidth:380, width:"100%", margin:"0 auto", boxSizing:"border-box" }}>
        <div style={{ marginBottom:28 }}>
          <img src="/logo.svg" alt="" style={{ width:36, height:35, marginBottom:14 }} />
          <h2 style={{ margin:"0 0 8px", fontSize:26, fontWeight:800, color:C.text }}>Welcome to Ankora</h2>
          <p style={{ margin:0, fontSize:14, color:C.text2, lineHeight:1.5 }}>Sign in to keep your tasks and lists in sync across your devices.</p>
        </div>

        {authSent ? (
          <div>
            <div style={{ textAlign:"center", marginBottom:18 }}>
              <div style={{ fontSize:40, marginBottom:10 }}>📬</div>
              <p style={{ margin:"0 0 6px", fontSize:15.5, fontWeight:600, color:C.text }}>Check your email</p>
              <p style={{ margin:0, fontSize:13.5, color:C.text2, lineHeight:1.5 }}>
                We sent a 6-digit code to <strong>{authEmail.trim()}</strong>. Enter it below — no need to leave the app.
              </p>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              <input
                type="text" inputMode="numeric" autoComplete="one-time-code"
                maxLength={6}
                value={otpCode}
                onChange={e => setOtpCode(e.target.value.replace(/\D/g, ""))}
                onKeyDown={e => e.key === "Enter" && verifyOtpCode()}
                placeholder="000000"
                style={{ ...fieldStyle, textAlign:"center", fontSize:22, letterSpacing:6, fontWeight:700 }}
              />
              {authError && <p style={{ margin:0, fontSize:12.5, color:C.danger }}>{authError}</p>}
              <span role="button" onClick={verifyOtpCode}
                style={{ textAlign:"center", fontSize:15, fontWeight:700, color:"#fff", backgroundColor:(otpVerifying||otpCode.length<6)?C.text3:C.blue, borderRadius:12, padding:"14px 0", cursor:(otpVerifying||otpCode.length<6)?"default":"pointer" }}>
                {otpVerifying ? "Verifying…" : "Sign in"}
              </span>
              <p style={{ margin:0, fontSize:11.5, color:C.text3, textAlign:"center", lineHeight:1.5 }}>On desktop? You can also click the link in the email instead.</p>
              <span role="button" onClick={() => { setAuthSent(false); setAuthError(""); setOtpCode(""); }}
                style={{ textAlign:"center", fontSize:13.5, color:C.blueText, cursor:"pointer", fontWeight:600 }}>Use a different email</span>
            </div>
          </div>
        ) : authMode === "password" ? (
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            <input
              type="email" inputMode="email" autoComplete="email" value={authEmail}
              onChange={e => setAuthEmail(e.target.value)}
              placeholder="you@example.com"
              style={fieldStyle}
            />
            <input
              type="password" autoComplete="current-password" value={authPassword}
              onChange={e => setAuthPassword(e.target.value)}
              onKeyDown={e => e.key === "Enter" && passwordSignIn()}
              placeholder="Password"
              style={fieldStyle}
            />
            {authError && <p style={{ margin:0, fontSize:12.5, color:C.danger }}>{authError}</p>}
            <span role="button" onClick={passwordSignIn}
              style={{ textAlign:"center", fontSize:15, fontWeight:700, color:"#fff", backgroundColor:(authBusy||!authEmail.trim()||!authPassword)?C.text3:C.blue, borderRadius:12, padding:"14px 0", cursor:(authBusy||!authEmail.trim()||!authPassword)?"default":"pointer" }}>
              {authBusy ? "Signing in…" : "Sign in"}
            </span>
            <span role="button" onClick={() => { setAuthMode("code"); setAuthError(""); setAuthPassword(""); }}
              style={{ textAlign:"center", fontSize:13.5, color:C.blueText, cursor:"pointer", fontWeight:600 }}>Email me a code instead</span>
            <p style={{ margin:"6px 0 0", fontSize:11.5, color:C.text3, lineHeight:1.5, textAlign:"center" }}>
              New here, or no password yet? Use a code — you can set a password later in Preferences.
            </p>
            <p style={{ margin:"10px 0 0", fontSize:11, color:C.text3, lineHeight:1.5, textAlign:"center" }}>
              By signing in you agree to our{" "}
              <a href="/terms.html" target="_blank" rel="noreferrer" style={{ color:C.text2, textDecoration:"underline" }}>Terms</a>
              {" "}and{" "}
              <a href="/privacy.html" target="_blank" rel="noreferrer" style={{ color:C.text2, textDecoration:"underline" }}>Privacy Policy</a>.
            </p>
          </div>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            <input
              type="email" inputMode="email" autoComplete="email" value={authEmail}
              onChange={e => setAuthEmail(e.target.value)}
              onKeyDown={e => e.key === "Enter" && sendMagicLink()}
              placeholder="you@example.com"
              style={fieldStyle}
            />
            {authError && <p style={{ margin:0, fontSize:12.5, color:C.danger }}>{authError}</p>}
            <span role="button" onClick={sendMagicLink}
              style={{ textAlign:"center", fontSize:15, fontWeight:700, color:"#fff", backgroundColor: authBusy ? C.text3 : C.blue, borderRadius:12, padding:"14px 0", cursor: authBusy ? "default" : "pointer" }}>
              {authBusy ? "Sending…" : "Email me a code"}
            </span>
            <p style={{ margin:"6px 0 0", fontSize:11.5, color:C.text3, lineHeight:1.5, textAlign:"center" }}>We'll email you a 6-digit code — no password needed.</p>
            <span role="button" onClick={() => { setAuthMode("password"); setAuthError(""); }}
              style={{ textAlign:"center", fontSize:13.5, color:C.blueText, cursor:"pointer", fontWeight:600 }}>Sign in with a password instead</span>
            <p style={{ margin:"10px 0 0", fontSize:11, color:C.text3, lineHeight:1.5, textAlign:"center" }}>
              By signing in you agree to our{" "}
              <a href="/terms.html" target="_blank" rel="noreferrer" style={{ color:C.text2, textDecoration:"underline" }}>Terms</a>
              {" "}and{" "}
              <a href="/privacy.html" target="_blank" rel="noreferrer" style={{ color:C.text2, textDecoration:"underline" }}>Privacy Policy</a>.
            </p>
          </div>
        )}
      </div>
    </div>
  );

  if (!hydrated || !cloudLoaded) return loadingScreen("Loading your space…");

  // Shared profile fields, used by both onboarding and Settings
  const profileFields = () => (
    <>
      <div style={{ marginBottom:22 }}>
        <p style={{ margin:"0 0 10px", fontSize:17, fontWeight:700, color:C.text }}>When you're stuck, what helps more?</p>
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {ONBOARD_STYLE.map(o => {
            const sel = onboardDraft.style === o.value;
            return (
              <div key={o.value} role="button" onClick={() => setOnboardDraft(d => ({ ...d, style: sel ? "" : o.value }))}
                style={{ padding:"12px 14px", borderRadius:12, border:`1.5px solid ${sel?C.blue:C.borderLt}`, backgroundColor:sel?C.blueBg:C.bg, cursor:"pointer" }}>
                <span style={{ fontSize:14.5, fontWeight:600, color:sel?C.blueText:C.text }}>{o.label}</span>
                <p style={{ margin:"2px 0 0", fontSize:12.5, color:C.text3 }}>{o.hint}</p>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ marginBottom:22 }}>
        <p style={{ margin:"0 0 10px", fontSize:17, fontWeight:700, color:C.text }}>What trips you up most?</p>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
          {ONBOARD_PATTERN.map(o => {
            const sel = onboardDraft.pattern === o.value;
            return (
              <div key={o.value} role="button" onClick={() => setOnboardDraft(d => ({ ...d, pattern: sel ? "" : o.value }))}
                style={{ padding:"12px", borderRadius:12, border:`1.5px solid ${sel?C.blue:C.borderLt}`, backgroundColor:sel?C.blueBg:C.bg, cursor:"pointer", textAlign:"center" }}>
                <span style={{ display:"block", fontSize:20, marginBottom:4 }}>{o.emoji}</span>
                <span style={{ fontSize:13, fontWeight:600, color:sel?C.blueText:C.text }}>{o.label}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ marginBottom:8 }}>
        <p style={{ margin:"0 0 10px", fontSize:17, fontWeight:700, color:C.text }}>What's on your plate these days? <span style={{ fontSize:14, fontWeight:400, color:C.text3 }}>(optional)</span></p>
        <textarea value={onboardDraft.context} onChange={e => setOnboardDraft(d => ({ ...d, context: e.target.value }))}
          placeholder="e.g. launching a product, juggling work + a newborn, finishing my thesis…" rows={2}
          style={{ width:"100%", resize:"none", fontSize:16, padding:"12px 14px", borderRadius:12, border:`1.5px solid ${C.border}`, backgroundColor:C.bg2, color:C.text, fontFamily:"inherit", lineHeight:1.5, outline:"none", boxSizing:"border-box" }} />
      </div>
    </>
  );

  if (!onboarded) return (
    <div style={{ display:"flex", flexDirection:"column", height:"100svh", maxWidth:720, margin:"0 auto", fontFamily:"system-ui,-apple-system,sans-serif", backgroundColor:C.bg }}>
      <div style={{ flex:1, overflowY:"auto", padding:"calc(32px + env(safe-area-inset-top)) 22px 24px" }}>
        <div style={{ marginBottom:28 }}>
          <img src="/logo.svg" alt="" style={{ width:40, height:38, marginBottom:14 }} />
          <h2 style={{ margin:"0 0 8px", fontSize:26, fontWeight:800, color:C.text }}>Hey, I'm Ankora</h2>
          <p style={{ margin:0, fontSize:14, color:C.text2, lineHeight:1.5 }}>Two quick questions so I can meet you where you are. No wrong answers.</p>
        </div>
        {profileFields()}
      </div>
      <div style={{ padding:"16px 22px calc(16px + env(safe-area-inset-bottom))", borderTop:`1.5px solid ${C.borderLt}`, display:"flex", gap:10, alignItems:"center", flexShrink:0 }}>
        <span role="button" onClick={skipOnboarding} style={{ fontSize:14, color:C.text2, padding:"12px 16px", cursor:"pointer", fontWeight:500 }}>Skip for now</span>
        <span role="button" onClick={finishOnboarding} style={{ flex:1, textAlign:"center", fontSize:15, fontWeight:700, color:"#fff", backgroundColor:C.blue, borderRadius:12, padding:"13px 0", cursor:"pointer" }}>Let's go</span>
      </div>
    </div>
  );

  const TABS = [
    { key:"chat", label:"Chat", glyph:"💬", count:pending.length },
    { key:"board", label:"Board", glyph:"📋", count:activeTasks },
    { key:"timer", label:"Timer", glyph:"⏱️" },
    { key:"grocery", label:"Grocery", glyph:"🛒", count:unchecked.length },
  ];

  const groups = {};
  unchecked.forEach(g => { const k = g.store && g.store.trim() ? g.store.trim() : "Grocery"; (groups[k]=groups[k]||[]).push(g); });
  const groupNames = Object.keys(groups).sort((a,b) => a==="Grocery"?-1 : b==="Grocery"?1 : a.localeCompare(b));

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100svh", maxWidth:720, margin:"0 auto", fontFamily:"system-ui,-apple-system,sans-serif", backgroundColor:C.bg, position:"relative" }} onClick={() => menuId && setMenuId(null)}>

      {/* Preferences / Settings overlay */}
      {showSettings && (
        <div style={{ position:"fixed", inset:0, zIndex:90, backgroundColor:C.bg, maxWidth:720, margin:"0 auto", display:"flex", flexDirection:"column" }}>
          <div style={{ padding:"calc(14px + env(safe-area-inset-top)) 18px 14px", borderBottom:`1.5px solid ${C.borderLt}`, display:"flex", alignItems:"center", gap:12, flexShrink:0 }}>
            <span role="button" onClick={() => setShowSettings(false)} style={{ fontSize:22, color:C.text2, cursor:"pointer", lineHeight:1 }}>←</span>
            <p style={{ margin:0, fontWeight:600, fontSize:16, color:C.text }}>Preferences</p>
          </div>
          <div style={{ flex:1, overflowY:"auto", padding:"22px" }}>
            <p style={{ margin:"0 0 20px", fontSize:13.5, color:C.text2, lineHeight:1.5 }}>How Ankora talks to you. She'll still adjust in the moment if you ask her to.</p>
            {profileFields()}
            <div style={{ marginTop:28, paddingTop:22, borderTop:`1.5px solid ${C.borderLt}` }}>
              <p style={{ margin:"0 0 12px", fontSize:14, fontWeight:600, color:C.text }}>Reminders</p>
              <div onClick={() => setOnboardDraft(d => ({ ...d, reminderEnabled: !d.reminderEnabled }))}
                style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 16px", borderRadius:12, border:`1.5px solid ${C.borderLt}`, backgroundColor:C.bg2, cursor:"pointer", marginBottom:10 }}>
                <div>
                  <p style={{ margin:"0 0 2px", fontSize:14, fontWeight:600, color:C.text }}>Daily check-in nudge</p>
                  <p style={{ margin:0, fontSize:12.5, color:C.text3 }}>Get a reminder to open Ankora at a set time</p>
                </div>
                <div style={{ width:44, height:26, borderRadius:13, backgroundColor:onboardDraft.reminderEnabled?C.blue:C.border, position:"relative", transition:"background-color 0.2s", flexShrink:0 }}>
                  <div style={{ position:"absolute", top:3, left:onboardDraft.reminderEnabled?21:3, width:20, height:20, borderRadius:"50%", backgroundColor:"#fff", transition:"left 0.2s", boxShadow:"0 1px 3px rgba(0,0,0,0.2)" }} />
                </div>
              </div>
              {onboardDraft.reminderEnabled && (
                <div style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 16px", borderRadius:12, border:`1.5px solid ${C.borderLt}`, backgroundColor:C.bg2, marginBottom:10 }}>
                  <p style={{ margin:0, fontSize:14, color:C.text, flex:1 }}>Remind me at</p>
                  <input type="time" value={onboardDraft.reminderTime || "09:00"}
                    onChange={e => setOnboardDraft(d => ({ ...d, reminderTime: e.target.value }))}
                    style={{ fontSize:15, padding:"6px 10px", borderRadius:8, border:`1.5px solid ${C.border}`, backgroundColor:C.bg, color:C.text, outline:"none" }} />
                </div>
              )}
              {onboardDraft.reminderEnabled && notifPermission !== "granted" && (
                notifPermission === "denied" ? (
                  <div style={{ padding:"12px 14px", borderRadius:12, border:`1.5px solid #FDE68A`, backgroundColor:"#FFFBEB", marginBottom:10 }}>
                    <p style={{ margin:"0 0 6px", fontSize:12.5, color:"#92400E", lineHeight:1.5 }}>Notifications are turned off, so reminders can't reach you.</p>
                    {renderNotifSteps("#92400E")}
                  </div>
                ) : (
                  <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 14px", borderRadius:12, border:`1.5px solid #FDE68A`, backgroundColor:"#FFFBEB", marginBottom:10 }}>
                    <p style={{ margin:0, flex:1, fontSize:12.5, color:"#92400E", lineHeight:1.5 }}>Reminders need permission to send you notifications.</p>
                    <span role="button" onClick={requestNotifPermission}
                      style={{ fontSize:12.5, fontWeight:700, color:"#fff", backgroundColor:C.blue, borderRadius:8, padding:"7px 13px", cursor:"pointer", flexShrink:0 }}>Enable</span>
                  </div>
                )
              )}
            </div>
            <div style={{ marginTop:28, paddingTop:22, borderTop:`1.5px solid ${C.borderLt}` }}>
              <p style={{ margin:"0 0 6px", fontSize:14, fontWeight:600, color:C.text }}>Calendar</p>
              <p style={{ margin:"0 0 12px", fontSize:12.5, color:C.text3, lineHeight:1.5 }}>
                Let Ankora see what's coming up by subscribing to your calendar's private link (read-only — she can't change anything).
              </p>
              <details style={{ marginBottom:12, fontSize:12.5, color:C.text2, lineHeight:1.5 }}>
                <summary style={{ cursor:"pointer", fontWeight:600, color:C.blueText }}>How do I get my calendar link?</summary>
                <div style={{ marginTop:8, paddingLeft:2 }}>
                  <p style={{ margin:"0 0 8px" }}><strong>Google Calendar</strong> (on a computer): Settings → click your calendar under <em>Settings for my calendars</em> → <em>Integrate calendar</em> → copy the <strong>Secret address in iCal format</strong>. Keep it private — anyone with it can see your events.</p>
                  <p style={{ margin:0 }}><strong>Apple Calendar</strong>: make the calendar a <em>public</em> calendar (right-click the calendar → Share → Public Calendar), then copy that link. Paste it here (a <code>webcal://</code> link is fine).</p>
                </div>
              </details>
              <input
                value={onboardDraft.calendarUrl || ""}
                onChange={e => setOnboardDraft(d => ({ ...d, calendarUrl: e.target.value }))}
                placeholder="Paste your iCal / calendar link"
                style={{ ...fieldStyle, marginBottom:8 }} />
              <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                <span role="button" onClick={() => refreshCalendar((onboardDraft.calendarUrl||"").trim())}
                  style={{ ...btnStyle, height:40, opacity:(onboardDraft.calendarUrl||"").trim()?1:0.5 }}>
                  {calStatus==="loading" ? "Checking…" : "Connect & test"}</span>
                {(onboardDraft.calendarUrl||"").trim() && (
                  <span role="button" onClick={() => { setOnboardDraft(d => ({ ...d, calendarUrl: "" })); setCalEvents([]); setCalStatus("idle"); setCalError(""); }}
                    style={{ fontSize:13, color:C.text2, cursor:"pointer", fontWeight:600 }}>Remove</span>
                )}
              </div>
              {calStatus==="ok" && (
                <p style={{ margin:"10px 0 0", fontSize:12.5, color:C.greenText }}>
                  ✓ Connected — Ankora can see {calEvents.length} event{calEvents.length===1?"":"s"} in the next 7 days.
                </p>
              )}
              {calStatus==="error" && (
                <p style={{ margin:"10px 0 0", fontSize:12.5, color:C.danger }}>{calError || "Couldn't read that calendar."}</p>
              )}
              <p style={{ margin:"8px 0 0", fontSize:11.5, color:C.text3, lineHeight:1.4 }}>
                Save Preferences to keep this. Apple (web) only supports public calendars; full private two-way sync is coming later.
              </p>
            </div>
            <div style={{ marginTop:28, paddingTop:22, borderTop:`1.5px solid ${C.borderLt}` }}>
              <p style={{ margin:"0 0 12px", fontSize:14, fontWeight:600, color:C.text }}>Plan</p>
              {subscription === "active" ? (
                <div role="button" onClick={openBillingPortal}
                  style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 16px", borderRadius:12, border:`1.5px solid ${C.blueBorder}`, backgroundColor:C.blueBg, cursor:"pointer" }}>
                  <div>
                    <p style={{ margin:"0 0 2px", fontSize:14, fontWeight:700, color:C.blueText }}>✦ Ankora Pro</p>
                    <p style={{ margin:0, fontSize:12.5, color:C.text2 }}>Unlimited messages</p>
                  </div>
                  <span style={{ fontSize:12.5, color:C.blueText, fontWeight:600, border:`1.5px solid ${C.blueBorder}`, borderRadius:8, padding:"6px 14px", backgroundColor:C.bg }}>
                    Manage
                  </span>
                </div>
              ) : (
                <div role="button" onClick={() => { setShowSettings(false); setShowUpgrade(true); }}
                  style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 16px", borderRadius:12, border:`1.5px solid ${C.borderLt}`, backgroundColor:C.bg2, cursor:"pointer" }}>
                  <div>
                    <p style={{ margin:"0 0 2px", fontSize:14, fontWeight:600, color:C.text }}>Free</p>
                    <p style={{ margin:0, fontSize:12.5, color:C.text2 }}>25 messages / day</p>
                  </div>
                  <span style={{ fontSize:12.5, color:"#fff", fontWeight:700, backgroundColor:C.blue, borderRadius:8, padding:"7px 16px" }}>
                    Upgrade
                  </span>
                </div>
              )}
            </div>
            <div style={{ marginTop:28, paddingTop:22, borderTop:`1.5px solid ${C.borderLt}` }}>
              <p style={{ margin:"0 0 4px", fontSize:14, fontWeight:600, color:C.text }}>Calendar app</p>
              {calendarApp ? (
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, padding:"12px 16px", borderRadius:12, border:`1.5px solid ${C.borderLt}`, backgroundColor:C.bg2 }}>
                  <p style={{ margin:0, fontSize:14, color:C.text }}>
                    Events open in <strong>{calendarApp === "google" ? "Google Calendar" : calendarApp === "outlook" ? "Outlook" : "Apple Calendar"}</strong>
                  </p>
                  <span role="button" onClick={() => { setCalendarApp(""); try { window.localStorage.removeItem("addie-calendar-app"); } catch {}; showToast("Ankora will ask next time"); }}
                    style={{ fontSize:12.5, fontWeight:600, color:C.blueText, border:`1.5px solid ${C.blueBorder}`, borderRadius:8, padding:"6px 13px", cursor:"pointer", backgroundColor:C.bg, flexShrink:0 }}>Change</span>
                </div>
              ) : (
                <p style={{ margin:0, fontSize:12.5, color:C.text2, lineHeight:1.5 }}>Ankora will ask which calendar to use the first time you add an event on this device.</p>
              )}
            </div>
            <div style={{ marginTop:28, paddingTop:22, borderTop:`1.5px solid ${C.borderLt}` }}>
              <p style={{ margin:"0 0 4px", fontSize:14, fontWeight:600, color:C.text }}>What Ankora remembers</p>
              <p style={{ margin:"0 0 12px", fontSize:12.5, color:C.text2, lineHeight:1.5 }}>Things Ankora has picked up about you and carries between chats. Remove anything that's off.</p>
              {memory.length === 0 ? (
                <p style={{ margin:"0 0 12px", fontSize:13, color:C.text3, fontStyle:"italic" }}>Nothing yet — Ankora will note things as you talk.</p>
              ) : (
                <div style={{ marginBottom:12 }}>
                  {memory.map(m => (
                    <div key={m.id} style={{ display:"flex", alignItems:"flex-start", gap:10, padding:"10px 12px", marginBottom:6, borderRadius:10, border:`1.5px solid ${C.borderLt}`, backgroundColor:C.bg2 }}>
                      <p style={{ margin:0, flex:1, fontSize:13.5, color:C.text, lineHeight:1.45 }}>{m.text}</p>
                      <span role="button" onClick={() => deleteMemory(m.id)} title="Forget this"
                        style={{ fontSize:16, color:C.text3, cursor:"pointer", lineHeight:1, flexShrink:0, marginTop:1 }}>×</span>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display:"flex", gap:8 }}>
                <input value={newMemory} onChange={e => setNewMemory(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && newMemory.trim()) { addMemory(newMemory); setNewMemory(""); } }}
                  placeholder="Add something for Ankora to remember…"
                  style={{ flex:1, fontSize:13.5, padding:"9px 12px", borderRadius:10, border:`1.5px solid ${C.border}`, backgroundColor:C.bg, color:C.text, outline:"none" }} />
                <span role="button" onClick={() => { if (newMemory.trim()) { addMemory(newMemory); setNewMemory(""); } }}
                  style={{ fontSize:13.5, fontWeight:700, color:newMemory.trim()?"#fff":C.text3, backgroundColor:newMemory.trim()?C.blue:C.bg2, border:newMemory.trim()?"none":`1.5px solid ${C.borderLt}`, borderRadius:10, padding:"9px 15px", cursor:newMemory.trim()?"pointer":"default", flexShrink:0 }}>Add</span>
              </div>
            </div>
            <div style={{ marginTop:28, paddingTop:22, borderTop:`1.5px solid ${C.borderLt}` }}>
              <p style={{ margin:"0 0 4px", fontSize:14, fontWeight:600, color:C.text }}>Password</p>
              <p style={{ margin:"0 0 12px", fontSize:12.5, color:C.text2, lineHeight:1.5 }}>Set a password to sign in without waiting for an emailed code. You can still use a code anytime.</p>
              <div style={{ display:"flex", gap:8 }}>
                <input type="password" autoComplete="new-password" value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") saveNewPassword(); }}
                  placeholder="New password (8+ characters)"
                  style={{ flex:1, fontSize:13.5, padding:"9px 12px", borderRadius:10, border:`1.5px solid ${C.border}`, backgroundColor:C.bg, color:C.text, outline:"none" }} />
                <span role="button" onClick={saveNewPassword}
                  style={{ fontSize:13.5, fontWeight:700, color:newPassword.length>=8?"#fff":C.text3, backgroundColor:newPassword.length>=8?C.blue:C.bg2, border:newPassword.length>=8?"none":`1.5px solid ${C.borderLt}`, borderRadius:10, padding:"9px 15px", cursor:newPassword.length>=8?"pointer":"default", flexShrink:0 }}>{pwBusy ? "Saving…" : "Save"}</span>
              </div>
              {pwMsg && <p style={{ margin:"8px 0 0", fontSize:12, color:pwMsg.includes("saved")?C.greenText:C.danger, lineHeight:1.4 }}>{pwMsg}</p>}
            </div>
            <div style={{ marginTop:22, paddingTop:18, borderTop:`1.5px solid ${C.borderLt}` }}>
              <span role="button" onClick={() => setShowClearConfirm(true)}
                style={{ fontSize:13, color:C.danger, cursor:"pointer" }}>Clear all data…</span>
            </div>
          </div>
          <div style={{ padding:"16px 22px calc(16px + env(safe-area-inset-bottom))", borderTop:`1.5px solid ${C.borderLt}`, display:"flex", gap:10, flexShrink:0 }}>
            <span role="button" onClick={() => setShowSettings(false)} style={{ fontSize:14, color:C.text2, padding:"12px 16px", cursor:"pointer", fontWeight:500 }}>Cancel</span>
            <span role="button" onClick={saveSettings} style={{ flex:1, textAlign:"center", fontSize:15, fontWeight:700, color:"#fff", backgroundColor:C.blue, borderRadius:12, padding:"13px 0", cursor:"pointer" }}>Save</span>
          </div>
        </div>
      )}

      {/* Past-sessions list overlay (opened from header during active chat) */}
      {showHistory && (
        <div style={{ position:"fixed", inset:0, zIndex:89, backgroundColor:C.bg, maxWidth:720, margin:"0 auto", display:"flex", flexDirection:"column" }}>
          <div style={{ padding:"calc(14px + env(safe-area-inset-top)) 18px 14px", borderBottom:`1.5px solid ${C.borderLt}`, display:"flex", alignItems:"center", gap:12, flexShrink:0 }}>
            <span role="button" onClick={() => setShowHistory(false)} style={{ fontSize:22, color:C.text2, cursor:"pointer", lineHeight:1 }}>←</span>
            <p style={{ margin:0, fontWeight:600, fontSize:16, color:C.text }}>Past sessions</p>
          </div>
          <div style={{ flex:1, overflowY:"auto", padding:"16px" }}>
            {sessions.length === 0 ? (
              <p style={{ fontSize:14, color:C.text3, fontStyle:"italic", textAlign:"center", marginTop:24 }}>No past sessions yet.</p>
            ) : sessions.map(s => (
              <div key={s.id} onClick={() => setViewingSession(s)} role="button"
                style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 14px", marginBottom:6, borderRadius:12, border:`1.5px solid ${C.borderLt}`, backgroundColor:C.bg2, cursor:"pointer" }}>
                <div style={{ minWidth:0 }}>
                  {(s.note || s.label) && <p style={{ margin:"0 0 2px", fontSize:14, fontWeight:600, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.note || s.label}</p>}
                  <p style={{ margin:0, fontSize:(s.note||s.label)?12:14, fontWeight:(s.note||s.label)?400:600, color:(s.note||s.label)?C.text3:C.text }}>{s.note && s.label ? `${s.label} · ` : ""}{fmtCalDate(s.startedAt)}</p>
                </div>
                <span style={{ fontSize:12, color:C.text3, flexShrink:0, marginLeft:10 }}>{s.messages.length} msg</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Session history overlay (read-only) */}
      {viewingSession && (
        <div style={{ position:"fixed", inset:0, zIndex:90, backgroundColor:C.bg, maxWidth:720, margin:"0 auto", display:"flex", flexDirection:"column" }}>
          <div style={{ padding:"calc(14px + env(safe-area-inset-top)) 18px 14px", borderBottom:`1.5px solid ${C.borderLt}`, display:"flex", alignItems:"center", gap:12, flexShrink:0 }}>
            <span role="button" onClick={() => setViewingSession(null)} style={{ fontSize:22, color:C.text2, cursor:"pointer", lineHeight:1 }}>←</span>
            <div style={{ flex:1, minWidth:0 }}>
              {viewingSession.label && <p style={{ margin:"0 0 1px", fontWeight:600, fontSize:15, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{viewingSession.label}</p>}
              <p style={{ margin:0, fontSize:viewingSession.label?11.5:15, color:C.text2, fontWeight:viewingSession.label?400:600 }}>{fmtCalDate(viewingSession.startedAt)}</p>
            </div>
            <input value={viewingSession.note || ""} maxLength={80}
              onChange={e => setSessionNote(viewingSession.id, e.target.value)}
              placeholder="✎ Edit title…"
              style={{ flexShrink:0, width:130, fontSize:12.5, padding:"7px 10px", borderRadius:9, border:`1.5px solid ${C.border}`, backgroundColor:C.bg2, color:C.text, outline:"none" }} />
          </div>
          <div style={{ padding:"10px 16px", borderBottom:`1.5px solid ${C.borderLt}`, flexShrink:0 }}>
            <span role="button" onClick={() => resumeSession(viewingSession)}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:7, width:"100%", fontSize:14, fontWeight:700, color:C.blueText, backgroundColor:C.blueBg, border:`1.5px solid ${C.blueBorder}`, borderRadius:10, padding:"11px 0", cursor:"pointer" }}>
              ↻ Resume this conversation
            </span>
          </div>
          <div style={{ flex:1, overflowY:"auto", padding:"14px 16px" }}>
            {viewingSession.messages.map((m, i) => {
              const u = m.role === "user";
              const grp = viewingSession.messages[i-1] && viewingSession.messages[i-1].role === m.role;
              return (
                <div key={m.id||i} style={{ display:"flex", flexDirection:"column", alignItems:u?"flex-end":"flex-start", marginTop:grp?3:12 }}>
                  <div style={{ maxWidth:"76%", backgroundColor:u?C.bubble:"#E9E9EB", color:u?"#fff":"#000", borderRadius:18, padding:"9px 14px", fontSize:14.5, lineHeight:1.5 }}>{renderContent(m.content)}</div>
                </div>
              );
            })}
            <div style={{ height:24 }} />
          </div>
        </div>
      )}

      {/* Calendar app chooser — shown the first time an event is added on this device */}
      {pendingCal && (
        <div style={{ position:"fixed", inset:0, zIndex:97, backgroundColor:"rgba(0,0,0,0.45)", display:"flex", alignItems:"flex-end", justifyContent:"center" }}
          onClick={() => setPendingCal(null)}>
          <div onClick={e => e.stopPropagation()}
            style={{ backgroundColor:C.bg, borderRadius:"20px 20px 0 0", padding:"22px 22px calc(22px + env(safe-area-inset-bottom))", width:"100%", maxWidth:480, boxShadow:"0 -4px 30px rgba(0,0,0,0.18)" }}>
            <h2 style={{ margin:"0 0 4px", fontSize:17, fontWeight:700, color:C.text }}>Open in which calendar?</h2>
            <p style={{ margin:"0 0 16px", fontSize:13, color:C.text2, lineHeight:1.5 }}>We'll remember your pick for next time — change it anytime in Settings.</p>
            {[
              { app:"apple",   emoji:"📅", label:"Apple Calendar", hint:"iPhone, iPad & Mac" },
              { app:"google",  emoji:"🗓️", label:"Google Calendar", hint:"Android, Gmail & web" },
              { app:"outlook", emoji:"📧", label:"Outlook",         hint:"Microsoft 365" },
            ].map(o => (
              <div key={o.app} role="button" onClick={() => chooseCalendarApp(o.app)}
                style={{ display:"flex", alignItems:"center", gap:14, padding:"14px 16px", marginBottom:8, borderRadius:14, border:`1.5px solid ${C.borderLt}`, backgroundColor:C.bg2, cursor:"pointer" }}>
                <span style={{ fontSize:22, lineHeight:1 }}>{o.emoji}</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <p style={{ margin:"0 0 1px", fontSize:15, fontWeight:600, color:C.text }}>{o.label}</p>
                  <p style={{ margin:0, fontSize:12, color:C.text3 }}>{o.hint}</p>
                </div>
                <span style={{ fontSize:18, color:C.text3 }}>›</span>
              </div>
            ))}
            <div style={{ textAlign:"center", marginTop:6 }}>
              <span role="button" onClick={() => setPendingCal(null)} style={{ fontSize:13.5, color:C.text2, cursor:"pointer", padding:"8px 16px", display:"inline-block" }}>Cancel</span>
            </div>
          </div>
        </div>
      )}

      {/* Clear-all-data confirmation */}
      {showClearConfirm && (
        <div style={{ position:"fixed", inset:0, zIndex:96, backgroundColor:"rgba(0,0,0,0.45)", display:"flex", alignItems:"center", justifyContent:"center", padding:"24px" }}
          onClick={() => setShowClearConfirm(false)}>
          <div onClick={e => e.stopPropagation()}
            style={{ backgroundColor:C.bg, borderRadius:18, padding:"24px", width:"100%", maxWidth:380, boxShadow:"0 8px 40px rgba(0,0,0,0.2)" }}>
            <div style={{ fontSize:30, textAlign:"center", marginBottom:10 }}>⚠️</div>
            <h2 style={{ margin:"0 0 10px", fontSize:18, fontWeight:700, color:C.text, textAlign:"center" }}>Clear all data?</h2>
            <p style={{ margin:"0 0 8px", fontSize:13.5, color:C.text2, lineHeight:1.55, textAlign:"center" }}>
              This deletes your <strong>board tasks</strong>, <strong>grocery list</strong>, and <strong>current chat</strong> from this device and your account.
            </p>
            <p style={{ margin:"0 0 18px", fontSize:12.5, color:C.text3, lineHeight:1.5, textAlign:"center" }}>
              You can undo the board &amp; grocery right after — but chat history can't be recovered.
            </p>
            <div style={{ display:"flex", gap:10 }}>
              <span role="button" onClick={() => setShowClearConfirm(false)}
                style={{ flex:1, textAlign:"center", fontSize:14.5, fontWeight:600, color:C.text2, border:`1.5px solid ${C.border}`, borderRadius:12, padding:"12px 0", cursor:"pointer" }}>Cancel</span>
              <span role="button" onClick={doClearAll}
                style={{ flex:1, textAlign:"center", fontSize:14.5, fontWeight:700, color:"#fff", backgroundColor:C.danger, borderRadius:12, padding:"12px 0", cursor:"pointer" }}>Clear everything</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Fix 4: Indigo timer alert overlay instead of red ── */}
      {timerAlert && (
        <div style={{
          position:"fixed", inset:0, zIndex:100,
          display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
          animation:"alertPulse 1s ease-in-out infinite alternate",
          backgroundColor: C.indigo,
        }}>
          <div style={{ fontSize:72, marginBottom:16, animation:"bounce 0.6s ease-in-out infinite alternate" }}>⏰</div>
          <h1 style={{ color:"#fff", fontSize:36, fontWeight:800, margin:"0 0 10px", textAlign:"center" }}>Time's up!</h1>
          {timer?.label && <p style={{ color:"rgba(255,255,255,0.85)", fontSize:18, margin:"0 0 40px", textAlign:"center", maxWidth:280 }}>{timer.label}</p>}
          <button onClick={dismissTimerAlert} style={{ fontSize:18, fontWeight:700, color:C.indigo, backgroundColor:"#fff", border:"none", borderRadius:16, padding:"16px 48px", cursor:"pointer", boxShadow:"0 4px 20px rgba(0,0,0,0.2)" }}>
            Done
          </button>
        </div>
      )}

      {/* Upgrade modal */}
      {showUpgrade && (
        <div style={{ position:"fixed", inset:0, zIndex:95, backgroundColor:"rgba(0,0,0,0.45)", display:"flex", alignItems:"flex-end", justifyContent:"center" }}
          onClick={() => setShowUpgrade(false)}>
          <div onClick={e => e.stopPropagation()}
            style={{ backgroundColor:C.bg, borderRadius:"20px 20px 0 0", padding:"28px 24px calc(28px + env(safe-area-inset-bottom))", width:"100%", maxWidth:520, boxShadow:"0 -4px 40px rgba(0,0,0,0.15)" }}>
            <div style={{ textAlign:"center", marginBottom:24 }}>
              <div style={{ fontSize:32, marginBottom:8 }}>✦</div>
              <h2 style={{ margin:"0 0 6px", fontSize:21, fontWeight:700, color:C.text }}>You've hit today's limit</h2>
              <p style={{ margin:0, fontSize:14, color:C.text2, lineHeight:1.5 }}>Upgrade to Ankora Pro for unlimited conversations and every new feature we ship.</p>
            </div>

            <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:16 }}>
              {/* Plan options — tapping highlights/selects a plan; checkout only fires from the Continue button below. */}
              {[
                { key:"annual",  name:"Annual",  price:"$48 / year", sub:"$4/month · save 20% vs monthly", best:true },
                { key:"monthly", name:"Monthly", price:"$5 / month",  sub:"Cancel any time",               best:false },
              ].map(plan => {
                const sel = selectedPlan === plan.key;
                return (
                  <div key={plan.key} role="button" onClick={() => setSelectedPlan(plan.key)}
                    style={{ borderRadius:14, border:`2px solid ${sel ? C.blue : C.borderLt}`, backgroundColor: sel ? C.blueBg : C.bg2, padding:"16px 18px", position:"relative", cursor:"pointer" }}>
                    {plan.best && <div style={{ position:"absolute", top:-10, left:18, fontSize:11, fontWeight:700, color:"#fff", backgroundColor:C.accentText, borderRadius:20, padding:"3px 12px" }}>BEST VALUE</div>}
                    <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                      <div style={{ width:20, height:20, borderRadius:"50%", border:`2px solid ${sel ? C.blue : C.border}`, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                        {sel && <div style={{ width:10, height:10, borderRadius:"50%", backgroundColor:C.blue }} />}
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:2 }}>
                          <span style={{ fontSize:15.5, fontWeight:700, color:C.text }}>{plan.name}</span>
                          <span style={{ fontSize:15.5, fontWeight:700, color: sel ? C.blueText : C.text }}>{plan.price}</span>
                        </div>
                        <p style={{ margin:0, fontSize:12.5, color:C.text2 }}>{plan.sub}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <span role="button" onClick={() => startCheckout(selectedPlan === "annual" ? import.meta.env.VITE_STRIPE_ANNUAL_PRICE_ID : import.meta.env.VITE_STRIPE_MONTHLY_PRICE_ID)}
              style={{ display:"block", textAlign:"center", marginBottom:14, fontSize:15, fontWeight:700, color:"#fff", backgroundColor: upgradeBusy ? C.text3 : C.blue, borderRadius:12, padding:"14px 0", cursor: upgradeBusy ? "default" : "pointer" }}>
              {upgradeBusy ? "Redirecting…" : "Continue to checkout"}
            </span>

            <p style={{ margin:0, fontSize:11.5, color:C.text3, textAlign:"center", lineHeight:1.5 }}>Secure checkout via Stripe · Cancel any time in Settings</p>
            <span role="button" onClick={() => setShowUpgrade(false)}
              style={{ display:"block", textAlign:"center", marginTop:16, fontSize:13.5, color:C.text2, cursor:"pointer" }}>Not now</span>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ padding:"calc(12px + env(safe-area-inset-top)) 18px 12px", borderBottom:`1.5px solid ${C.borderLt}`, display:"flex", alignItems:"center", gap:11, flexShrink:0 }}>
        <img src="/favicon.svg" alt="" style={{ width:28, height:27, flexShrink:0 }} />
        <div style={{ flex:1 }}>
          <p style={{ margin:0, fontWeight:600, fontSize:15, color:C.text }}>Ankora</p>
          <p style={{ margin:0, fontSize:11.5, color:C.text3 }}>your place to regroup</p>
        </div>
        {tab==="chat" && sessions.length>0 && (
          <span onClick={() => setShowHistory(true)} role="button" title="Past sessions"
            style={{ fontSize:18, lineHeight:1, color:C.text3, cursor:"pointer", flexShrink:0, padding:"2px" }}>🗂️</span>
        )}
        {tab==="chat" && messages.length>0 && (started || pastExpanded) && (
          <span onClick={startNewSession} role="button"
            style={{ fontSize:12, color:C.text2, backgroundColor:C.bg2, border:`1px solid ${C.borderLt}`, borderRadius:8, padding:"6px 12px", cursor:"pointer" }}>New session</span>
        )}
        <span onClick={openSettings} role="button" title="Preferences"
          style={{ fontSize:20, lineHeight:1, color:C.text3, cursor:"pointer", flexShrink:0, padding:"2px" }}>⚙️</span>
      </div>

      {showInstall && (
        <div style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 18px", backgroundColor:C.blueBg, borderBottom:`1px solid ${C.blueBorder}`, flexShrink:0 }}>
          <span style={{ fontSize:16, flexShrink:0 }}>📲</span>
          {installPrompt ? (
            <>
              <span style={{ flex:1, fontSize:12.5, color:C.blueText, lineHeight:1.4 }}>Install Ankora for alarms that fire even when the app is closed.</span>
              <span role="button" onClick={doInstall} style={{ fontSize:12.5, fontWeight:700, color:"#fff", backgroundColor:C.blue, borderRadius:8, padding:"6px 12px", cursor:"pointer", flexShrink:0 }}>Install</span>
            </>
          ) : (
            <span style={{ flex:1, fontSize:12.5, color:C.blueText, lineHeight:1.4 }}>Add Ankora to your Home Screen: tap <strong>Share ⬆︎</strong> then <strong>Add to Home Screen</strong>.</span>
          )}
          <span role="button" onClick={dismissInstall} style={{ fontSize:14, color:C.blueText, cursor:"pointer", lineHeight:1, flexShrink:0 }}>✕</span>
        </div>
      )}

      {notifPermission === "denied" && (
        <div style={{ padding:"10px 18px", backgroundColor:"#FEF3C7", borderBottom:`1px solid #FDE68A`, flexShrink:0 }}>
          <div onClick={() => setShowNotifHelp(v => !v)} role="button" style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" }}>
            <p style={{ margin:0, flex:1, fontSize:12.5, color:"#92400E", lineHeight:1.4 }}>
              ⚠️ Notifications are off — your timer alarm won't sound. <strong style={{ textDecoration:"underline" }}>How to turn them on</strong>
            </p>
            <span style={{ fontSize:11, color:"#92400E", flexShrink:0 }}>{showNotifHelp ? "▲" : "▼"}</span>
          </div>
          {showNotifHelp && <div style={{ marginTop:8 }}>{renderNotifSteps("#92400E")}</div>}
        </div>
      )}

      {timer && tab!=="timer" && (
        <div onClick={() => setTab("timer")} role="button"
          style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 18px", backgroundColor:timer.done?C.greenBg:C.blueBg, borderBottom:`1.5px solid ${C.borderLt}`, cursor:"pointer", flexShrink:0 }}>
          <span style={{ fontSize:15 }}>⏱️</span>
          <span style={{ fontSize:14, fontWeight:700, color:timer.done?C.greenText:C.blueText, fontVariantNumeric:"tabular-nums" }}>{timer.done?"Time's up!":fmtTime(timer.remaining)}</span>
          <span style={{ flex:1, fontSize:12.5, color:timer.done?C.greenText:C.blueText, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{timer.label||"Focus timer"}</span>
          <span onClick={(e) => { e.stopPropagation(); clearTimer(); }} role="button" style={{ fontSize:12, fontWeight:600, color:timer.done?C.greenText:C.blueText, padding:"2px 8px" }}>{timer.done?"Dismiss":"Stop"}</span>
        </div>
      )}

      {toast && <div style={{ backgroundColor:"#F0FDF4", padding:"10px 20px", fontSize:13.5, color:"#166534", textAlign:"center", fontWeight:500, flexShrink:0 }}>{toast}</div>}

      {clearBackup && (
        <div style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 18px", backgroundColor:"#FEF3C7", borderBottom:`1px solid #FDE68A`, flexShrink:0 }}>
          <span style={{ flex:1, fontSize:12.5, color:"#92400E" }}>Board &amp; grocery cleared.</span>
          <span role="button" onClick={undoClear} style={{ fontSize:12.5, fontWeight:700, color:C.blueText, cursor:"pointer" }}>Undo</span>
          <span role="button" onClick={() => setClearBackup(null)} style={{ fontSize:14, color:"#92400E", cursor:"pointer", lineHeight:1 }}>✕</span>
        </div>
      )}

      {/* Body */}
      <div ref={(el) => { bodyScrollRef.current = el; if (tab === "chat") chatScrollRef.current = el; }} style={{ flex:1, overflowY:"auto", minHeight:0 }}>

        {tab==="chat" && (
          <div style={{ padding:"14px 16px" }}>
            {(!started || messages.length === 0) && (
              <div>
                <div style={{ padding:"10px 0 18px" }}>
                  <h3 style={{ margin:"0 0 4px", fontSize:24, fontWeight:700, color:C.text }}>Hey, how's it going?</h3>
                  <p style={{ margin:0, fontSize:14, color:C.text2 }}>{((messages.length > 0 && !pastExpanded) || sessions.length > 0) ? "Pick up where you left off, or start something new below." : "Pick a starting point, or just tell me what's up."}</p>
                </div>
                {/* 1. Continue where you left off — active chat, else the most-recent archived session */}
                {(hasActiveConvo || continueSess) && (
                  <div role="button"
                    onClick={hasActiveConvo ? () => { setPastExpanded(true); setStarted(true); } : () => resumeSession(continueSess)}
                    style={{ marginBottom:20, padding:"15px 16px", backgroundColor:C.blueBg, border:`1.5px solid ${C.blueBorder}`, borderRadius:14, display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, cursor:"pointer" }}>
                    <div style={{ minWidth:0 }}>
                      <p style={{ margin:"0 0 2px", fontSize:15, fontWeight:700, color:C.blueText }}>Continue where you left off</p>
                      <p style={{ margin:0, fontSize:12.5, color:C.text2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                        {hasActiveConvo
                          ? `${messages.length} messages · pick the thread back up`
                          : `${continueSess.note || continueSess.label || fmtCalDate(continueSess.startedAt)} · ${(continueSess.messages||[]).length} messages`}
                      </p>
                    </div>
                    <span style={{ flexShrink:0, fontSize:13.5, fontWeight:700, color:"#fff", backgroundColor:C.accentText, borderRadius:9, padding:"9px 16px" }}>Continue</span>
                  </div>
                )}

                {/* 2. Start something new */}
                <p style={{ fontSize:12, color:C.text3, margin:"0 0 8px", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.05em" }}>{(hasActiveConvo || sessions.length > 0) ? "Or start something new" : "Start a conversation"}</p>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                  {STARTERS.map(s => (
                    <div key={s.label} onClick={() => sendMessage(s.prompt)} role="button"
                      style={{ display:"flex", alignItems:"center", gap:8, backgroundColor:C.bg2, border:`1.5px solid ${C.borderLt}`, borderRadius:12, padding:"11px 12px", cursor:"pointer", fontSize:13, color:C.text2, lineHeight:1.3, fontWeight:600 }}>
                      <span style={{ fontSize:17, flexShrink:0 }}>{s.icon}</span>{s.label}
                    </div>
                  ))}
                </div>

                {/* 3. The rest of history — capped, with "See all" handing off to the archive overlay */}
                {homeRecent.length > 0 && (
                  <div style={{ marginTop:24 }}>
                    <p style={{ fontSize:12, color:C.text3, margin:"0 0 8px", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.05em" }}>Recent</p>
                    {homeRecent.slice(0, HOME_RECENT_LIMIT).map(s => (
                      <div key={s.id} onClick={() => setViewingSession(s)} role="button"
                        style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 14px", marginBottom:6, borderRadius:12, border:`1.5px solid ${C.borderLt}`, backgroundColor:C.bg2, cursor:"pointer" }}>
                        <div style={{ minWidth:0 }}>
                          {(s.note || s.label) && <p style={{ margin:"0 0 2px", fontSize:14, fontWeight:600, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.note || s.label}</p>}
                          <p style={{ margin:0, fontSize:(s.note||s.label)?12:14, fontWeight:(s.note||s.label)?400:600, color:(s.note||s.label)?C.text3:C.text }}>{s.note && s.label ? `${s.label} · ` : ""}{fmtCalDate(s.startedAt)}</p>
                        </div>
                        <span style={{ fontSize:12, color:C.text3, flexShrink:0, marginLeft:10 }}>{s.messages.length} msg</span>
                      </div>
                    ))}
                    {homeRecent.length > HOME_RECENT_LIMIT && (
                      <div onClick={() => setShowHistory(true)} role="button"
                        style={{ marginTop:2, padding:"11px 14px", textAlign:"center", borderRadius:12, border:`1.5px solid ${C.borderLt}`, backgroundColor:C.bg, cursor:"pointer", fontSize:13, fontWeight:600, color:C.blueText }}>
                        See all {homeRecent.length} past sessions →
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {(pastExpanded || started) && messages.map((m, i) => {
              const u = m.role==="user";
              const grp = messages[i-1] && messages[i-1].role===m.role;
              return (
                <div key={m.id} style={{ display:"flex", flexDirection:"column", alignItems:u?"flex-end":"flex-start", marginTop:grp?3:12 }}>
                  <div style={{ maxWidth:"76%", backgroundColor:u?C.bubble:"#E9E9EB", color:u?"#fff":"#000", borderRadius:18, padding:"9px 14px", fontSize:14.5, lineHeight:1.5 }}>{renderContent(m.content)}</div>
                  {m.upgrade && (
                    <div style={{ maxWidth:"88%", width:"100%", marginTop:8, borderRadius:14, border:`1.5px solid ${C.blueBorder}`, backgroundColor:C.blueBg, padding:"14px 16px" }}>
                      <p style={{ margin:"0 0 10px", fontSize:13.5, fontWeight:600, color:C.blueText }}>Upgrade to Ankora Pro for unlimited</p>
                      <div style={{ display:"flex", gap:8 }}>
                        <span role="button" onClick={() => startCheckout(import.meta.env.VITE_STRIPE_ANNUAL_PRICE_ID)}
                          style={{ flex:1, textAlign:"center", fontSize:13, fontWeight:700, color:"#fff", backgroundColor:upgradeBusy?C.text3:C.blue, borderRadius:8, padding:"9px 0", cursor:upgradeBusy?"default":"pointer" }}>
                          {upgradeBusy ? "…" : "$48 / year"}
                        </span>
                        <span role="button" onClick={() => startCheckout(import.meta.env.VITE_STRIPE_MONTHLY_PRICE_ID)}
                          style={{ flex:1, textAlign:"center", fontSize:13, fontWeight:600, color:C.blueText, backgroundColor:C.bg, border:`1.5px solid ${C.blueBorder}`, borderRadius:8, padding:"9px 0", cursor:upgradeBusy?"default":"pointer" }}>
                          {upgradeBusy ? "…" : "$5 / month"}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {loading && <div style={{ display:"flex", justifyContent:"flex-start", marginTop:12 }}><div style={{ backgroundColor:"#E9E9EB", borderRadius:18, padding:"11px 16px" }}><span style={{ fontSize:20, letterSpacing:3, color:"#8E8E93" }}>···</span></div></div>}
            {pending.length>0 && (
              <div style={{ marginTop:16 }}>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", margin:"0 0 10px" }}>
                  <p style={{ fontSize:12.5, color:C.text2, margin:0, fontWeight:500 }}>Confirm?{pending.length>1 ? ` · ${pending.length}` : ""}</p>
                  {pending.length>1 && (
                    <span onClick={() => setPending([])} role="button"
                      style={{ fontSize:12.5, color:C.text2, cursor:"pointer", fontWeight:600 }}>Clear all</span>
                  )}
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  {pending.map(s => {
                    const bs = s.type==="grocery" ? {bg:C.greenBg,text:C.greenText,label:"Grocery"}
                              : s.type==="grocery-replace" ? {bg:"#FEF3C7",text:"#92400E",label:"Update item"}
                              : s.type==="grocery-remove" ? {bg:C.dangerBg,text:C.danger,label:"Remove item"}
                              : s.type==="replace" ? {bg:"#FEF3C7",text:"#92400E",label:"Update task"}
                              : s.type==="nextstep" ? {bg:"#EDE9FE",text:"#5B21B6",label:"Next step"}
                              : s.type==="complete" ? {bg:C.greenBg,text:C.greenText,label:"Mark done"}
                              : s.type==="calendar" ? {bg:"#FEF3C7",text:"#92400E",label:"Calendar"}
                              : s.type==="reminder" ? {bg:"#EDE9FE",text:"#5B21B6",label:"Reminder"}
                              : s.type==="timer" ? {bg:C.blueBg,text:C.blueText,label:"Timer"}
                              : s.type==="move" ? {bg:C.blueBg,text:C.blueText,label:"Move"}
                              : BUCKET_STYLE[s.bucket];
                    const taskRef = s.type==="complete" ? tasks.find(t=>t.id===s.targetId)?.text : null;
                    const moveRef = s.type==="move" ? tasks.find(t=>t.id===s.targetId)?.text : null;
                    const removeRef = s.type==="grocery-remove" ? grocery.find(g=>g.id===s.targetId)?.text : null;
                    const display = s.type==="calendar" ? `${s.title} · ${fmtCalDate(s.when)}`
                                    : s.type==="reminder" ? `${s.text} · ${fmtCalDate(s.when)}`
                                    : s.type==="timer" ? `${s.minutes} min${s.label?` · ${s.label}`:""}`
                                    : s.type==="move" ? `${moveRef || "Task"} → ${BUCKET_STYLE[s.bucket]?.label || s.bucket}`
                                    : (taskRef || removeRef || s.text);
                    const ctaLabel = s.type==="calendar" ? "Add to calendar" : s.type==="reminder" ? "Set reminder" : s.type==="timer" ? "Start" : s.type==="grocery-remove" ? "Remove" : s.type==="move" ? "Move" : "Confirm";
                    return (
                      <div key={s.id} style={{ display:"flex", alignItems:"center", gap:10, backgroundColor:C.bg, border:`1.5px solid ${C.border}`, borderRadius:12, padding:"10px 14px" }}>
                        <Badge bg={bs.bg} color={bs.text}>{bs.label}</Badge>
                        <span style={{ flex:1, fontSize:13.5, color:C.text }}>{display}</span>
                        <span onClick={() => confirm(s)} role="button" style={{ fontSize:13, padding:"6px 14px", borderRadius:8, border:`1.5px solid ${C.blueBorder}`, backgroundColor:C.blueBg, color:C.blueText, cursor:"pointer", fontWeight:600 }}>{ctaLabel}</span>
                        <span onClick={() => dismiss(s.id)} role="button" style={{ fontSize:13, padding:"6px 12px", borderRadius:8, border:`1.5px solid ${C.borderLt}`, color:C.text2, cursor:"pointer" }}>Skip</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}

        {tab==="board" && (
          <div style={{ padding:"16px 20px" }}>
            <BucketSection label="Today" items={todayTasks} bucket="today" />
            <BucketSection label="This week" items={weekTasks} bucket="week" />
            <BucketSection label="Parked" items={parkedTasks} bucket="parked" collapsible />
            {upcomingReminders.length>0 && (
              <div style={{ marginBottom:24 }}>
                <div onClick={() => setRemindersExpanded(v=>!v)} role="button"
                  style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"6px 0", cursor:"pointer" }}>
                  <p style={{ fontSize:12, color:C.text3, margin:0, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.05em" }}>⏰ Reminders · {upcomingReminders.length}</p>
                  <span style={{ fontSize:12, color:C.text2, fontWeight:600 }}>{remindersExpanded ? "Hide" : "Show"}</span>
                </div>
                <p style={{ fontSize:12, color:C.text3, margin:"2px 0 8px", lineHeight:1.4 }}>Things Ankora's holding to ping you at the right time — peek when you have a free moment.</p>
                {remindersExpanded && [...upcomingReminders].sort((a,b)=> new Date(b.when) - new Date(a.when)).map(r => {
                  const past = false;
                  return (
                    <div key={r.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 0", borderBottom:`1px solid ${C.borderLt}` }}>
                      <div style={{ flex:1, minWidth:0 }}>
                        <p style={{ margin:0, fontSize:13.5, color:past?C.text3:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.text}</p>
                        <p style={{ margin:"1px 0 0", fontSize:11.5, color:C.text3 }}>{past ? "Sent · " : ""}{fmtCalDate(r.when)}</p>
                      </div>
                      <span onClick={() => cancelReminder(r.id)} role="button" style={{ cursor:"pointer", color:C.text3, fontSize:15, padding:4, flexShrink:0 }}>✕</span>
                    </div>
                  );
                })}
              </div>
            )}
            {doneTasks.length>0 && (
              <div style={{ marginBottom:24 }}>
                <div onClick={() => setDoneExpanded(!doneExpanded)} role="button"
                  style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"6px 0", cursor:"pointer" }}>
                  <p style={{ fontSize:12, color:C.text3, margin:0, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.05em" }}>Done · {doneTasks.length}</p>
                  <span style={{ fontSize:12, color:C.text2, fontWeight:600 }}>{doneExpanded ? "Hide" : "Show"}</span>
                </div>
                {doneExpanded && doneTasks.map(t => (
                  <div key={t.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 0", borderBottom:`1px solid ${C.borderLt}` }}>
                    <div style={{ width:22, height:22, borderRadius:"50%", backgroundColor:C.greenBg, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:12, color:C.greenText, fontWeight:700 }}>✓</div>
                    <span style={{ flex:1, fontSize:13.5, color:C.text3, textDecoration:"line-through" }}>{t.text}</span>
                    <span onClick={(e) => { e.stopPropagation(); deleteTask(t.id); }} role="button" style={{ cursor:"pointer", color:C.text3, fontSize:15, padding:4 }}>✕</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ borderTop:`1.5px solid ${C.borderLt}`, paddingTop:18 }}>
              <p style={{ fontSize:13, color:C.text2, margin:"0 0 10px", fontWeight:500 }}>Add a task manually</p>
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                <input value={newTask} onChange={e=>setNewTask(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addManualTask()} placeholder="Task name" style={fieldStyle} />
                <div style={{ display:"flex", gap:8 }}>
                  <select value={newBucket} onChange={e=>setNewBucket(e.target.value)} style={{ ...fieldStyle, flex:1, width:"auto" }}>
                    <option value="today">Today</option><option value="week">This week</option><option value="parked">Parked</option>
                  </select>
                  <span onClick={addManualTask} role="button" style={btnStyle}>Add</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {tab==="timer" && (
          <div style={{ padding:"20px" }}>
            {!timer ? (
              <div style={{ textAlign:"center", paddingTop:10 }}>
                <div style={{ width:52, height:52, borderRadius:"50%", backgroundColor:C.blueBg, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 12px", fontSize:26 }}>⏱️</div>
                <h3 style={{ margin:"0 0 5px", fontSize:19, fontWeight:600, color:C.text }}>Focus timer</h3>
                <p style={{ margin:"0 0 24px", fontSize:13.5, color:C.text3, lineHeight:1.5 }}>Just pick a length and start. Don't aim to finish — aim to begin.</p>
                {notifPermission === "default" && (
                  <div style={{ margin:"0 auto 20px", padding:"12px 16px", backgroundColor:"#EFF6FF", border:`1px solid ${C.blueBorder}`, borderRadius:12, maxWidth:320, textAlign:"left" }}>
                    <p style={{ margin:0, fontSize:12.5, color:C.blueText, lineHeight:1.5 }}>
                      📣 <strong>The first timer asks to send notifications</strong> — allow it once, and your alarm sounds even if your screen is off.
                    </p>
                  </div>
                )}
                <input value={timerLabel} onChange={e => setTimerLabel(e.target.value)}
                  placeholder="What's this timer for? (optional)"
                  style={{ width:"100%", maxWidth:280, margin:"0 auto 12px", display:"block", boxSizing:"border-box", fontSize:15, padding:"12px 14px", borderRadius:12, border:`1.5px solid ${C.border}`, backgroundColor:C.bg2, color:C.text, outline:"none", textAlign:"center" }} />
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, maxWidth:280, margin:"0 auto" }}>
                  {TIMER_PRESETS.map(m => (
                    <div key={m} onClick={() => { startTimer(m, timerLabel.trim()); setTimerLabel(""); }} role="button"
                      style={{ height:64, display:"flex", alignItems:"center", justifyContent:"center", borderRadius:14, border:`1.5px solid ${C.border}`, backgroundColor:C.bg2, cursor:"pointer", fontSize:20, fontWeight:700, color:C.text }}>
                      {m}<span style={{ fontSize:13, fontWeight:500, color:C.text3 }}>&nbsp;min</span>
                    </div>
                  ))}
                </div>
                {(() => {
                  const m = parseInt(customMin, 10);
                  const valid = m > 0 && m <= 600;
                  const go = () => { if (valid) { startTimer(m, timerLabel.trim()); setCustomMin(""); setTimerLabel(""); } };
                  return (
                    <div style={{ display:"flex", gap:10, maxWidth:280, margin:"10px auto 0", alignItems:"stretch" }}>
                      <input type="number" inputMode="numeric" min="1" max="600" value={customMin}
                        onChange={e => setCustomMin(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") go(); }}
                        placeholder="Custom min"
                        style={{ flex:1, height:64, fontSize:18, padding:"0 14px", borderRadius:14, border:`1.5px solid ${C.border}`, backgroundColor:C.bg2, color:C.text, textAlign:"center", outline:"none", boxSizing:"border-box", fontWeight:700 }} />
                      <span role="button" onClick={go}
                        style={{ height:64, display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, fontWeight:700, color: valid ? "#fff" : C.text3, backgroundColor: valid ? C.blue : C.bg2, border: valid ? "none" : `1.5px solid ${C.borderLt}`, borderRadius:14, padding:"0 24px", cursor: valid ? "pointer" : "default" }}>Start</span>
                    </div>
                  );
                })()}
                <p style={{ margin:"22px 0 0", fontSize:12.5, color:C.text3, lineHeight:1.5 }}>Tip: start a timer for a specific task from the ••• menu on the Board.</p>
              </div>
            ) : (
              <div style={{ textAlign:"center", paddingTop:20 }}>
                <p style={{ margin:"0 0 6px", fontSize:14, color:C.text2 }}>{timer.label||"Focus timer"}</p>
                <div style={{ fontSize:64, fontWeight:700, color:timer.done?C.greenText:C.text, fontVariantNumeric:"tabular-nums", lineHeight:1.1, margin:"8px 0 20px" }}>{timer.done?"Done!":fmtTime(timer.remaining)}</div>
                {!timer.done && (
                  <div style={{ height:12, backgroundColor:"rgba(0,0,0,0.1)", borderRadius:6, overflow:"hidden", width:"100%", maxWidth:320, margin:"0 auto 28px" }}>
                    <div style={{ height:"100%", width:`${timerPct}%`, backgroundColor:C.blue, borderRadius:6, transition:"width 1s linear" }} />
                  </div>
                )}
                <div style={{ display:"flex", gap:10, justifyContent:"center", flexWrap:"wrap" }}>
                  {!timer.done && (timer.running
                    ? <span onClick={pauseTimer} role="button" style={{ fontSize:14, fontWeight:600, color:C.blueText, border:`1.5px solid ${C.blueBorder}`, borderRadius:10, padding:"10px 24px", cursor:"pointer" }}>Pause</span>
                    : <span onClick={resumeTimer} role="button" style={{ fontSize:14, fontWeight:600, color:"#fff", backgroundColor:C.blue, borderRadius:10, padding:"10px 24px", cursor:"pointer" }}>Resume</span>
                  )}
                  <span onClick={clearTimer} role="button" style={{ fontSize:14, fontWeight:600, color:C.text2, border:`1.5px solid ${C.border}`, borderRadius:10, padding:"10px 24px", cursor:"pointer" }}>{timer.done?"Done":"Stop"}</span>
                </div>
                {!timer.done && (
                  <div style={{ margin:"22px auto 0", maxWidth:320, padding:"12px 14px", backgroundColor:notifPermission==="granted"?C.greenBg:C.bg2, border:`1px solid ${notifPermission==="granted"?"#6EE7B7":C.borderLt}`, borderRadius:12, textAlign:"left" }}>
                    {notifPermission === "granted" ? (
                      <p style={{ margin:0, fontSize:12.5, color:C.greenText, lineHeight:1.5 }}>
                        📳 <strong>Notifications are on</strong> — your alarm will sound even if your screen is locked or this tab is closed.
                      </p>
                    ) : (
                      <p style={{ margin:0, fontSize:12.5, color:C.text2, lineHeight:1.5 }}>
                        📵 <strong>Walking away?</strong> Allow notifications to get an alarm even when the screen is off.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {tab==="notepad" && (
          <div style={{ padding:"16px 20px", display:"flex", flexDirection:"column", flex:1, minHeight:0 }}>
            <p style={{ fontSize:13, color:C.text2, margin:"0 0 9px", fontWeight:500 }}>
              Notepad — a quiet place to jot anything. Saves automatically and syncs across your devices.{" "}
              {profile?.notesReadable
                ? <span style={{ color:C.text3 }}>Ankora can read this.</span>
                : <span style={{ color:C.text3 }}>Private to you — Ankora can't read it.</span>}
            </p>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Brain dump, half-formed ideas, a phone number, whatever's rattling around…"
              style={{ flex:1, minHeight:300, width:"100%", resize:"none", fontSize:15, lineHeight:1.6, padding:"14px 15px", borderRadius:12, border:`1.5px solid ${C.border}`, backgroundColor:C.bg2, color:C.text, fontFamily:"inherit", outline:"none", boxSizing:"border-box" }} />
            <p style={{ fontSize:11.5, color:C.text3, margin:"8px 0 0" }}>
              {notes.trim() ? `${notes.trim().length} characters · saved` : "Empty"}
            </p>
          </div>
        )}

        {tab==="grocery" && (
          <div style={{ padding:"16px 20px" }}>
            <div style={{ marginBottom:22 }}>
              <p style={{ fontSize:13, color:C.text2, margin:"0 0 9px", fontWeight:500 }}>Add an item</p>
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                <input value={newGrocery} onChange={e=>setNewGrocery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addGroceryItem()} placeholder="What do you need?" style={fieldStyle} />
                <div style={{ display:"flex", gap:8 }}>
                  <input value={newStore} onChange={e=>setNewStore(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addGroceryItem()} placeholder="Store or place (optional)" style={{ ...fieldStyle, flex:1, width:"auto" }} />
                  <span onClick={addGroceryItem} role="button" style={btnStyle}>Add</span>
                </div>
              </div>
            </div>
            {unchecked.length===0 && checked.length===0 && <p style={{ fontSize:14, color:C.text3, marginBottom:20, fontStyle:"italic" }}>Nothing here yet. Add an item above or tell Ankora what you need.</p>}
            {groupNames.map(name => (
              <div key={name} style={{ marginBottom:22 }}>
                {(groupNames.length>1 || name!=="Grocery") && <p style={{ fontSize:12, color:C.text2, margin:"0 0 8px", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.05em" }}>{name}</p>}
                {groups[name].map(g => (
                  <div key={g.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"13px 0", borderBottom:`1px solid ${C.borderLt}` }}>
                    <div onClick={() => toggleGrocery(g.id)} role="button" tabIndex={0} onKeyDown={e=>(e.key==="Enter"||e.key===" ")&&toggleGrocery(g.id)}
                      style={{ width:26, height:26, borderRadius:6, border:`2px solid ${C.text}`, backgroundColor:C.bg2, cursor:"pointer", flexShrink:0, boxSizing:"border-box" }} />
                    <span onClick={() => toggleGrocery(g.id)} style={{ flex:1, fontSize:15, color:C.text, cursor:"pointer" }}>{g.text}</span>
                    <span onClick={() => deleteGrocery(g.id)} role="button" style={{ cursor:"pointer", color:C.text3, padding:4, fontSize:16 }}>✕</span>
                  </div>
                ))}
              </div>
            ))}
            {checked.length>0 && (
              <div style={{ marginTop:8 }}>
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
                  <p style={{ fontSize:12, color:C.text3, margin:0, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.05em" }}>In cart</p>
                  <span onClick={clearChecked} role="button" style={{ fontSize:12, color:C.text2, border:`1px solid ${C.borderLt}`, borderRadius:6, padding:"3px 10px", cursor:"pointer" }}>Clear all</span>
                </div>
                {checked.map(g => (
                  <div key={g.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"11px 0", borderBottom:`1px solid ${C.borderLt}` }}>
                    <div onClick={() => toggleGrocery(g.id)} role="button" tabIndex={0} onKeyDown={e=>(e.key==="Enter"||e.key===" ")&&toggleGrocery(g.id)}
                      style={{ width:26, height:26, borderRadius:6, border:`2px solid ${C.green}`, backgroundColor:C.greenBg, cursor:"pointer", flexShrink:0, boxSizing:"border-box", display:"flex", alignItems:"center", justifyContent:"center", color:C.greenText, fontSize:14, fontWeight:700 }}>✓</div>
                    <span onClick={() => toggleGrocery(g.id)} style={{ flex:1, fontSize:14, color:C.text3, textDecoration:"line-through", cursor:"pointer" }}>{g.text}{g.store?` · ${g.store}`:""}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Fix 5: Chat input with more vertical breathing room ── */}
      {tab==="chat" && (
        <div style={{ padding:"16px", borderTop:`1.5px solid ${C.borderLt}`, display:"flex", gap:10, alignItems:"flex-end", backgroundColor:C.bg, flexShrink:0 }}>
          <textarea ref={taRef} value={input} onChange={e=>{setInput(e.target.value); setLastActivity(Date.now());}} onKeyDown={handleKey}
            placeholder={isIOS || isAndroid ? "Message Ankora…  (🎤 tap your keyboard's mic to talk)" : "Message Ankora…  (Ctrl+Enter to send · 🎤 tap your keyboard's mic to talk)"} rows={2}
            style={{ flex:1, resize:"none", fontSize:16, padding:"13px 15px", borderRadius:20, border:`1.5px solid ${C.border}`, backgroundColor:C.bg2, color:C.text, fontFamily:"inherit", lineHeight:1.5, outline:"none", boxSizing:"border-box", maxHeight:160 }}
            onInput={e => { e.target.style.height="auto"; e.target.style.height=Math.min(e.target.scrollHeight,160)+"px"; }} />
          <span onClick={() => sendMessage(input)} role="button"
            style={{ width:44, height:44, borderRadius:"50%", backgroundColor:input.trim()&&!loading?C.accent:C.bg2, cursor:input.trim()&&!loading?"pointer":"default", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:18, color:input.trim()&&!loading?"#fff":C.text3, fontWeight:700, marginBottom:2 }}>↑</span>
        </div>
      )}

      {/* Bottom tab bar */}
      <div style={{ display:"flex", borderTop:`1.5px solid ${C.borderLt}`, backgroundColor:C.bg, flexShrink:0 }}>
        {TABS.map(t => {
          const active = tab===t.key;
          return (
            <div key={t.key} onClick={() => setTab(t.key)} role="button"
              style={{ flex:1, padding:"8px 0 10px", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:2, color:active?C.accentText:C.text3 }}>
              <div style={{ position:"relative", fontSize:20, opacity:active?1:0.55 }}>
                {t.glyph}
                {t.count>0 && <span style={{ position:"absolute", top:-5, right:-12, fontSize:10, fontWeight:700, backgroundColor:"#FF3B30", color:"#fff", borderRadius:10, padding:"1px 5px", minWidth:16, textAlign:"center" }}>{t.count}</span>}
              </div>
              <span style={{ fontSize:11, fontWeight:active?600:400 }}>{t.label}</span>
            </div>
          );
        })}
      </div>

      <div style={{ padding:"11px 20px calc(11px + env(safe-area-inset-bottom))", borderTop:`1px solid ${C.borderLt}`, display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0, gap:10 }}>
        <span style={{ fontSize:12.5, color:C.text2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", minWidth:0 }} title={session?.user?.email || ""}>
          {session?.user?.email ? `☁ ${session.user.email}` : "Synced to your account"}
        </span>
        <span style={{ display:"flex", gap:16, flexShrink:0, alignItems:"center" }}>
          {subscription === "active"
            ? <span style={{ fontSize:12, fontWeight:700, color:C.accentText, backgroundColor:C.accentBg, borderRadius:20, padding:"2px 10px" }}>✦ Pro</span>
            : subscription === "free"
              ? <span onClick={() => setShowUpgrade(true)} role="button" style={{ fontSize:12.5, color:C.accentText, cursor:"pointer", fontWeight:600 }}>Upgrade</span>
              : null}
          <a href="/privacy.html" target="_blank" rel="noreferrer" style={{ fontSize:12.5, color:C.text2, textDecoration:"underline" }}>Privacy</a>
          <a href="/terms.html" target="_blank" rel="noreferrer" style={{ fontSize:12.5, color:C.text2, textDecoration:"underline" }}>Terms</a>
          <span onClick={signOut} role="button" style={{ fontSize:12.5, color:C.text2, cursor:"pointer", textDecoration:"underline" }}>Sign out</span>
        </span>
      </div>

      <style>{`
        @keyframes alertPulse {
          0%   { background-color: #4F46E5; }
          100% { background-color: #6366F1; }
        }
        @keyframes bounce {
          0%   { transform: translateY(0px); }
          100% { transform: translateY(-12px); }
        }
        * { box-sizing: border-box; }
      `}</style>
    </div>
  );
}