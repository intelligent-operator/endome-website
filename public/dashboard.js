// =============================================================================
// EndoMe dashboard — daily logging, gamification, contextual reminders.
// Talks to /api/me/* (auth via session cookie).
// =============================================================================

// Visible in the dev console — confirms which JS build is running.
console.info("EndoMe dashboard build v4 (multi-select symptoms enabled — direct listeners)");

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
  async afternoonCheckin(body) { return postJson("/api/me/checkin/afternoon", { date: todayLocalDate(), ...body }); },
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
  renderDosesDue();
  renderEndoWatch();
  renderBodyMap();
  renderCyclePrediction();
  renderIntimacyList();
}

// --- Early-diagnosis pattern watch ---------------------------------------
// Shows up only for users on the "not yet diagnosed, please watch" path
// once 3+ endo markers are present in their last 60 days. Warm, plain,
// not alarmist — and always framed as "patterns we're noticing", never
// as a diagnosis.
async function renderEndoWatch() {
  const slot = document.getElementById("endo-watch-slot");
  if (!slot) return;
  let data;
  try {
    const r = await fetch("/api/me/early-dx-watch", { credentials: "same-origin" });
    if (!r.ok) { slot.innerHTML = ""; return; }
    data = await r.json();
  } catch { slot.innerHTML = ""; return; }

  if (!data.eligible || !data.flagged) { slot.innerHTML = ""; return; }

  const markerList = data.markers.map((m) => `<li>
    <span class="ew-check">✓</span>
    <div><strong>${escapeHtml(m.label)}</strong><span>${escapeHtml(m.why)}</span></div>
  </li>`).join("");

  slot.innerHTML = `
    <section class="endo-watch-card">
      <header class="ew-head">
        <div class="ew-emoji">🔭</div>
        <div class="ew-title">
          <h3>What we're noticing</h3>
          <span>${data.score} of 10 endo-pattern markers in your last ${data.sample.windowDays} days · not a diagnosis</span>
        </div>
        <a class="ew-cta" href="/my-insights">Read full write-up →</a>
      </header>
      <ul class="ew-list">${markerList}</ul>
      <footer class="ew-foot">
        <p>This is patterns we're seeing in your logs — your call what to do with it. Turn this off any time in <a href="/profile">Profile → Endometriosis</a>.</p>
      </footer>
    </section>`;
}

// --- Body pain map -------------------------------------------------------
// Interactive silhouette: each named region has a hotspot for click-to-log
// and (when a recent symptom exists at that location) a glowing red dot
// sized by how many entries hit it in the last 30 days.
// Each region: [key, cx, cy, hotR, glowR, label]
// Coordinates target the new 220x520 viewBox. Paired regions have
// distinct Left/Right entries so users can tap directly on the side
// that hurts — left ovary vs right ovary, left knee vs right knee,
// etc. — and the modal then offers sub-spots for further granularity
// (e.g. "Both" / specific quadrant).
const BODY_MAP_REGIONS = [
  // Head & neck
  ["Head",            110,  40, 22, 16, "Head"],
  ["Jaw",             110,  66, 10,  8, "Jaw"],
  ["Neck",            110,  72, 11,  9, "Neck"],
  // Shoulders + arms (paired)
  ["Left shoulder",    78,  92, 14, 10, "Left shoulder"],
  ["Right shoulder",  142,  92, 14, 10, "Right shoulder"],
  ["Left arm",         66, 150, 12, 10, "Left arm"],
  ["Right arm",       154, 150, 12, 10, "Right arm"],
  ["Left elbow",       62, 204, 10,  8, "Left elbow"],
  ["Right elbow",     158, 204, 10,  8, "Right elbow"],
  ["Left hand",        64, 304, 11,  9, "Left hand"],
  ["Right hand",      156, 304, 11,  9, "Right hand"],
  // Torso
  ["Chest",           110, 120, 18, 13, "Chest"],
  ["Left breast",      94, 130, 12,  9, "Left breast"],
  ["Right breast",    126, 130, 12,  9, "Right breast"],
  ["Upper abdomen",   110, 180, 16, 12, "Upper abdomen"],
  ["Lower abdomen",   110, 220, 17, 13, "Lower abdomen"],
  // Pelvic region (the core endo zone)
  ["Pelvis",          110, 268, 18, 14, "Pelvis"],
  ["Left ovary",       92, 264, 11,  9, "Left ovary"],
  ["Right ovary",     128, 264, 11,  9, "Right ovary"],
  ["Uterus",          110, 274, 11,  9, "Uterus"],
  ["Bladder",         110, 296, 11,  9, "Bladder"],
  ["Rectum",          110, 312, 10,  8, "Rectum"],
  ["Lower back",      110, 250, 13, 10, "Lower back"], // front-view, sits behind torso
  // Hips
  ["Left hip",         78, 308, 12, 10, "Left hip"],
  ["Right hip",       142, 308, 12, 10, "Right hip"],
  // Legs (each side: thigh, knee, calf, foot)
  ["Left thigh",       85, 370, 14, 11, "Left thigh"],
  ["Right thigh",     135, 370, 14, 11, "Right thigh"],
  ["Left knee",        86, 420, 12, 10, "Left knee"],
  ["Right knee",      134, 420, 12, 10, "Right knee"],
  ["Left calf",        86, 462, 12, 10, "Left calf"],
  ["Right calf",      134, 462, 12, 10, "Right calf"],
  ["Left foot",        88, 510, 13, 10, "Left foot"],
  ["Right foot",      132, 510, 13, 10, "Right foot"],
];

async function renderBodyMap() {
  const hotG  = document.getElementById("body-map-hotspots");
  const glowG = document.getElementById("body-map-glows");
  const legend = document.getElementById("body-map-legend");
  if (!hotG || !glowG || !legend) return;

  let data = { regions: {} };
  try {
    const r = await fetch("/api/me/body-pain-map", { credentials: "same-origin" });
    if (r.ok) data = await r.json();
  } catch { /* fall through with empty data */ }

  // Build hotspots (always present, even with no logs).
  // Render LARGEST radius first so the small precise targets (left/right
  // ovary, uterus, bladder) paint last and sit on top — otherwise the big
  // Pelvis circle would swallow taps meant for the ovaries.
  const sortedHotspots = [...BODY_MAP_REGIONS].sort((a, b) => b[3] - a[3]);
  hotG.innerHTML = sortedHotspots.map(([key, cx, cy, hr, _gr, label]) =>
    `<circle data-region="${escapeHtml(key)}" cx="${cx}" cy="${cy}" r="${hr}" tabindex="0" role="button" aria-label="Log pain — ${escapeHtml(label)}"><title>Tap to log: ${escapeHtml(label)}</title></circle>`
  ).join("");

  // Build glows from server data.
  const regions = data.regions || {};
  const glowMarkup = [];
  const legendRows = [];
  for (const [key, cx, cy, _hr, gr, label] of BODY_MAP_REGIONS) {
    const slot = regions[key];
    if (!slot || !slot.count) continue;
    // Scale glow with count + severity (capped).
    const sevBoost = Math.min(slot.maxSeverity || 3, 5);
    const haloR = gr + Math.min(slot.count, 6) + sevBoost * 1.5;
    glowMarkup.push(
      `<circle cx="${cx}" cy="${cy}" r="${haloR}" fill="url(#painGlow)"/>` +
      `<circle class="glow-core" cx="${cx}" cy="${cy}" r="${Math.max(4, gr * 0.45)}" fill="#ff4e6d"/>`
    );
    const sevClass = sevBoost >= 4 ? "sev-high" : sevBoost >= 3 ? "sev-mid" : "sev-low";
    legendRows.push({ key, label, count: slot.count, sev: sevBoost, sevClass, lastDate: slot.lastDate });
  }
  glowG.innerHTML = glowMarkup.join("");

  if (!legendRows.length) {
    legend.innerHTML = `<p class="body-map-empty">No pain logged in the last 30 days. Tap any spot on the figure to log one.</p>`;
  } else {
    legendRows.sort((a, b) => b.count - a.count || b.sev - a.sev);
    legend.innerHTML = legendRows.map((r) => `
      <button type="button" class="body-map-row" data-body-region="${escapeHtml(r.key)}">
        <span class="dot ${r.sevClass}"></span>
        <strong>${escapeHtml(r.label)}</strong>
        <span class="meta">${r.count}× · sev ${r.sev}</span>
      </button>`).join("");
  }
}

// Region → optional sub-spots offered after tapping. For paired body
// parts that already have explicit Left/Right entries on the silhouette
// we don't repeat the side here — sub-spots are for further granularity
// (e.g. front/back of knee, specific quadrant). For non-paired centre
// regions we still offer left/right/both/centre.
const PAIN_SUBSPOTS = {
  "Head":            ["Forehead", "Top of head", "Back of head", "Temples", "Behind eyes"],
  "Jaw":             ["Left side", "Right side", "Both sides", "Front (TMJ)"],
  "Neck":            ["Front", "Back", "Left side", "Right side"],
  "Chest":           ["Centre", "Left side", "Right side"],
  "Upper abdomen":   ["Centre", "Left upper", "Right upper", "Whole"],
  "Lower abdomen":   ["Centre", "Left lower", "Right lower", "Whole"],
  "Pelvis":          ["Centre", "Left pelvis", "Right pelvis", "Whole pelvis"],
  "Lower back":      ["Left", "Right", "Centre", "Across"],
  "Left arm":        ["Upper arm", "Elbow", "Forearm", "Whole arm"],
  "Right arm":       ["Upper arm", "Elbow", "Forearm", "Whole arm"],
  "Left thigh":      ["Front", "Back", "Inner", "Outer"],
  "Right thigh":     ["Front", "Back", "Inner", "Outer"],
  "Left knee":       ["Front", "Back", "Inner", "Outer"],
  "Right knee":      ["Front", "Back", "Inner", "Outer"],
  "Left calf":       ["Front (shin)", "Back (calf)", "Inner", "Outer"],
  "Right calf":      ["Front (shin)", "Back (calf)", "Inner", "Outer"],
  "Left foot":       ["Top", "Sole", "Heel", "Toes", "Ankle"],
  "Right foot":      ["Top", "Sole", "Heel", "Toes", "Ankle"],
  // No sub-spots for explicit pinpoint locations
  "Uterus":          [],
  "Bladder":         [],
  "Rectum":          [],
  "Left ovary":      [],
  "Right ovary":     [],
  "Left breast":     [],
  "Right breast":    [],
  "Left shoulder":   [],
  "Right shoulder":  [],
  "Left elbow":      [],
  "Right elbow":     [],
  "Left hand":       ["Palm", "Back", "Fingers", "Wrist"],
  "Right hand":      ["Palm", "Back", "Fingers", "Wrist"],
  "Left hip":        [],
  "Right hip":       [],
};

// Pick the canonical symptom key based on which region the user tapped,
// so the row lands in the right bucket on the symptom-frequency chart.
// We have explicit endo-relevant keys for the core regions and fall
// back to "pain" for limbs / extremities.
const REGION_TO_SYMPTOM = {
  "Head":            "headache",
  "Jaw":             "pain",
  "Neck":            "pain",
  "Chest":           "pain",
  "Left breast":     "breast_tender",
  "Right breast":    "breast_tender",
  "Left shoulder":   "pain",
  "Right shoulder":  "pain",
  "Left arm":        "pain",
  "Right arm":       "pain",
  "Left elbow":      "pain",
  "Right elbow":     "pain",
  "Left hand":       "pain",
  "Right hand":      "pain",
  "Upper abdomen":   "pain",
  "Lower abdomen":   "endo_belly",
  "Pelvis":          "pelvic_pain",
  "Left ovary":      "pelvic_pain",
  "Right ovary":     "pelvic_pain",
  "Uterus":          "pelvic_pain",
  "Bladder":         "painful_urination",
  "Rectum":          "painful_bowel",
  "Lower back":      "back_pain",
  "Left hip":        "pelvic_pain",
  "Right hip":       "pelvic_pain",
  "Left thigh":      "pain",
  "Right thigh":     "pain",
  "Left knee":       "pain",
  "Right knee":      "pain",
  "Left calf":       "pain",
  "Right calf":      "pain",
  "Left foot":       "pain",
  "Right foot":      "pain",
};

function openPainModal(region) {
  const modal = document.getElementById("modal-pain");
  if (!modal) return;
  // Reset state
  resetMultiState(modal);
  for (const b of modal.querySelectorAll(".seg-slider button")) {
    b.classList.remove("on");
    b.setAttribute("aria-pressed", "false");
  }
  const noteField = modal.querySelector('textarea[name="notes"]');
  if (noteField) noteField.value = "";

  // Populate the manual region dropdown (once) and select the tapped region.
  const select = modal.querySelector("#pain-region-select");
  if (select && !select.options.length) {
    // Group the regions for an easier-to-scan dropdown.
    select.innerHTML = BODY_MAP_REGIONS
      .map(([key, , , , , label]) => `<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`)
      .join("");
  }
  // Default to the tapped region; if it's not in the list, fall back to first.
  const known = BODY_MAP_REGIONS.some(([k]) => k === region);
  const chosen = known ? region : BODY_MAP_REGIONS[0][0];
  if (select) select.value = chosen;
  modal.querySelector("#pain-region-input").value = chosen;

  // Render the sub-spots for the chosen region.
  paintPainSubspots(modal, chosen);

  // Wire up the new chips
  wireMultiButtons(modal);
  // Open
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  // Scroll the modal back to top so the user starts at the region picker.
  const card = modal.querySelector(".modal-card");
  if (card) card.scrollTop = 0;
}

// Render sub-spot chips for a region (and hide the section when the region
// is already a pinpoint like Left ovary / Uterus).
function paintPainSubspots(modal, region) {
  const subGroup = modal.querySelector("#pain-subspot-group");
  const subSection = modal.querySelector("#pain-subspot-section");
  const subs = PAIN_SUBSPOTS[region] || [];
  // Clear any previous selection state.
  subGroup.dataset.value = "";
  if (!subs.length) {
    subSection.hidden = true;
    subGroup.innerHTML = "";
  } else {
    subSection.hidden = false;
    subGroup.innerHTML = subs.map((s) => `<button type="button" data-val="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("");
  }
  wireMultiButtons(modal);
}

// Manual region change inside the modal → re-render the sub-spots and
// update the hidden region input. Lets the user correct a mis-tap.
document.addEventListener("change", (e) => {
  if (e.target.id !== "pain-region-select") return;
  const modal = document.getElementById("modal-pain");
  const region = e.target.value;
  modal.querySelector("#pain-region-input").value = region;
  paintPainSubspots(modal, region);
});

// Click on the silhouette or legend → open the pain-only modal.
document.addEventListener("click", (e) => {
  const region =
    e.target.closest?.("[data-region]")?.dataset.region ||
    e.target.closest?.("[data-body-region]")?.dataset.bodyRegion;
  if (!region) return;
  openPainModal(region);
});

// Form submission — posts to /api/me/symptoms with pain-only payload.
document.addEventListener("submit", async (e) => {
  if (e.target.id !== "form-pain") return;
  e.preventDefault();
  const form = e.target;
  const modal = document.getElementById("modal-pain");
  const region = form.region.value;
  const severity = pickerVal(form, "painSeverity");
  if (!severity) { toast("Set severity 1–5", "error"); return; }
  const subs = multiVals(form, "subspot");
  const character = multiVals(form, "painCharacter");
  const triggers = multiVals(form, "painTriggers");
  const relief = multiVals(form, "painRelief");
  const notes = form.notes.value.trim();

  // Build the locations list: region + any sub-spots the user picked.
  const locations = [region, ...subs];
  const symptomKey = REGION_TO_SYMPTOM[region] || "pain";

  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true; submitBtn.textContent = "Saving…";
  try {
    const res = await fetch("/api/me/symptoms", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        date: todayLocalDate(),
        symptoms: [symptomKey],
        severity,
        locations,
        painTypes: character,
        triggers,
        relief,
        notes: notes || null,
      }),
    });
    if (!res.ok) throw new Error(await safeError(res));
    toast("Pain logged");
    closeAllModals();
    // Refresh dashboard + body map glow so user sees their entry land.
    await refresh();
  } catch (err) {
    toast(`Couldn't save: ${err.message || err}`, "error");
  } finally {
    submitBtn.disabled = false; submitBtn.textContent = "Save pain log";
  }
});

// --- Cycle prediction card -----------------------------------------------
// Renders below the body map once we have any cycle history. Shows
// predicted next period, day-in-cycle, estimated phase, fertile window,
// and a confidence pill driven by stddev of recent cycle lengths.
async function renderCyclePrediction() {
  const slot = document.getElementById("cycle-predict-slot");
  if (!slot) return;
  try {
    await _renderCyclePredictionInner(slot);
  } catch (err) {
    // Failing the cycle card must never break the rest of the dashboard.
    console.warn("renderCyclePrediction failed:", err?.message);
    slot.innerHTML = "";
  }
}
async function _renderCyclePredictionInner(slot) {
  let data;
  try {
    const r = await fetch("/api/me/cycles", { credentials: "same-origin" });
    if (!r.ok) { slot.innerHTML = ""; return; }
    data = await r.json();
  } catch { slot.innerHTML = ""; return; }
  if (!data || typeof data !== "object") { slot.innerHTML = ""; return; }

  const p = data.prediction;
  // No prediction yet — prompt to log a period start so we can start.
  if (!p) {
    const msg = !data.cycles?.length
      ? "Log when your period starts — after one cycle I can start predicting your next one."
      : "One cycle logged so far. Log your next period start and I'll begin predicting forward.";
    slot.innerHTML = `
      <div class="card cycle-predict-card cycle-empty">
        <div class="card-head wide">
          <span><span class="ico-tile pink">🌸</span> Cycle prediction</span>
        </div>
        <p class="cp-empty">${msg}</p>
        <button type="button" class="pill-btn full" id="cp-log-btn">📅 Log a period</button>
      </div>`;
    document.getElementById("cp-log-btn")?.addEventListener("click", () => {
      try { openPeriodCalendar(data); }
      catch (err) {
        console.warn("openPeriodCalendar throw:", err?.message);
        document.body.classList.remove("modal-open");
        toast("Could not open the period calendar.", "error");
      }
    });
    return;
  }

  const conf = p.confidence;
  const confColor = conf === "high" ? "good" : conf === "medium" ? "okay" : "warn";
  const phaseEmoji = { menstrual:"🌑", follicular:"🌒", ovulation:"☀️", luteal:"🌕" };
  const phaseLabel = { menstrual:"Menstrual", follicular:"Follicular", ovulation:"Ovulatory", luteal:"Luteal" };
  const daysUntilText = p.daysUntil >= 0
    ? (p.daysUntil === 0 ? "Due today" : `In ${p.daysUntil} day${p.daysUntil === 1 ? "" : "s"}`)
    : `${-p.daysUntil} day${-p.daysUntil === 1 ? "" : "s"} late`;
  const overdue = p.daysUntil < -2;

  slot.innerHTML = `
    <div class="card cycle-predict-card ${overdue ? "is-overdue" : ""}">
      <div class="card-head wide">
        <span><span class="ico-tile pink">🌸</span> Cycle prediction</span>
        <span class="cp-conf cp-conf-${confColor}">${escapeHtml(conf)} confidence</span>
      </div>
      <div class="cp-grid">
        <div class="cp-tile cp-next">
          <span class="cp-label">Next period</span>
          <strong class="cp-big">${escapeHtml(daysUntilText)}</strong>
          <em class="cp-sub">${escapeHtml(formatPrettyDate(p.nextStart))}</em>
        </div>
        <div class="cp-tile">
          <span class="cp-label">Today</span>
          <strong>${phaseEmoji[p.estimatedPhase] || "🌸"} ${escapeHtml(phaseLabel[p.estimatedPhase] || "—")}</strong>
          <em>Day ${p.dayInCycle ?? "—"} of ${p.avgCycleLength}</em>
        </div>
        <div class="cp-tile">
          <span class="cp-label">Fertile window</span>
          <strong>${escapeHtml(shortDate(p.fertileStart))} → ${escapeHtml(shortDate(p.fertileEnd))}</strong>
          <em>Ovulation ~${escapeHtml(shortDate(p.ovulation))}</em>
        </div>
        <div class="cp-tile">
          <span class="cp-label">Avg cycle</span>
          <strong>${p.avgCycleLength}<span class="cp-unit">d</span></strong>
          <em>±${p.stddev}d over last ${p.sampleCycles}</em>
        </div>
      </div>
      <button type="button" class="pill-btn full" id="cp-log-btn">📅 Log a period</button>
    </div>`;
  document.getElementById("cp-log-btn")?.addEventListener("click", () => {
    try { openPeriodCalendar(data); }
    catch (err) {
      console.warn("openPeriodCalendar throw:", err?.message);
      document.body.classList.remove("modal-open");
      toast("Could not open the period calendar.", "error");
    }
  });
}

function formatPrettyDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
function shortDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

// --- Period calendar ------------------------------------------------------
// Month-grid date picker for logging a period as a date RANGE
// (first click = start, second click = end). The calendar also overlays:
//   - past logged periods in solid red (rebuilt from /api/me/cycles)
//   - the next 1–2 predicted period windows in striped pink (predictNextCycle)
//   - the fertile window in green and predicted ovulation in yellow
//   - today, outlined in pink
// "Predictions based on previous months" comes straight from the server's
// rolling avg cycle length + period length; the calendar just paints them.
let _periodCalState = {
  viewYear: 0, viewMonth: 0,     // currently-displayed month
  start: null, end: null,        // selected range
  cycleData: null,               // /api/me/cycles payload
};

function isoFromYMD(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function addDaysIso(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetweenIso(a, b) {
  return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
}

function openPeriodCalendar(cycleData) {
  const modal = document.getElementById("modal-period");
  if (!modal) {
    toast("Period calendar unavailable — refresh the page.", "error");
    return;
  }
  // Open the modal FIRST so even if the render below throws, the user
  // sees the chrome, can hit Cancel, and isn't stuck behind a locked
  // body with nothing on screen.
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  // Wire close buttons immediately — never wait for a render that
  // might fail to give the user an exit.
  modal.querySelectorAll("[data-close-modal]").forEach((el) => {
    el.onclick = () => closeAllModals();
  });

  try {
    _periodCalState.cycleData = cycleData || null;
    _periodCalState.start = null;
    _periodCalState.end = null;
    const today = todayLocalDate();
    const td = new Date(today + "T00:00:00");
    _periodCalState.viewYear = td.getFullYear();
    _periodCalState.viewMonth = td.getMonth();

    paintSelectedSummary();
    renderPeriodCalendar();
  } catch (err) {
    console.warn("openPeriodCalendar render failed:", err?.message);
    // Replace the grid with a recovery message — modal still open + Cancel works.
    const grid = document.getElementById("period-cal-grid");
    if (grid) grid.innerHTML = `<p class="empty-state" style="grid-column:1/-1;padding:24px;text-align:center">Calendar failed to load. Tap Cancel to close.</p>`;
  }
}

// Emergency body-unlock — Escape always frees the body, no matter what
// state the modals are in. Belt-and-braces fix for the case where a
// rogue handler somewhere leaves body.modal-open / .bw-open set.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.body.classList.remove("modal-open");
    document.body.classList.remove("bw-open");
  }
});

// Pre-compute the sets of days for past logged periods + predicted future
// periods so the renderer is a tight loop.
function buildPredictionMaps(cycleData) {
  const cycles = cycleData?.cycles || [];
  const pred = cycleData?.prediction || null;
  const avgPeriodLen = cycleData?.summary?.avgPeriodLength || pred?.avgPeriodLength || 5;

  // Cap every loop at 45 days (longer than any reasonable period or
  // window) so a malformed end_date or fertile range can never lock the
  // tab. Defense in depth — predictNextCycle should already filter out
  // bad data, but bad data here would break the entire dashboard.
  const SAFE = 45;
  const loggedDays = new Set();   // confirmed period days from history
  const loggedStarts = new Set(); // start dates (for the "logged" dot)
  for (const c of cycles) {
    if (!c.start_date) continue;
    loggedStarts.add(c.start_date);
    const len = Math.max(1, Math.min(SAFE, c.period_length || avgPeriodLen || 5));
    const computedEnd = addDaysIso(c.start_date, len - 1);
    const end = (c.end_date && c.end_date >= c.start_date && daysBetweenIso(c.start_date, c.end_date) <= SAFE)
      ? c.end_date : computedEnd;
    let d = c.start_date;
    let guard = 0;
    while (d <= end && guard++ < SAFE) { loggedDays.add(d); d = addDaysIso(d, 1); }
  }

  const predictedDays = new Set();
  const fertileDays = new Set();
  let ovulationDay = null;
  if (pred?.nextStart) {
    const pLen = Math.max(1, Math.min(SAFE, avgPeriodLen || 5));
    for (let i = 0; i < pLen; i++) predictedDays.add(addDaysIso(pred.nextStart, i));
    const cycleLen = Math.max(18, Math.min(60, pred.avgCycleLength || 28));
    const next2 = addDaysIso(pred.nextStart, cycleLen);
    for (let i = 0; i < pLen; i++) predictedDays.add(addDaysIso(next2, i));
  }
  if (pred?.fertileStart && pred?.fertileEnd && daysBetweenIso(pred.fertileStart, pred.fertileEnd) <= SAFE) {
    let d = pred.fertileStart;
    let guard = 0;
    while (daysBetweenIso(d, pred.fertileEnd) >= 0 && guard++ < SAFE) { fertileDays.add(d); d = addDaysIso(d, 1); }
  }
  if (pred?.ovulation) ovulationDay = pred.ovulation;

  // The most-recent logged start anchors the "Day N" cycle-day badge.
  const lastStart = cycles[0]?.start_date || pred?.lastStart || null;
  return { loggedDays, loggedStarts, predictedDays, fertileDays, ovulationDay, lastStart };
}

function renderPeriodCalendar() {
  const grid = document.getElementById("period-cal-grid");
  const monthLabel = document.getElementById("period-cal-month");
  if (!grid) return;
  const { viewYear, viewMonth, cycleData, start, end } = _periodCalState;
  const today = todayLocalDate();

  if (monthLabel) {
    monthLabel.textContent = new Date(viewYear, viewMonth, 1)
      .toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  const maps = buildPredictionMaps(cycleData);
  const firstDow = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  // Range hover preview: when start is set but no end, hovered cell
  // previews the range. We re-render on hover for simplicity.
  let cells = "";
  for (let i = 0; i < firstDow; i++) cells += `<span class="pc-cell pc-empty"></span>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = isoFromYMD(viewYear, viewMonth, d);
    const isFuture = iso > today;
    const classes = ["pc-cell"];
    if (iso === today) classes.push("pc-today");

    // Selection layer (highest priority visually)
    let inSelected = false;
    if (start && end && iso >= start && iso <= end) { classes.push("pc-selected"); inSelected = true; }
    else if (start && !end && iso === start) { classes.push("pc-selected", "pc-selected-start"); inSelected = true; }

    // Logged period day (solid red) — past months
    if (!inSelected && maps.loggedDays.has(iso)) classes.push("pc-period-logged");
    // Predicted period day (striped pink) — future months
    else if (!inSelected && maps.predictedDays.has(iso)) classes.push("pc-period-predicted");
    // Fertile + ovulation overlays (don't fight with period colours)
    if (!inSelected && !maps.loggedDays.has(iso) && !maps.predictedDays.has(iso)) {
      if (maps.fertileDays.has(iso)) classes.push("pc-fertile");
      if (iso === maps.ovulationDay) classes.push("pc-ovul");
    }
    if (isFuture) classes.push("pc-future");

    // Cycle-day badge relative to most-recent start (so user sees Day 1/2/3...).
    let cycleDayBadge = "";
    if (maps.lastStart && iso >= maps.lastStart) {
      const cd = daysBetweenIso(maps.lastStart, iso) + 1;
      if (cd >= 1 && cd <= 45) cycleDayBadge = `<em class="pc-cd">${cd}</em>`;
    }
    const loggedDot = maps.loggedStarts.has(iso) ? '<i class="pc-logged"></i>' : "";
    cells += `<button type="button" class="${classes.join(" ")}" data-date="${iso}" ${isFuture ? "disabled" : ""}>
      <span class="pc-num">${d}</span>${cycleDayBadge}${loggedDot}
    </button>`;
  }
  grid.innerHTML = cells;
}

// Show the running selection summary above the Log button.
function paintSelectedSummary() {
  const sel = document.getElementById("period-selected");
  const btn = document.getElementById("period-save-btn");
  const { start, end, cycleData } = _periodCalState;
  if (!sel || !btn) return;

  if (!start) {
    sel.hidden = true;
    btn.disabled = true;
    btn.textContent = "Log period";
    return;
  }
  const fmt = (iso) => new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const lastStart = cycleData?.cycles?.[0]?.start_date || null;

  if (!end) {
    let context = "";
    if (lastStart && start > lastStart) {
      const cd = daysBetweenIso(lastStart, start) + 1;
      context = ` (day <strong>${cd}</strong> of current cycle)`;
    }
    sel.innerHTML = `Period start: <strong>${fmt(start)}</strong>${context}.<br><em>Now tap the last bleeding day — or save start-only.</em>`;
    sel.hidden = false;
    btn.disabled = false;
    btn.textContent = "Log start only";
  } else {
    const n = daysBetweenIso(start, end) + 1;
    sel.innerHTML = `Period: <strong>${fmt(start)} → ${fmt(end)}</strong> · <strong>${n} day${n === 1 ? "" : "s"}</strong>.`;
    sel.hidden = false;
    btn.disabled = false;
    btn.textContent = "Log period";
  }
}

// Calendar interactions — handles month nav + range selection.
document.addEventListener("click", (e) => {
  if (e.target.closest("#period-prev")) {
    _periodCalState.viewMonth--;
    if (_periodCalState.viewMonth < 0) { _periodCalState.viewMonth = 11; _periodCalState.viewYear--; }
    renderPeriodCalendar();
    return;
  }
  if (e.target.closest("#period-next")) {
    _periodCalState.viewMonth++;
    if (_periodCalState.viewMonth > 11) { _periodCalState.viewMonth = 0; _periodCalState.viewYear++; }
    renderPeriodCalendar();
    return;
  }
  if (e.target.closest("#period-clear-btn")) {
    _periodCalState.start = null;
    _periodCalState.end = null;
    paintSelectedSummary();
    renderPeriodCalendar();
    return;
  }
  const cell = e.target.closest(".pc-cell[data-date]");
  if (!cell || cell.disabled) return;
  const iso = cell.dataset.date;
  const s = _periodCalState;
  if (!s.start || (s.start && s.end)) {
    // No start yet, or already have a complete range → start over.
    s.start = iso;
    s.end = null;
  } else if (iso < s.start) {
    // Clicked earlier than current start → that becomes the new start.
    s.start = iso;
    s.end = null;
  } else if (iso === s.start) {
    // Same day clicked again → treat as one-day period.
    s.end = iso;
  } else {
    // Later day → that's the end.
    s.end = iso;
  }
  paintSelectedSummary();
  renderPeriodCalendar();
});

document.getElementById("period-save-btn")?.addEventListener("click", async () => {
  const { start, end } = _periodCalState;
  if (!start) return;
  const btn = document.getElementById("period-save-btn");
  const prev = btn.textContent;
  btn.disabled = true; btn.textContent = "Logging…";
  let posted = false;
  try {
    const r = await fetch("/api/me/cycles", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ start_date: start, end_date: end || null }),
    });
    if (!r.ok) {
      let msg = r.statusText;
      try { const j = await r.json(); msg = j.error || msg; } catch {}
      throw new Error(msg);
    }
    posted = true;
    toast("Period logged 🌸");
  } catch (err) {
    toast(`Couldn't log: ${err.message || err}`, "error");
  } finally {
    // Always reset the button. Always close on success. Never let a
    // render error leave the user stuck inside the modal.
    btn.disabled = false; btn.textContent = prev;
    if (posted) {
      try { closeAllModals(); } catch {}
      try { await renderCyclePrediction(); } catch (e) { console.warn(e); }
    }
  }
});

// --- Doses due banner ----------------------------------------------------
// Pulls today's scheduled doses + their current status. Renders a card
// for every dose that's pending now (or recently overdue). Includes
// Taken / Missed buttons that post back and re-render. Pending doses are
// also pushed into pendingDosesCache so the notif bell counts them and
// the dropdown lists them alongside the built-in check-in nudges.
let pendingDosesCache = [];
async function renderDosesDue() {
  const slot = document.getElementById("doses-due-slot");
  let data;
  try {
    const r = await fetch("/api/me/doses-due", { credentials: "same-origin" });
    if (!r.ok) { if (slot) slot.innerHTML = ""; pendingDosesCache = []; renderNotifBadge(); return; }
    data = await r.json();
  } catch { if (slot) slot.innerHTML = ""; pendingDosesCache = []; renderNotifBadge(); return; }

  const pending = (data.doses || []).filter((d) => d.status === "pending");
  pendingDosesCache = pending;
  // Recompute the badge + dropdown so the count now includes pending doses.
  renderNotifBadge();
  if (!slot) return;
  if (!pending.length) { slot.innerHTML = ""; return; }

  const KIND_ICO = { medication: "💊", supplement: "🌿", vitamin: "💚", hormone: "🌸", herb: "🍃", other: "💊" };
  slot.innerHTML = `
    <section class="doses-due-card">
      <header class="doses-due-head">
        <h3>🔔 Doses due today</h3>
        <span class="doses-due-sub">${pending.length} waiting · tap to confirm</span>
      </header>
      <ul class="doses-due-list">
        ${pending.map((d) => `
          <li class="doses-due-row" data-med="${d.medicationId}" data-slot="${d.scheduledFor}">
            <span class="doses-due-ico">${KIND_ICO[d.kind] || "💊"}</span>
            <div class="doses-due-info">
              <strong>${escapeHtml(d.name)}</strong>
              <span>${escapeHtml(d.timeOfDay)}${d.dose ? " · " + escapeHtml(d.dose) : ""}</span>
            </div>
            <div class="doses-due-actions">
              <button type="button" class="btn-soft small" data-dose-taken>✅ Taken</button>
              <button type="button" class="btn-soft small danger" data-dose-missed>✗ Missed</button>
            </div>
          </li>`).join("")}
      </ul>
    </section>`;

  slot.querySelectorAll(".doses-due-row").forEach((row) => {
    const medId = row.dataset.med;
    const scheduledFor = +row.dataset.slot;
    const taken  = row.querySelector("[data-dose-taken]");
    const missed = row.querySelector("[data-dose-missed]");
    const act = async (url, body, label) => {
      taken.disabled = missed.disabled = true;
      const me = label === "Taken" ? taken : missed;
      me.textContent = "Saving…";
      try {
        const r = await fetch(url, {
          method: "POST", credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error("save failed");
        row.classList.add("done");
        row.querySelector(".doses-due-actions").innerHTML =
          `<span class="dose-confirmed">${label === "Taken" ? "✅ Logged" : "✗ Missed"}</span>`;
        setTimeout(renderDosesDue, 600);
      } catch {
        taken.disabled = missed.disabled = false;
        me.textContent = label === "Taken" ? "✅ Taken" : "✗ Missed";
      }
    };
    taken.addEventListener("click", () => act(
      `/api/me/medications/${medId}/log`, { scheduledFor }, "Taken"
    ));
    missed.addEventListener("click", () => act(
      `/api/me/medications/${medId}/miss`, { scheduledFor }, "Missed"
    ));
  });
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
  // Mini avatar in the stat card — fills the whole container.
  const mini = document.getElementById("ep-mini-art");
  if (mini) {
    mini.innerHTML = svg;
    mini.dataset.pet = type;
    mini.dataset.mood = pet.mood || "happy";
    mini.style.setProperty("--color-shift", `${pet.colorSeed || 0}deg`);
  }
  // Big art on the right rail — render INSIDE a dedicated stage so the poop
  // overlay and hint can sit alongside the SVG without being clobbered.
  const big = document.getElementById("ep-big-art");
  const stage = document.getElementById("ep-pet-stage");
  if (big && stage) {
    stage.innerHTML = svg;
    big.dataset.pet = type;
    big.dataset.mood = pet.mood || "happy";
    big.style.setProperty("--color-shift", `${pet.colorSeed || 0}deg`);
    // Random "live" gestures — a small head-tilt / hop every 8-18s.
    if (!big.dataset.alive) {
      big.dataset.alive = "1";
      scheduleLiveGesture(big);
    }
  }
}

function scheduleLiveGesture(big) {
  const tick = () => {
    if (!document.body.contains(big)) return;
    const moves = ["pet-hop", "pet-tilt-l", "pet-tilt-r", "pet-blink"];
    const cls = moves[Math.floor(Math.random() * moves.length)];
    big.classList.add(cls);
    setTimeout(() => big.classList.remove(cls), 900);
    setTimeout(tick, 8000 + Math.random() * 10000);
  };
  setTimeout(tick, 3000 + Math.random() * 4000);
}

function renderPetPoop(pet) {
  const hasPoop = !!pet.hasPoop;
  const mini = document.getElementById("ep-mini-poop");
  if (mini) mini.hidden = !hasPoop;
  const spot = document.getElementById("ep-poop-spot");
  const hint = document.getElementById("ep-poop-hint-live");
  if (spot) {
    spot.hidden = !hasPoop;
    if (hasPoop && !spot.dataset.placed) placePoopRandomly(spot);
    else if (!hasPoop) { delete spot.dataset.placed; }
  }
  if (hint) hint.hidden = !hasPoop;
}

// Drop the poop somewhere along the bottom-half of the pet area, away from
// the centre so it doesn't sit on top of the pet's face.
function placePoopRandomly(spot) {
  const stage = spot.parentElement;
  if (!stage) return;
  const x = 8 + Math.random() * 70;         // % across, 8..78
  const y = 55 + Math.random() * 32;        // % down, 55..87
  spot.style.left = `${x}%`;
  spot.style.top  = `${y}%`;
  spot.dataset.placed = "1";
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
  mood:              { icon: "💭", label: "Mood swing" }, // legacy entries pre-2026-05
  mood_happy:        { icon: "😊", label: "Happy" },
  mood_sad:          { icon: "😢", label: "Sad" },
  mood_angry:        { icon: "😠", label: "Angry" },
  mood_anxious:      { icon: "😰", label: "Anxious" },
  mood_irritable:    { icon: "😤", label: "Irritable" },
  mood_numb:         { icon: "😶", label: "Numb" },
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

// --- Symptoms-this-week modal (opens from Today's Symptoms card) ---------
async function renderSymptomsWeekModal() {
  const body = document.getElementById("symptoms-week-body");
  if (!body) return;
  body.innerHTML = `<p class="empty-state">Loading…</p>`;
  const week = await loadWeek(true);
  const days = week?.days || [];
  if (!days.length) {
    body.innerHTML = `<p class="empty-state">No symptoms logged yet — your week chart fills in as you log.</p>`;
    return;
  }
  const max = Math.max(1, ...days.map((d) => d.symptomCount || 0));
  const total = days.reduce((s, d) => s + (d.symptomCount || 0), 0);
  const todayISO = todayLocalDate();
  const bars = days.map((d) => {
    const n = d.symptomCount || 0;
    const h = (n / max) * 100;
    const dayLabel = ["S","M","T","W","T","F","S"][new Date(d.date + "T00:00:00").getDay()];
    const date = d.date.slice(5);
    const disabled = n === 0;
    return `<button type="button" class="cw-bar-col cw-bar-btn ${d.date === todayISO ? "is-today" : ""}" data-day="${d.date}" aria-label="Open ${date} (${n} symptoms)"${disabled ? " aria-disabled='true'" : ""}>
      <div class="cw-bar-wrap"><div class="cw-bar" style="height:${h}%;background:linear-gradient(180deg,#ff4e8a,#ffb380)" title="${date}: ${n} symptom${n===1?"":"s"}"></div></div>
      <span class="cw-day">${dayLabel}</span>
      <span class="cw-count">${n}</span>
    </button>`;
  }).join("");
  body.innerHTML = `
    <div class="cw-metric">
      <div class="cw-metric-head"><strong>Symptom entries</strong> <span class="cw-meta">tap a day to see the details</span></div>
      <div class="cw-bars cw-bars-tappable">${bars}</div>
    </div>
    <div id="cw-day-detail" class="cw-day-detail">
      <p class="empty-state small">Tap a day above to expand.</p>
    </div>
    <p class="cw-summary"><strong>${total}</strong> symptom${total === 1 ? "" : "s"} logged across the past week.</p>`;

  // Bind day-bar clicks to load that day's full symptom list.
  body.querySelectorAll("[data-day]").forEach((btn) => {
    btn.addEventListener("click", () => loadDayDetail(btn.dataset.day, btn));
  });
}

async function loadDayDetail(date, btn) {
  const out = document.getElementById("cw-day-detail");
  if (!out) return;
  // Visual selection on the tapped bar.
  out.parentElement.querySelectorAll(".cw-bar-btn").forEach((b) => b.classList.toggle("is-selected", b === btn));
  out.innerHTML = `<p class="empty-state small">Loading…</p>`;
  try {
    const data = await getJson(`/api/me/symptoms?from=${encodeURIComponent(date)}&to=${encodeURIComponent(date)}`);
    const items = data.symptoms || [];
    if (!items.length) {
      out.innerHTML = `<p class="empty-state small">Nothing logged on ${prettyDate(date)}.</p>`;
      return;
    }
    out.innerHTML = `
      <h4 class="cw-day-title">${prettyDate(date)} <span class="cw-day-count">${items.length} entr${items.length===1?"y":"ies"}</span></h4>
      <ul class="sym-list">
        ${items.map((s) => {
          const meta = SYMPTOM_META[s.symptom] || { icon: "•", label: s.symptom };
          const tags = [];
          if (s.pain_type) String(s.pain_type).split(",").filter(Boolean).forEach((p) => tags.push(`🩸 ${p}`));
          if (s.location)  String(s.location).split(",").map((l) => l.trim()).filter(Boolean).forEach((l) => tags.push(`📍 ${l}`));
          return `<li class="sym-row">
            <div class="sym-ico" title="${meta.label}">${meta.icon}</div>
            <div class="sym-main">
              <div class="sym-top"><strong>${meta.label}</strong> <span class="sev sev-${s.severity}">${s.severity}/5</span></div>
              ${s.notes ? `<p class="sym-notes">${escapeHtml(s.notes)}</p>` : ""}
              ${tags.length ? `<div class="sym-tags">${tags.map(escapeHtml).join(" ")}</div>` : ""}
            </div>
            <div class="sym-time">${relTime(s.logged_at)}</div>
          </li>`;
        }).join("")}
      </ul>`;
  } catch (err) {
    out.innerHTML = `<p class="empty-state small">Couldn't load that day's symptoms.</p>`;
  }
}

function prettyDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
}

// --- Medication log modal (opens from "+ Log medication" sidebar button) --
// Always renders an "add a new one" search at the top, even when the user
// already has saved meds. Below that, the saved list with one-tap dose
// logging. No need to ever leave the dashboard.
let _medLogCache = [];
async function renderMedLogModal() {
  const body = document.getElementById("med-log-body");
  if (!body) return;
  body.innerHTML = `
    <div class="med-add-inline">
      <label class="field">
        <span>Add &amp; log a new one</span>
        <input type="search" id="med-quick-search" placeholder="Start typing — Ibuprofen, Magnesium, Vitamin D, NAC…" autocomplete="off" />
      </label>
      <ul class="med-autocomplete" id="med-quick-ac" hidden></ul>
      <div id="med-quick-detail" hidden></div>
    </div>
    <div id="med-quick-saved">
      <div class="med-quick-head">Your saved medications</div>
      <ul class="med-quicklog-list" id="med-quicklog-list">
        <li class="empty-state small">Loading…</li>
      </ul>
    </div>`;
  wireQuickSearch();
  await refreshMedQuickList();
}

async function refreshMedQuickList() {
  const ul = document.getElementById("med-quicklog-list");
  if (!ul) return;
  try {
    const data = await fetch("/api/me/medications", { credentials: "same-origin" }).then((r) => r.json());
    _medLogCache = data.medications || [];
    if (!_medLogCache.length) {
      ul.innerHTML = `<li class="empty-state small">Nothing saved yet — add your first medication above.</li>`;
      return;
    }
    ul.innerHTML = _medLogCache.map(medQuickRow).join("");
  } catch {
    ul.innerHTML = `<li class="empty-state small">Couldn't load medications.</li>`;
  }
}

function medQuickRow(m) {
  const okNow = !m.nextAllowedAt || (Date.now() / 1000) >= m.nextAllowedAt;
  const next  = m.nextAllowedAt
    ? `Next allowed in ${Math.max(1, Math.ceil((m.nextAllowedAt - Date.now() / 1000) / 60))} min`
    : "Available now";
  return `<li class="med-quick-row">
    <div class="med-quick-info">
      <strong>${escapeHtml(m.name)}</strong>
      <span class="med-quick-meta">${escapeHtml(m.dose || "—")} · ${okNow ? "✅ Available now" : "⏳ " + next}</span>
    </div>
    <button class="btn btn-primary small" data-quick-log="${m.id}" ${okNow ? "" : "disabled"}>Log dose</button>
  </li>`;
}

// --- Inline "add new" search inside the medLog modal ---------------------
function wireQuickSearch() {
  const input  = document.getElementById("med-quick-search");
  const ac     = document.getElementById("med-quick-ac");
  const detail = document.getElementById("med-quick-detail");
  if (!input || !ac || !detail) return;
  const CATALOG = Array.isArray(window.MED_CATALOG) ? window.MED_CATALOG : [];

  let hover = -1;
  let picked = null; // either a catalog entry or { name } for custom

  function paint(query) {
    const q = (query || "").trim().toLowerCase();
    let items;
    if (!q) {
      items = CATALOG.filter((c) => ["Ibuprofen","Paracetamol","Magnesium","Vitamin D","Omega-3","NAC (N-Acetyl Cysteine)","PEA (Palmitoylethanolamide)","Dienogest"].includes(c.name));
    } else {
      items = CATALOG.filter((c) =>
        c.name.toLowerCase().includes(q) ||
        (c.aliases || []).some((a) => a.toLowerCase().includes(q)) ||
        (c.category || "").toLowerCase().includes(q));
    }
    items = items.slice(0, 8);
    // Always offer the "use this as a custom name" row when there's a query
    // that doesn't match any catalog name exactly.
    const exactMatch = q && items.some((c) => c.name.toLowerCase() === q);
    let html = items.map((m) => `<li data-name="${escapeHtml(m.name)}">
      <span class="ac-name">${escapeHtml(m.name)}</span>
      <span class="ac-meta">${escapeHtml(m.category || "")} · ${escapeHtml(m.kind)}</span>
    </li>`).join("");
    if (q && !exactMatch) {
      html += `<li data-custom="${escapeHtml(query.trim())}">
        <span class="ac-name">Use "${escapeHtml(query.trim())}" as a custom medication</span>
        <span class="ac-meta">+ add to my list</span>
      </li>`;
    }
    if (!html) { ac.hidden = true; return; }
    ac.innerHTML = html;
    hover = -1;
    ac.querySelectorAll("li").forEach((li) => {
      li.addEventListener("click", () => pick(li));
    });
    ac.hidden = false;
  }
  function pick(li) {
    if (li.dataset.name) {
      picked = CATALOG.find((c) => c.name === li.dataset.name) || null;
    } else if (li.dataset.custom) {
      picked = { name: li.dataset.custom, kind: "medication" };
    }
    if (!picked) return;
    input.value = picked.name;
    ac.hidden = true;
    showDetail(picked);
  }
  function showDetail(entry) {
    detail.hidden = false;
    detail.innerHTML = `
      <div class="med-detail-card">
        <div class="med-detail-top">
          <strong>${escapeHtml(entry.name)}</strong>
          <span class="med-detail-meta">${escapeHtml(entry.category || "Custom")} · ${escapeHtml(entry.kind || "medication")}</span>
        </div>
        ${entry.summary ? `<p class="med-detail-summary">${escapeHtml(entry.summary)}</p>` : ""}
        <div class="med-detail-fields">
          <label class="field"><span>Dose</span>
            <input type="text" id="med-q-dose" maxlength="40" value="${escapeHtml(entry.defaultDose || "")}" placeholder="e.g. 400mg" />
          </label>
          <label class="field"><span>Min hours between doses <em>(optional)</em></span>
            <input type="number" id="med-q-cooldown" min="0" max="168" step="0.5" value="${entry.minHoursBetween != null ? entry.minHoursBetween : ""}" placeholder="e.g. 6" />
          </label>
        </div>
        <div class="med-detail-actions">
          <button class="btn btn-primary" id="med-q-save">Save &amp; log this dose</button>
          <button class="btn-soft" id="med-q-save-only">Just add to my list</button>
        </div>
        <p class="form-status" id="med-q-status" role="status"></p>
      </div>`;
    document.getElementById("med-q-save").addEventListener("click", () => saveAndLog(entry, true));
    document.getElementById("med-q-save-only").addEventListener("click", () => saveAndLog(entry, false));
  }
  async function saveAndLog(entry, alsoLog) {
    const dose = document.getElementById("med-q-dose").value.trim();
    const cooldown = document.getElementById("med-q-cooldown").value.trim();
    const status = document.getElementById("med-q-status");
    status.textContent = "Saving…"; status.className = "form-status";
    try {
      // 1. Create the medication
      const res = await fetch("/api/me/medications", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: entry.name,
          kind: entry.kind || "medication",
          dose: dose || null,
          frequency: entry.defaultFreq || "as_needed",
          minHoursBetween: cooldown || null,
        }),
      }).then((r) => r.json());
      if (res.error) throw new Error(res.error);
      // 2. Optionally log a dose right now
      if (alsoLog && res.id) {
        const logRes = await fetch(`/api/me/medications/${res.id}/log`, {
          method: "POST", credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ doseText: dose || null }),
        }).then((r) => r.json());
        if (logRes.error) throw new Error(logRes.error);
      }
      toast(alsoLog ? `Added ${entry.name} & logged a dose ✨` : `Added ${entry.name}`, "ok");
      // Reset and refresh the saved list inside the modal
      input.value = "";
      detail.hidden = true;
      detail.innerHTML = "";
      picked = null;
      await refreshMedQuickList();
    } catch (err) {
      status.textContent = err.message || "Couldn't save.";
      status.className = "form-status err";
    }
  }

  input.addEventListener("input", () => paint(input.value));
  input.addEventListener("focus", () => paint(input.value));
  input.addEventListener("keydown", (e) => {
    if (ac.hidden) return;
    const items = ac.querySelectorAll("li");
    if (e.key === "ArrowDown") { e.preventDefault(); hover = Math.min(items.length - 1, hover + 1); items.forEach((it, i) => it.classList.toggle("is-hover", i === hover)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); hover = Math.max(0, hover - 1); items.forEach((it, i) => it.classList.toggle("is-hover", i === hover)); }
    else if (e.key === "Enter" && hover >= 0) { e.preventDefault(); items[hover]?.click(); }
    else if (e.key === "Escape") { ac.hidden = true; }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".med-add-inline")) ac.hidden = true;
  });
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
  const items = computeNotifications();
  // Badge counts unread only — read items still show in the dropdown for
  // history but don't keep nudging the user.
  const unread = items.filter((n) => !n.read).length;
  if (badge) {
    if (unread === 0) { badge.hidden = true; badge.textContent = "0"; }
    else { badge.hidden = false; badge.textContent = String(unread); }
  }
  const pill = document.getElementById("notif-unread-pill");
  if (pill) {
    if (unread === 0) { pill.hidden = true; }
    else { pill.hidden = false; pill.textContent = String(unread); }
  }
  const markAll = document.getElementById("notif-mark-all");
  if (markAll) markAll.hidden = unread === 0;

  const list = document.getElementById("notif-list");
  if (!list) return;
  if (items.length === 0) {
    list.innerHTML = `<p class="notif-empty">🎉 You're all caught up. Nothing needs your attention right now.</p>`;
  } else {
    list.innerHTML = items.map(itemHtml).join("");
  }
}
function itemHtml(n) {
  // Build a data-payload of everything the click handler needs so the
  // delegated listener doesn't have to look it up again.
  const id = n.server ?? "";
  const url = n.actionUrl || "";
  const modal = n.modal || "";
  return `
    <div class="notif-item ${n.read ? "is-read" : "is-unread"}"
         data-notif-id="${escapeAttr(String(id))}"
         data-notif-url="${escapeAttr(url)}"
         data-notif-modal="${escapeAttr(modal)}"
         data-notif-virtual="${n.virtual ? "1" : "0"}">
      <button class="notif-main" type="button" data-notif-open>
        <span class="notif-emoji">${n.icon}</span>
        <span class="notif-text">
          <strong>${escapeAttr(n.title)}</strong>
          <span>${escapeAttr(n.body)}</span>
        </span>
        ${n.read ? "" : `<span class="notif-dot" aria-label="Unread"></span>`}
      </button>
      <button class="notif-dismiss" type="button" data-notif-dismiss aria-label="Dismiss">×</button>
    </div>`;
}
function escapeAttr(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;",
  })[c]);
}
// Client-side memory of which built-in reminders (morning / evening
// check-ins) the user has read this session. Server-side notifications
// carry their own read_at; medication + appointment reminders use the
// server's dismissed_reminders table.
const localReadKeys = new Set();
function computeNotifications() {
  if (!state) return [];
  const items = [];
  const hour = new Date().getHours();
  if (!state.morning && hour >= 5 && hour < 12) {
    const key = "builtin:morning";
    items.push({
      key, icon: "🌅", title: "Morning check-in",
      body: "Log how you're feeling today.", modal: "morning",
      read: localReadKeys.has(key), local: true,
    });
  }
  if (state.morning && !state.evening && hour >= 18) {
    const key = "builtin:evening";
    items.push({
      key, icon: "🌙", title: "Evening check-in",
      body: "Reflect on your day.", modal: "evening",
      read: localReadKeys.has(key), local: true,
    });
  }
  for (const n of state.notifications || []) {
    const virtual = typeof n.id === "string" && !/^\d+$/.test(String(n.id));
    // Honor client-side read tracking too — if Mark-all-read fired before
    // the server's dismissal table propagated, the local set still hides
    // these from the badge count.
    const locallyRead = typeof n.id === "string" && localReadKeys.has(n.id);
    items.push({
      icon: virtual ? (String(n.id).startsWith("appt:") ? "📅" : "💊") : "🔔",
      title: n.title,
      body: n.body || "",
      server: n.id,
      actionUrl: n.action_url || "",
      virtual,
      read: !!n.read_at || locallyRead,
    });
  }
  // Pending doses fetched by renderDosesDue — surface them in the bell
  // so the badge count and the dropdown actually match.
  for (const d of pendingDosesCache || []) {
    const key = `dose:${d.medicationId}:${d.scheduledFor}`;
    items.push({
      key, icon: "💊",
      title: `${d.name} · ${d.timeOfDay}`,
      body: d.dose ? `Dose due — ${d.dose}` : "Dose due — tap below to confirm",
      modal: null, local: true,
      dose: { medicationId: d.medicationId, scheduledFor: d.scheduledFor },
      read: localReadKeys.has(key),
    });
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
  // Make sure every multi-select chip in this modal has its direct click
  // handler. Cheap + idempotent — safe to call on every open.
  wireMultiButtons(modal);
  // Fresh slate every open for the symptom modal — last session's picks
  // shouldn't haunt the next entry.
  if (name === "symptom") resetMultiState(modal);
  prefillModal(name);
  if (name === "cycleWeek") renderCycleWeekModal();
  if (name === "symptomsWeek") renderSymptomsWeekModal();
  if (name === "medLog") renderMedLogModal();
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
  try {
    document.querySelectorAll(".modal.open").forEach((m) => {
      m.classList.remove("open");
      m.setAttribute("aria-hidden", "true");
    });
  } catch {}
  // Always remove the body lock — this is the most important step.
  // If a previous open call set the class but the close path bailed,
  // we still need the page to be scrollable again.
  document.body.classList.remove("modal-open");
  document.body.classList.remove("bw-open");
}
function prefillModal(name) {
  const modal = document.getElementById(`modal-${name}`);
  if (!modal) return;
  // 1) If the user already logged this slot today, pre-select their values.
  const map = { morning: state?.morning, evening: state?.evening };
  const data = map[name];
  if (data) {
    for (const grp of modal.querySelectorAll("[data-scale]")) {
      const key = grp.dataset.scale;
      const val = data[key === "overall" ? "overall" : key];
      if (val) selectScale(grp, val);
    }
  }
  // 2) Cycle day + phase: prefer today's saved cycle, else use the
  //    server-suggested value (yesterday + 1) so users don't keep
  //    re-typing the same day.
  if (name === "morning" || name === "evening" || name === "symptom" || name === "afternoon") {
    const cycle = state?.cycle;
    const suggested = state?.cycleSuggested;
    const dayInput = modal.querySelector("input[name='cycleDay']");
    const phaseGroup = modal.querySelector("[data-chip='cyclePhase']");
    if (dayInput && !dayInput.value) {
      const v = cycle?.day || suggested?.day;
      if (v) dayInput.value = String(v);
    }
    if (phaseGroup && !phaseGroup.dataset.value) {
      const v = cycle?.phase || suggested?.phase;
      if (v) selectChip(phaseGroup, v);
    }
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

// Direct per-button click handlers for every [data-multi] group on the page.
// Belt + braces: this bypasses the document-level delegated handler entirely
// so no other listener can ever swallow a chip click. Idempotent — re-runnable
// after DOM updates without double-wiring.
function wireMultiButtons(root = document) {
  for (const group of root.querySelectorAll("[data-multi]")) {
    for (const btn of group.children) {
      if (btn.tagName !== "BUTTON") continue;
      if (btn.dataset.multiWired === "1") continue;
      btn.dataset.multiWired = "1";
      btn.type = "button"; // never let it submit the form
      btn.setAttribute("role", "checkbox");
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleMulti(group, btn.dataset.val);
        onPickerChange(btn);
      });
    }
    updateMultiCount(group);
  }
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
  // Multi-select chips have their own direct-bound listeners (see
  // wireMultiButtons) so we don't touch them here.
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
  const quickLog = e.target.closest("[data-quick-log]");
  if (quickLog) {
    e.preventDefault();
    const id = quickLog.dataset.quickLog;
    quickLog.disabled = true;
    quickLog.textContent = "Logging…";
    fetch(`/api/me/medications/${id}/log`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }).then((r) => r.json()).then((res) => {
      if (res.error) throw new Error(res.error);
      toast(`Logged ${res.name || "dose"} ✨`, "ok");
      renderMedLogModal();
    }).catch((err) => {
      toast(err.message || "Couldn't log dose", "err");
      quickLog.disabled = false;
      quickLog.textContent = "Log dose";
    });
    return;
  }
  const poopSpot = e.target.closest("#ep-poop-spot");
  if (poopSpot) {
    e.preventDefault();
    if (poopSpot.dataset.cleaning) return;
    poopSpot.dataset.cleaning = "1";
    poopSpot.classList.add("is-cleaning");
    api.cleanPet().then((res) => {
      const gained = res?.gainedXp ?? 2;
      toast(`Cleaned ✨ +${gained} XP for your pet`, "ok");
      // Hide immediately so it feels responsive, then re-fetch.
      poopSpot.hidden = true;
      delete poopSpot.dataset.placed;
      refresh();
    }).catch((err) => {
      toast(err.message || "Couldn't clean", "err");
    }).finally(() => {
      poopSpot.classList.remove("is-cleaning");
      delete poopSpot.dataset.cleaning;
    });
    return;
  }
  // Keyboard activate today's symptoms / cycle snapshot cards (Enter).
  if (e.target.id === "today-symptoms-card") {
    // Treat as click on data-modal so existing logic handles it.
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
      morningSymptoms: multiVals(form, "morningSymptoms"),
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
  "form-afternoon",
  (form) => {
    const mood = pickerVal(form, "mood");
    const energy = pickerVal(form, "energy");
    const pain = pickerVal(form, "pain");
    if (!mood || !energy || !pain) throw new Error("Pick a value for mood, energy and pain.");
    return {
      mood, energy, pain,
      afternoonSymptoms: multiVals(form, "afternoonSymptoms"),
      notes: form.notes.value || null,
    };
  },
  api.afternoonCheckin,
  "Midday check-in logged"
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
      relief: multiVals(form, "relief"),
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

// --- Intimacy log --------------------------------------------------------
// Discreet quick-log on the dashboard. Feeds into the AI/insights
// context via ctxIntimacy on the server.
async function renderIntimacyList() {
  const slot = document.getElementById("intimacy-list");
  if (!slot) return;
  let data;
  try {
    const r = await fetch("/api/me/intimacy", { credentials: "same-origin" });
    if (!r.ok) return;
    data = await r.json();
  } catch { return; }
  const entries = (data.entries || []).slice(0, 5);
  if (!entries.length) {
    slot.innerHTML = `<p class="empty-state small">Private log for pain &amp; comfort patterns. Tap + Log to record an entry — only you (and the EndoMe insights engine) ever see it.</p>`;
    return;
  }
  slot.innerHTML = `<ul class="intimacy-rows">${entries.map((e) => `
    <li class="intimacy-row" data-id="${e.id}">
      <span class="intimacy-icon">${e.kind === "solo" ? "🌸" : "👫"}</span>
      <span class="intimacy-date">${escapeHtml(e.log_date)}</span>
      <span class="intimacy-meta">
        ${e.pain_level != null ? `pain <strong>${e.pain_level}/5</strong>` : ""}
        ${e.comfort != null ? ` · comfort <strong>${e.comfort}/5</strong>` : ""}
      </span>
      <button type="button" class="intimacy-del" data-del-intimacy="${e.id}" aria-label="Remove">×</button>
    </li>`).join("")}</ul>`;
  slot.querySelectorAll("[data-del-intimacy]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await fetch(`/api/me/intimacy/${b.dataset.delIntimacy}`, { method: "DELETE", credentials: "same-origin" });
        renderIntimacyList();
      } catch {}
    })
  );
}

document.addEventListener("submit", async (e) => {
  if (e.target.id !== "form-intimacy") return;
  e.preventDefault();
  const modal = document.getElementById("modal-intimacy");
  const kind = modal.querySelector('[data-chip="intimacyKind"]')?.dataset.value || "partnered";
  const pain = pickerVal(e.target, "intimacyPain");
  const comfort = pickerVal(e.target, "intimacyComfort");
  const notes = e.target.notes.value.trim() || null;
  if (pain == null && comfort == null && !notes) { toast("Add at least one detail.", "error"); return; }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const r = await fetch("/api/me/intimacy", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, pain_level: pain, comfort, notes }),
    });
    if (!r.ok) throw new Error(await safeError(r));
    toast("Logged 🤍");
    closeAllModals();
    renderIntimacyList();
  } catch (err) {
    toast(`Couldn't save: ${err.message || err}`, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Save";
  }
});

// Mark all notifications as read — broken out so we can bind it both via
// delegation AND directly on the button. Mobile Safari sometimes drops
// the synthesised click on a small button inside a dropdown; the direct
// pointerup binding is the belt-and-braces backup.
let _markingAllRead = false;
async function markAllNotificationsAsRead() {
  if (_markingAllRead) return;
  _markingAllRead = true;
  // Immediate visual feedback so the user knows the tap registered, even
  // before the server round-trip and refresh finishes.
  const btn = document.getElementById("notif-mark-all");
  if (btn) { btn.disabled = true; btn.textContent = "Marking…"; }
  const badge = document.querySelector(".bell-dot");
  if (badge) { badge.hidden = true; badge.textContent = "0"; }
  // Optimistically dim every notif row so they read as "done".
  document.querySelectorAll("#notif-list .notif-item").forEach((row) => {
    row.classList.add("notif-item-read");
    row.classList.remove("notif-item-unread");
  });
  // Mirror the server-side dismissal locally so the next render keeps
  // the badge at zero even if the network response is slow.
  for (const k of ["builtin:morning","builtin:evening"]) localReadKeys.add(k);
  for (const d of pendingDosesCache || []) {
    localReadKeys.add(`dose:${d.medicationId}:${d.scheduledFor}`);
  }
  for (const n of (state?.notifications || [])) {
    if (typeof n.id === "string") localReadKeys.add(n.id);
  }

  try {
    const r = await fetch("/api/me/notifications/read-all", {
      method: "POST", credentials: "same-origin",
    });
    if (!r.ok) throw new Error("Server returned " + r.status);
    toast("All caught up ✨");
    await refresh();
  } catch (err) {
    console.warn("mark-all-read failed:", err?.message);
    toast("Couldn't mark all read — check your connection.", "err");
  } finally {
    _markingAllRead = false;
    if (btn) { btn.disabled = false; btn.textContent = "Mark all read"; }
  }
}

// --- Bell dropdown --------------------------------------------------------
const bell = document.querySelector(".bell");
const dropdown = document.getElementById("notif-dropdown");
if (bell && dropdown) {
  // Direct binding on the mark-all-read button. Belt-and-braces against
  // mobile Safari occasionally dropping the synthesised click — pointerup
  // gives us a touch-first path that doesn't have the 300ms delay.
  // _mar flag prevents double-binding.
  const wireMarkAll = () => {
    const b = document.getElementById("notif-mark-all");
    if (!b || b._mar) return;
    b._mar = true;
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      markAllNotificationsAsRead();
    };
    b.addEventListener("click", handler);
    b.addEventListener("pointerup", handler);
  };
  // Run once on load and again every time the bell is opened.
  setTimeout(wireMarkAll, 100);
  bell.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
    // Belt: re-resolve + re-bind in case the button wasn't in the DOM
    // at first script run (e.g. delayed render on slow mobile).
    if (!dropdown.hidden) setTimeout(wireMarkAll, 0);
  });
  document.addEventListener("click", (e) => {
    if (!dropdown.hidden && !e.target.closest("#notif-dropdown") && !e.target.closest(".bell")) {
      dropdown.hidden = true;
    }
  });
  dropdown.addEventListener("click", async (e) => {
    if (e.target.closest("[data-close-notif]")) { dropdown.hidden = true; return; }

    // Mark all as read
    if (e.target.closest("#notif-mark-all")) {
      e.preventDefault();
      e.stopPropagation();
      await markAllNotificationsAsRead();
      return;
    }

    const row = e.target.closest(".notif-item");
    if (!row) return;
    const id = row.dataset.notifId;
    const url = row.dataset.notifUrl;
    const modal = row.dataset.notifModal;

    // Per-item dismiss button — fully removes the notification from the
    // feed (real rows get dismissed_at; virtuals get a dismissed_reminders
    // entry that filters them out on next compute).
    if (e.target.closest("[data-notif-dismiss]")) {
      e.preventDefault();
      e.stopPropagation();
      row.classList.add("is-dismissing");
      try {
        if (id && id.startsWith && id.startsWith("builtin:")) {
          localReadKeys.add(id);
        } else if (id) {
          await fetch(`/api/me/notifications/${encodeURIComponent(id)}/dismiss`, {
            method: "POST", credentials: "same-origin",
          });
        }
      } catch {}
      setTimeout(refresh, 220);
      return;
    }

    // Main button — open the target (modal, url, or appointment id).
    if (e.target.closest("[data-notif-open]")) {
      e.preventDefault();
      await markNotifRead(id, row);
      dropdown.hidden = true;
      if (modal) {
        openModal(modal);
      } else if (id && id.startsWith && id.startsWith("appt:")) {
        const apptId = id.slice(5);
        location.href = `/appointments?id=${encodeURIComponent(apptId)}`;
      } else if (url) {
        location.href = url;
      }
      // Refresh shortly after so the badge count drops.
      setTimeout(refresh, 250);
    }
  });
}

// Persist the read state, then optimistically grey out the row so the user
// sees instant feedback even before refresh() repaints the dropdown.
async function markNotifRead(id, row) {
  if (!id) return;
  if (id.startsWith && id.startsWith("builtin:")) {
    // Built-in (check-in nudges) — session-only memory.
    localReadKeys.add(id);
  } else {
    try {
      await fetch(`/api/me/notifications/${encodeURIComponent(id)}/read`, {
        method: "POST", credentials: "same-origin",
      });
    } catch {}
  }
  if (row) {
    row.classList.remove("is-unread");
    row.classList.add("is-read");
    row.querySelector(".notif-dot")?.remove();
  }
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
wireMultiButtons();        // wire every multi-select on the page (modals included)
refresh();
// Soft refresh every few minutes (so banners switch when 12:00 / 18:00 hit)
setInterval(refresh, 5 * 60 * 1000);
