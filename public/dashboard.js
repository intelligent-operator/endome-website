// =============================================================================
// EndoMe dashboard — daily logging, gamification, contextual reminders.
// Talks to /api/me/* (auth via session cookie).
// =============================================================================

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
    state = await api.today();
    render();
  } catch (err) {
    console.warn("dashboard refresh failed:", err.message);
    toast("Could not load latest data. Check connection.", "err");
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
  }

  renderBanner();
  renderNotifBadge();
  renderSymptomsTodayHint(symptoms?.length || 0);
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
  prefillModal(name);
  const firstInput = modal.querySelector("button[data-val], input, textarea");
  setTimeout(() => firstInput?.focus(), 80);
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
  group.querySelectorAll("button").forEach((b) => b.classList.toggle("on", set.has(b.dataset.val)));
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
  const scaleBtn = e.target.closest("[data-scale] button");
  if (scaleBtn) { selectScale(scaleBtn.parentElement, scaleBtn.dataset.val); onPickerChange(scaleBtn); return; }
  const chipBtn = e.target.closest("[data-chip] button");
  if (chipBtn) { selectChip(chipBtn.parentElement, chipBtn.dataset.val); onPickerChange(chipBtn); return; }
  const multiBtn = e.target.closest("[data-multi] button");
  if (multiBtn) { toggleMulti(multiBtn.parentElement, multiBtn.dataset.val); return; }
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
  const open = e.target.closest("[data-modal]");
  if (open) { e.preventDefault(); openModal(open.dataset.modal); return; }
  if (e.target.closest("[data-close-modal]")) { closeAllModals(); return; }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllModals();
});

// --- Contextual show/hide -------------------------------------------------
function onPickerChange(btn) {
  const group = btn.parentElement;
  const key = group.dataset.scale || group.dataset.chip;
  const value = group.dataset.value;

  // Show "Flow today" only when Menstrual is selected
  if (key === "cyclePhase") {
    const flowRow = document.getElementById("flow-row");
    if (flowRow) flowRow.hidden = value !== "menstrual";
  }

  // Show location row only for pain-type symptoms
  if (key === "symptom") {
    document.querySelectorAll("#symptom-extras [data-show-when]").forEach((el) => {
      const triggers = el.dataset.showWhen.split(/\s+/);
      el.hidden = !triggers.includes(value);
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
    const symptom = pickerVal(form, "symptom", "chip");
    const severity = pickerVal(form, "severity");
    if (!symptom) throw new Error("Pick a symptom.");
    if (!severity) throw new Error("Set severity 1–5.");
    return {
      symptom, severity,
      location: pickerVal(form, "location", "chip"),
      triggers: multiVals(form, "triggers"),
      relief: multiVals(form, "relief"),
      notes: form.notes.value || null,
    };
  },
  api.logSymptom,
  "Symptom logged"
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

// --- Sidebar nav (visual) -------------------------------------------------
document.querySelectorAll(".side-nav a").forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
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
