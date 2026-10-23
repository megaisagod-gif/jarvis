"use strict";
// ===================================================================
//  J.A.R.V.I.S. — voice assistant (static PWA, Gemini-powered)
// ===================================================================

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("jarvis." + k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("jarvis." + k, v); } catch {} },
  del(k) { try { localStorage.removeItem("jarvis." + k); } catch {} },
};
const cfg = {
  get key() { return store.get("key", ""); },
  get model() { return store.get("model", "gemini-flash-latest"); },
  get search() { return store.get("search", "1") === "1"; },
  get title() { return store.get("title", "") || "sir"; },
  get city() { return store.get("city", "") || "Bucharest"; },
  get region() { return store.get("region", "") || "Romania and the world"; },
  get lang() { return store.get("lang", "en-US"); },
  get voice() { return store.get("voice", ""); },
  get rate() { return parseFloat(store.get("rate", "1")); },
};
// shared state (declared first: the clock and reactor read it right away)
const timers = [];
let wakeMode = false, state = "idle";

const pick = a => a[Math.floor(Math.random() * a.length)];
const norm = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9\s'-]/g, " ").replace(/\s+/g, " ").trim();

// ------------------------------------------------------------------ UI helpers
function addMsg(text, who = "jarvis") {
  const d = document.createElement("div");
  d.className = "msg " + who;
  const label = { jarvis: "J.A.R.V.I.S.", user: cfg.title.toUpperCase(), sys: "SYSTEM" }[who];
  d.innerHTML = `<div class="who">${label} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div><div class="body"></div>`;
  d.querySelector(".body").textContent = text;
  $("log").appendChild(d);
  $("log").scrollTop = 1e9;
  return d;
}
let toastTimer;
function toast(html, ms = 4000) {
  const t = $("toast"); t.innerHTML = html; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
function setState(s, label) {
  state = s;
  $("reactor").className = "reactor " + s;
  $("stateLabel").textContent = label || { idle: "STANDBY", listening: "LISTENING", thinking: "PROCESSING", speaking: "SPEAKING" }[s];
  $("micPill").className = "pill " + (s === "listening" || (wakeMode && s !== "speaking") ? "live" : "");
}
function setPill(id, cls) { $(id).className = "pill " + cls; }

// ------------------------------------------------------------------ HUD clock
function tick() {
  const d = new Date();
  $("hudTime").textContent = d.toLocaleTimeString("en-GB");
  $("hudDate").textContent = d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
  renderTimers();
}
setInterval(tick, 1000); tick();
const updateNet = () => setPill("netPill", navigator.onLine ? "ok" : "err");
addEventListener("online", updateNet); addEventListener("offline", updateNet); updateNet();
const updateAi = () => setPill("aiPill", cfg.key ? "ok" : "warn");
updateAi();

// ------------------------------------------------------------------ reactor drawing
(function buildReactor() {
  const NS = "http://www.w3.org/2000/svg";
  const mk = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.appendChild(e); return e; };
  const ticks = $("ticks");
  for (let i = 0; i < 120; i++) {
    const a = i * 3 * Math.PI / 180, major = i % 10 === 0;
    const r1 = 172, r2 = major ? 160 : 166;
    mk("line", { x1: 200 + r1 * Math.cos(a), y1: 200 + r1 * Math.sin(a), x2: 200 + r2 * Math.cos(a), y2: 200 + r2 * Math.sin(a), class: "tick" + (major ? " major" : "") }, ticks);
  }
  const segs = $("segments");
  for (let i = 0; i < 10; i++) {
    const a1 = (i * 36 + 4) * Math.PI / 180, a2 = (i * 36 + 32) * Math.PI / 180, r1 = 74, r2 = 84;
    const p = (r, a) => `${200 + r * Math.cos(a)} ${200 + r * Math.sin(a)}`;
    mk("path", { d: `M${p(r1, a1)} L${p(r2, a1)} A${r2} ${r2} 0 0 1 ${p(r2, a2)} L${p(r1, a2)} A${r1} ${r1} 0 0 0 ${p(r1, a1)}Z`, class: "seg" }, segs);
  }
  const bars = $("bars"), N = 64, barEls = [];
  for (let i = 0; i < N; i++) barEls.push(mk("line", { class: "bar" }, bars));
  let level = 0;
  (function anim(t) {
    const target = state === "speaking" ? 1 : state === "listening" ? .45 : state === "thinking" ? .3 : .08;
    level += (target - level) * .08;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 - Math.PI / 2;
      const wave = Math.abs(Math.sin(t / 180 + i * .7) * Math.sin(t / 310 + i * .23)) + Math.random() * .25;
      const len = 3 + level * wave * 26;
      const r1 = 140, r2 = r1 + len;
      const e = barEls[i];
      e.setAttribute("x1", 200 + r1 * Math.cos(a)); e.setAttribute("y1", 200 + r1 * Math.sin(a));
      e.setAttribute("x2", 200 + r2 * Math.cos(a)); e.setAttribute("y2", 200 + r2 * Math.sin(a));
    }
    requestAnimationFrame(anim);
  })(0);
})();

// ------------------------------------------------------------------ holographic background
(function background() {
  const c = $("bg"), g = c.getContext("2d");
  let w, h, pts = [];
  const resize = () => {
    w = c.width = innerWidth * devicePixelRatio; h = c.height = innerHeight * devicePixelRatio;
    const n = Math.min(90, Math.floor(innerWidth * innerHeight / 16000));
    pts = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - .5) * .25, vy: (Math.random() - .5) * .25, r: Math.random() * 1.6 + .4 }));
  };
  addEventListener("resize", resize); resize();
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  (function frame() {
    g.clearRect(0, 0, w, h);
    // perspective floor grid
    g.strokeStyle = "rgba(42,212,255,0.06)"; g.lineWidth = 1;
    const horizon = h * .62, cx = w / 2;
    for (let i = -14; i <= 14; i++) { g.beginPath(); g.moveTo(cx + i * w * .01, horizon); g.lineTo(cx + i * w * .12, h); g.stroke(); }
    for (let j = 0; j < 10; j++) { const y = horizon + (h - horizon) * Math.pow(j / 10, 1.8); g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    // particles + links
    const D = 140 * devicePixelRatio;
    for (const p of pts) {
      if (!reduce) { p.x += p.vx; p.y += p.vy; }
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
    }
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < D) { g.strokeStyle = `rgba(42,212,255,${.12 * (1 - d / D)})`; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
    }
    for (const p of pts) { g.fillStyle = "rgba(159,243,255,.7)"; g.beginPath(); g.arc(p.x, p.y, p.r * devicePixelRatio, 0, 7); g.fill(); }
    requestAnimationFrame(frame);
  })();
})();

// ------------------------------------------------------------------ text-to-speech
let voices = [], speaking = false, speakId = 0;
function bestVoice() {
  const lang = cfg.lang.toLowerCase(), base = lang.slice(0, 2);
  const saved = voices.find(v => v.name === cfg.voice);
  if (saved) return saved;
  const pool = voices.filter(v => v.lang.toLowerCase().replace("_", "-").startsWith(base));
  // JARVIS is British: prefer natural en-GB male voices
  const prefs = base === "en"
    ? [/ryan.*natural|thomas.*natural/i, /en-gb.*natural|natural.*en-gb/i, /google uk english male/i, /daniel/i, /arthur/i, /natural/i, /male/i]
    : [/natural|online/i];
  for (const re of prefs) { const v = pool.find(v => re.test(v.name + " " + v.lang)); if (v) return v; }
  return pool.find(v => v.lang.toLowerCase().replace("_", "-") === lang) || pool[0] || null;
}
function loadVoices() {
  voices = speechSynthesis.getVoices();
  const sel = $("sVoice"), base = cfg.lang.slice(0, 2);
  const list = voices.filter(v => v.lang.toLowerCase().startsWith(base));
  sel.innerHTML = "";
  sel.add(new Option("Auto (best available)", ""));
  list.forEach(v => sel.add(new Option(`${v.name} (${v.lang})`, v.name)));
  sel.value = list.some(v => v.name === cfg.voice) ? cfg.voice : "";
}
if ("speechSynthesis" in window) { speechSynthesis.onvoiceschanged = loadVoices; loadVoices(); }

function cleanForSpeech(t) {
  return t.replace(/```[\s\S]*?```/g, " ").replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#`>|~]/g, "").replace(/\[(.*?)\]\(.*?\)/g, "$1").replace(/\s+/g, " ").trim();
}
function speak(text) {
  if (!("speechSynthesis" in window)) return Promise.resolve();
  speechSynthesis.cancel();
  const clean = cleanForSpeech(text);
  if (!clean) return Promise.resolve();
  // Chrome cuts long utterances (~15s): queue sentence by sentence
  const parts = clean.match(/[^.!?;]+[.!?;]*/g) || [clean];
  const voice = bestVoice(), id = ++speakId;
  speaking = true; pauseRec(); setState("speaking");
  return new Promise(resolve => {
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p.trim());
      u.lang = voice ? voice.lang : cfg.lang; if (voice) u.voice = voice;
      u.rate = cfg.rate; u.pitch = .95;
      if (i === parts.length - 1) u.onend = u.onerror = () => { if (id === speakId) { speaking = false; afterSpeak(); } resolve(); };
      speechSynthesis.speak(u);
    });
  });
}
function say(text) { addMsg(text, "jarvis"); return speak(text); }
function silence() { speakId++; if ("speechSynthesis" in window) speechSynthesis.cancel(); speaking = false; afterSpeak(); }

// ------------------------------------------------------------------ speech recognition
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recOn = false, oneShot = false, armed = false;
const WAKE = /\b(jarvis|jarvi|jarvus|jervis|javis|jarvys|jar vis|gervais|travis)\b/;

if (SR) {
  rec = new SR();
  rec.continuous = true; rec.interimResults = true;
  rec.onstart = () => { recOn = true; if (!speaking) setState("listening", wakeMode && !oneShot && !armed ? "SAY “JARVIS”" : "LISTENING"); };
  rec.onend = () => {
    recOn = false; $("interim").textContent = "";
    if (wakeMode && !speaking) setTimeout(startRec, 250);    // browsers stop on their own; keep it alive
    else if (!speaking && state !== "thinking") setState("idle");
  };
  rec.onerror = e => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      wakeMode = false; oneShot = false; $("wakeBtn").classList.remove("on");
      setPill("micPill", "err");
      addMsg("Microphone access denied. Allow the microphone for this site in your browser settings.", "sys");
    } else if (e.error === "network") {
      addMsg("Speech recognition needs an internet connection.", "sys");
    } else if (e.error === "language-not-supported") {
      addMsg(`Speech recognition does not support ${cfg.lang} in this browser.`, "sys");
    }
  };
  rec.onresult = e => {
    let interim = "", final = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]; r.isFinal ? final += r[0].transcript : interim += r[0].transcript;
    }
    $("interim").textContent = interim;
    if (!final.trim()) return;
    $("interim").textContent = "";
    final = final.trim();

    if (oneShot || armed) {
      oneShot = false; armed = false;
      if (!wakeMode) try { rec.stop(); } catch {}
      return handle(final);
    }
    const n = norm(final), m = n.match(WAKE);
    if (!m) return;
    const rest = final.slice(final.toLowerCase().indexOf(m[0]) + m[0].length).replace(/^[\s,.!?]+/, "");
    if (rest.length > 1) handle(rest);
    else { armed = true; speak(pick([`Yes, ${cfg.title}?`, "At your service.", `Listening, ${cfg.title}.`])); }
  };
} else {
  setPill("micPill", "err");
}
function startRec() {
  if (!rec || recOn) return;
  rec.lang = cfg.lang;
  try { rec.start(); } catch {}
}
function pauseRec() { if (rec && recOn) try { rec.abort(); } catch {} }
function afterSpeak() {
  if (wakeMode || oneShot || armed) startRec();
  else if (state !== "thinking") setState("idle");
}

function talk() {
  if (!rec) { $("cmdInput").focus(); return toast("Voice input isn't supported in this browser. Use Chrome, Edge or Safari."); }
  silence(); oneShot = true;
  if (recOn) setState("listening"); else startRec();
}
$("talkBtn").onclick = talk;
$("reactor").onclick = talk;
$("reactor").onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); talk(); } };
$("wakeBtn").onclick = () => {
  if (!rec) return toast("Voice input isn't supported in this browser.");
  wakeMode = !wakeMode; $("wakeBtn").classList.toggle("on", wakeMode);
  if (wakeMode) { startRec(); addMsg("Wake word active. Say “Jarvis” followed by your command.", "sys"); }
  else { pauseRec(); setState("idle"); }
};
$("stopBtn").onclick = silence;
$("clearBtn").onclick = () => { $("log").innerHTML = ""; };
$("cmdForm").onsubmit = e => {
  e.preventDefault();
  const t = $("cmdInput").value.trim();
  if (t) { $("cmdInput").value = ""; handle(t); }
};
addEventListener("keydown", e => {
  if (e.key === " " && e.ctrlKey) { e.preventDefault(); talk(); }
  if (e.key === "Escape") silence();
});

// mobile tabs
document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => showTab(b.dataset.tab));
function showTab(t) {
  document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("active", x.dataset.tab === t));
  $("commsPanel").classList.toggle("active", t === "comms");
  $("intelPanel").classList.toggle("active", t === "intel");
}
showTab("comms");

// ------------------------------------------------------------------ actions
const SITES = {
  youtube: "https://www.youtube.com", google: "https://www.google.com", gmail: "https://mail.google.com",
  facebook: "https://www.facebook.com", instagram: "https://www.instagram.com", tiktok: "https://www.tiktok.com",
  netflix: "https://www.netflix.com", spotify: "https://open.spotify.com", twitter: "https://x.com", x: "https://x.com",
  whatsapp: "https://web.whatsapp.com", github: "https://github.com", reddit: "https://www.reddit.com",
  maps: "https://www.google.com/maps", "google maps": "https://www.google.com/maps", amazon: "https://www.amazon.com",
  chatgpt: "https://chatgpt.com", claude: "https://claude.ai", "ai studio": "https://aistudio.google.com",
  linkedin: "https://www.linkedin.com", twitch: "https://www.twitch.tv", wikipedia: "https://www.wikipedia.org",
  emag: "https://www.emag.ro", olx: "https://www.olx.ro", calendar: "https://calendar.google.com", drive: "https://drive.google.com",
};
function openUrl(url, label) {
  const w = window.open(url, "_blank", "noopener");
  // popup blockers (especially on phones) block opening without a tap: offer a button instead
  if (!w) {
    const m = addMsg(`Tap to open ${label || url}`, "sys");
    const a = document.createElement("a");
    a.href = url; a.target = "_blank"; a.rel = "noopener"; a.className = "btn primary act"; a.textContent = "OPEN";
    a.style.textDecoration = "none";
    m.appendChild(a);
    toast(`Popup blocked — <a href="${url}" target="_blank" rel="noopener">tap here to open</a>`, 8000);
  }
}

// timers
function addTimer(seconds, label) {
  const t = { end: Date.now() + seconds * 1000, label: label || fmtDur(seconds) };
  t.h = setTimeout(() => {
    timers.splice(timers.indexOf(t), 1); beep();
    say(`${cap(cfg.title)}, your ${t.label} timer is done.`);
    if (window.Notification?.permission === "granted" && document.hidden) new Notification("J.A.R.V.I.S.", { body: `Timer done: ${t.label}`, icon: "icons/icon-192.png" });
  }, seconds * 1000);
  timers.push(t); renderTimers();
  if (window.Notification && Notification.permission === "default") Notification.requestPermission().catch(() => {});
}
function renderTimers() {
  $("timerWidget").hidden = !timers.length;
  $("timerList").innerHTML = timers.map(t => {
    const s = Math.max(0, Math.round((t.end - Date.now()) / 1000));
    return `<div class="timer"><span>${escapeHtml(t.label)}</span><b>${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}</b></div>`;
  }).join("");
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
const fmtDur = s => s >= 3600 ? plural(+(s / 3600).toFixed(1), "hour") : s >= 60 ? plural(Math.round(s / 60), "minute") : plural(s, "second");
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, .3, .6].forEach(t => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 988; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(.18, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + t + .25);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + .26);
    });
  } catch {}
}

// weather (Open-Meteo, free, no key)
const WMO = { 0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light showers", 81: "showers",
  82: "violent showers", 85: "snow showers", 86: "heavy snow showers", 95: "thunderstorms", 96: "thunderstorms with hail", 99: "severe thunderstorms with hail" };
async function getWeather(city) {
  const geo = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(city)}`)).json();
  if (!geo.results?.length) throw new Error(`I couldn't find a place called ${city}.`);
  const p = geo.results[0];
  const q = new URLSearchParams({ latitude: p.latitude, longitude: p.longitude, timezone: "auto", forecast_days: 1,
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max" });
  const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?${q}`)).json();
  const c = w.current, d = w.daily;
  const wx = { city: p.name, country: p.country || "", temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature),
    desc: WMO[c.weather_code] || "unknown conditions", wind: Math.round(c.wind_speed_10m), hum: c.relative_humidity_2m,
    max: Math.round(d.temperature_2m_max[0]), min: Math.round(d.temperature_2m_min[0]), rain: d.precipitation_probability_max?.[0] };
  $("wxTemp").textContent = wx.temp + "°";
  $("wxDesc").textContent = `${wx.city} · ${wx.desc}`;
  $("wxMeta").textContent = `FEELS ${wx.feels}° · ${wx.min}°/${wx.max}° · WIND ${wx.wind}KM/H · RAIN ${wx.rain ?? "?"}%`;
  return wx;
}
getWeather(cfg.city).catch(() => {});

// ------------------------------------------------------------------ Gemini
let history = [];
try { history = JSON.parse(store.get("history", "[]")); } catch { history = []; }
const saveHistory = () => store.set("history", JSON.stringify(history.slice(-30)));

function systemPrompt() {
  const now = new Date();
  return `You are J.A.R.V.I.S., the AI assistant from Iron Man. You serve the user, whom you address as "${cfg.title}".
Personality: calm, highly competent, loyal, with dry, understated British wit. Never sycophantic.

Your replies are SPOKEN ALOUD by text-to-speech, so:
- Be brief: usually 1 to 3 sentences. Go longer only if explicitly asked for detail, or for a news briefing.
- Plain text only. No markdown, no bullet symbols, no emojis, no URLs, no tables.
- Write numbers, times and units the way they should be spoken.
- Reply in English unless the user clearly speaks another language.

Context: the current local date and time is ${now.toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short" })} (${Intl.DateTimeFormat().resolvedOptions().timeZone}). The user's home city is ${cfg.city}. Preferred news region: ${cfg.region}.
${cfg.search ? "You have Google Search available: use it for anything current (news, scores, prices, events, facts that may have changed). Never invent current events." : "You do not have internet access; say so if asked about current events."}

Device actions: you can control the user's device by adding tags on separate lines at the very END of your reply. They are executed and hidden from speech.
[[open: https://full-url]]  opens a website (use it when asked to open, show or play something; for YouTube searches use https://www.youtube.com/results?search_query=...)
[[timer: SECONDS | short label]]  starts a countdown timer
Only use actions when the user asks for them.`;
}

async function gemini(userText, { useSearch = cfg.search } = {}) {
  const contents = [...history.slice(-20), { role: "user", parts: [{ text: userText }] }];
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt() }] },
    contents,
    generationConfig: { temperature: .7, maxOutputTokens: 1024 },
  };
  if (useSearch) body.tools = [{ google_search: {} }];
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.key },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || res.statusText;
    // search grounding may be unavailable for some models / quotas: retry once without it
    if (useSearch && (res.status === 400 || res.status === 429) && /search|tool|grounding|quota|exhausted/i.test(msg))
      return gemini(userText, { useSearch: false });
    const err = new Error(msg); err.status = res.status; throw err;
  }
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join("").trim();
  if (!text) throw new Error(cand?.finishReason === "SAFETY" ? "That request was blocked by Gemini's safety filter." : "Gemini returned an empty response.");
  history.push({ role: "user", parts: [{ text: userText }] }, { role: "model", parts: [{ text }] });
  saveHistory();
  const chunks = cand.groundingMetadata?.groundingChunks || [];
  return { text, sources: chunks.map(c => c.web).filter(Boolean) };
}

function showSources(sources, title) {
  if (!sources.length) return;
  const seen = new Set();
  const box = $("sources"); box.innerHTML = "";
  sources.forEach(s => {
    if (seen.has(s.title)) return; seen.add(s.title);
    const a = document.createElement("a");
    a.href = s.uri; a.target = "_blank"; a.rel = "noopener";
    a.innerHTML = `<small></small>`; a.prepend(s.title || "Source");
    a.querySelector("small").textContent = (title || "").toUpperCase();
    box.appendChild(a);
  });
  $("intelMeta").textContent = `${seen.size} SOURCES · ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

function runActions(text) {
  const acts = [...text.matchAll(/\[\[\s*(open|timer)\s*:\s*([^\]]+?)\s*\]\]/gi)];
  for (const [, kind, arg] of acts) {
    if (kind.toLowerCase() === "open" && /^https?:\/\//i.test(arg)) openUrl(arg.trim());
    if (kind.toLowerCase() === "timer") {
      const [sec, label] = arg.split("|").map(s => s.trim());
      if (+sec > 0) addTimer(Math.round(+sec), label);
    }
  }
  return text.replace(/\[\[[^\]]*\]\]/g, "").trim();
}

async function askAI(text, { sourceTitle } = {}) {
  if (!cfg.key) {
    say(`I'm afraid my higher functions are offline, ${cfg.title}. Please add your Gemini API key in settings.`);
    return openSettings();
  }
  if (!navigator.onLine) return say("We appear to be offline. I need a connection for that.");
  setState("thinking");
  const pending = addMsg("", "jarvis"); pending.classList.add("typing");
  try {
    const { text: reply, sources } = await gemini(text);
    setPill("aiPill", "ok");
    const spoken = runActions(reply);
    pending.classList.remove("typing");
    pending.querySelector(".body").textContent = spoken;
    showSources(sources, sourceTitle || text.slice(0, 40));
    speak(spoken);
  } catch (e) {
    pending.remove();
    let msg = `I ran into a problem reaching Gemini: ${e.message}`;
    if (e.status === 400 && /api key/i.test(e.message)) msg = "Gemini rejected the API key. Please check it in settings.";
    else if (e.status === 403) msg = "Gemini refused the request. The API key may be restricted or disabled.";
    else if (e.status === 404) msg = `The model ${cfg.model} isn't available. Pick another one in settings.`;
    else if (e.status === 429) msg = "We've hit Gemini's rate limit. Give it a minute and try again.";
    else if (e.status >= 500) msg = "Gemini's servers are having trouble right now. Try again shortly.";
    setPill("aiPill", "err");
    say(msg);
  }
}

// ------------------------------------------------------------------ command router
// Simple things are handled instantly and offline; everything else goes to Gemini.
const NUMW = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, half: .5 };
const HELP = () => `Here's what I can do, ${cfg.title}. Brief you on the news, tell you the time, date and weather, open websites, search Google or YouTube, set timers, and answer pretty much anything else through Gemini. Say Jarvis first when wake word mode is on.`;

async function handle(raw) {
  addMsg(raw, "user");
  const n = norm(raw);
  let m;

  if (/^(stop|silence|quiet|shut up|enough|cancel|that's all)\b/.test(n)) return silence();

  if (/^(what time is it|what's the time|whats the time|time|tell me the time|current time)\b/.test(n)) {
    return say(`It's ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}, ${cfg.title}.`);
  }
  if (/^(what's the date|whats the date|what day is (it|today)|what is the date|today's date|date)\b/.test(n)) {
    return say(`Today is ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.`);
  }

  if ((m = n.match(/\b(?:timer|countdown|remind me in|alarm in)\b.*?\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety|half)\s*(?:an?\s*)?(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/))
      || (m = n.match(/\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|ten|fifteen|twenty|thirty|half)\s*(?:an?\s*)?(seconds?|secs?|minutes?|mins?|hours?|hrs?)\s+timer\b/))) {
    const k = /^\d/.test(m[1]) ? parseFloat(m[1]) : NUMW[m[1]];
    const mult = m[2].startsWith("s") ? 1 : m[2].startsWith("m") ? 60 : 3600;
    const secs = Math.round(k * mult);
    addTimer(secs);
    return say(`Timer set for ${fmtDur(secs)}.`);
  }

  if (/\b(weather|temperature|forecast|is it (cold|hot|raining|warm))\b/.test(n) && !/\b(tomorrow|week|weekend|next)\b/.test(n)) {
    m = raw.match(/\b(?:in|for|at)\s+([A-Za-zÀ-ž .'-]+?)\s*(?:today|now|right now)?[?.!]*$/i);
    const city = m ? m[1].trim() : cfg.city;
    setState("thinking");
    try {
      const w = await getWeather(city);
      showTab("intel");
      let s = `Currently ${w.temp} degrees and ${w.desc} in ${w.city}, feeling like ${w.feels}. Today's range is ${w.min} to ${w.max}`;
      s += w.rain != null ? `, with a ${w.rain} percent chance of precipitation.` : ".";
      if (w.rain >= 50) s += ` I'd take an umbrella, ${cfg.title}.`;
      else if (w.max <= 3) s += " Dress warmly.";
      return say(s);
    } catch (e) { return say(e.message.startsWith("I couldn't") ? e.message : "I can't reach the weather service right now."); }
  }

  if ((m = n.match(/^(?:play|put on)\s+(.+?)(?:\s+on youtube)?$/)) || (m = n.match(/^(?:search|look up|find)\s+(.+?)\s+on youtube$/)) || (m = n.match(/^youtube\s+(.+)$/))) {
    openUrl("https://www.youtube.com/results?search_query=" + encodeURIComponent(m[1]), "YouTube");
    return say(`Searching YouTube for ${m[1]}.`);
  }
  if ((m = n.match(/^(?:google|search for|search|look up)\s+(.+?)(?:\s+on google)?$/))) {
    openUrl("https://www.google.com/search?q=" + encodeURIComponent(m[1]), "Google");
    return say(`Searching for ${m[1]}.`);
  }
  if ((m = n.match(/^(?:open|launch|go to|show me)\s+(.+)$/))) {
    const k = m[1].replace(/\.(com|ro|org|net)$/, "").replace(/^the\s+/, "").trim();
    if (SITES[k]) { openUrl(SITES[k], k); return say(pick([`Opening ${k}.`, `${cap(k)}, coming up.`, `Right away, ${cfg.title}.`])); }
    // anything else: let Gemini figure out the URL
  }

  if (/\b(news|headlines|briefing|what's happening|whats happening|what happened today)\b/.test(n) && !/\b(about|regarding)\b/.test(n)) {
    showTab("intel");
    return askAI(`Give me a spoken news briefing: the 5 most important news stories right now for ${cfg.region}. Use Google Search for today's news. One or two sentences per story, introduced naturally like a butler briefing his employer. End by asking if I want details on any of them.`, { sourceTitle: "News briefing" });
  }

  if (/^(help|what can you do|commands|what do you do)\b/.test(n)) return say(HELP());
  if (/^(forget everything|clear memory|reset memory|erase memory)\b/.test(n)) { history = []; saveHistory(); return say("Memory wiped. A fresh start."); }

  return askAI(raw);
}

// ------------------------------------------------------------------ settings
function openSettings() {
  $("sKey").value = cfg.key; $("sTitle").value = store.get("title", ""); $("sCity").value = store.get("city", "");
  $("sRegion").value = store.get("region", ""); $("sLang").value = cfg.lang; $("sRate").value = cfg.rate;
  $("sSearch").checked = cfg.search;
  fillModels(cfg.model ? [cfg.model] : []);
  loadVoices();
  $("settings").showModal();
}
function fillModels(list) {
  const sel = $("sModel"), cur = cfg.model;
  const all = [...new Set(["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-pro-latest", cur, ...list])].filter(Boolean);
  sel.innerHTML = ""; all.forEach(m => sel.add(new Option(m, m))); sel.value = cur;
}
async function testKey() {
  const key = $("sKey").value.trim(), out = $("sTestOut");
  if (!key) return out.textContent = "Enter a key first.";
  out.textContent = "Testing…";
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || r.statusText);
    const names = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => m.name.replace("models/", "")).filter(n => /^gemini/.test(n) && !/embedding|image|tts|audio|live/.test(n));
    fillModels(names);
    out.textContent = `✓ Key works. ${names.length} models available.`;
    store.set("key", key); updateAi();
  } catch (e) { out.textContent = "✗ " + e.message; }
}
$("settingsBtn").onclick = openSettings;
$("sTest").onclick = testKey;
$("sKey").onchange = e => { store.set("key", e.target.value.trim()); updateAi(); };
$("sModel").onchange = e => store.set("model", e.target.value);
$("sSearch").onchange = e => store.set("search", e.target.checked ? "1" : "0");
$("sTitle").onchange = e => store.set("title", e.target.value.trim());
$("sCity").onchange = e => { store.set("city", e.target.value.trim()); getWeather(cfg.city).catch(() => {}); };
$("sRegion").onchange = e => store.set("region", e.target.value.trim());
$("sLang").onchange = e => { store.set("lang", e.target.value); store.del("voice"); loadVoices(); };
$("sVoice").onchange = e => store.set("voice", e.target.value);
$("sRate").oninput = e => store.set("rate", e.target.value);
$("sVoiceTest").onclick = () => speak(cfg.lang.startsWith("ro") ? "Bună ziua. Toate sistemele sunt funcționale." : `Good day, ${cfg.title}. All systems are online.`);
$("sForget").onclick = () => { history = []; saveHistory(); $("sForget").textContent = "MEMORY ERASED"; };

// ------------------------------------------------------------------ boot
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});

(function boot() {
  const h = new Date().getHours();
  const greet = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  addMsg(`${greet}, ${cfg.title}. All systems online. Tap the reactor or press TALK to speak.`, "jarvis");
  if (!cfg.key) addMsg("Gemini API key not configured. Open settings (gear icon, top right) to enable conversation and news.", "sys");
  if (!SR) addMsg("This browser doesn't support voice input. Typing still works. For voice, use Chrome, Edge, or Safari.", "sys");
  if (location.protocol === "http:" && !/^(localhost|127\.)/.test(location.hostname))
    addMsg("Microphone requires HTTPS. Open this app over https:// or from localhost.", "sys");
})();
