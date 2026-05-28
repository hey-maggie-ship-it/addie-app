// ──────────────────────────────────────────────────────────
// ADDIE — ADHD Daily Assistant · Deployable build v2
// Set VITE_ANTHROPIC_KEY in your Vercel environment variables.
// ──────────────────────────────────────────────────────────

import { useState, useRef, useEffect, useCallback } from "react";

const API_KEY = import.meta.env.VITE_ANTHROPIC_KEY || "";
const STORAGE_KEY = "addie-app-state-v1";
const IDLE_RESET_MS = 60 * 60 * 1000;

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

const BUCKET_STYLE = {
  today:  { bg: "#FEF2F2", text: "#B91C1C", label: "Today" },
  week:   { bg: "#FFFBEB", text: "#92400E", label: "This week" },
  parked: { bg: "#F3F4F6", text: "#4B5563", label: "Parked" },
};

const C = {
  bg: "#ffffff", bg2: "#F9FAFB", border: "#9CA3AF", borderLt: "#E5E7EB",
  text: "#111827", text2: "#6B7280", text3: "#9CA3AF",
  blue: "#0B84FE", blueBg: "#EFF6FF", blueText: "#1D4ED8", blueBorder: "#BFDBFE",
  green: "#059669", greenBg: "#D1FAE5", greenText: "#065F46",
  danger: "#DC2626", dangerBg: "#FEF2F2",
  indigo: "#4F46E5", indigoBg: "#EEF2FF", indigoLight: "#6366F1",
};

function buildSystemPrompt(tasks, grocery) {
  const today  = tasks.filter(t => t.bucket === "today"  && !t.done);
  const week   = tasks.filter(t => t.bucket === "week"   && !t.done);
  const parked = tasks.filter(t => t.bucket === "parked" && !t.done);
  const done   = tasks.filter(t => t.done);
  const gItems = grocery.filter(g => !g.checked);
  const withNext = tasks.filter(t => t.nextStep && !t.done);

  return `You are Addie, a warm, direct, no-nonsense AI coach for high-achieving professionals with ADHD. Thinking partner — not a task manager, not a therapist.

Be DECISIVE when someone needs an answer or is ready to act — give your best take in one shot rather than dragging a question across many turns. One clarifying question is fine; three is too many.

But READ THE MOMENT — decisiveness is not the same as being blunt or transactional. When someone is struggling, venting, frustrated, or overwhelmed, slow down and meet them there first: acknowledge how it feels, dig a little deeper to understand what's really going on, and normalize it ("this is really common — a lot of people hit exactly this wall"). Then, when they're ready, help break it into a small, manageable next step. The empathy and the decisiveness work together: understand first, then point the way. Don't rush a struggling person toward a solution before they feel heard, and don't over-explain to someone who just wants a quick answer.

NEVER guess dates, times, prices, or facts you don't know. If a date/time isn't stated, ASK rather than fabricate. "Memorial Day" is the last Monday of May; "July 4th" is July 4th; never substitute one for another. If unsure, say so or ask.

CURRENT TASK MEMORY:
Today (max 3): ${today.length ? today.map(t=>`"${t.text}" [id:${t.id}]${t.nextStep?` [next:"${t.nextStep}"]`:""}`).join(", ") : "empty"}
This week: ${week.length ? week.map(t=>`"${t.text}" [id:${t.id}]${t.nextStep?` [next:"${t.nextStep}"]`:""}`).join(", ") : "empty"}
Parked: ${parked.length ? parked.map(t=>`"${t.text}" [id:${t.id}]`).join(", ") : "empty"}
Done today: ${done.length ? done.map(t=>`"${t.text}"`).join(", ") : "none"}

TASKS WITH PENDING NEXT STEPS:
${withNext.length ? withNext.map(t=>`- "${t.text}" → next: "${t.nextStep}" [id:${t.id}]`).join("\n") : "none"}

GROCERY: ${gItems.length ? gItems.map(g=>`"${g.text}"${g.store?` (from ${g.store})`:""}`).join(", ") : "Empty"}
Today has ${today.length}/${MAX_TODAY} slots. ${today.length>=MAX_TODAY?"Today is FULL.":`${MAX_TODAY-today.length} remaining.`}

When the user mentions completing something on the board, MARK IT DONE via the SUGGESTIONS block — don't just verbally acknowledge.

A focus timer exists. When someone's stuck starting something, casually offer time-boxing ("want to give this 15 minutes?"). When the user asks you to start a timer, include a type:timer suggestion in the SUGGESTIONS block.

CALENDAR HANDOFF: When a specific date+time emerges, include a type:calendar suggestion. Only concrete date+time — not vague stuff like "later today".

SUGGESTION FORMAT:

SUGGESTIONS:
- type:task | bucket:today | "task text"
- type:task | bucket:week | "task text"
- type:task | bucket:parked | "task text"
- type:grocery | "item name"
- type:grocery | "item name" | store:"store or place"
- type:replace | id:TASK_ID | "concrete first step"
- type:replace | id:TASK_ID | "concrete first step" | next:"what comes after"
- type:nextstep | id:TASK_ID | "next step text"
- type:complete | id:TASK_ID
- type:calendar | "event title" | when:"YYYY-MM-DDTHH:MM" | minutes:60
- type:timer | minutes:15 | label:"what the timer is for"

Rules: Max 3 suggestions per message. If Today is full, suggest week. Omit the entire SUGGESTIONS block if nothing to add.

ADVICE MODE: Sometimes the user just wants to think something through. Engage substantively, give ADHD-aware advice, don't pivot to tasks unless something concrete genuinely emerges.

STYLE: Warm, direct, short paragraphs. Bold one key action with **bold**. No "just do X." No shame. Acknowledge wins. Smallest physical first step when stuck.`;
}

export default function Addie() {
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
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [menuId, setMenuId] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const [timer, setTimer] = useState(null);
  const [pastExpanded, setPastExpanded] = useState(false);
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [timerAlert, setTimerAlert] = useState(false);
  const [notifPermission, setNotifPermission] = useState("default");
  const bottomRef = useRef(null);
  const taRef = useRef(null);
  const timerRef = useRef(null);
  const bodyScrollRef = useRef(null);
  const chatScrollRef = useRef(null);
  const wakeLockRef = useRef(null);
  // Store the absolute end time so backgrounding doesn't affect accuracy
  const timerEndTimeRef = useRef(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.tasks) setTasks(s.tasks);
        if (s.grocery) setGrocery(s.grocery);
        if (s.messages) setMessages(s.messages);
        if (s.lastActivity) setLastActivity(s.lastActivity);
        setStarted(false);
        setPastExpanded(false);
      }
    } catch {}
    if ("Notification" in window) setNotifPermission(Notification.permission);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tasks, grocery, messages, lastActivity })); } catch {}
  }, [tasks, grocery, messages, lastActivity, hydrated]);

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
            triggerTimerAlert();
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

  const requestNotifPermission = async () => {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      const result = await Notification.requestPermission();
      setNotifPermission(result);
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

  const triggerTimerAlert = () => {
    setTimerAlert(true);
    fireNotification(timer?.label || "");
  };

  const dismissTimerAlert = () => {
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
  const clearTimer = () => { clearTimeout(timerRef.current); timerEndTimeRef.current = null; setTimer(null); releaseWakeLock(); setTimerAlert(false); };
  const fmtTime = (s) => `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;

  const calendarLink = (title, whenIso, minutes) => {
    try {
      const start = new Date(whenIso);
      const end = new Date(start.getTime() + (minutes || 60) * 60000);
      const fmt = (d) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");
      const u = new URL("https://calendar.google.com/calendar/render");
      u.searchParams.set("action", "TEMPLATE");
      u.searchParams.set("text", title);
      u.searchParams.set("dates", `${fmt(start)}/${fmt(end)}`);
      return u.toString();
    } catch { return null; }
  };
  const fmtCalDate = (iso) => {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch { return iso; }
  };

  const parseSuggestions = (text) => {
    const block = text.match(/SUGGESTIONS:\n([\s\S]*?)(?:\n\n|$)/);
    if (!block) return { clean: text, suggestions: [] };
    const suggestions = block[1].trim().split("\n").map((l, i) => {
      const tim = l.match(/- type:timer \| minutes:(\d+)(?: \| label:"([^"]*)")?/);
      if (tim) return { id: "s"+Date.now()+i, type: "timer", minutes: parseInt(tim[1]), label: tim[2] || "" };
      const cal = l.match(/- type:calendar \| "(.+)" \| when:"([^"]+)"(?: \| minutes:(\d+))?/);
      if (cal) return { id: "s"+Date.now()+i, type: "calendar", title: cal[1], when: cal[2], minutes: cal[3] ? parseInt(cal[3]) : 60 };
      const comp = l.match(/- type:complete \| id:(\S+)/);
      if (comp) return { id: "s"+Date.now()+i, type: "complete", targetId: comp[1] };
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
      const t = l.match(/- type:task \| bucket:(today|week|parked) \| "(.+)"/);
      if (t) return { id: "s"+Date.now()+i, type: "task", bucket: t[1], text: t[2] };
      return null;
    }).filter(Boolean);
    return { clean: text.replace(/SUGGESTIONS:\n[\s\S]*?(?:\n\n|$)/, "").trim(), suggestions };
  };

  const sendMessage = async (userText) => {
    if (!userText.trim() || loading) return;
    const next = [...messages, { role: "user", content: userText, id: "u"+Date.now() }];
    setMessages(next); setInput(""); setLoading(true); setStarted(true); setPending([]); setLastActivity(Date.now());
    if (taRef.current) { taRef.current.style.height = "auto"; }
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, system: buildSystemPrompt(tasks, grocery), messages: next.map(m => ({ role: m.role, content: m.content })) }),
      });
      const data = await res.json();
      const raw = data.content?.find(b => b.type === "text")?.text || "Something went wrong.";
      const { clean, suggestions } = parseSuggestions(raw);
      setMessages([...next, { role: "assistant", content: clean, id: "a"+Date.now() }]);
      if (suggestions.length) setPending(suggestions);
    } catch { setMessages([...next, { role: "assistant", content: "Connection issue. Take a breath — try again.", id: "e"+Date.now() }]); }
    setLoading(false);
  };

  const confirm = (s) => {
    if (s.type === "grocery") { setGrocery(p => [...p, { id:"g"+Date.now(), text:s.text, checked:false, store:s.store||"" }]); showToast(`Added: ${s.text}`); }
    else if (s.type === "replace") { setTasks(p => p.map(t => t.id===s.targetId ? {...t, text:s.text, nextStep:s.nextStep||t.nextStep} : t)); showToast("Task updated"); }
    else if (s.type === "nextstep") { setTasks(p => p.map(t => t.id===s.targetId ? {...t, nextStep:s.text} : t)); showToast("Next step saved"); }
    else if (s.type === "complete") {
      const t = tasks.find(t => t.id === s.targetId);
      setTasks(p => p.map(t => t.id===s.targetId ? {...t, done:true} : t));
      showToast(`✓  ${t?.text || "Done"}`);
    }
    else if (s.type === "timer") { startTimer(s.minutes, s.label); }
    else if (s.type === "calendar") {
      const link = calendarLink(s.title, s.when, s.minutes);
      if (link) window.open(link, "_blank");
    }
    else { const n = tasks.filter(t=>t.bucket==="today"&&!t.done).length; const b = s.bucket==="today"&&n>=MAX_TODAY?"week":s.bucket; setTasks(p => [...p, {id:"t"+Date.now(), text:s.text, bucket:b, done:false}]); showToast(`Added to ${BUCKET_STYLE[b].label}`); }
    setPending(p => p.filter(x => x.id !== s.id));
  };
  const dismiss = (id) => setPending(p => p.filter(x => x.id !== id));
  const completeTask = (id) => { const t = tasks.find(t=>t.id===id); setTasks(p => p.map(t => t.id===id?{...t,done:true}:t)); setMenuId(null); showToast(`✓  ${t?.text}`); };
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
  const resetAll = () => { setTasks([]); setGrocery([]); setMessages([]); setStarted(false); setPending([]); try{window.localStorage.removeItem(STORAGE_KEY);}catch{} showToast("Everything cleared"); };

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
    // No special handling — let Enter be a normal line break
  };

  const fmtText = (t) => t.split(/(\*\*[^*]+\*\*)/).map((p,i) => p.startsWith("**")&&p.endsWith("**") ? <strong key={i} style={{fontWeight:600}}>{p.slice(2,-2)}</strong> : p);
  const renderContent = (t) => t.split("\n").filter(Boolean).map((line,i) => <p key={i} style={{margin:"0 0 5px",lineHeight:1.5}}>{fmtText(line)}</p>);

  const todayTasks  = tasks.filter(t => t.bucket==="today"  && !t.done);
  const weekTasks   = tasks.filter(t => t.bucket==="week"   && !t.done);
  const parkedTasks = tasks.filter(t => t.bucket==="parked" && !t.done);
  const doneTasks   = tasks.filter(t => t.done);
  const activeTasks = tasks.filter(t => !t.done).length;
  const unchecked   = grocery.filter(g => !g.checked);
  const checked     = grocery.filter(g => g.checked);
  const timerPct    = timer && timer.total>0 ? (timer.remaining/timer.total)*100 : 0;
  const idleNow     = Date.now() - lastActivity > IDLE_RESET_MS;

  // ── Fix 5: More vertical padding in chat input ──
  const fieldStyle = { display:"block", width:"100%", height:46, minHeight:46, fontSize:14, padding:"0 14px", borderRadius:10, border:`1.5px solid ${C.border}`, backgroundColor:C.bg, color:C.text, fontFamily:"inherit", outline:"none", boxSizing:"border-box", appearance:"none", WebkitAppearance:"none" };
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

  const BucketSection = ({ label, items, bucket }) => {
    const { bg, text } = BUCKET_STYLE[bucket];
    return (
      <div style={{ marginBottom:24 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
          <Badge bg={bg} color={text}>{label}</Badge>
          {bucket==="today" && <span style={{ fontSize:12, color:items.length>=MAX_TODAY?C.danger:C.text3, fontWeight:items.length>=MAX_TODAY?600:400 }}>{items.length}/{MAX_TODAY}</span>}
        </div>
        {items.length===0 ? <p style={{ fontSize:13, color:C.text3, margin:0, fontStyle:"italic" }}>Nothing here yet</p> : items.map(t => <TaskRow key={t.id} task={t} />)}
      </div>
    );
  };

  if (!hydrated) return <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", fontFamily:"system-ui,sans-serif", color:C.text3 }}>Loading your space…</div>;

  const TABS = [
    { key:"chat", label:"Chat", glyph:"💬" },
    { key:"board", label:"Board", glyph:"📋", count:activeTasks },
    { key:"timer", label:"Timer", glyph:"⏱️" },
    { key:"grocery", label:"Grocery", glyph:"🛒", count:unchecked.length },
  ];

  const groups = {};
  unchecked.forEach(g => { const k = g.store && g.store.trim() ? g.store.trim() : "Grocery"; (groups[k]=groups[k]||[]).push(g); });
  const groupNames = Object.keys(groups).sort((a,b) => a==="Grocery"?-1 : b==="Grocery"?1 : a.localeCompare(b));

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100vh", maxWidth:720, margin:"0 auto", fontFamily:"system-ui,-apple-system,sans-serif", backgroundColor:C.bg, position:"relative" }} onClick={() => menuId && setMenuId(null)}>

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

      {/* Header */}
      <div style={{ padding:"12px 18px", borderBottom:`1.5px solid ${C.borderLt}`, display:"flex", alignItems:"center", gap:11, flexShrink:0 }}>
        <div style={{ width:34, height:34, borderRadius:"50%", backgroundColor:C.blueBg, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:17 }}>🧠</div>
        <div style={{ flex:1 }}>
          <p style={{ margin:0, fontWeight:600, fontSize:15, color:C.text }}>Addie</p>
          <p style={{ margin:0, fontSize:11.5, color:C.text3 }}>clarity for a busy brain</p>
        </div>
        {tab==="chat" && messages.length>0 && (
          <span onClick={() => { setMessages([]); setStarted(false); setPending([]); }} role="button"
            style={{ fontSize:12, color:C.text2, backgroundColor:C.bg2, border:`1px solid ${C.borderLt}`, borderRadius:8, padding:"6px 12px", cursor:"pointer" }}>New session</span>
        )}
      </div>

      {notifPermission === "denied" && (
        <div style={{ padding:"10px 18px", backgroundColor:"#FEF3C7", borderBottom:`1px solid #FDE68A`, flexShrink:0 }}>
          <p style={{ margin:0, fontSize:12.5, color:"#92400E", lineHeight:1.5 }}>
            ⚠️ Notifications are blocked — timer alarm won't sound. Fix: Chrome Settings → Site settings → Notifications → allow this site.
          </p>
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

      {/* Body */}
      <div ref={(el) => { bodyScrollRef.current = el; if (tab === "chat") chatScrollRef.current = el; }} style={{ flex:1, overflowY:"auto", minHeight:0 }}>

        {tab==="chat" && (
          <div style={{ padding:"14px 16px" }}>
            {(!started || messages.length === 0) && (
              <div>
                <div style={{ textAlign:"center", padding:"4px 0 20px" }}>
                  <div style={{ width:46, height:46, borderRadius:"50%", backgroundColor:C.blueBg, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 10px", fontSize:23 }}>🧠</div>
                  <h3 style={{ margin:"0 0 4px", fontSize:19, fontWeight:600, color:C.text }}>Hey, how's it going?</h3>
                  <p style={{ margin:0, fontSize:13, color:C.text3 }}>Pick a starting point, or just tell me what's up.</p>
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                  {STARTERS.map(s => (
                    <div key={s.label} onClick={() => sendMessage(s.prompt)} role="button"
                      style={{ backgroundColor:C.bg2, border:`1.5px solid ${C.borderLt}`, borderRadius:12, padding:"12px", cursor:"pointer", fontSize:13, color:C.text, lineHeight:1.4, fontWeight:500 }}>
                      <span style={{ display:"block", fontSize:20, marginBottom:5 }}>{s.icon}</span>{s.label}
                    </div>
                  ))}
                </div>
                {messages.length > 0 && !pastExpanded && (
                  <div onClick={() => setPastExpanded(true)} role="button"
                    style={{ marginTop:18, padding:"12px 14px", backgroundColor:C.bg2, border:`1px solid ${C.borderLt}`, borderRadius:12, display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer" }}>
                    <span style={{ fontSize:13, color:C.text2 }}>↑ Continue where you left off · {messages.length} messages</span>
                    <span style={{ fontSize:12, color:C.blueText, fontWeight:600 }}>Show</span>
                  </div>
                )}
              </div>
            )}
            {(pastExpanded || started) && messages.map((m, i) => {
              const u = m.role==="user";
              const grp = messages[i-1] && messages[i-1].role===m.role;
              return (
                <div key={m.id} style={{ display:"flex", justifyContent:u?"flex-end":"flex-start", marginTop:grp?3:12 }}>
                  <div style={{ maxWidth:"76%", backgroundColor:u?C.blue:"#E9E9EB", color:u?"#fff":"#000", borderRadius:18, padding:"9px 14px", fontSize:14.5, lineHeight:1.5 }}>{renderContent(m.content)}</div>
                </div>
              );
            })}
            {loading && <div style={{ display:"flex", justifyContent:"flex-start", marginTop:12 }}><div style={{ backgroundColor:"#E9E9EB", borderRadius:18, padding:"11px 16px" }}><span style={{ fontSize:20, letterSpacing:3, color:"#8E8E93" }}>···</span></div></div>}
            {pending.length>0 && (
              <div style={{ marginTop:16 }}>
                <p style={{ fontSize:12.5, color:C.text2, margin:"0 0 10px", fontWeight:500 }}>Confirm?</p>
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  {pending.map(s => {
                    const bs = s.type==="grocery" ? {bg:C.greenBg,text:C.greenText,label:"Grocery"}
                              : s.type==="replace" ? {bg:"#FEF3C7",text:"#92400E",label:"Replace"}
                              : s.type==="nextstep" ? {bg:"#EDE9FE",text:"#5B21B6",label:"Next step"}
                              : s.type==="complete" ? {bg:C.greenBg,text:C.greenText,label:"Mark done"}
                              : s.type==="calendar" ? {bg:"#FEF3C7",text:"#92400E",label:"Calendar"}
                              : s.type==="timer" ? {bg:C.blueBg,text:C.blueText,label:"Timer"}
                              : BUCKET_STYLE[s.bucket];
                    const taskRef = s.type==="complete" ? tasks.find(t=>t.id===s.targetId)?.text : null;
                    const display = s.type==="calendar" ? `${s.title} · ${fmtCalDate(s.when)}`
                                    : s.type==="timer" ? `${s.minutes} min${s.label?` · ${s.label}`:""}`
                                    : (taskRef || s.text);
                    const ctaLabel = s.type==="calendar" ? "Add to calendar" : s.type==="timer" ? "Start" : "Confirm";
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
            <BucketSection label="Parked" items={parkedTasks} bucket="parked" />
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
                      📣 <strong>Starting a timer will ask for notification permission</strong> — allow it so your alarm fires even if the screen turns off.
                    </p>
                  </div>
                )}
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, maxWidth:280, margin:"0 auto" }}>
                  {TIMER_PRESETS.map(m => (
                    <div key={m} onClick={() => startTimer(m,"")} role="button"
                      style={{ padding:"20px 0", borderRadius:14, border:`1.5px solid ${C.border}`, backgroundColor:C.bg2, cursor:"pointer", fontSize:20, fontWeight:700, color:C.text }}>
                      {m}<span style={{ fontSize:13, fontWeight:500, color:C.text3 }}> min</span>
                    </div>
                  ))}
                </div>
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
                  <p style={{ margin:"22px 0 0", fontSize:12, color:C.text3, lineHeight:1.5, maxWidth:320, marginLeft:"auto", marginRight:"auto" }}>
                    Screen stays on while the timer runs. Walking away? <a href={`https://www.google.com/search?q=set+timer+${Math.ceil(timer.remaining/60)}+minutes`} target="_blank" rel="noreferrer" style={{ color:C.blueText, fontWeight:600, textDecoration:"underline" }}>Set a phone alarm</a> as backup.
                  </p>
                )}
              </div>
            )}
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
            {unchecked.length===0 && checked.length===0 && <p style={{ fontSize:14, color:C.text3, marginBottom:20, fontStyle:"italic" }}>Nothing here yet. Add an item above or tell Addie what you need.</p>}
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
            placeholder="Message Addie…" rows={2}
            style={{ flex:1, resize:"none", fontSize:14, padding:"13px 15px", borderRadius:20, border:`1.5px solid ${C.border}`, backgroundColor:C.bg2, color:C.text, fontFamily:"inherit", lineHeight:1.5, outline:"none", boxSizing:"border-box", maxHeight:160 }}
            onInput={e => { e.target.style.height="auto"; e.target.style.height=Math.min(e.target.scrollHeight,160)+"px"; }} />
          <span onClick={() => sendMessage(input)} role="button"
            style={{ width:44, height:44, borderRadius:"50%", backgroundColor:input.trim()&&!loading?C.blue:C.bg2, cursor:input.trim()&&!loading?"pointer":"default", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:18, color:input.trim()&&!loading?"#fff":C.text3, fontWeight:700, marginBottom:2 }}>↑</span>
        </div>
      )}

      {/* Bottom tab bar */}
      <div style={{ display:"flex", borderTop:`1.5px solid ${C.borderLt}`, backgroundColor:C.bg, flexShrink:0 }}>
        {TABS.map(t => {
          const active = tab===t.key;
          return (
            <div key={t.key} onClick={() => setTab(t.key)} role="button"
              style={{ flex:1, padding:"8px 0 10px", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:2, color:active?C.blueText:C.text3 }}>
              <div style={{ position:"relative", fontSize:20, opacity:active?1:0.55 }}>
                {t.glyph}
                {t.count>0 && <span style={{ position:"absolute", top:-5, right:-12, fontSize:10, fontWeight:700, backgroundColor:"#FF3B30", color:"#fff", borderRadius:10, padding:"1px 5px", minWidth:16, textAlign:"center" }}>{t.count}</span>}
              </div>
              <span style={{ fontSize:11, fontWeight:active?600:400 }}>{t.label}</span>
            </div>
          );
        })}
      </div>

      <div style={{ padding:"8px 20px", borderTop:`1px solid ${C.borderLt}`, display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0 }}>
        <span style={{ fontSize:11, color:C.text3 }}>Saved on this device</span>
        <span onClick={resetAll} role="button" style={{ fontSize:11, color:C.text3, cursor:"pointer", textDecoration:"underline" }}>Reset everything</span>
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
