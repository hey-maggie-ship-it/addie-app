// ──────────────────────────────────────────────────────────
// ADDIE — ADHD Daily Assistant · Final deployable build
//
// Goes in src/App.jsx of a Vite + React project.
// Set VITE_ANTHROPIC_KEY in your host's environment variables.
// Full step-by-step deploy guide is in the chat.
// ──────────────────────────────────────────────────────────

import { useState, useRef, useEffect, useCallback } from "react";

const API_KEY = import.meta.env.VITE_ANTHROPIC_KEY || "";
const STORAGE_KEY = "addie-app-state-v1";

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
};

function buildSystemPrompt(tasks, grocery) {
  const today  = tasks.filter(t => t.bucket === "today"  && !t.done);
  const week   = tasks.filter(t => t.bucket === "week"   && !t.done);
  const parked = tasks.filter(t => t.bucket === "parked" && !t.done);
  const done   = tasks.filter(t => t.done);
  const gItems = grocery.filter(g => !g.checked);
  const withNext = tasks.filter(t => t.nextStep && !t.done);

  return `You are Addie, a warm, direct, no-nonsense AI coach for high-achieving professionals with ADHD. You are a thinking partner — not a task manager, not a therapist, not a productivity guru.
You deeply understand ADHD: initiation struggles, time blindness, overwhelm, open loops, shame spirals, hyperfocus, and the exhausting extra cognitive load of high-responsibility life.

CURRENT TASK MEMORY:
Today (max 3): ${today.length ? today.map(t=>`"${t.text}" [id:${t.id}]${t.nextStep?` [next:"${t.nextStep}"]`:""}`).join(", ") : "empty"}
This week: ${week.length ? week.map(t=>`"${t.text}" [id:${t.id}]${t.nextStep?` [next:"${t.nextStep}"]`:""}`).join(", ") : "empty"}
Parked: ${parked.length ? parked.map(t=>`"${t.text}" [id:${t.id}]`).join(", ") : "empty"}
Done today: ${done.length ? done.map(t=>`"${t.text}"`).join(", ") : "none"}

TASKS WITH PENDING NEXT STEPS (bring up naturally during check-ins/wind-downs):
${withNext.length ? withNext.map(t=>`- "${t.text}" → next: "${t.nextStep}" [id:${t.id}]`).join("\n") : "none"}

GROCERY: ${gItems.length ? gItems.map(g=>`"${g.text}"${g.store?` (from ${g.store})`:""}`).join(", ") : "Empty"}
Today has ${today.length}/${MAX_TODAY} slots. ${today.length>=MAX_TODAY?"Today is FULL.":`${MAX_TODAY-today.length} remaining.`}

YOUR ROLE:
- Reference task memory naturally. During check-in/wind-down, weave in pending next steps gently — once, never forced.
- A countdown timer exists. When someone's stuck starting something, casually suggest time-boxing it ("want to give this just 15 minutes?"). Optional, never prescriptive about schedules.
- When tasks or grocery items emerge, append EXACTLY this block:

SUGGESTIONS:
- type:task | bucket:today | "task text"
- type:task | bucket:week | "task text"
- type:task | bucket:parked | "task text"
- type:grocery | "item name"
- type:grocery | "item name" | store:"store or place"
- type:replace | id:TASK_ID | "concrete first step"
- type:replace | id:TASK_ID | "concrete first step" | next:"what comes after"
- type:nextstep | id:TASK_ID | "next step text"

Rules: type:replace swaps a vague board task for a concrete first step (no duplicates). Include next: when known. type:nextstep attaches a follow-up without replacing. Concrete actionable tasks only. Food/consumables → grocery; include store: when the user says where ("eggs from Costco"). Single purchases → task. Max 3 suggestions. If Today full, suggest week. Omit the block entirely if nothing to add.

ADVICE MODE: Sometimes the user just wants to think something through, not make tasks. Engage with substance, give ADHD-aware advice, don't rush to suggest tasks.

STYLE: Warm, direct, short paragraphs. Bold one key action with **bold**. One question at a time. Never "just do X." No shame. Acknowledge wins. Smallest possible next step when stuck.`;
}

export default function Addie() {
  const [tab, setTab] = useState("chat");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);
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
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [timer, setTimer] = useState(null);
  const bottomRef = useRef(null);
  const recRef = useRef(null);
  const taRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.tasks) setTasks(s.tasks);
        if (s.grocery) setGrocery(s.grocery);
        if (s.messages) { setMessages(s.messages); if (s.messages.length) setStarted(true); }
      }
    } catch {}
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tasks, grocery, messages })); } catch {}
  }, [tasks, grocery, messages, hydrated]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading, pending]);

  useEffect(() => {
    if (timer && timer.running && timer.remaining > 0) {
      timerRef.current = setTimeout(() => setTimer(t => t ? { ...t, remaining: t.remaining - 1 } : null), 1000);
      return () => clearTimeout(timerRef.current);
    }
    if (timer && timer.running && timer.remaining === 0) {
      setTimer(t => t ? { ...t, running: false, done: true } : null);
      showToast("⏰ Time's up!");
    }
  }, [timer]);

  const showToast = (m) => { setToast(m); setTimeout(() => setToast(null), 4000); };

  const startTimer = (min, label) => {
    setTimer({ label: label || "", total: min*60, remaining: min*60, running: true, done: false });
    setMenuId(null); setTab("timer");
  };
  const pauseTimer = () => setTimer(t => t ? { ...t, running: false } : null);
  const resumeTimer = () => setTimer(t => t ? { ...t, running: true, done: false } : null);
  const clearTimer = () => { clearTimeout(timerRef.current); setTimer(null); };
  const fmtTime = (s) => `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;

  const startListening = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const r = new SR();
    r.continuous = false; r.interimResults = true; r.lang = "en-US";
    r.onstart = () => { setListening(true); setTranscript(""); };
    r.onresult = e => {
      const t = Array.from(e.results).map(x => x[0].transcript).join("");
      setTranscript(t);
      if (e.results[e.results.length-1].isFinal) { setInput(t); setTranscript(""); }
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recRef.current = r; r.start();
  }, []);
  const stopListening = () => { recRef.current?.stop(); setListening(false); };

  const parseSuggestions = (text) => {
    const block = text.match(/SUGGESTIONS:\n([\s\S]*?)(?:\n\n|$)/);
    if (!block) return { clean: text, suggestions: [] };
    const suggestions = block[1].trim().split("\n").map((l, i) => {
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
    setMessages(next); setInput(""); setLoading(true); setStarted(true); setPending([]);
    if (taRef.current) taRef.current.style.height = "auto";
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system: buildSystemPrompt(tasks, grocery), messages: next.map(m => ({ role: m.role, content: m.content })) }),
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

  const handleKey = (e) => { if (e.key==="Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(input); } };
  const fmtText = (t) => t.split(/(\*\*[^*]+\*\*)/).map((p,i) => p.startsWith("**")&&p.endsWith("**") ? <strong key={i} style={{fontWeight:600}}>{p.slice(2,-2)}</strong> : p);
  const renderContent = (t) => t.split("\n").filter(Boolean).map((line,i) => <p key={i} style={{margin:"0 0 5px",lineHeight:1.5}}>{fmtText(line)}</p>);

  const todayTasks  = tasks.filter(t => t.bucket==="today"  && !t.done);
  const weekTasks   = tasks.filter(t => t.bucket==="week"   && !t.done);
  const parkedTasks = tasks.filter(t => t.bucket==="parked" && !t.done);
  const doneTasks   = tasks.filter(t => t.done);
  const activeTasks = tasks.filter(t => !t.done).length;
  const unchecked   = grocery.filter(g => !g.checked);
  const checked     = grocery.filter(g => g.checked);
  const hasSpeech   = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  const timerPct    = timer && timer.total>0 ? (timer.remaining/timer.total)*100 : 0;

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
                <input autoFocus value={editText} onChange={e=>setEditText(e.target.value)}
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

      {/* Header */}
      <div style={{ padding:"12px 18px", borderBottom:`1.5px solid ${C.borderLt}`, display:"flex", alignItems:"center", gap:11, flexShrink:0 }}>
        <div style={{ width:34, height:34, borderRadius:"50%", backgroundColor:C.blueBg, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:17 }}>🧠</div>
        <div style={{ flex:1 }}>
          <p style={{ margin:0, fontWeight:600, fontSize:15, color:C.text }}>Addie</p>
          <p style={{ margin:0, fontSize:11.5, color:C.text3 }}>your ADHD coach</p>
        </div>
        {tab==="chat" && messages.length>0 && (
          <span onClick={() => { setMessages([]); setStarted(false); setPending([]); }} role="button"
            style={{ fontSize:12, color:C.text2, backgroundColor:C.bg2, border:`1px solid ${C.borderLt}`, borderRadius:8, padding:"6px 12px", cursor:"pointer" }}>New session</span>
        )}
      </div>

      {/* Slim persistent timer indicator */}
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
      {listening && (
        <div style={{ backgroundColor:C.blueBg, padding:"10px 20px", display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
          <span style={{ width:8, height:8, borderRadius:"50%", backgroundColor:C.blue, display:"inline-block", animation:"pulse 1s infinite" }} />
          <span style={{ fontSize:13.5, color:C.blueText, flex:1, fontStyle:transcript?"normal":"italic" }}>{transcript||"Listening…"}</span>
          <span onClick={stopListening} role="button" style={{ fontSize:12, color:C.blueText, border:`1.5px solid ${C.blueBorder}`, borderRadius:8, padding:"4px 12px", cursor:"pointer", fontWeight:600 }}>Done</span>
        </div>
      )}

      {/* Body */}
      <div style={{ flex:1, overflowY:"auto", minHeight:0 }}>

        {tab==="chat" && (
          <div style={{ padding:"14px 16px" }}>
            {!started && (
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
              </div>
            )}
            {messages.map((m, i) => {
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
                <p style={{ fontSize:12.5, color:C.text2, margin:"0 0 10px", fontWeight:500 }}>Add to your board?</p>
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  {pending.map(s => {
                    const bs = s.type==="grocery" ? {bg:C.greenBg,text:C.greenText,label:"Grocery"} : s.type==="replace" ? {bg:"#FEF3C7",text:"#92400E",label:"Replace"} : s.type==="nextstep" ? {bg:"#EDE9FE",text:"#5B21B6",label:"Next step"} : BUCKET_STYLE[s.bucket];
                    return (
                      <div key={s.id} style={{ display:"flex", alignItems:"center", gap:10, backgroundColor:C.bg, border:`1.5px solid ${C.border}`, borderRadius:12, padding:"10px 14px" }}>
                        <Badge bg={bs.bg} color={bs.text}>{bs.label}</Badge>
                        <span style={{ flex:1, fontSize:13.5, color:C.text }}>{s.text}</span>
                        <span onClick={() => confirm(s)} role="button" style={{ fontSize:13, padding:"6px 14px", borderRadius:8, border:`1.5px solid ${C.blueBorder}`, backgroundColor:C.blueBg, color:C.blueText, cursor:"pointer", fontWeight:600 }}>Add</span>
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
                <p style={{ fontSize:12, color:C.text3, margin:"0 0 10px", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.05em" }}>Done</p>
                {doneTasks.map(t => (
                  <div key={t.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 0", borderBottom:`1px solid ${C.borderLt}` }}>
                    <div style={{ width:22, height:22, borderRadius:"50%", backgroundColor:C.greenBg, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:12, color:C.greenText, fontWeight:700 }}>✓</div>
                    <span style={{ flex:1, fontSize:13.5, color:C.text3, textDecoration:"line-through" }}>{t.text}</span>
                    <span onClick={() => deleteTask(t.id)} role="button" style={{ cursor:"pointer", color:C.text3, fontSize:15, padding:4 }}>✕</span>
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

      {/* Chat input */}
      {tab==="chat" && (
        <div style={{ padding:"12px 16px", borderTop:`1.5px solid ${C.borderLt}`, display:"flex", gap:10, alignItems:"flex-end", backgroundColor:C.bg, flexShrink:0 }}>
          {hasSpeech && (
            <span onClick={listening?stopListening:startListening} role="button"
              style={{ width:42, height:42, borderRadius:"50%", border:`1.5px solid ${listening?"#FECACA":C.border}`, backgroundColor:listening?C.dangerBg:C.bg2, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:18 }}>{listening?"🔴":"🎙️"}</span>
          )}
          <textarea ref={taRef} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={handleKey}
            placeholder={listening?"Listening…":"Message Addie…"} rows={1}
            style={{ flex:1, resize:"none", fontSize:14, padding:"11px 15px", borderRadius:20, border:`1.5px solid ${C.border}`, backgroundColor:C.bg2, color:C.text, fontFamily:"inherit", lineHeight:1.5, outline:"none", boxSizing:"border-box" }}
            onInput={e => { e.target.style.height="auto"; e.target.style.height=Math.min(e.target.scrollHeight,100)+"px"; }} />
          <span onClick={() => sendMessage(input)} role="button"
            style={{ width:42, height:42, borderRadius:"50%", backgroundColor:input.trim()&&!loading?C.blue:C.bg2, cursor:input.trim()&&!loading?"pointer":"default", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:18, color:input.trim()&&!loading?"#fff":C.text3, fontWeight:700 }}>↑</span>
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

      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.35}} *{box-sizing:border-box;}`}</style>
    </div>
  );
}
