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
  get city() { return store.get("city", "") || "Suceava"; },
  get region() { return store.get("region", "") || "Romania and the world"; },
  get lang() { return store.get("lang", "en-US"); },
  get voice() { return store.get("voice", ""); },
  get rate() { return parseFloat(store.get("rate", "1")); },
  get elKey() { return store.get("elKey", ""); },
  get engine() { return store.get("engine", "eleven"); },
  get elVoice() { return store.get("elVoice", EL_PRESETS[0].id); },
  get elModel() { return store.get("elModel", "eleven_flash_v2_5"); },
  get fx() { return store.get("fx", "1") === "1"; },
};
// ElevenLabs premade British voices (IDs from ElevenLabs' default library; TEST in settings shows what the account really has)
const EL_PRESETS = [
  { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel: deep, composed British (recommended)" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George: warm, mature British" },
];

// shared state (declared first: the clock and reactor read it right away)
const timers = [];
let actx = null, analyser = null, freq = null, audioPlaying = false, currentSource = null;
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
      let wave = Math.abs(Math.sin(t / 180 + i * .7) * Math.sin(t / 310 + i * .23)) + Math.random() * .25;
      if (audioPlaying && analyser) {
        if (i === 0) analyser.getByteFrequencyData(freq);
        const bin = 2 + Math.floor(Math.abs((i % 32) - 16) * 2.2);     // mirrored spectrum around the ring
        wave = freq[bin] / 190;
      }
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
  const clean = cleanForSpeech(text);
  stopAudio();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (!clean) return Promise.resolve();
  if (cfg.engine === "eleven" && cfg.elKey && navigator.onLine) {
    const id = ++speakId;
    speaking = true; pauseRec(); setState("speaking");
    return elevenSpeak(clean, id).catch(err => {
      if (id !== speakId) return;
      elevenWarn(err);
      return browserSpeak(clean);
    }).finally(() => { if (id === speakId) { speaking = false; afterSpeak(); } });
  }
  return browserSpeak(clean);
}
function browserSpeak(clean) {
  if (!("speechSynthesis" in window)) { speaking = false; afterSpeak(); return Promise.resolve(); }
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
function silence() { speakId++; stopAudio(); if ("speechSynthesis" in window) speechSynthesis.cancel(); speaking = false; afterSpeak(); }

// ------------------------------------------------------------------ ElevenLabs voice
// Audio goes through Web Audio: it works after the first tap on iPhone/iPad, allows the HUD filter and feeds the reactor.
function audioCtx() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    actx = new AC();
    analyser = actx.createAnalyser(); analyser.fftSize = 128; analyser.smoothingTimeConstant = .6;
    freq = new Uint8Array(analyser.frequencyBinCount);
    analyser.connect(actx.destination);
  }
  return actx;
}
// browsers only allow sound after a user gesture: unlock on the first tap / key
function unlockAudio() {
  const c = audioCtx(); if (!c) return;
  if (c.state !== "running") c.resume().catch(() => {});
  const b = c.createBuffer(1, 1, 22050), src = c.createBufferSource(); src.buffer = b; src.connect(c.destination); src.start(0);
}
["pointerdown", "touchend", "keydown"].forEach(ev => addEventListener(ev, unlockAudio, { passive: true }));

function fxChain(c) {
  // subtle "suit comms" colour: trim lows, lift presence, tiny short echo
  const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 110;
  const pk = c.createBiquadFilter(); pk.type = "peaking"; pk.frequency.value = 3200; pk.Q.value = .9; pk.gain.value = 3;
  const dly = c.createDelay(); dly.delayTime.value = .022;
  const fb = c.createGain(); fb.gain.value = .14;
  const out = c.createGain();
  hp.connect(pk); pk.connect(out); pk.connect(dly); dly.connect(fb); fb.connect(out);
  out.connect(analyser);
  return hp;
}

const ttsCache = new Map();   // short phrases ("Yes, sir?") are reused instead of paying for them again
async function elevenAudio(text) {
  const key = `${cfg.elVoice}|${cfg.elModel}|${cfg.rate}|${text}`;
  if (ttsCache.has(key)) return ttsCache.get(key);
  const p = (async () => {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.elVoice)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": cfg.elKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text, model_id: cfg.elModel,
        voice_settings: { stability: .55, similarity_boost: .8, style: .1, use_speaker_boost: true, speed: Math.min(1.2, Math.max(.7, cfg.rate)) },
      }),
    });
    if (!res.ok) {
      let detail = ""; try { const j = await res.json(); detail = j.detail?.message || j.detail?.status || JSON.stringify(j.detail || j); } catch {}
      const err = new Error(detail || res.statusText); err.status = res.status; throw err;
    }
    const buf = await res.arrayBuffer();
    return await new Promise((ok, bad) => audioCtx().decodeAudioData(buf, ok, bad));
  })();
  if (text.length <= 80) { ttsCache.set(key, p); p.catch(() => ttsCache.delete(key)); }
  return p;
}
function chunkText(t) {
  // first sentence alone so playback starts fast; the rest in larger pieces, all requested in parallel
  const sentences = t.match(/[^.!?]+[.!?]*\s*/g) || [t];
  const chunks = [sentences.shift()];
  let cur = "";
  for (const s of sentences) { if ((cur + s).length > 700 && cur) { chunks.push(cur); cur = ""; } cur += s; }
  if (cur.trim()) chunks.push(cur);
  return chunks.map(c => c.trim()).filter(Boolean);
}
async function elevenSpeak(text, id) {
  const c = audioCtx();
  if (!c) throw new Error("Web Audio isn't available");
  if (c.state !== "running") await c.resume().catch(() => {});
  const jobs = chunkText(text).map(elevenAudio);
  for (const job of jobs) {
    const buffer = await job;
    if (id !== speakId) return;
    await new Promise(resolve => {
      const src = c.createBufferSource(); src.buffer = buffer;
      src.connect(cfg.fx ? fxChain(c) : analyser);
      src.onended = () => { audioPlaying = false; currentSource = null; resolve(); };
      currentSource = src; audioPlaying = true; src.start();
    });
    if (id !== speakId) return;
  }
}
function stopAudio() {
  if (currentSource) { try { currentSource.onended = null; currentSource.stop(); } catch {} currentSource = null; }
  audioPlaying = false;
}
let elWarned = 0;
function elevenWarn(err) {
  if (Date.now() - elWarned < 60000) return;     // don't spam the log
  elWarned = Date.now();
  let msg = `ElevenLabs voice failed (${err.message}). Using the browser voice.`;
  if (err.status === 401) msg = "ElevenLabs rejected the API key (or it lacks text-to-speech permission). Using the browser voice.";
  else if (err.status === 402 || /quota|credits|limit/i.test(err.message)) msg = "ElevenLabs credits are used up for this month. Using the browser voice.";
  else if (err.status === 404 || /voice/i.test(err.message) && err.status === 400) msg = "That ElevenLabs voice isn't available on your account. Pick another in settings. Using the browser voice for now.";
  else if (err instanceof TypeError) msg = "Couldn't reach ElevenLabs. Using the browser voice.";
  addMsg(msg, "sys");
}

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

// tabs: on phones one panel at a time; on wide screens comms stays and the left column flips intel <-> workshop
document.querySelectorAll("#tabs button, .ptabs button").forEach(b => b.onclick = () => showTab(b.dataset.tab));
let sideTab = store.get("sideTab", "intel");
function showTab(t) {
  if (t !== "comms") { sideTab = t; store.set("sideTab", t); }
  document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("active", x.dataset.tab === t));
  document.querySelectorAll(".ptabs button").forEach(x => x.classList.toggle("on", x.dataset.tab === sideTab));
  $("commsPanel").classList.toggle("active", t === "comms");
  $("intelPanel").classList.toggle("active", t === "intel");
  $("workshopPanel").classList.toggle("active", t === "workshop");
  $("intelPanel").classList.toggle("shown", sideTab === "intel");
  $("workshopPanel").classList.toggle("shown", sideTab === "workshop");
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
- Spoken part: plain text only. No markdown, no bullet symbols, no emojis, no URLs, no tables.
- When details must be SEEN rather than heard (code, wiring, pin maps, calculations, part lists), give the short spoken answer first, then put the details in a fenced code block (\`\`\`). Code blocks are shown on screen and never read aloud; just say they're on screen.
- Write numbers, times and units the way they should be spoken.
- Reply in English unless the user clearly speaks another language.

Context: the current local date and time is ${now.toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short" })} (${Intl.DateTimeFormat().resolvedOptions().timeZone}). The user's home city is ${cfg.city}. Preferred news region: ${cfg.region}.
${cfg.search ? "You have Google Search available: use it for anything current (news, scores, prices, events, facts that may have changed). Never invent current events." : "You do not have internet access; say so if asked about current events."}

WORKSHOP: like you do for Tony Stark, you are the user's engineering partner. Help them design and build real things: electronics (Arduino, ESP32, Raspberry Pi, sensors, LEDs, motors), robotics, 3D printing, props and cosplay (Iron Man helmets, arc reactors, repulsor lights), home automation, mechanics and code.
Be concrete and practical: exact part names, component values, pin numbers, wiring, working code. Prefer cheap, easy-to-find parts. Prices in RON; good sources for the user: Optimus Digital, Cleste.ro, Sigmanortec, Ardushop, eMAG, or AliExpress.
Safety first, briefly: flag mains voltage (230 V), lithium batteries, high current, heat, lasers and power tools. Decline weapons or anything designed to hurt people; offer a safe prop version instead.
If the user sends a photo, look carefully: identify components, read labels, check wiring against the current project, and point out problems.
${visionOn ? `VISION IS LIVE: every user message comes with a fresh frame from the user's camera, showing what is in front of them right now. Use it: identify what you see, read labels, check wiring, spot problems and give specific, practical advice. If the question isn't about what's on camera, just answer normally without describing the image. If the frame is too dark, blurry or far away to tell, say exactly what you need (closer, more light, different angle).` : ""}
${projectContext()}

Device actions: you can control the user's device by adding tags on separate lines at the very END of your reply. They are executed and hidden from speech.
[[open: https://full-url]]  opens a website (use it when asked to open, show or play something; for YouTube searches use https://www.youtube.com/results?search_query=...)
[[timer: SECONDS | short label]]  starts a countdown timer
Only use actions when the user asks for them.`;
}

async function gemini(userText, opts = {}) {
  const { image = null, json = false, remember = !json } = opts;
  const useSearch = opts.useSearch ?? (cfg.search && !json);
  const parts = [{ text: userText }];
  if (image) parts.unshift({ inlineData: { mimeType: "image/jpeg", data: image } });
  const contents = remember ? [...history.slice(-20), { role: "user", parts }] : [{ role: "user", parts }];
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt() }] },
    contents,
    // generous limit: newer models spend part of it on internal "thinking"
    generationConfig: json ? { temperature: .4, maxOutputTokens: 16384, responseMimeType: "application/json" }
                           : { temperature: .7, maxOutputTokens: 4096 },
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
      return gemini(userText, { ...opts, useSearch: false });
    const err = new Error(msg); err.status = res.status; throw err;
  }
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join("").trim();
  if (!text) throw new Error(cand?.finishReason === "SAFETY" ? "That request was blocked by Gemini's safety filter." : "Gemini returned an empty response.");
  if (remember) {
    // photos are not kept in memory (too big for storage); just note that one was sent
    history.push({ role: "user", parts: [{ text: (image ? "[sent a photo] " : "") + userText }] }, { role: "model", parts: [{ text }] });
    saveHistory();
  }
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

async function askAI(text, { sourceTitle, image } = {}) {
  if (!cfg.key) {
    say(`I'm afraid my higher functions are offline, ${cfg.title}. Please add your Gemini API key in settings.`);
    return openSettings();
  }
  if (!navigator.onLine) return say("We appear to be offline. I need a connection for that.");
  setState("thinking");
  const pending = addMsg("", "jarvis"); pending.classList.add("typing");
  try {
    if (!image && visionOn) image = captureFrame();
    const { text: reply, sources } = await gemini(text, { image });
    setPill("aiPill", "ok");
    const spoken = runActions(reply);
    pending.classList.remove("typing");
    renderRich(pending.querySelector(".body"), spoken);
    showSources(sources, sourceTitle || text.slice(0, 40));
    speak(spoken);
  } catch (e) {
    pending.remove();
    say(geminiError(e));
  }
}

function geminiError(e) {
    let msg = `I ran into a problem reaching Gemini: ${e.message}`;
    if (e.status === 400 && /api key/i.test(e.message)) msg = "Gemini rejected the API key. Please check it in settings.";
    else if (e.status === 403) msg = "Gemini refused the request. The API key may be restricted or disabled.";
    else if (e.status === 404) msg = `The model ${cfg.model} isn't available. Pick another one in settings.`;
    else if (e.status === 429) msg = "We've hit Gemini's rate limit. Give it a minute and try again.";
    else if (e.status >= 500) msg = "Gemini's servers are having trouble right now. Try again shortly.";
    setPill("aiPill", "err");
    return msg;
}

// text with ``` fences -> paragraphs + copyable code blocks
function renderRich(el, text) {
  el.innerHTML = "";
  text.split(/```/).forEach((chunk, i) => {
    if (i % 2) {
      const code = chunk.replace(/^[\w+#.-]*\n/, "");
      const pre = document.createElement("pre"), c = document.createElement("code"), b = document.createElement("button");
      c.textContent = code.replace(/\n$/, "");
      b.className = "mini copy"; b.type = "button"; b.textContent = "COPY";
      b.onclick = () => navigator.clipboard?.writeText(c.textContent).then(() => { b.textContent = "COPIED"; });
      pre.append(c, b); el.appendChild(pre);
    } else if (chunk.trim()) {
      el.appendChild(document.createTextNode(chunk.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^\s*\n|\n\s*$/g, "")));
    }
  });
}

// ------------------------------------------------------------------ workshop (Stark-style build projects)
let projects = [];
try { projects = JSON.parse(store.get("projects", "[]")); } catch { projects = []; }
let activeId = store.get("activeProject", "");
let awaitingIdea = false, pendingScanQuestion = "";
const saveProjects = () => { store.set("projects", JSON.stringify(projects)); store.set("activeProject", activeId || ""); };
const active = () => projects.find(p => p.id === activeId) || null;

const IDEAS = [
  ["Arc reactor desk lamp", "LEDs · 3D print · beginner"],
  ["Iron Man helmet with glowing eyes", "Cosplay · LEDs · intermediate"],
  ["Voice-controlled RGB LED strip with an ESP32", "Wi-Fi · code · beginner"],
  ["Repulsor glove light with a palm button", "Props · Arduino · beginner"],
  ["Room weather station on a small display", "Sensors · ESP32 · beginner"],
  ["Desktop robot arm with 4 servos", "Robotics · intermediate"],
];

function projectContext() {
  const p = active();
  if (!p) return "No workshop project is active right now.";
  const step = p.steps[p.cur];
  return `ACTIVE PROJECT: "${p.name}" (codename ${p.codename}). ${p.summary}
Parts: ${p.parts.map(x => `${x.qty}x ${x.name}${x.spec ? " (" + x.spec + ")" : ""}`).join("; ")}.
Progress: ${p.steps.filter(s => s.done).length} of ${p.steps.length} steps done. ${step ? `Current step ${p.cur + 1}: ${step.title}. ${step.detail}` : "Not started yet."}
Answer questions in the context of this project unless the user clearly changes the subject.`;
}

async function createProject(idea) {
  if (!cfg.key) { say(`I'll need my Gemini link for that, ${cfg.title}. Add your API key in settings.`); return openSettings(); }
  showTab("workshop");
  setState("thinking", "DESIGNING");
  $("workshop").innerHTML = `<div class="ws-code">DESIGNING…</div><div class="ws-name"></div><div class="dim">Running the numbers. This takes a few seconds.</div>`;
  $("workshop").querySelector(".ws-name").textContent = idea;
  speak(pick(["Right away. Drawing up the schematics.", "Excellent idea. Let me run the numbers.", "On it. Pulling up the blueprints."]));
  const prompt = `Design a realistic project plan that a hobbyist can build at home for: "${idea}".
The builder lives in ${cfg.city}, Romania. Prices in RON, from Romanian shops (Optimus Digital, Cleste.ro, Sigmanortec, Ardushop, eMAG) or AliExpress. Prefer cheap, common parts.
If the idea is a weapon or meant to hurt people, design a harmless prop or display version instead and say so in the summary.
Return ONLY JSON with exactly these keys:
{"codename": "2-3 word Stark-style codename, uppercase", "name": "short project name", "summary": "2 sentences, spoken style",
 "difficulty": "beginner|intermediate|advanced", "time": "e.g. 2 evenings", "cost": "e.g. 150-200 RON",
 "parts": [{"name": "", "qty": 1, "spec": "value/model", "price": "e.g. 25 RON", "where": "shop"}],
 "tools": ["..."],
 "wiring": [{"from": "component pin", "to": "component pin", "note": ""}],
 "steps": [{"title": "short imperative title", "detail": "2-4 concrete sentences with values, pins and checks"}],
 "safety": ["short warnings"],
 "upgrades": ["ideas for a Mark II version"]}
6 to 14 steps. Wiring may be empty if nothing is wired. Use plain text inside strings.`;
  try {
    const { text } = await gemini(prompt, { json: true });
    const d = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    const p = {
      id: Date.now().toString(36), created: Date.now(), idea,
      codename: String(d.codename || "MARK I").toUpperCase(), name: d.name || idea, summary: d.summary || "",
      difficulty: d.difficulty || "", time: d.time || "", cost: d.cost || "",
      parts: Array.isArray(d.parts) ? d.parts : [], tools: Array.isArray(d.tools) ? d.tools : [],
      wiring: Array.isArray(d.wiring) ? d.wiring : [], safety: Array.isArray(d.safety) ? d.safety : [],
      upgrades: Array.isArray(d.upgrades) ? d.upgrades : [],
      steps: (Array.isArray(d.steps) ? d.steps : []).map(s => ({ title: s.title || "", detail: s.detail || "", done: false })),
      cur: -1,
    };
    if (!p.steps.length) throw new Error("the plan came back without any steps");
    projects.unshift(p); activeId = p.id; saveProjects(); renderWorkshop();
    setPill("aiPill", "ok");
    say(`Project ${p.codename} is on the board. ${p.summary} Estimated cost ${p.cost || "unknown"}, ${p.parts.length} parts, ${p.steps.length} steps. Say "next step" when you're ready to start.`);
  } catch (e) {
    renderWorkshop();
    say(e instanceof SyntaxError ? "The blueprint came back garbled. Shall we try again?" : (e.status ? geminiError(e) : `I couldn't finish the design: ${e.message}.`));
  }
}

function stepSpeech(p) {
  showTab("workshop");
  const s = p.steps[p.cur];
  return `Step ${p.cur + 1} of ${p.steps.length}. ${s.title}. ${s.detail}`;
}

// voice / text commands for the workshop; returns a promise when handled, otherwise null
function workshopCommand(raw, n) {
  let m;
  if ((m = raw.match(/^\s*(?:new project|start (?:a )?(?:new )?project|let'?s build|help me (?:build|make)|i (?:want|wanna) to? ?(?:build|make)|build me|design me|let'?s make)\b[\s:,-]*(?:an?\s+|the\s+)?(.*)$/i))) {
    const idea = m[1].replace(/[.?!]+$/, "").trim();
    if (idea.length > 2) return createProject(idea);
    awaitingIdea = true; showTab("workshop");
    return say(`What are we building, ${cfg.title}?`);
  }
  if (/^(list|show)( my)? projects|^my projects|^what projects/.test(n)) {
    if (!projects.length) return say("The workshop is empty. Say let's build, followed by an idea.");
    return say(`You have ${projects.length} project${projects.length > 1 ? "s" : ""}: ${projects.map(p => p.name).join(", ")}.`);
  }
  if ((m = n.match(/^(?:switch to|open|load|resume|continue) (?:the )?(?:project )?(.+?)(?: project)?$/))) {
    const q = m[1];
    const p = projects.find(p => norm(p.name).includes(q) || norm(p.codename).includes(q));
    if (p) { activeId = p.id; saveProjects(); renderWorkshop(); showTab("workshop"); return say(`Project ${p.codename} loaded. ${p.cur >= 0 ? `We're on step ${p.cur + 1}.` : "We haven't started yet."}`); }
    if (/^project\b/.test(m[0].replace(/^\S+ /, ""))) return say("I don't have a project by that name.");
  }
  if (/^(vision on|activate vision|turn on (the )?(camera|vision)|enable (the )?(camera|vision)|open (the )?camera|start (the )?camera)\b/.test(n)) return startVision(true);
  if (/^(vision off|deactivate vision|turn off (the )?(camera|vision)|disable (the )?(camera|vision)|close (the )?camera|stop (the )?camera)\b/.test(n)) { stopVision(); return say("Vision offline."); }
  if (visionOn && /^(what do you see|what can you see|describe (this|what you see)|look|scan|take a look|look at this|have a look|what is this|what's this|whats this|check (this|my) (wiring|circuit|build))\b/.test(n))
    return askAI(`${raw}\n(Look closely at the camera frame and answer about what you see. If something looks wrong or risky, say so and how to fix it.)`, { sourceTitle: "Vision" });
  if (/^(scan|take a look|look at this|have a look|what is this|what's this|check (this|my) (wiring|circuit|build))\b/.test(n)) {
    pendingScanQuestion = raw;
    ["camBtn", "wsScan"].forEach(id => { $(id).classList.remove("pulse"); void $(id).offsetWidth; $(id).classList.add("pulse"); });
    return say("Tap VISION to let me watch through the camera, or the camera icon to send me a photo.");
  }

  const p = active();
  if (!p) return null;
  if (/^(next|next step|what's next|whats next|done|step done|finished|i'm done|im done|ok next|continue)\b/.test(n)) {
    if (p.cur >= 0 && p.steps[p.cur]) p.steps[p.cur].done = true;
    const nextIdx = p.steps.findIndex((s, i) => i > p.cur && !s.done);
    if (nextIdx === -1) {
      p.cur = p.steps.length; saveProjects(); renderWorkshop();
      return say(`That's the last step. Project ${p.codename} is complete. Outstanding work, ${cfg.title}.${p.upgrades[0] ? ` For the Mark Two, consider this: ${p.upgrades[0]}` : ""}`);
    }
    p.cur = nextIdx; saveProjects(); renderWorkshop();
    return say(stepSpeech(p));
  }
  if (/^(repeat|say again|current step|what step|which step|where (are|were) we)\b/.test(n)) {
    if (p.cur < 0) return say(`We haven't started. Say "next step" to begin.`);
    if (!p.steps[p.cur]) return say("Every step is done.");
    return say(stepSpeech(p));
  }
  if (/^(previous|previous step|go back|back|last step)\b/.test(n)) {
    if (p.cur <= 0) return say("We're at the very beginning.");
    p.cur = Math.min(p.cur, p.steps.length) - 1; p.steps[p.cur].done = false; saveProjects(); renderWorkshop();
    return say(stepSpeech(p));
  }
  if ((m = n.match(/^(?:go to |jump to )?step (\d+)$/))) {
    const k = +m[1] - 1;
    if (!p.steps[k]) return say(`There are only ${p.steps.length} steps.`);
    p.cur = k; saveProjects(); renderWorkshop();
    return say(stepSpeech(p));
  }
  if (/^(parts|parts list|shopping list|what do i need|what parts|bill of materials)\b/.test(n)) {
    const list = p.parts.slice(0, 10).map(x => `${x.qty > 1 ? x.qty + " " : ""}${x.name}`).join(", ");
    return say(`You'll need ${list}${p.parts.length > 10 ? ", and a few more items on screen" : ""}. Roughly ${p.cost || "an unknown amount"} in total.`);
  }
  if (/^(tools|what tools)\b/.test(n)) return say(p.tools.length ? `Tools: ${p.tools.join(", ")}.` : "No special tools needed.");
  if (/^(safety|safety check|is it safe|any risks)\b/.test(n)) return say(p.safety.length ? p.safety.join(". ") : "Nothing hazardous here, but use common sense.");
  return null;
}

function renderWorkshop() {
  const sel = $("wsSelect");
  sel.innerHTML = "";
  if (!projects.length) sel.add(new Option("No projects yet", ""));
  projects.forEach(p => sel.add(new Option(`${p.codename} · ${p.name}`, p.id)));
  sel.value = activeId;

  const p = active(), box = $("workshop");
  if (!p) {
    $("wsMeta").textContent = "NO PROJECT";
    box.innerHTML = `<div class="ws-code">WORKSHOP ONLINE</div>
      <div class="ws-name">What are we building today?</div>
      <div class="dim">Say <b>“let's build…”</b> and an idea, or tap one below. I'll design the parts list, wiring and step-by-step plan, then talk you through it. Tap the camera to show me your build.</div>
      <div class="ideas"></div>`;
    IDEAS.forEach(([t, s]) => {
      const b = document.createElement("button"); b.type = "button";
      b.innerHTML = `<small></small>`; b.prepend(t); b.querySelector("small").textContent = s;
      b.onclick = () => handle(`Let's build ${t.toLowerCase()}`);
      box.querySelector(".ideas").appendChild(b);
    });
    return;
  }
  const done = p.steps.filter(s => s.done).length;
  $("wsMeta").textContent = `${done}/${p.steps.length} STEPS`;
  const e = escapeHtml, str = v => e(String(v ?? ""));
  box.innerHTML = `
    <div class="ws-code">PROJECT ${str(p.codename)}</div>
    <div class="ws-name">${str(p.name)}</div>
    <div class="chips">${[p.difficulty, p.time, p.cost].filter(Boolean).map(c => `<span class="chip">${str(c).toUpperCase()}</span>`).join("")}</div>
    <div>${str(p.summary)}</div>
    <div class="progress"><i style="width:${Math.round(done / p.steps.length * 100)}%"></i></div>
    <div class="ws-h">BUILD SEQUENCE</div>
    <div id="wsSteps">${p.steps.map((s, i) => `<div class="step${i === p.cur ? " cur" : ""}${s.done ? " done" : ""}" data-i="${i}">
      <input type="checkbox" ${s.done ? "checked" : ""} aria-label="Done"><div><b>${i + 1}. ${str(s.title)}</b><span>${str(s.detail)}</span></div></div>`).join("")}</div>
    <div class="ws-h">BILL OF MATERIALS</div>
    <table class="ws">${p.parts.map(x => `<tr><td class="q">${str(x.qty || 1)}×</td><td>${str(x.name)}<small>${str([x.spec, x.where].filter(Boolean).join(" · "))}</small></td><td class="pr">${str(x.price)}</td></tr>`).join("")}</table>
    ${p.tools.length ? `<div class="ws-h">TOOLS</div><ul class="ws-list">${p.tools.map(t => `<li>${str(t)}</li>`).join("")}</ul>` : ""}
    ${p.wiring.length ? `<div class="ws-h">WIRING</div><table class="ws">${p.wiring.map(w => `<tr><td>${str(w.from)}</td><td class="q">→</td><td>${str(w.to)}${w.note ? `<small>${str(w.note)}</small>` : ""}</td></tr>`).join("")}</table>` : ""}
    ${p.safety.length ? `<div class="ws-h">SAFETY</div><ul class="ws-list warn">${p.safety.map(t => `<li>${str(t)}</li>`).join("")}</ul>` : ""}
    ${p.upgrades.length ? `<div class="ws-h">MARK II IDEAS</div><ul class="ws-list">${p.upgrades.map(t => `<li>${str(t)}</li>`).join("")}</ul>` : ""}`;
  box.querySelectorAll(".step").forEach(el => {
    const i = +el.dataset.i;
    el.querySelector("input").onclick = ev => { ev.stopPropagation(); p.steps[i].done = ev.target.checked; saveProjects(); renderWorkshop(); };
    el.onclick = () => { if (i === p.cur) el.classList.toggle("open"); else { p.cur = i; saveProjects(); renderWorkshop(); } };
  });
  box.querySelector(".step.cur")?.scrollIntoView({ block: "nearest" });
}

$("wsSelect").onchange = e => { activeId = e.target.value; saveProjects(); renderWorkshop(); };
$("wsNew").onclick = () => { activeId = ""; saveProjects(); renderWorkshop(); awaitingIdea = true; say(`What are we building, ${cfg.title}?`); };
$("wsDelete").onclick = () => {
  const p = active(); if (!p) return;
  if (!confirm(`Delete project ${p.codename} (${p.name})?`)) return;
  projects = projects.filter(x => x !== p); activeId = projects[0]?.id || ""; saveProjects(); renderWorkshop();
};

// camera / photo: resize on device, then send to Gemini with the question
$("camBtn").onclick = $("wsScan").onclick = () => $("scanInput").click();
$("scanInput").onchange = async e => {
  const file = e.target.files[0]; e.target.value = "";
  if (!file) return;
  try {
    const dataUrl = await shrinkImage(file, 1280);
    const typed = $("cmdInput").value.trim(); $("cmdInput").value = "";
    const q = typed || pendingScanQuestion ||
      (active() ? "Here's my build so far. What do you see? Check it against the current step and point out any problems." : "What is this? Identify it and tell me anything useful.");
    pendingScanQuestion = "";
    const m = addMsg(q, "user");
    const img = document.createElement("img"); img.className = "shot"; img.src = dataUrl; img.alt = "Photo sent to JARVIS";
    m.appendChild(img);
    askAI(q, { image: dataUrl.split(",")[1], sourceTitle: "Photo analysis" });
  } catch { say("I couldn't read that image."); }
};
function shrinkImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", .85));
    };
    img.onerror = reject; img.src = url;
  });
}
renderWorkshop();


// ------------------------------------------------------------------ vision: live camera JARVIS can look through
let visionOn = false, visionStream = null, facing = store.get("facing", "environment");
async function startVision(fromVoice = false, quiet = false) {
  if (!navigator.mediaDevices?.getUserMedia) return say("This browser can't give me camera access. It needs HTTPS and a modern browser.");
  try {
    stopStream();
    visionStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
    const v = $("visionVideo");
    v.srcObject = visionStream;
    v.classList.toggle("mirror", facing === "user");
    await v.play().catch(() => {});
    visionOn = true;
    $("vision").hidden = false; $("visionBtn").classList.add("on");
    document.querySelector(".core-zone").classList.add("vision-on");
    if (!quiet) say(pick([`Vision online. Show me what you're working on, ${cfg.title}.`, "Optics online. I'm watching.", "Camera feed is live. Ask me anything about what I see."]));
  } catch (e) {
    const denied = e.name === "NotAllowedError" || e.name === "SecurityError";
    say(denied ? (fromVoice ? "I need you to tap the VISION button so the browser lets me use the camera." : "Camera access was denied. Allow the camera for this site in your browser settings.")
               : `I couldn't start the camera: ${e.message}`);
  }
}
function stopStream() { visionStream?.getTracks().forEach(t => t.stop()); visionStream = null; }
function stopVision() {
  stopStream(); visionOn = false;
  $("vision").hidden = true; $("visionBtn").classList.remove("on");
  document.querySelector(".core-zone").classList.remove("vision-on");
}
// grab the current frame as base64 JPEG (max 1024 px) for Gemini
function captureFrame() {
  const v = $("visionVideo");
  if (!v.videoWidth) return null;
  const k = Math.min(1, 1024 / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
  c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
  const f = $("visionFlash"); f.classList.remove("go"); void f.offsetWidth; f.classList.add("go");
  return c.toDataURL("image/jpeg", .82).split(",")[1];
}
$("visionBtn").onclick = () => visionOn ? (stopVision(), say("Vision offline.")) : startVision();
$("visionFlip").onclick = () => { facing = facing === "user" ? "environment" : "user"; store.set("facing", facing); startVision(false, true); };
// free the camera when the app goes to the background; resume when it comes back
document.addEventListener("visibilitychange", () => {
  if (!visionOn) return;
  if (document.hidden) stopStream();
  else startVision(false, true);
});
// ------------------------------------------------------------------ command router
// Simple things are handled instantly and offline; everything else goes to Gemini.
const NUMW = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, half: .5 };
const HELP = () => `Here's what I can do, ${cfg.title}. Tap VISION and I'll see through the camera: ask me what I see or what's wrong with your build. In the workshop: say "let's build" and an idea, and I'll draw up the parts, wiring and steps, then walk you through them with "next step". Tap the camera to show me your build. I can also brief you on the news, give you the weather, open websites, set timers, and answer pretty much anything through Gemini.`;

async function handle(raw) {
  addMsg(raw, "user");
  const n = norm(raw);
  let m;

  if (awaitingIdea) { awaitingIdea = false; if (!/^(never mind|nevermind|cancel|nothing)\b/.test(n)) return createProject(raw); return say("Very well."); }

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

  const ws = workshopCommand(raw, n);
  if (ws) return ws;

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
  $("sEngine").value = cfg.engine; $("sElKey").value = cfg.elKey; $("sElModel").value = cfg.elModel; $("sFx").checked = cfg.fx;
  fillElVoices(elVoicesLoaded);
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
let elVoicesLoaded = [];
function fillElVoices(list) {
  const sel = $("sElVoice"), cur = cfg.elVoice;
  sel.innerHTML = "";
  const seen = new Set();
  const add = (id, name) => { if (seen.has(id)) return; seen.add(id); sel.add(new Option(name, id)); };
  EL_PRESETS.forEach(v => add(v.id, v.name));
  list.forEach(v => add(v.id, v.name));
  if (!seen.has(cur)) add(cur, "Current voice (" + cur.slice(0, 6) + "…)");
  sel.value = cur;
}
async function testEleven() {
  const key = $("sElKey").value.trim(), out = $("sElOut");
  if (!key) return out.textContent = "Enter a key first.";
  out.textContent = "Testing…";
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail?.message || j.detail?.status || r.statusText);
    const british = v => /brit|engl|uk/i.test(`${v.labels?.accent || ""} ${v.labels?.locale || ""} ${v.name} ${v.description || ""}`);
    const male = v => /male/i.test(v.labels?.gender || "") && !/female/i.test(v.labels?.gender || "");
    const voices = (j.voices || []).map(v => ({ v, score: (british(v) ? 2 : 0) + (male(v) ? 1 : 0) }))
      .sort((a, b) => b.score - a.score)
      .map(({ v }) => ({ id: v.voice_id, name: `${v.name}${v.labels?.accent ? " · " + v.labels.accent : ""}${v.labels?.gender ? " · " + v.labels.gender : ""}${v.category && v.category !== "premade" ? " · " + v.category : ""}` }));
    elVoicesLoaded = voices;
    store.set("elKey", key);
    fillElVoices(voices);
    let credits = "";
    try {
      const s = await (await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": key } })).json();
      if (s.character_limit) credits = ` Credits used this month: ${s.character_count.toLocaleString()} / ${s.character_limit.toLocaleString()}.`;
    } catch {}
    out.textContent = `✓ Key works. ${voices.length} voices loaded.${credits}`;
  } catch (e) { out.textContent = "✗ " + (e instanceof TypeError ? "Couldn't reach ElevenLabs from this browser." : e.message); }
}
$("sElTest").onclick = testEleven;
$("sEngine").onchange = e => store.set("engine", e.target.value);
$("sElKey").onchange = e => store.set("elKey", e.target.value.trim());
$("sElVoice").onchange = e => store.set("elVoice", e.target.value);
$("sElModel").onchange = e => store.set("elModel", e.target.value);
$("sFx").onchange = e => store.set("fx", e.target.checked ? "1" : "0");
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
