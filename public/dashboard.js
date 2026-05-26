// =============================================================================
// EndoMe dashboard — daily logging, gamification, contextual reminders.
// Talks to /api/me/* (auth via session cookie).
// =============================================================================

// Visible in the dev console — confirms which JS build is running.
console.info("EndoMe dashboard build v3 (multi-select symptoms enabled)");

// If the cached HTML is too old to know about our multi-select markup, the
// chips would silently behave as single-select. Detect that case on load and
// force a one-shot cache-busting reload so the user gets the latest HTML.
(function detectStaleHtml() {
  const hasMultiSymptom = document.querySelector('[data-multi="symptom"]');
  if (hasMultiSymptom) return; // fresh HTML, we're good
  if (sessionStorage.getItem("endome_html_busted")) return; // already tried
  sessionStorage.setItem("endome_html_busted", "1");
  const u = new URL(location.href);
  u.searchParams.set("_v", String(Date.now()));
  location.replace(u.toString());
})();

const todayLocalDate = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};

const api = {
  async today() { return getJson("/api/me/today?date=" + todayLocalDate()); },
  async morningCheckin(body) { return postJson("/api/me/checkin/morning", { date: todayLocalDate(), ...body }); },
  async eveningCheckin(body) { return postJson("/api/me/checkin/evening", { date: todayLocalDate(), ...body }); },
  async logSymptom(body) { return postJson("/api/me/symptoms", { date: todayLocalDate(), ...body }); },
  async dismissNotif(id) { return postJson(`/api/me/notifications/${id}/dismiss`, {}); },
  async week() { return getJson("/api/me/week"); },
  async cleanPet() { return postJson("/api/me/pet/clean", {}); },
};

async function getJson(url) {
  const res = await fetch(url, { credentials: "same-origin" });
  if (res.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
  if (!res.ok) throw new Error(await safeError(res));
  return res.json();
}
async function postJson(url, data) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(data),
    credentials: "same-origin",
  });
  if (res.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
  let payload = {};
  try { payload = await res.json(); } catch {}
  if (!res.ok) throw new Error(payload.error || "Request failed");
  return payload;
}
async function safeError(res) { try { return (await res.json()).error || res.statusText; } catch { return res.statusText; } }

// --- State ----------------------------------------------------------------
let state = null;

async function refresh() {
  try {
    weekCache = null; // re-fetch streak + cycle week
    state = await api.today();
    render();
  } catch (err) {
    console.warn("dashboard refresh failed:", err.message);
    toast("Could not load latest data. Check connection.", "err");
  } finally {
    document.getElementById("page-loader")?.classList.add("is-hidden");
  }
}

// --- Render ---------------------------------------------------------------
function bind(name, value) {
  document.querySelectorAll(`[data-bind="${name}"]`).forEach((el) => {
    if (el.tagName === "DIV" && el.classList.contains("xp-fill")) return;
    el.textContent = value;
  });
}

function render() {
  if (!state) return;
  const { user, pet, symptoms } = state;

  bind("displayName", user.displayName || user.username || "there");

  if (pet) {
    bind("petName", pet.name);
    bind("petLevel", String(pet.level));
    bind("petXp", String(pet.xp));
    bind("petXpForNext", String(pet.xpForNext));
    document.querySelectorAll('[data-bind="petXpFill"]').forEach((el) => {
      const pct = Math.max(0, Math.min(100, (pet.xp / pet.xpForNext) * 100));
      el.style.width = `${pct}%`;
    });
    document.querySelectorAll('[data-bind="petMoodClass"]').forEach((el) => {
      el.textContent = capitalize(pet.mood);
      el.className = `happy-pill mood-${pet.mood}`;
    });
    bind("streakDays", String(pet.streakDays || 0));
    bind("streakPlural", pet.streakDays === 1 ? "" : "s");
    renderPetArt(pet);
    renderPetPoop(pet);
  }

  renderBanner();
  renderNotifBadge();
  renderSymptomsTodayHint(symptoms?.length || 0);
  renderCycleSnapshot();
  renderTodaySymptoms();
  renderStreakWeek();
  renderStoryMini();
}

// --- Pet art (matches /pet page) -----------------------------------------
const PET_SVGS = {
  luna: `<svg class="pet-svg" viewBox="0 0 160 160" width="100%" height="100%">
    <ellipse cx="80" cy="138" rx="50" ry="8" fill="rgba(0,0,0,.06)"/>
    <path d="M44 60 L30 26 L52 50 Z" fill="var(--pet-mid)"/>
    <path d="M116 60 L130 26 L108 50 Z" fill="var(--pet-mid)"/>
    <path d="M48 56 L40 38 L56 50 Z" fill="var(--pet-light)"/>
    <path d="M112 56 L120 38 L104 50 Z" fill="var(--pet-light)"/>
    <ellipse cx="80" cy="106" rx="38" ry="30" fill="var(--pet-mid)"/>
    <circle cx="80" cy="80" r="36" fill="var(--pet-light)"/>
    <ellipse cx="66" cy="82" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="94" cy="82" rx="5" ry="6" fill="#2c1320"/>
    <circle cx="68" cy="80" r="1.6" fill="#fff"/><circle cx="96" cy="80" r="1.6" fill="#fff"/>
    <path d="M80 92 l-2 3 h4 z" fill="#ff5d8f"/>
    <path d="M76 96 q4 4 8 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    <ellipse cx="60" cy="93" rx="6" ry="3" fill="#ff5d8f" opacity=".35"/>
    <ellipse cx="100" cy="93" rx="6" ry="3" fill="#ff5d8f" opacity=".35"/>
  </svg>`,
  poppy: `<svg class="pet-svg" viewBox="0 0 160 160" width="100%" height="100%">
    <ellipse cx="80" cy="138" rx="50" ry="8" fill="rgba(0,0,0,.06)"/>
    <ellipse cx="50" cy="88" rx="16" ry="22" fill="var(--pet-mid)"/>
    <ellipse cx="110" cy="88" rx="16" ry="22" fill="var(--pet-mid)"/>
    <ellipse cx="80" cy="100" rx="40" ry="32" fill="var(--pet-light)"/>
    <circle cx="80" cy="78" r="34" fill="var(--pet-light)"/>
    <circle cx="80" cy="66" r="14" fill="var(--pet-mid)"/>
    <ellipse cx="68" cy="80" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="92" cy="80" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="80" cy="92" rx="3.5" ry="2.5" fill="#2c1320"/>
    <path d="M76 98 q4 4 8 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  </svg>`,
  mochi: `<svg class="pet-svg" viewBox="0 0 160 160" width="100%" height="100%">
    <ellipse cx="80" cy="138" rx="50" ry="8" fill="rgba(0,0,0,.06)"/>
    <ellipse cx="58" cy="40" rx="10" ry="26" fill="var(--pet-mid)"/>
    <ellipse cx="102" cy="40" rx="10" ry="26" fill="var(--pet-mid)"/>
    <ellipse cx="58" cy="42" rx="4" ry="16" fill="#ffb6c8"/>
    <ellipse cx="102" cy="42" rx="4" ry="16" fill="#ffb6c8"/>
    <ellipse cx="80" cy="106" rx="40" ry="32" fill="var(--pet-mid)"/>
    <circle cx="80" cy="82" r="32" fill="var(--pet-light)"/>
    <ellipse cx="68" cy="84" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="92" cy="84" rx="5" ry="6" fill="#2c1320"/>
    <path d="M78 94 l2 2 l2 -2 z" fill="#ff7a99"/>
    <path d="M76 100 q4 3 8 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  </svg>`,
  sunny: `<svg class="pet-svg" viewBox="0 0 160 160" width="100%" height="100%">
    <ellipse cx="80" cy="138" rx="50" ry="8" fill="rgba(0,0,0,.06)"/>
    <path d="M44 44 L56 70 L36 64 Z" fill="var(--pet-mid)"/>
    <path d="M116 44 L104 70 L124 64 Z" fill="var(--pet-mid)"/>
    <ellipse cx="80" cy="108" rx="38" ry="28" fill="var(--pet-mid)"/>
    <ellipse cx="80" cy="112" rx="22" ry="18" fill="#fff"/>
    <circle cx="80" cy="82" r="34" fill="var(--pet-light)"/>
    <path d="M80 70 Q60 84 64 102 Q80 96 80 96 Q80 96 96 102 Q100 84 80 70 Z" fill="#fff"/>
    <ellipse cx="68" cy="82" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="92" cy="82" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="80" cy="94" rx="3.5" ry="2.5" fill="#2c1320"/>
    <path d="M76 100 q4 4 8 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  </svg>`,
  coco: `<svg class="pet-svg" viewBox="0 0 160 160" width="100%" height="100%">
    <ellipse cx="80" cy="138" rx="50" ry="8" fill="rgba(0,0,0,.06)"/>
    <ellipse cx="80" cy="110" rx="40" ry="30" fill="var(--pet-mid)"/>
    <circle cx="40" cy="64" r="18" fill="var(--pet-mid)"/>
    <circle cx="120" cy="64" r="18" fill="var(--pet-mid)"/>
    <circle cx="40" cy="64" r="10" fill="#f4cce3"/>
    <circle cx="120" cy="64" r="10" fill="#f4cce3"/>
    <circle cx="80" cy="78" r="34" fill="var(--pet-light)"/>
    <ellipse cx="68" cy="78" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="92" cy="78" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="80" cy="94" rx="10" ry="8" fill="#2c1320"/>
    <path d="M70 106 q10 4 20 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  </svg>`,
  kiki: `<svg class="pet-svg" viewBox="0 0 160 160" width="100%" height="100%">
    <ellipse cx="80" cy="138" rx="50" ry="8" fill="rgba(0,0,0,.06)"/>
    <ellipse cx="62" cy="40" rx="7" ry="22" fill="var(--pet-mid)"/>
    <ellipse cx="98" cy="40" rx="7" ry="22" fill="var(--pet-mid)"/>
    <ellipse cx="80" cy="110" rx="40" ry="30" fill="var(--pet-mid)"/>
    <ellipse cx="80" cy="80" rx="30" ry="28" fill="var(--pet-light)"/>
    <ellipse cx="70" cy="78" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="90" cy="78" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="80" cy="90" rx="3.5" ry="2.5" fill="#2c1320"/>
    <path d="M76 96 q4 4 8 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  </svg>`,
};

function renderPetArt(pet) {
  const type = pet.type && PET_SVGS[pet.type] ? pet.type : "luna";
  const svg = PET_SVGS[type];
  ["ep-mini-art", "ep-big-art"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = svg;
    el.dataset.pet = type;
    el.dataset.mood = pet.mood || "happy";
    el.style.setProperty("--color-shift", `${pet.colorSeed || 0}deg`);
  });
}

function renderPetPoop(pet) {
  const hasPoop = !!pet.hasPoop;
  const mini = document.getElementById("ep-mini-poop");
  if (mini) mini.hidden = !hasPoop;
  const row = document.getElementById("ep-poop-row");
  if (row) row.hidden = !hasPoop;
}

// --- Story mini ring (right rail) ----------------------------------------
async function renderStoryMini() {
  const ring = document.getElementById("mini-ring");
  const pctEl = document.getElementById("mini-percent");
  const fracEl = document.getElementById("mini-fraction");
  if (!ring || !pctEl || !fracEl) return;
  try {
    const res = await fetch("/api/me/story", { credentials: "same-origin" });
    if (!res.ok) return;
    const data = await res.json();
    const pct = Math.max(0, Math.min(100, data.percent || 0));
    const circ = 2 * Math.PI * 42;
    ring.setAttribute("stroke-dasharray", String(circ));
    ring.style.strokeDashoffset = String(circ * (1 - pct / 100));
    pctEl.textContent = `${pct}%`;
    fracEl.textContent = `${data.completed} of ${data.total}`;
  } catch {}
}

// --- Cycle Snapshot card --------------------------------------------------
const PHASE_LABEL = {
  menstrual:  { label: "Menstrual",  icon: "🌑" },
  follicular: { label: "Follicular", icon: "🌒" },
  ovulation:  { label: "Ovulation",  icon: "🌕" },
  luteal:     { label: "Luteal",     icon: "🌘" },
};
function dotsHtml(n) {
  let out = '<span class="dots">';
  for (let i = 1; i <= 5; i++) out += `<i class="${i <= n ? "" : "o"}"></i>`;
  return out + "</span>";
}
function painLabel(n) { return ["", "None", "Mild", "Moderate", "Strong", "Severe"][n] || "—"; }
function levelLabel(n) { return ["", "Low", "Low", "Okay", "Good", "High"][n] || "—"; }
function moodLabel(n) { return ["", "Low", "Low", "Okay", "Good", "Great"][n] || "—"; }

function renderCycleSnapshot() {
  const el = document.getElementById("cycle-snapshot");
  if (!el) return;
  const cycle = state.cycle || {};
  const m = state.morning;

  if (!m && !cycle.day && !cycle.phase) {
    el.innerHTML = `<p class="empty-state">Log this morning's check-in to see your cycle overview.</p>
      <button class="pill-btn full" data-modal="morning">Morning check-in</button>`;
    return;
  }

  const phase = cycle.phase ? PHASE_LABEL[cycle.phase] : null;
  const dayLine = cycle.day
    ? `<div class="cycle-day">Day ${cycle.day}</div>`
    : `<div class="cycle-day">—</div>`;
  const phaseLine = phase
    ? `<div class="cycle-phase">${phase.icon} ${phase.label} Phase</div>`
    : `<div class="cycle-phase">Phase not set</div>`;

  let statsHtml = "";
  if (m) {
    statsHtml = `<ul class="cycle-stats">
      <li><span class="cs-ico">🔥</span><span>Pain</span>${dotsHtml(m.pain)}<span class="cs-val">${painLabel(m.pain)}</span></li>
      <li><span class="cs-ico">⚡</span><span>Energy</span>${dotsHtml(m.energy)}<span class="cs-val">${levelLabel(m.energy)}</span></li>
      <li><span class="cs-ico">🙂</span><span>Mood</span>${dotsHtml(m.mood)}<span class="cs-val">${moodLabel(m.mood)}</span></li>
      ${m.sleepQuality ? `<li><span class="cs-ico">🌙</span><span>Sleep</span>${dotsHtml(m.sleepQuality)}<span class="cs-val">${levelLabel(m.sleepQuality)}</span></li>` : ""}
    </ul>`;
  } else {
    statsHtml = `<p class="empty-state small">Add a morning check-in for today's mood, energy, and pain.</p>`;
  }

  el.innerHTML = dayLine + phaseLine + statsHtml;
}

// --- Today's Symptoms list ------------------------------------------------
const SYMPTOM_META = {
  pain:              { icon: "💢", label: "Pain" },
  pelvic_pain:       { icon: "⚡", label: "Pelvic pain" },
  back_pain:         { icon: "🦴", label: "Lower back" },
  cramps:            { icon: "🔥", label: "Cramps" },
  endo_belly:        { icon: "🎈", label: "Endo belly" },
  bloating:          { icon: "💧", label: "Bloating" },
  nausea:            { icon: "🤢", label: "Nausea" },
  fatigue:           { icon: "😴", label: "Fatigue" },
  headache:          { icon: "🧠", label: "Headache" },
  breast_tender:     { icon: "💗", label: "Breast tender" },
  hot_flash:         { icon: "🥵", label: "Hot flash" },
  dizziness:         { icon: "💫", label: "Dizziness" },
  spotting:          { icon: "🩸", label: "Spotting" },
  painful_urination: { icon: "🚽", label: "Painful peeing" },
  painful_bowel:     { icon: "💩", label: "Painful BM" },
  painful_sex:       { icon: "💔", label: "Painful sex" },
  mood:              { icon: "💭", label: "Mood swing" },
  sleep:             { icon: "🌙", label: "Sleep issue" },
  appetite:          { icon: "🍽", label: "Appetite" },
  other:             { icon: "＋", label: "Other" },
};
function relTime(unixSec) {
  const n = Number(unixSec);
  if (!Number.isFinite(n) || n <= 0) return "just now";
  const diff = Math.floor(Date.now() / 1000) - n;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  const d = new Date(n * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderTodaySymptoms() {
  const list = document.getElementById("today-symptoms-list");
  const count = document.getElementById("sym-count");
  if (!list) return;
  const items = state.symptoms || [];

  count.textContent = items.length ? `· ${items.length}` : "";

  if (items.length === 0) {
    list.innerHTML = `<p class="empty-state">Nothing logged today. Tap "+ Log symptom" when something comes up.</p>`;
    return;
  }

  list.innerHTML = `<ul class="sym-list">` + items.map((s) => {
    const meta = SYMPTOM_META[s.symptom] || { icon: "•", label: s.symptom };
    const tags = [];
    if (s.pain_type) String(s.pain_type).split(",").filter(Boolean).forEach((p) => tags.push(`🩸 ${p}`));
    if (s.location)  String(s.location).split(",").map((l) => l.trim()).filter(Boolean).forEach((l) => tags.push(`📍 ${l}`));
    if (s.triggers)  String(s.triggers).split(",").filter(Boolean).forEach((t) => tags.push(`· ${t}`));
    return `<li class="sym-row">
      <div class="sym-ico" title="${meta.label}">${meta.icon}</div>
      <div class="sym-main">
        <div class="sym-top"><strong>${meta.label}</strong> <span class="sev sev-${s.severity}">${s.severity}/5</span></div>
        ${s.notes ? `<p class="sym-notes">${escapeHtml(s.notes)}</p>` : ""}
        ${tags.length ? `<div class="sym-tags">${tags.map(escapeHtml).join(" ")}</div>` : ""}
      </div>
      <div class="sym-time">${relTime(s.logged_at)}</div>
    </li>`;
  }).join("") + `</ul>`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[<>&"']/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function renderBanner() {
  const slot = document.getElementById("ctx-banner-slot");
  if (!slot) return;
  const hour = new Date().getHours();
  let html = "";

  if (!state.morning && hour >= 5 && hour < 12) {
    html = bannerHtml({
      tone: "morning",
      icon: "🌅",
      title: "Good morning!",
      body: "How are you feeling this morning? Takes 30 seconds.",
      cta: "Morning check-in",
      reward: "+10 XP",
      modal: "morning",
    });
  } else if (state.morning && !state.evening && hour >= 18) {
    html = bannerHtml({
      tone: "evening",
      icon: "🌙",
      title: "Wrapping up your day?",
      body: "A short reflection helps EndoMe learn your patterns.",
      cta: "Evening check-in",
      reward: "+15 XP",
      modal: "evening",
    });
  } else if (state.morning && state.evening) {
    html = bannerHtml({
      tone: "done",
      icon: "✨",
      title: "You're all checked in today.",
      body: `${state.symptoms?.length || 0} symptom${state.symptoms?.length === 1 ? "" : "s"} logged · ${state.pointsToday} XP earned today.`,
    });
  }
  slot.innerHTML = html;
}

function bannerHtml({ tone, icon, title, body, cta, reward, modal }) {
  return `
    <div class="ctx-banner ctx-${tone}">
      <div class="ctx-icon" aria-hidden="true">${icon}</div>
      <div class="ctx-body">
        <strong>${title}</strong>
        <p>${body}</p>
      </div>
      ${cta ? `<button type="button" class="btn btn-primary" data-modal="${modal}">${cta} <em class="xp-badge">${reward}</em></button>` : ""}
    </div>`;
}

// --- Streak week (data-driven, only ticks on days actually logged) -------
let weekCache = null;
async function loadWeek(force = false) {
  if (weekCache && !force) return weekCache;
  try { weekCache = await api.week(); } catch { weekCache = null; }
  return weekCache;
}

async function renderStreakWeek() {
  const el = document.getElementById("streak-week");
  if (!el) return;
  const week = await loadWeek();
  if (!week?.days?.length) {
    el.innerHTML = `<p class="empty-state small">Log today to start your week.</p>`;
    return;
  }
  const todayISO = todayLocalDate();
  el.innerHTML = week.days.map((d) => {
    const isToday = d.date === todayISO;
    const dayLetter = ["S","M","T","W","T","F","S"][new Date(d.date + "T00:00:00").getDay()];
    let dot;
    if (d.logged) {
      dot = `<span class="dot done">✓</span>`;
    } else if (isToday) {
      dot = `<span class="dot today">·</span>`;
    } else {
      dot = `<span class="dot">·</span>`;
    }
    return `<div${isToday ? ' class="is-today"' : ''}><span>${dayLetter}</span>${dot}</div>`;
  }).join("");
}

// --- Cycle week modal (opens from clicking the Cycle Snapshot card) ------
async function renderCycleWeekModal() {
  const body = document.getElementById("cycle-week-body");
  if (!body) return;
  body.innerHTML = `<p class="empty-state">Loading…</p>`;
  const week = await loadWeek(true);
  if (!week?.days?.length) {
    body.innerHTML = `<p class="empty-state">No data yet. Log a morning check-in to start seeing your week.</p>`;
    return;
  }
  const days = week.days;
  // Max-of-5 scale for pain/energy/mood since those are 1–5.
  const metric = (label, key, color) => {
    const bars = days.map((d) => {
      const v = d[key];
      const has = v != null && v > 0;
      const h = has ? (v / 5) * 100 : 0;
      const dayLabel = ["S","M","T","W","T","F","S"][new Date(d.date + "T00:00:00").getDay()];
      return `<div class="cw-bar-col">
        <div class="cw-bar-wrap"><div class="cw-bar" style="height:${h}%;background:${color}" title="${dayLabel}: ${has ? v + '/5' : 'no data'}"></div></div>
        <span class="cw-day">${dayLabel}</span>
      </div>`;
    }).join("");
    return `<div class="cw-metric">
      <div class="cw-metric-head"><strong>${label}</strong> <span class="cw-meta">last 7 days</span></div>
      <div class="cw-bars">${bars}</div>
    </div>`;
  };
  const symptomTotal = days.reduce((s, d) => s + (d.symptomCount || 0), 0);
  body.innerHTML = `
    ${metric("Pain",   "pain",   "linear-gradient(180deg,#ff4e8a,#ff7aa6)")}
    ${metric("Energy", "energy", "linear-gradient(180deg,#ffb43c,#ffd07a)")}
    ${metric("Mood",   "mood",   "linear-gradient(180deg,#7ad06f,#a8e09f)")}
    <p class="cw-summary">${symptomTotal} symptom${symptomTotal === 1 ? "" : "s"} logged this week.</p>`;
}

function renderSymptomsTodayHint(count) {
  const card = document.querySelector(".welcome-banner .wb-text");
  if (!card) return;
  const base = "Track your symptoms, understand your body, and get the support you deserve.";
  card.textContent = count > 0
    ? `${count} symptom${count === 1 ? "" : "s"} logged today. Keep going — every entry helps spot patterns.`
    : base + " You're not alone — we're here with you.";
}

function renderNotifBadge() {
  const badge = document.querySelector('[data-bind="notifCount"]');
  if (!badge) return;
  const items = computeNotifications();
  if (items.length === 0) { badge.hidden = true; badge.textContent = "0"; }
  else { badge.hidden = false; badge.textContent = String(items.length); }
  // Build dropdown
  const list = document.getElementById("notif-list");
  if (!list) return;
  if (items.length === 0) {
    list.innerHTML = `<p class="notif-empty">You're all caught up.</p>`;
  } else {
    list.innerHTML = items.map(itemHtml).join("");
  }
}
function itemHtml(n) {
  return `
    <button class="notif-item" type="button" ${n.modal ? `data-modal="${n.modal}"` : ""}>
      <span class="notif-emoji">${n.icon}</span>
      <span class="notif-text">
        <strong>${n.title}</strong>
        <span>${n.body}</span>
      </span>
    </button>`;
}
function computeNotifications() {
  if (!state) return [];
  const items = [];
  const hour = new Date().getHours();
  if (!state.morning && hour >= 5 && hour < 12) {
    items.push({ icon: "🌅", title: "Morning check-in", body: "Log how you're feeling today.", modal: "morning" });
  }
  if (state.morning && !state.evening && hour >= 18) {
    items.push({ icon: "🌙", title: "Evening check-in", body: "Reflect on your day.", modal: "evening" });
  }
  for (const n of state.notifications || []) {
    items.push({ icon: "🔔", title: n.title, body: n.body || "", server: n.id });
  }
  return items;
}

// --- Modal logic ----------------------------------------------------------
function openModal(name) {
  const modal = document.getElementById(`modal-${name}`);
  if (!modal) return;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  // Fresh slate every open for the symptom modal — last session's picks
  // shouldn't haunt the next entry.
  if (name === "symptom") resetMultiState(modal);
  prefillModal(name);
  if (name === "cycleWeek") renderCycleWeekModal();
  const firstInput = modal.querySelector("button[data-val], input, textarea");
  setTimeout(() => firstInput?.focus(), 80);
}

function resetMultiState(modal) {
  for (const group of modal.querySelectorAll("[data-multi]")) {
    group.dataset.value = "";
    for (const b of group.children) {
      if (b.tagName === "BUTTON") {
        b.classList.remove("on");
        b.setAttribute("aria-pressed", "false");
      }
    }
    updateMultiCount(group);
  }
  // Also clear the hide-when sections so the form starts collapsed.
  for (const el of modal.querySelectorAll("[data-show-when]")) el.hidden = true;
}
function closeAllModals() {
  document.querySelectorAll(".modal.open").forEach((m) => {
    m.classList.remove("open");
    m.setAttribute("aria-hidden", "true");
  });
  document.body.classList.remove("modal-open");
}
function prefillModal(name) {
  // If the user has already logged this slot today, pre-select their values.
  const map = { morning: state?.morning, evening: state?.evening };
  const data = map[name];
  if (!data) return;
  const modal = document.getElementById(`modal-${name}`);
  for (const grp of modal.querySelectorAll("[data-scale]")) {
    const key = grp.dataset.scale;
    const val = data[key === "overall" ? "overall" : key];
    if (val) selectScale(grp, val);
  }
}

// --- Scale / chip / multi pickers ----------------------------------------
function selectScale(group, value) {
  group.querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.val === +value));
  group.dataset.value = String(value);
}
function selectChip(group, value) {
  group.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.val === value));
  group.dataset.value = value;
}
function toggleMulti(group, value) {
  const set = new Set((group.dataset.value || "").split(",").filter(Boolean));
  if (set.has(value)) set.delete(value); else set.add(value);
  group.dataset.value = [...set].join(",");
  // Only flip the .on class on direct-child buttons of this group, so a nested
  // group (if any) doesn't accidentally get its state nuked.
  for (const b of group.children) {
    if (b.tagName === "BUTTON") {
      b.classList.toggle("on", set.has(b.dataset.val));
      b.setAttribute("aria-pressed", set.has(b.dataset.val) ? "true" : "false");
    }
  }
  updateMultiCount(group);
}

function updateMultiCount(group) {
  const key = group.dataset.multi;
  if (!key) return;
  const count = (group.dataset.value || "").split(",").filter(Boolean).length;
  document.querySelectorAll(`[data-multi-count-for="${key}"]`).forEach((el) => {
    el.hidden = count === 0;
    el.textContent = el.classList.contains("inline") ? `${count}` : `${count} selected`;
  });
}

// --- Counters (+/-) -------------------------------------------------------
function bumpCounter(form, target, delta, opts = {}) {
  const input = form.querySelector(`input[name="${target}"]`);
  if (!input) return;
  let v = parseFloat(input.value || "0");
  if (!Number.isFinite(v)) v = 0;
  v = +(v + delta).toFixed(2);
  const min = opts.min != null ? +opts.min : (input.min !== "" ? +input.min : -Infinity);
  const max = opts.max != null ? +opts.max : (input.max !== "" ? +input.max : Infinity);
  v = Math.max(min, Math.min(max, v));
  input.value = String(v);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

document.addEventListener("click", (e) => {
  // Multi-select chips come first: they're the most specific case and we
  // never want a misfire to fall through to single-select behaviour.
  const multiBtnDirect = e.target.closest("button");
  if (multiBtnDirect && multiBtnDirect.parentElement?.hasAttribute("data-multi")) {
    e.preventDefault();
    e.stopPropagation();
    toggleMulti(multiBtnDirect.parentElement, multiBtnDirect.dataset.val);
    onPickerChange(multiBtnDirect);
    return;
  }
  const scaleBtn = e.target.closest("[data-scale] button");
  if (scaleBtn && scaleBtn.parentElement?.hasAttribute("data-scale")) {
    selectScale(scaleBtn.parentElement, scaleBtn.dataset.val); onPickerChange(scaleBtn); return;
  }
  const chipBtn = e.target.closest("[data-chip] button");
  if (chipBtn && chipBtn.parentElement?.hasAttribute("data-chip")) {
    selectChip(chipBtn.parentElement, chipBtn.dataset.val); onPickerChange(chipBtn); return;
  }
  const cDecr = e.target.closest("[data-counter-decr]");
  if (cDecr) {
    const form = cDecr.closest("form");
    bumpCounter(form, cDecr.dataset.counterTarget, -parseFloat(cDecr.dataset.counterDecr), { min: cDecr.dataset.min, max: cDecr.dataset.max });
    return;
  }
  const cIncr = e.target.closest("[data-counter-incr]");
  if (cIncr) {
    const form = cIncr.closest("form");
    bumpCounter(form, cIncr.dataset.counterTarget, parseFloat(cIncr.dataset.counterIncr), { min: cIncr.dataset.min, max: cIncr.dataset.max });
    return;
  }
  const cleanBtn = e.target.closest("#ep-clean-btn");
  if (cleanBtn) {
    e.preventDefault();
    cleanBtn.disabled = true;
    api.cleanPet().then(() => {
      toast("Cleaned ✨ +2 XP", "ok");
      refresh();
    }).catch((err) => {
      toast(err.message || "Couldn't clean", "err");
      cleanBtn.disabled = false;
    });
    return;
  }
  const open = e.target.closest("[data-modal]");
  if (open) { e.preventDefault(); openModal(open.dataset.modal); return; }
  if (e.target.closest("[data-close-modal]")) { closeAllModals(); return; }
});

// Keyboard activation for the clickable cycle-snapshot card.
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.id === "cycle-snapshot-card") {
    e.preventDefault();
    openModal("cycleWeek");
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllModals();
});

// --- Contextual show/hide -------------------------------------------------
function onPickerChange(btn) {
  const group = btn.parentElement;
  const key = group.dataset.scale || group.dataset.chip || group.dataset.multi;
  const value = group.dataset.value;

  // Show "Flow today" only when Menstrual is selected
  if (key === "cyclePhase") {
    const flowRow = document.getElementById("flow-row");
    if (flowRow) flowRow.hidden = value !== "menstrual";
  }

  // Show pain-type + location rows when any pain-style symptom is selected.
  if (key === "symptom") {
    const selected = (group.dataset.value || "").split(",").filter(Boolean);
    document.querySelectorAll("[data-show-when]").forEach((el) => {
      const triggers = el.dataset.showWhen.split(/\s+/);
      el.hidden = !selected.some((v) => triggers.includes(v));
    });
  }
}

// --- Form submissions -----------------------------------------------------
async function submitForm(formId, gather, apiCall, successLabel) {
  const form = document.getElementById(formId);
  if (!form) return;
  const status = form.querySelector(".form-status");
  const button = form.querySelector('button[type="submit"]');
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let body;
    try { body = gather(form); }
    catch (err) { status.textContent = err.message; status.className = "form-status err"; return; }
    button.disabled = true;
    status.textContent = "Saving…";
    status.className = "form-status";
    try {
      const res = await apiCall(body);
      const bonusMsg = res.fullDayBonus ? ` + ${20} bonus for completing today!` : "";
      const leveledMsg = res.pet?.leveledUp ? ` 🎉 ${res.pet.name} levelled up to ${res.pet.level}!` : "";
      toast(`${successLabel} · +${res.pointsAwarded} XP${bonusMsg}${leveledMsg}`, "ok");
      closeAllModals();
      await refresh();
    } catch (err) {
      status.textContent = err.message || "Could not save.";
      status.className = "form-status err";
    } finally {
      button.disabled = false;
    }
  });
}

function pickerVal(form, key, type = "scale") {
  const sel = type === "scale" ? `[data-scale="${key}"]` : `[data-chip="${key}"]`;
  const v = form.querySelector(sel)?.dataset.value;
  if (v == null || v === "") return null;
  return type === "scale" ? +v : v;
}
function multiVals(form, key) {
  const raw = form.querySelector(`[data-multi="${key}"]`)?.dataset.value || "";
  return raw ? raw.split(",").filter(Boolean) : [];
}

submitForm(
  "form-morning",
  (form) => {
    const mood = pickerVal(form, "mood");
    const energy = pickerVal(form, "energy");
    const pain = pickerVal(form, "pain");
    if (!mood || !energy || !pain) throw new Error("Pick a value for mood, energy and pain.");
    return {
      mood, energy, pain,
      sleepHours: form.sleepHours.value || null,
      sleepQuality: pickerVal(form, "sleepQuality"),
      cycleDay: form.cycleDay.value || null,
      cyclePhase: pickerVal(form, "cyclePhase", "chip"),
      flow: pickerVal(form, "flow", "chip"),
      bbt: form.bbt.value || null,
      cervicalMucus: pickerVal(form, "cervicalMucus", "chip"),
      breastTenderness: pickerVal(form, "breastTenderness"),
      notes: form.notes.value || null,
    };
  },
  api.morningCheckin,
  "Morning check-in logged"
);

submitForm(
  "form-symptom",
  (form) => {
    const symptoms = multiVals(form, "symptom");
    const severity = pickerVal(form, "severity");
    if (!symptoms.length) throw new Error("Pick at least one symptom.");
    if (!severity) throw new Error("Set severity 1–5.");
    return {
      symptoms, severity,
      locations: multiVals(form, "location"),
      painTypes: multiVals(form, "painType"),
      triggers: multiVals(form, "triggers"),
      relief: multiVals(form, "relief"),
      notes: form.notes.value || null,
    };
  },
  api.logSymptom,
  "Symptoms logged"
);

submitForm(
  "form-evening",
  (form) => {
    const overall = pickerVal(form, "overall");
    if (!overall) throw new Error("How was your day overall? Pick 1–5.");
    return {
      overall,
      stressLevel: pickerVal(form, "stressLevel"),
      waterGlasses: form.waterGlasses.value || null,
      movementLevel: pickerVal(form, "movementLevel", "chip"),
      bowelCount: form.bowelCount.value || null,
      bowelType: pickerVal(form, "bowelType", "chip"),
      eveningSymptoms: multiVals(form, "eveningSymptoms"),
      appetite: pickerVal(form, "appetite", "chip"),
      intimacy: pickerVal(form, "intimacy", "chip"),
      medications: form.medications.value || null,
      reflection: form.reflection.value || null,
      gratitude: form.gratitude.value || null,
    };
  },
  api.eveningCheckin,
  "Evening check-in logged"
);

// --- Bell dropdown --------------------------------------------------------
const bell = document.querySelector(".bell");
const dropdown = document.getElementById("notif-dropdown");
if (bell && dropdown) {
  bell.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!dropdown.hidden && !e.target.closest("#notif-dropdown") && !e.target.closest(".bell")) {
      dropdown.hidden = true;
    }
  });
  dropdown.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-notif]")) dropdown.hidden = true;
  });
}

// --- Sidebar nav: real navigation, no preventDefault -----------------------
// (We just paint the visual active state on click — the browser does the rest.)
document.querySelectorAll(".side-nav a").forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".side-nav a").forEach((a) => a.classList.remove("active"));
    link.classList.add("active");
  });
});
document.querySelectorAll(".seg button").forEach((btn) => {
  if (btn.classList.contains("more")) return;
  btn.addEventListener("click", () => {
    btn.parentElement.querySelectorAll("button:not(.more)").forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
  });
});

// --- Toast ----------------------------------------------------------------
function toast(text, tone = "ok") {
  const stack = document.getElementById("toast-stack");
  if (!stack) return;
  const t = document.createElement("div");
  t.className = `toast toast-${tone}`;
  t.textContent = text;
  stack.appendChild(t);
  requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => {
    t.classList.remove("in");
    setTimeout(() => t.remove(), 250);
  }, 4500);
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : ""; }

// Kick everything off
refresh();
// Soft refresh every few minutes (so banners switch when 12:00 / 18:00 hit)
setInterval(refresh, 5 * 60 * 1000);
