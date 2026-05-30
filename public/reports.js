/* /reports — generates a clinician-ready printable summary from
   /api/me/report. All rendering happens client-side so the user can
   tweak the date range and re-print without round-trips. */

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
  spotting:"Spotting", painful_urination:"Painful urination",
  painful_bowel:"Painful bowel movement", painful_sex:"Dyspareunia (painful sex)",
  mood_happy:"Mood — happy", mood_sad:"Mood — sad", mood_angry:"Mood — angry",
  mood_anxious:"Mood — anxious", mood_irritable:"Mood — irritable",
  mood_numb:"Mood — numb", anxiety:"Anxiety", brain_fog:"Brain fog",
  sleep:"Sleep issue", appetite:"Appetite change", other:"Other",
};
const CRAVING_LABEL = {
  salty:"Salty", sweet:"Sweet", fatty:"Fatty", carbs:"Carbs",
  chocolate:"Chocolate", spicy:"Spicy", protein:"Protein",
  cold:"Cold", sour:"Sour", other:"Other",
};
const PHASE_LABEL = {
  menstrual:"Menstrual", follicular:"Follicular", ovulation:"Ovulation", luteal:"Luteal",
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

// --- main render ----------------------------------------------------------
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
  doc.innerHTML = buildReportHtml(data);
}

function buildReportHtml(d){
  const m = d.meta || {};
  const p = m.patient || {};
  const generated = m.generatedAt ? new Date(m.generatedAt * 1000).toLocaleString() : "—";

  const parts = [];
  parts.push(`
    <header class="report-header">
      <div>
        <h1>EndoMe Health Report</h1>
        <div class="meta">
          <div><strong>Patient:</strong> ${escapeHtml(p.displayName || "—")}${p.alias && p.alias !== p.displayName ? ` (${escapeHtml(p.alias)})` : ""}</div>
          <div><strong>Endometriosis status:</strong> ${escapeHtml(p.endoStatus || "not recorded")}${p.endoStage ? ` · ${escapeHtml(p.endoStage.replace(/_/g, " "))}` : ""}</div>
          ${p.memberSince ? `<div><strong>EndoMe member since:</strong> ${escapeHtml(new Date(p.memberSince * 1000).toISOString().slice(0,10))}</div>` : ""}
          ${p.timezone ? `<div><strong>Timezone:</strong> ${escapeHtml(p.timezone)}</div>` : ""}
          <div><strong>Report range:</strong> ${escapeHtml(m.from)} → ${escapeHtml(m.to)} (${m.spanDays} day${m.spanDays === 1 ? "" : "s"})</div>
          <div><strong>Generated:</strong> ${escapeHtml(generated)}</div>
        </div>
      </div>
      <div class="report-brand">
        <img src="/logo-final.png" alt="" />
        <span>EndoMe</span>
      </div>
    </header>
  `);

  parts.push(sectionSummary(d));
  parts.push(sectionCycle(d));
  parts.push(sectionSymptomFrequency(d));
  parts.push(sectionBodyRegions(d));
  parts.push(sectionSymptomLog(d));
  parts.push(sectionDailyLogs(d));
  parts.push(sectionMedications(d));
  parts.push(sectionMedLogs(d));
  parts.push(sectionFood(d));
  parts.push(sectionCravings(d));
  parts.push(sectionAppointments(d));
  parts.push(sectionTestResults(d));
  parts.push(sectionPatternWatch(d));

  parts.push(`
    <footer class="report-footer">
      <p>This report was generated from data the patient self-tracked in EndoMe over the selected window. It is not a diagnosis and is intended to support — not replace — a clinical assessment.</p>
      <p>EndoMe · endome.com</p>
    </footer>
  `);

  return parts.join("");
}

// === SECTIONS =============================================================

function sectionSummary(d){
  const da = d.daily?.averages || {};
  const sym = d.symptoms || {};
  const food = d.food?.averages;
  return `
    <section class="report-section">
      <h2>At-a-glance summary</h2>
      <div class="kv-grid">
        <div><span>Days logged</span><strong>${num(da.daysLogged)}</strong></div>
        <div><span>Symptoms recorded</span><strong>${num(sym.total)}</strong><em>avg severity ${num(sym.avgSeverity, 1)}</em></div>
        <div><span>Bleeding days</span><strong>${num(d.daily?.bleedingDays)}</strong><em>heaviest: ${escapeHtml(FLOW_LABEL[d.daily?.heaviestFlow] || "none")}</em></div>
        <div><span>Avg morning pain</span><strong>${num(da.avgPain, 1)}</strong><em>1–5 scale</em></div>
        <div><span>Avg energy</span><strong>${num(da.avgEnergy, 1)}</strong></div>
        <div><span>Avg mood</span><strong>${num(da.avgMood, 1)}</strong></div>
        <div><span>Avg sleep</span><strong>${num(da.avgSleepHours, 1)}</strong><em>hours</em></div>
        <div><span>Avg stress</span><strong>${num(da.avgStress, 1)}</strong></div>
        ${food ? `<div><span>Avg calories</span><strong>${num(food.avgCalories)}</strong><em>kcal/day</em></div>` : ""}
      </div>
    </section>
  `;
}

function sectionCycle(d){
  const phases = d.daily?.phaseCounts || {};
  const total = Object.values(phases).reduce((a, b) => a + b, 0);
  if (!total && !d.daily?.bleedingDays) return emptySection("Cycle", "No cycle data logged in this window.");
  const phaseRows = Object.entries(phases).map(([k, v]) => `
    <tr>
      <td>${escapeHtml(PHASE_LABEL[k] || k)}</td>
      <td class="num">${v}</td>
      <td class="num">${total ? Math.round(v / total * 100) : 0}%</td>
    </tr>`).join("");
  return `
    <section class="report-section">
      <h2>Cycle &amp; bleeding</h2>
      <p class="section-sub">Distribution of cycle phases and bleeding days across the window.</p>
      <table class="report-table">
        <thead><tr><th>Phase</th><th class="num">Days</th><th class="num">% of logged days</th></tr></thead>
        <tbody>${phaseRows || `<tr><td colspan="3" class="muted">No phase logged</td></tr>`}</tbody>
      </table>
      <div class="kv-grid">
        <div><span>Total bleeding days</span><strong>${num(d.daily?.bleedingDays)}</strong></div>
        <div><span>Heaviest flow</span><strong>${escapeHtml(FLOW_LABEL[d.daily?.heaviestFlow] || "None")}</strong></div>
      </div>
    </section>
  `;
}

function sectionSymptomFrequency(d){
  const rows = d.symptoms?.byType || [];
  if (!rows.length) return emptySection("Symptom frequency", "No symptoms logged in this window.");
  return `
    <section class="report-section">
      <h2>Symptom frequency (most → least)</h2>
      <table class="report-table">
        <thead><tr><th>Symptom</th><th class="num">Count</th><th class="num">Avg severity</th><th class="num">Max</th><th>Last logged</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td>${escapeHtml(symLabel(r.symptom))}</td>
            <td class="num">${r.count}</td>
            <td class="num">${num(r.avgSev, 1)}</td>
            <td class="num">${sevPill(r.maxSev)}</td>
            <td>${escapeHtml(fmtDate(r.lastDate))}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </section>
  `;
}

function sectionBodyRegions(d){
  const rows = d.symptoms?.byRegion || [];
  if (!rows.length) return emptySection("Pain by body region", "No region data captured.");
  return `
    <section class="report-section">
      <h2>Pain by body region</h2>
      <table class="report-table">
        <thead><tr><th>Region</th><th class="num">Count</th><th class="num">Max severity</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr><td>${escapeHtml(r.region)}</td><td class="num">${r.count}</td><td class="num">${sevPill(r.maxSev)}</td></tr>
        `).join("")}</tbody>
      </table>
    </section>
  `;
}

function sectionSymptomLog(d){
  const rows = d.symptoms?.rows || [];
  if (!rows.length) return "";
  return `
    <section class="report-section">
      <h2>Full symptom log</h2>
      <p class="section-sub">${rows.length} entries.</p>
      <table class="report-table">
        <thead>
          <tr><th>Date</th><th>Symptom</th><th class="num">Sev</th><th>Location</th><th>Pain type</th><th>Triggers</th><th>Relief</th><th>Notes</th></tr>
        </thead>
        <tbody>${rows.map((r) => `
          <tr>
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
  if (!rows.length) return emptySection("Daily check-ins", "No check-ins logged.");
  return `
    <section class="report-section">
      <h2>Daily check-ins</h2>
      <p class="section-sub">${rows.length} day${rows.length === 1 ? "" : "s"} of logged data.</p>
      <table class="report-table">
        <thead>
          <tr>
            <th>Date</th><th class="num">Pain</th><th class="num">Mood</th><th class="num">Energy</th>
            <th class="num">Sleep h</th><th class="num">Sleep Q</th><th class="num">Stress</th>
            <th class="num">Overall</th><th>Cycle</th><th>Flow</th><th class="num">Water</th>
          </tr>
        </thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td>${escapeHtml(r.log_date)}</td>
            <td class="num">${r.morning_pain ?? "—"}</td>
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
  if (!list.length) return emptySection("Medications", "No medications recorded.");
  return `
    <section class="report-section">
      <h2>Medications</h2>
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
  return `
    <section class="report-section">
      <h2>Medication adherence &amp; log</h2>
      ${adh.length ? `
        <table class="report-table">
          <thead><tr><th>Medication</th><th class="num">Doses taken</th><th class="num">Missed</th><th>Last taken</th></tr></thead>
          <tbody>${adh.map((a) => `
            <tr>
              <td><strong>${escapeHtml(a.name)}</strong></td>
              <td class="num">${a.taken}</td>
              <td class="num">${a.missed}</td>
              <td>${escapeHtml(fmtDateTime(a.lastTaken))}</td>
            </tr>`).join("")}
          </tbody>
        </table>` : ""}
      ${logs.length ? `
        <p class="section-sub" style="margin-top:14px">Full dose log (${logs.length} entries).</p>
        <table class="report-table">
          <thead><tr><th>When</th><th>Medication</th><th>Dose</th><th>Status</th><th>Notes</th></tr></thead>
          <tbody>${logs.map((l) => `
            <tr>
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
  if (!avg && !rows.length) return emptySection("Nutrition", "No food logged.");
  return `
    <section class="report-section">
      <h2>Nutrition</h2>
      ${avg ? `
        <div class="kv-grid">
          <div><span>Days logged</span><strong>${avg.daysLogged}</strong></div>
          <div><span>Avg calories</span><strong>${avg.avgCalories}</strong><em>kcal/day</em></div>
          <div><span>Avg protein</span><strong>${avg.avgProtein}</strong><em>g</em></div>
          <div><span>Avg carbs</span><strong>${avg.avgCarbs}</strong><em>g</em></div>
          <div><span>Avg fat</span><strong>${avg.avgFat}</strong><em>g</em></div>
          <div><span>Avg fiber</span><strong>${avg.avgFiber}</strong><em>g</em></div>
        </div>` : ""}
      ${rows.length ? `
        <p class="section-sub">Most recent ${Math.min(rows.length, 60)} entries.</p>
        <table class="report-table">
          <thead><tr><th>Date</th><th>Meal</th><th>Item</th><th class="num">Servings</th><th class="num">kcal</th><th class="num">P</th><th class="num">C</th><th class="num">F</th></tr></thead>
          <tbody>${rows.slice(0, 60).map((r) => `
            <tr>
              <td>${escapeHtml(r.log_date)}</td>
              <td>${escapeHtml(titleCase(r.meal || ""))}</td>
              <td>${escapeHtml(r.name)}</td>
              <td class="num">${num(r.servings, 1)}</td>
              <td class="num">${num((r.calories || 0) * (r.servings || 1))}</td>
              <td class="num">${num((r.protein_g || 0) * (r.servings || 1), 1)}</td>
              <td class="num">${num((r.carbs_g || 0) * (r.servings || 1), 1)}</td>
              <td class="num">${num((r.fat_g || 0) * (r.servings || 1), 1)}</td>
            </tr>`).join("")}
          </tbody>
        </table>` : ""}
    </section>
  `;
}

function sectionCravings(d){
  const by = d.cravings?.byType || [];
  const rows = d.cravings?.rows || [];
  if (!rows.length) return "";
  return `
    <section class="report-section">
      <h2>Cravings</h2>
      <table class="report-table">
        <thead><tr><th>Craving</th><th class="num">Count</th></tr></thead>
        <tbody>${by.map((c) => `
          <tr><td>${escapeHtml(cravingLabel(c.craving))}</td><td class="num">${c.count}</td></tr>
        `).join("")}</tbody>
      </table>
    </section>
  `;
}

function sectionAppointments(d){
  const rows = d.appointments || [];
  if (!Array.isArray(rows) || !rows.length) return emptySection("Appointments", "No appointments in this window.");
  return `
    <section class="report-section">
      <h2>Appointments</h2>
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
  if (!Array.isArray(rows) || !rows.length) return emptySection("Tests &amp; results", "No test results in this window.");
  return `
    <section class="report-section">
      <h2>Tests &amp; results</h2>
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
      <h2>Endo-pattern markers</h2>
      <p class="section-sub">${pw.score} of 10 endo-pattern markers observed in the last ${pw.sample?.windowDays || 60} days. This is pattern recognition, not a diagnosis.</p>
      <table class="report-table">
        <thead><tr><th>Marker</th><th>Why it was flagged</th></tr></thead>
        <tbody>${pw.markers.map((m) => `
          <tr><td><strong>${escapeHtml(m.label)}</strong></td><td>${escapeHtml(m.why)}</td></tr>
        `).join("")}</tbody>
      </table>
    </section>
  `;
}

function emptySection(title, msg){
  return `
    <section class="report-section">
      <h2>${title}</h2>
      <div class="report-empty-section">${escapeHtml(msg)}</div>
    </section>`;
}

// --- wire up --------------------------------------------------------------
document.addEventListener("click", (e) => {
  const preset = e.target.closest?.(".preset-btn");
  if (preset) { setPreset(+preset.dataset.preset); generateReport(); return; }
});
generate.addEventListener("click", generateReport);
printBtn.addEventListener("click", () => window.print());

// Init: 90d preset, fetch immediately so the user sees content.
setPreset(90);
window.addEventListener("DOMContentLoaded", () => {
  generateReport().finally(() => { if (loader) loader.style.display = "none"; });
});
