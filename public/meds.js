// /meds — manage user's medications, log doses, schedule weekly routine,
// react to other people's meds and see the community's top picks.
console.info("EndoMe meds build v3");

(() => {
  const FREQ_LABEL = {
    as_needed: "As needed",
    once_daily: "Once daily",
    twice_daily: "Twice daily",
    three_times_daily: "Three times daily",
    every_6h: "Every 6h",
    every_8h: "Every 8h",
    every_12h: "Every 12h",
    weekly: "Weekly",
    other: "Other",
  };
  const KIND_ICO = {
    medication: "💊", vitamin: "🌿", supplement: "🧴", herbal: "🍃",
  };
  const DAY_LABELS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

  let meds = [];
  let editingMedId = null;
  let editingSchedules = []; // local schedule list for the open modal
  let pendingDays = 0;       // bitmask of days chosen by the user in the modal

  const medModal = document.getElementById("med-modal");
  const logModal = document.getElementById("med-log-modal");

  (async () => {
    try {
      const me = await fetchJson("/api/me/today");
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = me?.user?.displayName || me?.user?.username || "there";
      });
    } catch {}
    await load();
    await loadTopPicks();
    document.getElementById("page-loader")?.classList.add("is-hidden");
  })();

  async function load() {
    try {
      const data = await fetchJson("/api/me/medications");
      meds = data.medications || [];
      renderMeds();
      await renderRecentLogs();
      await renderTimetable();
    } catch (err) {
      document.getElementById("med-list").innerHTML =
        `<li class="empty-state">${escapeHtml(err.message || "Couldn't load.")}</li>`;
    }
  }

  function renderMeds() {
    const el = document.getElementById("med-list");
    if (!meds.length) {
      el.innerHTML = `<li class="empty-state">No medications yet. Tap <strong>+ Add medication</strong> to start tracking.</li>`;
      return;
    }
    el.innerHTML = meds.map(medCard).join("");
  }

  function medCard(m) {
    const now = Math.floor(Date.now() / 1000);
    const okNow = !m.nextAllowedAt || now >= m.nextAllowedAt;
    const lastTaken = m.lastTakenAt ? relTime(m.lastTakenAt) : "never";
    const nextLabel = m.nextAllowedAt
      ? (okNow ? "✅ Available now" : `⏳ Next dose ${relTimeFuture(m.nextAllowedAt)}`)
      : "⚡ Take whenever needed";
    const c = m.community || { loves: 0, downs: 0, users: 0 };
    const mine = m.myReaction;
    return `<li class="med-card">
      <div class="med-card-head">
        <div class="med-card-icon">${KIND_ICO[m.kind] || "💊"}</div>
        <div class="med-card-title">
          <strong>${escapeHtml(m.name)}</strong>
          <span class="med-card-meta">${escapeHtml(m.dose || "—")} · ${escapeHtml(FREQ_LABEL[m.frequency] || m.frequency)}${m.brand ? " · " + escapeHtml(m.brand) : ""}</span>
        </div>
        <div class="med-card-status ${okNow ? "ok" : "wait"}">${nextLabel}</div>
      </div>
      ${m.notes ? `<p class="med-notes">${escapeHtml(m.notes)}</p>` : ""}
      ${schedSummary(m.schedules)}
      ${m.insight ? `<div class="med-insight"><span class="med-insight-tag">ℹ️ Why this</span><p>${escapeHtml(m.insight)}</p>${m.link ? `<a href="${escapeHtml(m.link)}" target="_blank" rel="noopener">More info →</a>` : ""}</div>` : (m.link ? `<a class="med-link" href="${escapeHtml(m.link)}" target="_blank" rel="noopener">Reference →</a>` : "")}
      <div class="med-community" data-name="${escapeHtml(m.name)}">
        <span class="med-community-stat">👥 ${c.users} ${c.users === 1 ? "person" : "people"} taking this</span>
        <div class="med-react">
          <button class="react-chip love ${mine === "love" ? "on" : ""}" data-react="love" data-name="${escapeHtml(m.name)}" aria-label="Love this medication">❤ <span>${c.loves}</span></button>
          <button class="react-chip down ${mine === "down" ? "on" : ""}" data-react="down" data-name="${escapeHtml(m.name)}" aria-label="Thumbs down">👎 <span>${c.downs}</span></button>
        </div>
      </div>
      <div class="med-card-foot">
        <span class="med-last">Last taken: ${lastTaken}</span>
        <div class="med-card-actions">
          <button class="btn btn-primary small" data-log="${m.id}" ${okNow ? "" : "disabled"}>Log dose</button>
          <button class="btn-soft small" data-edit="${m.id}">Edit</button>
          <button class="btn-soft small danger" data-delete="${m.id}">Remove</button>
        </div>
      </div>
    </li>`;
  }

  function schedSummary(schedules) {
    if (!schedules || !schedules.length) return "";
    const parts = schedules.slice(0, 4).map((s) => `${formatDays(s.daysMask)} · ${s.timeOfDay}`);
    const more = schedules.length > 4 ? ` +${schedules.length - 4} more` : "";
    return `<div class="med-sched-pill">📅 ${escapeHtml(parts.join(" · "))}${more}</div>`;
  }

  function formatDays(mask) {
    const all = mask === 127;
    if (all) return "Every day";
    const weekdays = mask === (2|4|8|16|32);
    if (weekdays) return "Weekdays";
    const weekend = mask === (1|64);
    if (weekend) return "Weekend";
    const out = [];
    for (let i = 0; i < 7; i++) if (mask & (1 << i)) out.push(DAY_LABELS[i]);
    return out.join("/");
  }

  async function renderRecentLogs() {
    // Pull logs for all meds + flatten. Cheap enough since most users have a handful.
    const all = [];
    for (const m of meds) {
      try {
        const data = await fetchJson(`/api/me/medications/${m.id}/logs`);
        (data.logs || []).slice(0, 20).forEach((l) => all.push({ ...l, medName: m.name, kind: m.kind }));
      } catch {}
    }
    all.sort((a, b) => b.taken_at - a.taken_at);
    const el = document.getElementById("med-log-list");
    const top = all.slice(0, 20);
    if (!top.length) { el.innerHTML = `<li class="empty-state">Nothing logged yet.</li>`; return; }
    el.innerHTML = top.map((l) => `
      <li class="med-log-row">
        <span class="med-log-ico">${KIND_ICO[l.kind] || "💊"}</span>
        <div class="med-log-info">
          <strong>${escapeHtml(l.medName)}</strong>
          <span class="med-log-meta">${l.dose_text ? escapeHtml(l.dose_text) + " · " : ""}${relTime(l.taken_at)}</span>
        </div>
        ${l.notes ? `<span class="med-log-note">${escapeHtml(l.notes)}</span>` : ""}
      </li>`).join("");
  }

  // --- Weekly timetable ---------------------------------------------------
  async function renderTimetable() {
    const tableEl = document.getElementById("timetable");
    const emptyEl = document.getElementById("timetable-empty");
    try {
      const data = await fetchJson("/api/me/medications/timetable");
      const slots = data.slots || [];
      const recent = data.recentLogs || [];
      if (!slots.length) {
        tableEl.innerHTML = "";
        emptyEl.hidden = false;
        return;
      }
      emptyEl.hidden = true;

      // Bucket slots into 7 day columns
      const days = [[],[],[],[],[],[],[]];
      slots.forEach((s) => {
        for (let i = 0; i < 7; i++) {
          if (s.daysMask & (1 << i)) days[i].push(s);
        }
      });
      // Sort each column by time
      days.forEach((col) => col.sort((a, b) => a.timeOfDay.localeCompare(b.timeOfDay)));

      const today = new Date().getDay();
      let html = "<thead><tr>";
      for (let i = 0; i < 7; i++) {
        const isToday = i === today;
        html += `<th class="${isToday ? "is-today" : ""}">${DAY_LABELS[i]}${isToday ? " · today" : ""}</th>`;
      }
      html += "</tr></thead><tbody><tr>";
      for (let i = 0; i < 7; i++) {
        const isToday = i === today;
        html += `<td class="${isToday ? "is-today" : ""}">`;
        if (!days[i].length) {
          html += `<div class="slot-empty">—</div>`;
        } else {
          html += days[i].map((s) => {
            const isPast = isToday && slotIsPastNow(s.timeOfDay);
            const takenToday = isToday && recentLogHitsSlot(recent, s.medicationId, s.timeOfDay);
            const cls = takenToday ? "taken" : (isPast ? "missed" : "");
            const checkmark = takenToday ? "✓ " : "";
            return `<div class="slot ${cls}" data-med="${s.medicationId}" data-time="${escapeHtml(s.timeOfDay)}" tabindex="0">
              <span class="slot-time">${escapeHtml(s.timeOfDay)}</span>
              <span class="slot-name">${checkmark}${KIND_ICO[s.kind] || "💊"} ${escapeHtml(s.name)}</span>
              ${s.dose ? `<span class="slot-dose">${escapeHtml(s.dose)}</span>` : ""}
            </div>`;
          }).join("");
        }
        html += `</td>`;
      }
      html += "</tr></tbody>";
      tableEl.innerHTML = html;

      // Wire slot clicks → confirm taken / skipped
      tableEl.querySelectorAll(".slot").forEach((sl) => {
        sl.addEventListener("click", () => onSlotClick(sl));
      });
    } catch {
      tableEl.innerHTML = "";
      emptyEl.hidden = false;
    }
  }

  function slotIsPastNow(timeOfDay) {
    const [h, m] = timeOfDay.split(":").map(Number);
    const d = new Date();
    return (d.getHours() > h) || (d.getHours() === h && d.getMinutes() > m + 5);
  }
  function recentLogHitsSlot(logs, medId, timeOfDay) {
    const [h, m] = timeOfDay.split(":").map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    const slotSec = Math.floor(d.getTime() / 1000);
    return logs.some((l) => l.medicationId === medId && Math.abs(l.takenAt - slotSec) < 3600 * 2);
  }
  async function onSlotClick(sl) {
    const medId = +sl.dataset.med;
    if (sl.classList.contains("taken")) {
      toast("Already logged for this slot", "ok");
      return;
    }
    const action = confirm("Did you take this dose?\n\nOK = Yes, log it.\nCancel = No, skip.");
    if (!action) {
      sl.classList.add("missed");
      toast("Skipped", "ok");
      return;
    }
    try {
      await fetchJson(`/api/me/medications/${medId}/log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doseText: null, notes: "Scheduled dose" }),
      });
      toast("Logged ✨", "ok");
      await load();
    } catch (err) {
      toast(err.message || "Couldn't log", "err");
    }
  }

  // --- Top picks sidebar -------------------------------------------------
  async function loadTopPicks() {
    try {
      const data = await fetchJson("/api/me/medications/top");
      paintTopPick("top-medication-body", data.medication);
      paintTopPick("top-vitamin-body", data.vitamin);
    } catch {}
  }
  function paintTopPick(elId, entry) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!entry) return; // keep the empty-state copy
    el.innerHTML = `
      <div class="top-pick-name">${KIND_ICO[entry.kind] || "💊"} <strong>${escapeHtml(entry.name)}</strong></div>
      <div class="top-pick-stats">
        <span class="tp-stat">❤ ${entry.loves}</span>
        <span class="tp-stat">👎 ${entry.downs}</span>
        <span class="tp-stat">👥 ${entry.users}</span>
      </div>
      <p class="top-pick-hint">Score based on community votes + how many people are taking it.</p>`;
  }

  // --- Add / Edit -------------------------------------------------------
  document.getElementById("btn-add-med").addEventListener("click", () => openMedModal(null));
  function openMedModal(m) {
    const form = document.getElementById("med-form");
    form.reset();
    form.id.value = m?.id || "";
    document.getElementById("med-modal-title").textContent = m ? "Edit medication" : "Add a medication";
    document.getElementById("med-status").textContent = "";
    editingMedId = m?.id || null;
    editingSchedules = m?.schedules ? [...m.schedules] : [];
    pendingDays = 0;
    if (m) {
      form.name.value = m.name || "";
      form.kind.value = m.kind || "medication";
      form.dose.value = m.dose || "";
      form.doseMg.value = m.doseMg != null ? m.doseMg : "";
      form.frequency.value = m.frequency || "as_needed";
      form.minHoursBetween.value = m.minHoursBetween != null ? m.minHoursBetween : "";
      form.brand.value = m.brand || "";
      form.link.value = m.link || "";
      form.notes.value = m.notes || "";
    }
    paintScheduleEditor();
    medModal.classList.add("open"); medModal.setAttribute("aria-hidden", "false");
  }
  function closeMedModal() { medModal.classList.remove("open"); medModal.setAttribute("aria-hidden", "true"); }

  function paintScheduleEditor() {
    const wrap = document.getElementById("med-schedule-editor");
    const list = document.getElementById("med-schedule-list");
    if (!wrap || !list) return;
    if (!editingMedId) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    if (!editingSchedules.length) {
      list.innerHTML = `<li class="med-schedule-empty">No recurring schedule yet. Pick days + a time below to add one.</li>`;
    } else {
      list.innerHTML = editingSchedules.map((s) => `
        <li class="med-schedule-row">
          <span class="sched-days">${escapeHtml(formatDays(s.daysMask))}</span>
          <span class="sched-time">${escapeHtml(s.timeOfDay)}</span>
          <button type="button" class="btn-soft small danger" data-del-sched="${s.id}">Remove</button>
        </li>`).join("");
    }
    // Reset day chips
    document.querySelectorAll(".dow-chip").forEach((b) => b.classList.toggle("on", (pendingDays & +b.dataset.day) !== 0));
  }

  // Day-of-week chip toggling
  document.querySelector("#dow-row").addEventListener("click", (e) => {
    const btn = e.target.closest(".dow-chip");
    if (!btn) return;
    e.preventDefault();
    const bit = +btn.dataset.day;
    pendingDays ^= bit;
    btn.classList.toggle("on", (pendingDays & bit) !== 0);
  });

  document.getElementById("sched-add").addEventListener("click", async () => {
    if (!editingMedId) return;
    const status = document.getElementById("sched-status");
    const time = document.getElementById("sched-time").value;
    status.textContent = "";
    status.className = "form-status";
    if (!pendingDays) { status.textContent = "Pick at least one day."; status.className = "form-status err"; return; }
    if (!time) { status.textContent = "Pick a time."; status.className = "form-status err"; return; }
    try {
      const res = await fetchJson(`/api/me/medications/${editingMedId}/schedules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ daysMask: pendingDays, timeOfDay: time }),
      });
      editingSchedules.push({ id: res.id, daysMask: pendingDays, timeOfDay: time });
      pendingDays = 0;
      document.getElementById("sched-time").value = "";
      paintScheduleEditor();
      toast("Schedule added", "ok");
      await renderTimetable();
    } catch (err) {
      status.textContent = err.message || "Couldn't save.";
      status.className = "form-status err";
    }
  });

  document.getElementById("med-schedule-list").addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del-sched]");
    if (!del || !editingMedId) return;
    const schedId = +del.dataset.delSched;
    try {
      await fetchJson(`/api/me/medications/${editingMedId}/schedules/${schedId}`, { method: "DELETE" });
      editingSchedules = editingSchedules.filter((s) => s.id !== schedId);
      paintScheduleEditor();
      toast("Schedule removed", "ok");
      await renderTimetable();
    } catch (err) { toast(err.message || "Couldn't remove", "err"); }
  });

  document.getElementById("med-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const id = form.id.value;
    const body = {
      name: form.name.value.trim(),
      kind: form.kind.value,
      dose: form.dose.value.trim() || null,
      doseMg: form.doseMg.value || null,
      frequency: form.frequency.value,
      minHoursBetween: form.minHoursBetween.value || null,
      brand: form.brand.value.trim() || null,
      link: form.link.value.trim() || null,
      notes: form.notes.value.trim() || null,
    };
    const status = document.getElementById("med-status");
    status.textContent = "Saving…"; status.className = "form-status";
    try {
      const res = await fetchJson(id ? `/api/me/medications/${id}` : "/api/me/medications", {
        method: id ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      toast(id ? "Medication updated" : "Medication added", "ok");
      // If we just created a new med, swap into edit mode so the user can add a schedule.
      if (!id && res.id) {
        await load();
        const created = meds.find((x) => x.id === res.id);
        if (created) openMedModal(created);
        return;
      }
      closeMedModal();
      await load();
    } catch (err) {
      status.textContent = err.message || "Couldn't save.";
      status.className = "form-status err";
    }
  });

  // --- Log / Edit / Delete / React actions ----------------------------------
  document.addEventListener("click", async (e) => {
    if (e.target.closest("[data-close-modal]")) {
      e.preventDefault();
      closeMedModal();
      logModal.classList.remove("open");
      return;
    }
    const log = e.target.closest("[data-log]");
    if (log) { openLogModal(+log.dataset.log); return; }
    const edit = e.target.closest("[data-edit]");
    if (edit) {
      const m = meds.find((x) => x.id === +edit.dataset.edit);
      if (m) openMedModal(m);
      return;
    }
    const del = e.target.closest("[data-delete]");
    if (del) {
      if (!confirm("Remove this medication from your list? Your dose history stays.")) return;
      try {
        await fetchJson(`/api/me/medications/${del.dataset.delete}`, { method: "DELETE" });
        toast("Removed", "ok");
        await load();
      } catch (err) { toast(err.message || "Couldn't remove", "err"); }
      return;
    }
    const react = e.target.closest("[data-react]");
    if (react) {
      e.preventDefault();
      const name = react.dataset.name;
      const wanted = react.dataset.react;
      // If already on, clear; otherwise switch to the chosen reaction.
      const reaction = react.classList.contains("on") ? null : wanted;
      try {
        const res = await fetchJson("/api/me/medications/react", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, reaction }),
        });
        // Update local state in place
        const target = meds.find((m) => m.name === name);
        if (target) {
          target.community = res.stats;
          target.myReaction = res.reaction;
          renderMeds();
        }
        // Also refresh the glossary item if it's expanded
        applyCommunityToGlossary({ [medKey(name)]: { stats: res.stats, mine: res.reaction } });
        await loadTopPicks();
      } catch (err) { toast(err.message || "Couldn't save reaction", "err"); }
      return;
    }
    const greact = e.target.closest("[data-greact]");
    if (greact) {
      e.preventDefault();
      const name = greact.dataset.name;
      const wanted = greact.dataset.greact;
      const reaction = greact.classList.contains("on") ? null : wanted;
      try {
        const res = await fetchJson("/api/me/medications/react", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, reaction }),
        });
        applyCommunityToGlossary({ [medKey(name)]: { stats: res.stats, mine: res.reaction } });
        // If user owns this med, also refresh card stats
        const target = meds.find((m) => m.name === name);
        if (target) { target.community = res.stats; target.myReaction = res.reaction; renderMeds(); }
        await loadTopPicks();
      } catch (err) { toast(err.message || "Couldn't save", "err"); }
      return;
    }
  });

  function openLogModal(id) {
    const m = meds.find((x) => x.id === id);
    if (!m) return;
    const form = document.getElementById("med-log-form");
    form.reset();
    form.id.value = id;
    document.getElementById("log-modal-title").textContent = `Log ${m.name}`;
    document.getElementById("log-modal-sub").textContent = m.dose
      ? `Default dose: ${m.dose}` : "";
    document.getElementById("log-status").textContent = "";
    logModal.classList.add("open"); logModal.setAttribute("aria-hidden", "false");
  }
  document.getElementById("med-log-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const id = form.id.value;
    const status = document.getElementById("log-status");
    status.textContent = "Logging…"; status.className = "form-status";
    try {
      await fetchJson(`/api/me/medications/${id}/log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          doseText: form.doseText.value.trim() || null,
          notes:    form.notes.value.trim() || null,
        }),
      });
      toast("Dose logged ✨", "ok");
      logModal.classList.remove("open");
      await load();
    } catch (err) {
      status.textContent = err.message || "Couldn't log.";
      status.className = "form-status err";
    }
  });

  // ====================================================================
  // CATALOG — autocomplete in the Add form + searchable glossary section
  // ====================================================================
  const catalog = Array.isArray(window.MED_CATALOG) ? window.MED_CATALOG : [];
  // Caches the latest community stats per med_key for glossary rendering
  const glossaryCommunity = {};

  // --- Autocomplete on the Name input -----------------------------------
  const nameInput  = document.getElementById("med-name-input");
  const acList     = document.getElementById("med-autocomplete");
  let acHover = -1;

  if (nameInput && acList) {
    nameInput.addEventListener("input", () => paintAutocomplete(nameInput.value.trim()));
    nameInput.addEventListener("focus", () => paintAutocomplete(nameInput.value.trim()));
    nameInput.addEventListener("keydown", (e) => {
      if (acList.hidden) return;
      const items = acList.querySelectorAll("li");
      if (e.key === "ArrowDown") { e.preventDefault(); acHover = Math.min(items.length - 1, acHover + 1); paintHover(items); }
      else if (e.key === "ArrowUp") { e.preventDefault(); acHover = Math.max(0, acHover - 1); paintHover(items); }
      else if (e.key === "Enter" && acHover >= 0) { e.preventDefault(); items[acHover]?.click(); }
      else if (e.key === "Escape") { acList.hidden = true; }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".med-autocomplete-wrap")) acList.hidden = true;
    });
  }

  function paintAutocomplete(query) {
    if (!acList) return;
    const q = query.toLowerCase();
    let matches;
    if (!q) {
      matches = catalog.filter((c) => ["Ibuprofen","Paracetamol","Magnesium","Vitamin D","Omega-3","Iron","NAC (N-Acetyl Cysteine)","PEA (Palmitoylethanolamide)","Dienogest","Slynd","Yaz","Levonorgestrel IUD"].includes(c.name));
    } else {
      matches = catalog.filter((c) =>
        c.name.toLowerCase().includes(q) ||
        (c.aliases || []).some((a) => a.toLowerCase().includes(q)) ||
        (c.category || "").toLowerCase().includes(q)
      );
    }
    matches = matches.slice(0, 10);
    acHover = -1;
    if (!matches.length) { acList.hidden = true; return; }
    acList.innerHTML = matches.map((m) => `
      <li data-name="${escapeHtml(m.name)}">
        <span class="ac-name">${escapeHtml(m.name)}</span>
        <span class="ac-meta">${escapeHtml(m.category || "")} · ${escapeHtml(m.kind)}</span>
      </li>`).join("");
    acList.querySelectorAll("li").forEach((li) => {
      li.addEventListener("click", () => applyCatalogEntry(catalog.find((c) => c.name === li.dataset.name)));
    });
    acList.hidden = false;
  }
  function paintHover(items) {
    items.forEach((it, i) => it.classList.toggle("is-hover", i === acHover));
  }

  function applyCatalogEntry(entry) {
    if (!entry) return;
    const form = document.getElementById("med-form");
    form.name.value = entry.name;
    form.kind.value = entry.kind || "medication";
    if (entry.defaultDose && !form.dose.value)        form.dose.value = entry.defaultDose;
    if (entry.defaultFreq && form.frequency)          form.frequency.value = entry.defaultFreq;
    if (entry.minHoursBetween != null && !form.minHoursBetween.value)
      form.minHoursBetween.value = entry.minHoursBetween;
    acList.hidden = true;
  }

  // --- Glossary section: filters + search list --------------------------
  const glossarySearch  = document.getElementById("glossary-search");
  const glossaryFilters = document.getElementById("glossary-filters");
  const glossaryList    = document.getElementById("glossary-list");
  let glossaryCategory = "All";

  if (glossaryFilters && glossaryList) {
    const cats = ["All", ...Array.from(new Set(catalog.map((c) => c.category || "Other")))];
    glossaryFilters.innerHTML = cats.map((c) =>
      `<button class="glossary-chip ${c === "All" ? "on" : ""}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join("");
    glossaryFilters.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-cat]");
      if (!chip) return;
      glossaryCategory = chip.dataset.cat;
      glossaryFilters.querySelectorAll(".glossary-chip").forEach((b) => b.classList.toggle("on", b === chip));
      renderGlossary();
    });
    glossarySearch.addEventListener("input", () => renderGlossary());
    renderGlossary();
  }

  function renderGlossary() {
    if (!glossaryList) return;
    const q = (glossarySearch.value || "").trim().toLowerCase();
    let items = catalog;
    if (glossaryCategory !== "All") items = items.filter((c) => (c.category || "Other") === glossaryCategory);
    if (q) items = items.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      (c.aliases || []).some((a) => a.toLowerCase().includes(q)) ||
      (c.summary || "").toLowerCase().includes(q));
    items = items.slice(0, 100);
    if (!items.length) {
      glossaryList.innerHTML = `<li class="empty-state">Nothing matches "${escapeHtml(glossarySearch.value || "")}".</li>`;
      return;
    }
    glossaryList.innerHTML = items.map(glossaryItem).join("");
    glossaryList.querySelectorAll("[data-add-from-glossary]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const entry = catalog.find((c) => c.name === btn.dataset.addFromGlossary);
        if (!entry) return;
        openMedModal(null);
        applyCatalogEntry(entry);
      });
    });
    // Toggle expand
    glossaryList.querySelectorAll(".glossary-item-head").forEach((head) => {
      head.addEventListener("click", () => head.parentElement.classList.toggle("is-open"));
    });
    // Lazy-load community stats for the visible items
    const names = items.map((c) => c.name);
    fetchCommunityStatsForGlossary(names);
  }

  async function fetchCommunityStatsForGlossary(names) {
    try {
      const data = await fetchJson("/api/me/medications/community", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ names }),
      });
      // Stash + paint
      const merged = {};
      for (const k of Object.keys(data.stats || {})) {
        merged[k] = { stats: data.stats[k], mine: (data.mine || {})[k] || null };
        glossaryCommunity[k] = merged[k];
      }
      applyCommunityToGlossary(merged);
    } catch {}
  }

  function applyCommunityToGlossary(byKey) {
    if (!glossaryList) return;
    for (const k of Object.keys(byKey)) {
      const wrap = glossaryList.querySelector(`[data-gcomm="${cssEscape(k)}"]`);
      if (!wrap) continue;
      const { stats, mine } = byKey[k];
      wrap.innerHTML = communityChipsHtml(wrap.dataset.gname, stats || {loves:0,downs:0,users:0}, mine);
    }
  }

  function communityChipsHtml(name, stats, mine) {
    return `
      <span class="med-community-stat">👥 ${stats.users || 0} taking this</span>
      <div class="med-react">
        <button class="react-chip love ${mine === "love" ? "on" : ""}" data-greact="love" data-name="${escapeHtml(name)}" aria-label="Love this">❤ <span>${stats.loves || 0}</span></button>
        <button class="react-chip down ${mine === "down" ? "on" : ""}" data-greact="down" data-name="${escapeHtml(name)}" aria-label="Thumbs down">👎 <span>${stats.downs || 0}</span></button>
      </div>`;
  }

  function glossaryItem(c) {
    const aliases = (c.aliases || []).slice(0, 4).join(", ");
    const KIND_ICO = { medication: "💊", vitamin: "🌿", supplement: "🧴", herbal: "🍃" };
    const k = medKey(c.name);
    const cached = glossaryCommunity[k];
    const chips = cached
      ? communityChipsHtml(c.name, cached.stats, cached.mine)
      : `<span class="med-community-stat">👥 –</span>
         <div class="med-react">
           <button class="react-chip love" data-greact="love" data-name="${escapeHtml(c.name)}">❤ <span>0</span></button>
           <button class="react-chip down" data-greact="down" data-name="${escapeHtml(c.name)}">👎 <span>0</span></button>
         </div>`;
    return `<li class="glossary-item">
      <div class="glossary-item-head" role="button" tabindex="0">
        <span class="glossary-ico">${KIND_ICO[c.kind] || "💊"}</span>
        <div class="glossary-info">
          <strong>${escapeHtml(c.name)}</strong>
          <span class="glossary-meta">${escapeHtml(c.category || "")} · ${escapeHtml(c.kind)}${aliases ? " · also: " + escapeHtml(aliases) : ""}</span>
        </div>
        <span class="glossary-toggle" aria-hidden="true">▾</span>
      </div>
      <div class="glossary-body">
        <p>${escapeHtml(c.summary || "")}</p>
        <div class="glossary-row">
          ${c.defaultDose ? `<span class="glossary-pill">Default: ${escapeHtml(c.defaultDose)}</span>` : ""}
          ${c.defaultFreq ? `<span class="glossary-pill">${escapeHtml(FREQ_LABEL[c.defaultFreq] || c.defaultFreq)}</span>` : ""}
          ${c.minHoursBetween != null ? `<span class="glossary-pill">Min ${c.minHoursBetween}h between</span>` : ""}
        </div>
        <div class="med-community glossary-community" data-gcomm="${escapeHtml(k)}" data-gname="${escapeHtml(c.name)}">${chips}</div>
        <button class="btn btn-primary small" data-add-from-glossary="${escapeHtml(c.name)}">+ Add to my list</button>
      </div>
    </li>`;
  }

  // --- Helpers ---------------------------------------------------------
  async function fetchJson(url, init = {}) {
    const res = await fetch(url, { credentials: "same-origin", ...init });
    if (res.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
    let payload = {};
    try { payload = await res.json(); } catch {}
    if (!res.ok) throw new Error(payload.error || `Request failed (${res.status})`);
    return payload;
  }
  function escapeHtml(s) {
    return String(s ?? "").replace(/[<>&"']/g, (c) => ({
      "<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&#39;",
    })[c]);
  }
  function cssEscape(s) {
    return String(s).replace(/["\\]/g, (c) => "\\" + c);
  }
  function medKey(s) {
    return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  }
  function relTime(unixSec) {
    if (!unixSec) return "never";
    const diff = Math.floor(Date.now() / 1000) - unixSec;
    if (diff < 60)    return "just now";
    if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }
  function relTimeFuture(unixSec) {
    const diff = unixSec - Math.floor(Date.now() / 1000);
    if (diff <= 60)   return "in a moment";
    if (diff < 3600)  return `in ${Math.ceil(diff / 60)} min`;
    if (diff < 86400) return `in ${Math.ceil(diff / 3600)}h`;
    return `in ${Math.ceil(diff / 86400)}d`;
  }
  function toast(text, tone = "ok") {
    const stack = document.getElementById("toast-stack");
    if (!stack) return;
    const t = document.createElement("div");
    t.className = `toast toast-${tone}`;
    t.textContent = text;
    stack.appendChild(t);
    requestAnimationFrame(() => t.classList.add("in"));
    setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 250); }, 2400);
  }
})();
