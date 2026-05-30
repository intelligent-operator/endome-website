/* /reports — clinician-ready printable summary.
   - Pulls structured data from /api/me/report
   - Asks /api/me/report/clinical-summary to draft a doctor-to-doctor
     narrative (Bedrock under the hood) and renders it at the top
   - Everything is client-rendered so the user can change the date range
     and re-print without round-trips. */

const $ = (sel, root = document) => root.querySelector(sel);

const fromInput  = $("#report-from");
const toInput    = $("#report-to");
const generate   = $("#report-generate");
const printBtn   = $("#report-print");
const doc        = $("#report-doc");
const loader     = $("#page-loader");

const SYMPTOM_LABEL = {
  pelvic_pain:"Pelvic pain", cramps:"Cramps", endo_belly:"Endo belly",
  back_pain:"Lower back pain", pain:"Pain (other)", bloating:"Bloating",
  nausea:"Nausea", fatigue:"Fatigue", headache:"Headache", headaches:"Headache",
  breast_tender:"Breast tenderness", hot_flash:"Hot flash", dizziness:"Dizziness",
  spotting:"Spotting", painful_urination:"Dysuria",
  painful_bowel:"Dyschezia", painful_sex:"Dyspareunia",
  mood_happy:"Mood — euthymic", mood_sad:"Mood — low", mood_angry:"Mood — angry",
  mood_anxious:"Mood — anxious", mood_irritable:"Mood — irritable",
  mood_numb:"Mood — flat/numb", anxiety:"Anxiety", brain_fog:"Cognitive fog",
  sleep:"Sleep disturbance", appetite:"Appetite change", other:"Other",
};
const CRAVING_LABEL = {
  salty:"Salty", sweet:"Sweet", fatty:"Fatty", carbs:"Carbohydrate",
  chocolate:"Chocolate", spicy:"Spicy", protein:"Protein",
  cold:"Cold", sour:"Sour", other:"Other",
};
const PHASE_LABEL = {
  menstrual:"Menstrual", follicular:"Follicular", ovulation:"Ovulatory", luteal:"Luteal",
};
const FLOW_LABEL = { none:"None", spotting:"Spotting", light:"Light", medium:"Medium", heavy:"Heavy" };

const symLabel = (k) => SYMPTOM_LABEL[k] || titleCase(String(k).replace(/_/g, " "));
const cravingLabel = (k) => CRAVING_LABEL[k] || titleCase(String(k));
function titleCase(s){ return s.replace(/\b\w/g, (c) => c.toUpperCase()); }

function escapeHtml(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
function fmtDate(iso){ if (!iso) return "—"; return iso; }
function fmtDateTime(epochSec){
  if (!epochSec) return "—";
  const d = new Date(epochSec * 1000);
  return d.toLocaleString();
}
function num(v, digits = 0){ if (v == null || isNaN(v)) return "—"; return Number(v).toFixed(digits); }
function sevPill(s){
  const n = Math.max(1, Math.min(5, Math.round(s || 0)));
  return `<span class="sev-pill s${n}">${n}</span>`;
}

// --- date helpers ---------------------------------------------------------
function isoToday(){
  const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function isoDaysAgo(n){
  const d = new Date(); d.setDate(d.getDate() - n); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function setPreset(days){
  fromInput.value = isoDaysAgo(days - 1);
  toInput.value = isoToday();
  for (const b of document.querySelectorAll(".preset-btn")) {
    b.classList.toggle("active", +b.dataset.preset === days);
  }
}

// --- tiny markdown → safe HTML ---------------------------------------------
// Handles the subset the AI prompt asks for: H3, paragraphs, **bold**,
// *italic*, `code`, and bulleted lists. Everything else is escaped.
function mdToSafeHtml(md){
  if (!md) return "";
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inList = false, paraBuf = [];
  const flushPara = () => {
    if (!paraBuf.length) return;
    const p = paraBuf.join(" ").trim();
    if (p) out.push(`<p>${inline(p)}</p>`);
    paraBuf = [];
  };
  const flushList = () => { if (inList) { out.push("</ul>"); inList = false; } };
  const inline = (s) => {
    let safe = escapeHtml(s);
    safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");
    safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    safe = safe.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    return safe;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) { flushPara(); flushList(); out.push(`<h3>${inline(h3[1])}</h3>`); continue; }
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) { flushPara(); flushList(); out.push(`<h3>${inline(h2[1])}</h3>`); continue; }
    const li = line.match(/^[-*]\s+(.+)$/);
    if (li) { flushPara(); if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    paraBuf.push(line);
  }
  flushPara(); flushList();
  return out.join("\n");
}

// --- main render ----------------------------------------------------------
let lastReportData = null;

async function generateReport(){
  const from = fromInput.value || isoDaysAgo(89);
  const to   = toInput.value   || isoToday();
  doc.innerHTML = `<p class="report-empty">Building report…</p>`;

  let data;
  try {
    const r = await fetch(`/api/me/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { credentials: "same-origin" });
    if (!r.ok) throw new Error(await r.text());
    data = await r.json();
  } catch (err) {
    doc.innerHTML = `<p class="report-empty">Couldn't build the report: ${escapeHtml(err.message || err)}.</p>`;
    return;
  }
  lastReportData = data;
  doc.innerHTML = buildReportHtml(data);
  // Kick off the AI narrative in parallel — it streams in once ready.
  fetchClinicalNarrative(data);
  wireShowMore();
}

function buildReportHtml(d){
  const m = d.meta || {};
  const p = m.patient || {};
  const generated = m.generatedAt ? new Date(m.generatedAt * 1000).toLocaleString() : "—";

  return [
    letterhead(m, p, generated),
    narrativePlaceholder(),
    sectionSummary(d),
    sectionCycle(d),
    sectionSymptomFrequency(d),
    sectionBodyRegions(d),
    sectionSymptomLog(d),
    sectionDailyLogs(d),
    sectionMedications(d),
    sectionMedLogs(d),
    sectionFood(d),
    sectionCravings(d),
    sectionAppointments(d),
    sectionTestResults(d),
    sectionPatternWatch(d),
    reportFooter(generated),
  ].join("");
}

// --- letterhead -----------------------------------------------------------
function letterhead(m, p, generated){
  const memberSince = p.memberSince ? new Date(p.memberSince * 1000).toISOString().slice(0, 10) : null;
  return `
    <header class="report-header">
      <div>
        <h1>EndoMe Health Report</h1>
        <p class="subtitle">Patient-tracked summary for clinical review</p>
        <div class="report-meta-grid">
          <div><strong>Patient</strong><span>${escapeHtml(p.displayName || "—")}${p.alias && p.alias !== p.displayName ? ` (${escapeHtml(p.alias)})` : ""}</span></div>
          <div><strong>Endo status</strong><span>${escapeHtml(p.endoStatus || "not recorded")}${p.endoStage ? ` · ${escapeHtml(p.endoStage.replace(/_/g, " "))}` : ""}</span></div>
          <div><strong>Report range</strong><span>${escapeHtml(m.from)} → ${escapeHtml(m.to)}</span></div>
          <div><strong>Window</strong><span>${m.spanDays} day${m.spanDays === 1 ? "" : "s"}</span></div>
          ${memberSince ? `<div><strong>Member since</strong><span>${escapeHtml(memberSince)}</span></div>` : ""}
          ${p.timezone ? `<div><strong>Timezone</strong><span>${escapeHtml(p.timezone)}</span></div>` : ""}
          <div><strong>Generated</strong><span>${escapeHtml(generated)}</span></div>
        </div>
      </div>
      <div class="report-brand">
        <div class="brand-lockup">
          <img src="/logo-final.png" alt="" />
          <span>EndoMe</span>
        </div>
        <span class="brand-tag">endome.com · health report</span>
      </div>
    </header>
  `;
}

// --- AI narrative placeholder (filled in async) ---------------------------
function narrativePlaceholder(){
  return `
    <section class="report-narrative" id="report-narrative">
      <header>
        <h2>Clinical synopsis</h2>
        <span class="narrative-stamp">AI-assisted · <em>review before action</em></span>
      </header>
      <div class="narrative-body" id="narrative-body">
        <p class="narrative-loading">Drafting the clinician synopsis from the data above…</p>
      </div>
      <p class="narrative-disclaimer">This synopsis was generated by an AI clinical-assistant model from the patient's self-tracked EndoMe data over the report window. It is intended as a structured prompt for clinical discussion, not a diagnosis. Verify against the tables below and the patient's history before any clinical decision.</p>
    </section>
  `;
}

async function fetchClinicalNarrative(data){
  const body = $("#narrative-body");
  if (!body) return;
  try {
    const r = await fetch("/api/me/report/clinical-summary", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ report: data }),
    });
    const out = await r.json();
    if (!r.ok || !out.ok) {
      body.innerHTML = `<p class="narrative-error">Synopsis unavailable: ${escapeHtml(out.error || r.statusText)}. The tables below contain the full source data.</p>`;
      return;
    }
    body.innerHTML = mdToSafeHtml(out.summary);
  } catch (err) {
    body.innerHTML = `<p class="narrative-error">Synopsis unavailable: ${escapeHtml(err.message || String(err))}. The tables below contain the full source data.</p>`;
  }
}

// === SECTIONS =============================================================

function sectionSummary(d){
  const da = d.daily?.averages || {};
  const sym = d.symptoms || {};
  const food = d.food?.averages;
  return `
    <section class="report-section">
      <h2><span class="sec-ico">📋</span> At-a-glance</h2>
      <div class="kv-grid">
        <div><span>Days logged</span><strong>${num(da.daysLogged)}</strong><em>of ${d.meta.spanDays} in window</em></div>
        <div><span>Symptom entries</span><strong>${num(sym.total)}</strong><em>avg severity ${num(sym.avgSeverity, 1)} / 5</em></div>
        <div><span>Bleeding days</span><strong>${num(d.daily?.bleedingDays)}</strong><em>heaviest: ${escapeHtml(FLOW_LABEL[d.daily?.heaviestFlow] || "none")}</em></div>
        <div><span>Avg AM pain</span><strong>${num(da.avgPain, 1)}</strong><em>1–5 scale</em></div>
        <div><span>Avg energy</span><strong>${num(da.avgEnergy, 1)}</strong><em>1–5 scale</em></div>
        <div><span>Avg mood</span><strong>${num(da.avgMood, 1)}</strong><em>1–5 scale</em></div>
        <div><span>Avg sleep</span><strong>${num(da.avgSleepHours, 1)}</strong><em>hours/night</em></div>
        <div><span>Avg stress</span><strong>${num(da.avgStress, 1)}</strong><em>1–5 scale</em></div>
        ${food ? `<div><span>Avg kcal</span><strong>${num(food.avgCalories)}</strong><em>per day logged</em></div>` : ""}
      </div>
    </section>
  `;
}

function sectionCycle(d){
  const phases = d.daily?.phaseCounts || {};
  const total = Object.values(phases).reduce((a, b) => a + b, 0);
  if (!total && !d.daily?.bleedingDays) return emptySection("Cycle &amp; bleeding", "🌸", "No cycle data logged in this window.");
  const phaseOrder = ["menstrual","follicular","ovulation","luteal"];
  const bars = phaseOrder.map((k) => {
    const v = phases[k] || 0;
    const pct = total ? Math.round(v / total * 100) : 0;
    return `
      <div class="phase-bar" data-phase="${k}">
        <header><span>${escapeHtml(PHASE_LABEL[k])}</span><em>${v} d</em></header>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="phase-meta"><span>${pct}% of logged</span></div>
      </div>`;
  }).join("");
  return `
    <section class="report-section">
      <h2><span class="sec-ico">🌸</span> Cycle &amp; bleeding</h2>
      <p class="section-sub">Distribution of self-reported cycle phases and bleeding across the window.</p>
      <div class="phase-bars">${bars}</div>
      <div class="kv-grid">
        <div><span>Total bleeding days</span><strong>${num(d.daily?.bleedingDays)}</strong><em>any flow ≥ spotting</em></div>
        <div><span>Heaviest flow recorded</span><strong>${escapeHtml(FLOW_LABEL[d.daily?.heaviestFlow] || "None")}</strong></div>
        <div><span>Days with phase logged</span><strong>${total}</strong></div>
      </div>
    </section>
  `;
}

function sectionSymptomFrequency(d){
  const rows = d.symptoms?.byType || [];
  if (!rows.length) return emptySection("Symptom frequency", "📊", "No symptoms logged in this window.");
  const maxCount = Math.max(...rows.map((r) => r.count), 1);
  return `
    <section class="report-section">
      <h2><span class="sec-ico">📊</span> Symptom frequency</h2>
      <p class="section-sub">Ordered most-frequent first across the report window.</p>
      <table class="report-table">
        <thead><tr><th>Symptom</th><th>Frequency</th><th class="num">Avg sev</th><th class="num">Max</th><th>Last logged</th></tr></thead>
        <tbody>${rows.map((r) => {
          const pct = Math.round(r.count / maxCount * 100);
          return `
            <tr>
              <td><strong>${escapeHtml(symLabel(r.symptom))}</strong></td>
              <td>
                <div class="freq-cell">
                  <div class="freq-bar"><i style="width:${pct}%"></i></div>
                  <span class="freq-count">${r.count}</span>
                </div>
              </td>
              <td class="num">${num(r.avgSev, 1)}</td>
              <td class="num">${sevPill(r.maxSev)}</td>
              <td>${escapeHtml(fmtDate(r.lastDate))}</td>
            </tr>`;
        }).join("")}</tbody>
      </table>
    </section>
  `;
}

function sectionBodyRegions(d){
  const rows = d.symptoms?.byRegion || [];
  if (!rows.length) return "";
  const maxCount = Math.max(...rows.map((r) => r.count), 1);
  return `
    <section class="report-section">
      <h2><span class="sec-ico">🫀</span> Pain distribution by region</h2>
      <table class="report-table">
        <thead><tr><th>Region</th><th>Frequency</th><th class="num">Max severity</th></tr></thead>
        <tbody>${rows.map((r) => {
          const pct = Math.round(r.count / maxCount * 100);
          return `
            <tr>
              <td><strong>${escapeHtml(r.region)}</strong></td>
              <td>
                <div class="freq-cell">
                  <div class="freq-bar"><i style="width:${pct}%"></i></div>
                  <span class="freq-count">${r.count}</span>
                </div>
              </td>
              <td class="num">${sevPill(r.maxSev)}</td>
            </tr>`;
        }).join("")}</tbody>
      </table>
    </section>
  `;
}

function sectionSymptomLog(d){
  const rows = d.symptoms?.rows || [];
  if (!rows.length) return "";
  const limit = 25;
  return `
    <section class="report-section">
      <h2><span class="sec-ico">📝</span> Full symptom log</h2>
      <p class="section-sub">${rows.length} entries in the report window.</p>
      ${rows.length > limit ? `<button type="button" class="show-more-btn no-print" data-toggle="symptom-log">Show all ${rows.length} entries</button>` : ""}
      <table class="report-table${rows.length > limit ? " is-truncated" : ""}" id="table-symptom-log">
        <thead>
          <tr><th>Date</th><th>Symptom</th><th class="num">Sev</th><th>Location</th><th>Character</th><th>Triggers</th><th>Relief</th><th>Notes</th></tr>
        </thead>
        <tbody>${rows.map((r, i) => `
          <tr${i >= limit ? ' class="hidden-row"' : ""}>
            <td>${escapeHtml(r.log_date)}</td>
            <td>${escapeHtml(symLabel(r.symptom))}</td>
            <td class="num">${sevPill(r.severity)}</td>
            <td>${escapeHtml(r.location || "—")}</td>
            <td>${escapeHtml(r.pain_type || "—")}</td>
            <td>${escapeHtml(r.triggers || "—")}</td>
            <td>${escapeHtml(r.relief || "—")}</td>
            <td class="muted">${escapeHtml(r.notes || "")}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </section>
  `;
}

function sectionDailyLogs(d){
  const rows = d.daily?.rows || [];
  if (!rows.length) return emptySection("Daily check-ins", "🌅", "No check-ins logged.");
  const limit = 30;
  return `
    <section class="report-section">
      <h2><span class="sec-ico">🌅</span> Daily check-ins</h2>
      <p class="section-sub">${rows.length} day${rows.length === 1 ? "" : "s"} of paired morning + evening data.</p>
      ${rows.length > limit ? `<button type="button" class="show-more-btn no-print" data-toggle="daily-log">Show all ${rows.length} days</button>` : ""}
      <table class="report-table${rows.length > limit ? " is-truncated" : ""}" id="table-daily-log">
        <thead>
          <tr>
            <th>Date</th><th class="num">Pain</th><th class="num">Mood</th><th class="num">Energy</th>
            <th class="num">Sleep h</th><th class="num">Sleep Q</th><th class="num">Stress</th>
            <th class="num">Overall</th><th>Cycle</th><th>Flow</th><th class="num">Water</th>
          </tr>
        </thead>
        <tbody>${rows.map((r, i) => `
          <tr${i >= limit ? ' class="hidden-row"' : ""}>
            <td>${escapeHtml(r.log_date)}</td>
            <td class="num">${r.morning_pain != null ? sevPill(r.morning_pain) : "—"}</td>
            <td class="num">${r.morning_mood ?? "—"}</td>
            <td class="num">${r.morning_energy ?? "—"}</td>
            <td class="num">${r.morning_sleep_hours ?? "—"}</td>
            <td class="num">${r.morning_sleep_quality ?? "—"}</td>
            <td class="num">${r.stress_level ?? "—"}</td>
            <td class="num">${r.evening_overall ?? "—"}</td>
            <td>${r.cycle_day ? `d${r.cycle_day} · ${escapeHtml(PHASE_LABEL[r.cycle_phase] || r.cycle_phase || "")}` : "—"}</td>
            <td>${escapeHtml(FLOW_LABEL[r.flow] || r.flow || "—")}</td>
            <td class="num">${r.water_glasses ?? "—"}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </section>
  `;
}

function sectionMedications(d){
  const list = d.medications?.list || [];
  if (!list.length) return emptySection("Medications", "💊", "No medications recorded.");
  return `
    <section class="report-section">
      <h2><span class="sec-ico">💊</span> Medications on file</h2>
      <table class="report-table">
        <thead><tr><th>Name</th><th>Kind</th><th>Dose</th><th>Frequency</th><th>Brand</th><th>Status</th><th>Notes</th></tr></thead>
        <tbody>${list.map((m) => `
          <tr>
            <td><strong>${escapeHtml(m.name)}</strong></td>
            <td>${escapeHtml(m.kind || "—")}</td>
            <td>${escapeHtml(m.dose || "—")}</td>
            <td>${escapeHtml(m.frequency || "—")}</td>
            <td>${escapeHtml(m.brand || "—")}</td>
            <td>${m.is_active ? "Active" : "Inactive"}</td>
            <td class="muted">${escapeHtml(m.notes || "")}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </section>
  `;
}

function sectionMedLogs(d){
  const adh = d.medications?.adherence || [];
  const logs = d.medications?.logs || [];
  if (!adh.length && !logs.length) return "";
  const limit = 25;
  return `
    <section class="report-section">
      <h2><span class="sec-ico">📈</span> Medication adherence</h2>
      ${adh.length ? `
        <table class="report-table">
          <thead><tr><th>Medication</th><th class="num">Doses taken</th><th class="num">Missed</th><th class="num">Adherence</th><th>Last taken</th></tr></thead>
          <tbody>${adh.map((a) => {
            const total = a.taken + a.missed;
            const pct = total ? Math.round(a.taken / total * 100) : null;
            return `
              <tr>
                <td><strong>${escapeHtml(a.name)}</strong></td>
                <td class="num">${a.taken}</td>
                <td class="num">${a.missed}</td>
                <td class="num">${pct == null ? "—" : pct + "%"}</td>
                <td>${escapeHtml(fmtDateTime(a.lastTaken))}</td>
              </tr>`;
          }).join("")}
          </tbody>
        </table>` : ""}
      ${logs.length ? `
        <p class="section-sub" style="margin-top:14px">Full dose log — ${logs.length} entries.</p>
        ${logs.length > limit ? `<button type="button" class="show-more-btn no-print" data-toggle="med-log">Show all ${logs.length} entries</button>` : ""}
        <table class="report-table${logs.length > limit ? " is-truncated" : ""}" id="table-med-log">
          <thead><tr><th>When</th><th>Medication</th><th>Dose</th><th>Status</th><th>Notes</th></tr></thead>
          <tbody>${logs.map((l, i) => `
            <tr${i >= limit ? ' class="hidden-row"' : ""}>
              <td>${escapeHtml(fmtDateTime(l.taken_at))}</td>
              <td>${escapeHtml(l.med_name || "—")}</td>
              <td>${escapeHtml(l.dose_text || "—")}</td>
              <td>${escapeHtml(l.status || "taken")}</td>
              <td class="muted">${escapeHtml(l.notes || "")}</td>
            </tr>`).join("")}
          </tbody>
        </table>` : ""}
    </section>
  `;
}

function sectionFood(d){
  const avg = d.food?.averages;
  const rows = d.food?.rows || [];
  if (!avg && !rows.length) return "";
  return `
    <section class="report-section">
      <h2><span class="sec-ico">🥗</span> Nutrition</h2>
      ${avg ? `
        <div class="kv-grid">
          <div><span>Days logged</span><strong>${avg.daysLogged}</strong></div>
          <div><span>Avg energy</span><strong>${avg.avgCalories}</strong><em>kcal/day</em></div>
          <div><span>Avg protein</span><strong>${avg.avgProtein}</strong><em>g/day</em></div>
          <div><span>Avg carbs</span><strong>${avg.avgCarbs}</strong><em>g/day</em></div>
          <div><span>Avg fat</span><strong>${avg.avgFat}</strong><em>g/day</em></div>
          <div><span>Avg fibre</span><strong>${avg.avgFiber}</strong><em>g/day</em></div>
        </div>` : ""}
    </section>
  `;
}

function sectionCravings(d){
  const by = d.cravings?.byType || [];
  const rows = d.cravings?.rows || [];
  if (!rows.length) return "";
  const max = Math.max(...by.map((c) => c.count), 1);
  return `
    <section class="report-section">
      <h2><span class="sec-ico">🌙</span> Cravings</h2>
      <p class="section-sub">Often clustered in the luteal phase — useful for cycle correlation.</p>
      <table class="report-table">
        <thead><tr><th>Craving</th><th>Frequency</th></tr></thead>
        <tbody>${by.map((c) => {
          const pct = Math.round(c.count / max * 100);
          return `
            <tr>
              <td><strong>${escapeHtml(cravingLabel(c.craving))}</strong></td>
              <td>
                <div class="freq-cell">
                  <div class="freq-bar"><i style="width:${pct}%"></i></div>
                  <span class="freq-count">${c.count}</span>
                </div>
              </td>
            </tr>`;
        }).join("")}</tbody>
      </table>
    </section>
  `;
}

function sectionAppointments(d){
  const rows = d.appointments || [];
  if (!Array.isArray(rows) || !rows.length) return "";
  return `
    <section class="report-section">
      <h2><span class="sec-ico">📅</span> Appointments</h2>
      <table class="report-table">
        <thead><tr><th>When</th><th>Title</th><th>Kind</th><th>Clinician</th><th>Location</th><th>Notes</th></tr></thead>
        <tbody>${rows.map((a) => `
          <tr>
            <td>${escapeHtml(fmtDateTime(a.starts_at))}</td>
            <td><strong>${escapeHtml(a.title)}</strong></td>
            <td>${escapeHtml(a.kind || "—")}</td>
            <td>${escapeHtml(a.doctor || "—")}</td>
            <td>${escapeHtml(a.location || "—")}</td>
            <td class="muted">${escapeHtml(a.notes || "")}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </section>
  `;
}

function sectionTestResults(d){
  const rows = d.testResults || [];
  if (!Array.isArray(rows) || !rows.length) return "";
  return `
    <section class="report-section">
      <h2><span class="sec-ico">🧪</span> Tests &amp; results</h2>
      <table class="report-table">
        <thead><tr><th>When</th><th>Kind</th><th>Title</th><th>Summary</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td>${escapeHtml(fmtDateTime(r.assessed_at))}</td>
            <td>${escapeHtml((r.kind || "").toUpperCase())}</td>
            <td><strong>${escapeHtml(r.title)}</strong></td>
            <td class="muted">${escapeHtml(r.summary || "")}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </section>
  `;
}

function sectionPatternWatch(d){
  const pw = d.patternWatch;
  if (!pw || !pw.eligible || !pw.markers?.length) return "";
  return `
    <section class="report-section">
      <h2><span class="sec-ico">🔭</span> Endo-pattern markers</h2>
      <p class="section-sub">${pw.score} of 10 deterministic endo-pattern markers observed in the last ${pw.sample?.windowDays || 60} days. This is pattern recognition over self-reported data — not a diagnosis.</p>
      <table class="report-table">
        <thead><tr><th>Marker</th><th>Why it was flagged</th></tr></thead>
        <tbody>${pw.markers.map((m) => `
          <tr><td><strong>${escapeHtml(m.label)}</strong></td><td>${escapeHtml(m.why)}</td></tr>
        `).join("")}</tbody>
      </table>
    </section>
  `;
}

function emptySection(title, ico, msg){
  return `
    <section class="report-section">
      <h2><span class="sec-ico">${ico}</span> ${title}</h2>
      <div class="report-empty-section">${escapeHtml(msg)}</div>
    </section>`;
}

function reportFooter(generated){
  return `
    <footer class="report-footer">
      <div class="signature-block">
        <strong>Patient acknowledgement</strong><br>
        Signature: ______________________________ &nbsp; Date: ____________
      </div>
      <div class="signature-block">
        <strong>Clinician notes</strong><br>
        ___________________________________________________________________
      </div>
      <div style="flex:1 1 100%;text-align:center;margin-top:14px;font-size:10.5px;color:#7a5f6c">
        Generated by EndoMe · endome.com · ${escapeHtml(generated)} · Self-reported data over the selected window. Not a clinical record.
      </div>
    </footer>
  `;
}

// --- wire up --------------------------------------------------------------
function wireShowMore(){
  for (const btn of document.querySelectorAll(".show-more-btn")) {
    btn.addEventListener("click", () => {
      const key = btn.dataset.toggle;
      const table = document.getElementById(`table-${key}`);
      if (!table) return;
      table.classList.toggle("is-truncated");
      btn.textContent = table.classList.contains("is-truncated")
        ? btn.textContent.replace(/^Show fewer/, "Show all").replace(/^Showing all/, "Show all")
        : btn.textContent.replace(/^Show all\s+/, "Show fewer ");
    });
  }
}

document.addEventListener("click", (e) => {
  const preset = e.target.closest?.(".preset-btn");
  if (preset) { setPreset(+preset.dataset.preset); generateReport(); return; }
});
generate.addEventListener("click", generateReport);
printBtn.addEventListener("click", () => window.print());

setPreset(90);
window.addEventListener("DOMContentLoaded", () => {
  generateReport().finally(() => { if (loader) loader.style.display = "none"; });
});
