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

  // ------------------------------------------------------------------
  // Sub-nav: My routine / Recent doses / Glossary
  // Each tab pill toggles visibility on its [data-tab] sibling section.
  // ------------------------------------------------------------------
  document.querySelectorAll(".subnav-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tabTarget;
      document.querySelectorAll(".subnav-tab").forEach((t) => {
        const on = t === tab;
        t.classList.toggle("on", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      document.querySelectorAll("[data-tab]").forEach((p) => {
        p.hidden = p.dataset.tab !== target;
      });
      // Scroll to top of the page-subnav so the user sees the start of the
      // tab they just switched to, not the middle of a long list.
      document.querySelector(".page-subnav")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

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
    // If the med has recurring schedules, the meta line should reflect that
    // ("Mon–Sun · 17:30") instead of the raw frequency enum ("As needed").
    // The 📅 pill below still shows the full schedule list for >1 entry.
    const hasSchedule = m.schedules && m.schedules.length;
    const cadenceLabel = hasSchedule
      ? `${formatDays(m.schedules[0].daysMask)} · ${m.schedules[0].timeOfDay}${m.schedules.length > 1 ? ` +${m.schedules.length - 1} more` : ""}`
      : (FREQ_LABEL[m.frequency] || m.frequency);
    // Replace the eligibility badge for scheduled meds — "Take whenever
    // needed" makes no sense once a dose time is set. Show next pending
    // slot today (or 'Tomorrow') and lean on the doses-due banner for
    // actual taken/missed marking.
    const scheduledBadge = hasSchedule ? nextScheduledLabel(m.schedules) : null;
    return `<li class="med-card">
      <div class="med-card-head">
        <div class="med-card-icon">${KIND_ICO[m.kind] || "💊"}</div>
        <div class="med-card-title">
          <strong>${escapeHtml(m.name)}</strong>
          <span class="med-card-meta">${escapeHtml(m.dose || "—")} · ${escapeHtml(cadenceLabel)}${m.brand ? " · " + escapeHtml(m.brand) : ""}</span>
        </div>
        <div class="med-card-status ${scheduledBadge ? "ok" : (okNow ? "ok" : "wait")}">${scheduledBadge || nextLabel}</div>
      </div>
      ${m.notes ? `<p class="med-notes">${escapeHtml(m.notes)}</p>` : ""}
      ${m.schedules && m.schedules.length > 1 ? schedSummary(m.schedules) : ""}
      ${m.insight ? `<div class="med-insight"><span class="med-insight-tag">ℹ️ Why this</span><p>${escapeHtml(m.insight)}</p>${m.link ? `<a href="${escapeHtml(m.link)}" target="_blank" rel="noopener">More info →</a>` : ""}</div>` : (m.link ? `<a class="med-link" href="${escapeHtml(m.link)}" target="_blank" rel="noopener">Reference →</a>` : "")}
      <div class="med-community" data-name="${escapeHtml(m.name)}">
        <span class="med-community-stat" data-tip="${c.users} ${c.users === 1 ? "person is" : "people are"} currently tracking this med on EndoMe">👥 ${c.users} ${c.users === 1 ? "person" : "people"} taking this</span>
        <div class="med-react">
          <button class="react-chip love ${mine === "love" ? "on" : ""}" data-react="love" data-name="${escapeHtml(m.name)}" aria-label="Love this medication" data-tip="${c.loves} ${c.loves === 1 ? "EndoMe user loves" : "EndoMe users love"} this — tap to add yours">❤ <span>${c.loves}</span></button>
          <button class="react-chip down ${mine === "down" ? "on" : ""}" data-react="down" data-name="${escapeHtml(m.name)}" aria-label="Thumbs down" data-tip="${c.downs === 0 ? "No one's flagged this — tap if it didn't work for you (comment required)" : c.downs + " " + (c.downs === 1 ? "person" : "people") + " flagged this as unhelpful"}">👎 <span>${c.downs}</span></button>
        </div>
      </div>
      ${downCommentsHtml(c.downComments)}
      <div class="med-card-foot">
        <span class="med-last">Last taken: ${lastTaken}</span>
        <div class="med-card-actions">
          <button class="btn btn-primary small" data-log="${m.id}" ${okNow || (m.schedules && m.schedules.length) ? "" : "disabled"}>Log dose</button>
          <button class="btn-soft small" data-edit="${m.id}">Edit</button>
          <button class="btn-soft small danger" data-delete="${m.id}">Remove</button>
        </div>
      </div>
    </li>`;
  }

  function downCommentsHtml(comments) {
    if (!comments || !comments.length) return "";
    const top = comments.slice(0, 3);
    return `<details class="med-down-feedback">
      <summary>👎 ${comments.length} ${comments.length === 1 ? "comment" : "comments"} from the community</summary>
      <ul class="med-down-list">
        ${top.map((c) => `<li>
          <span class="med-down-text">"${escapeHtml(c.comment)}"</span>
          <span class="med-down-date">${relTime(c.createdAt)}</span>
        </li>`).join("")}
        ${comments.length > top.length ? `<li class="med-down-more">+ ${comments.length - top.length} more</li>` : ""}
      </ul>
    </details>`;
  }

  function schedSummary(schedules) {
    if (!schedules || !schedules.length) return "";
    const parts = schedules.slice(0, 4).map((s) => `${formatDays(s.daysMask)} · ${s.timeOfDay}`);
    const more = schedules.length > 4 ? ` +${schedules.length - 4} more` : "";
    return `<div class="med-sched-pill">📅 ${escapeHtml(parts.join(" · "))}${more}</div>`;
  }

  // Walks the user's schedules and returns the label for the next slot —
  // either "📅 Today at 17:30" or "📅 Tomorrow at 08:00". Used on the med
  // card badge instead of the eligibility-only "Take whenever needed".
  function nextScheduledLabel(schedules) {
    if (!schedules?.length) return null;
    const now = new Date();
    const todayBit = 1 << now.getDay();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    // Today's remaining slots first.
    let best = null;
    for (const s of schedules) {
      if (!(s.daysMask & todayBit)) continue;
      const [h, m] = String(s.timeOfDay).split(":").map((n) => +n);
      const slotMin = h * 60 + (m || 0);
      if (slotMin >= nowMin && (best == null || slotMin < best)) best = slotMin;
    }
    if (best != null) {
      const hh = String(Math.floor(best / 60)).padStart(2, "0");
      const mm = String(best % 60).padStart(2, "0");
      return `📅 Today at ${hh}:${mm}`;
    }
    // Otherwise look for the next day with a slot.
    for (let i = 1; i <= 7; i++) {
      const bit = 1 << ((now.getDay() + i) % 7);
      const matches = schedules.filter((s) => s.daysMask & bit);
      if (!matches.length) continue;
      const earliest = matches.map((s) => s.timeOfDay).sort()[0];
      const day = i === 1 ? "Tomorrow" : ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][(now.getDay() + i) % 7];
      return `📅 ${day} at ${earliest}`;
    }
    return null;
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
  // Render order is Monday → Sunday so the working week reads left-to-right.
  // Day bits stay Sun=1, Mon=2, ..., Sat=64 (legacy of `Date.getDay()`).
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon, Tue, Wed, Thu, Fri, Sat, Sun
  const DAY_NAMES_LONG = { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" };

  async function renderTimetable() {
    const tableEl = document.getElementById("timetable");
    const emptyHintEl = document.getElementById("timetable-empty");
    let slots = [];
    let recent = [];
    let hasAny = false;
    try {
      const data = await fetchJson("/api/me/medications/timetable");
      slots = data.slots || [];
      recent = data.recentLogs || [];
      hasAny = slots.length > 0;
    } catch {}

    // Always render the full Mon→Sun grid, even when empty, so the page
    // shows the skeleton of the week as a placeholder.
    if (emptyHintEl) emptyHintEl.hidden = hasAny;

    const days = { 0:[],1:[],2:[],3:[],4:[],5:[],6:[] };
    slots.forEach((s) => {
      for (let i = 0; i < 7; i++) {
        if (s.daysMask & (1 << i)) days[i].push(s);
      }
    });
    for (const k of Object.keys(days)) days[k].sort((a, b) => a.timeOfDay.localeCompare(b.timeOfDay));

    const today = new Date().getDay();
    let html = "<thead><tr>";
    for (const i of DAY_ORDER) {
      const isToday = i === today;
      html += `<th class="${isToday ? "is-today" : ""}">${DAY_NAMES_LONG[i]}${isToday ? " · today" : ""}</th>`;
    }
    html += "</tr></thead><tbody><tr>";
    for (const i of DAY_ORDER) {
      const isToday = i === today;
      const dayBit = 1 << i;
      html += `<td class="${isToday ? "is-today" : ""}" data-daybit="${dayBit}">`;
      if (!days[i].length) {
        html += `<button type="button" class="slot-empty slot-empty-add" data-add-day="${dayBit}">
          <span class="slot-empty-plus" aria-hidden="true">+</span>
          <span class="slot-empty-label">Add a dose</span>
        </button>`;
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
        html += `<button type="button" class="slot-add-more" data-add-day="${dayBit}" aria-label="Add another dose to this day">+ Add</button>`;
      }
      html += `</td>`;
    }
    html += "</tr></tbody>";
    tableEl.innerHTML = html;

    // Wire slot clicks → confirm taken / skipped
    tableEl.querySelectorAll(".slot").forEach((sl) => {
      sl.addEventListener("click", () => onSlotClick(sl));
    });
    // Empty-slot clicks open the add-medication modal with this day preselected
    tableEl.querySelectorAll("[data-add-day]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const bit = +btn.dataset.addDay || 0;
        startQuickScheduleAdd(bit);
      });
    });
  }

  // Called when an empty timetable cell is tapped. Pops the add-medication
  // modal pre-tuned for "I want to schedule this". If the user already has
  // medications, we drop them into a small chooser first so they can either
  // (a) attach a schedule to an existing med, or (b) add a brand-new med.
  function startQuickScheduleAdd(dayBit) {
    if (meds.length > 0) {
      openQuickScheduleChooser(dayBit);
    } else {
      openMedModal(null);
      // Pre-seed the day chip selection so once they finish step 1 (save the
      // med) the schedule editor already knows what day they had in mind.
      pendingDays = dayBit;
      paintScheduleEditor();
    }
  }

  function openQuickScheduleChooser(dayBit) {
    const chooser = document.getElementById("quick-sched-modal");
    const list = document.getElementById("quick-sched-list");
    if (!chooser || !list) return;
    list.innerHTML = meds.map((m) => `
      <li>
        <button type="button" class="quick-sched-pick" data-med="${m.id}">
          <span class="quick-sched-ico">${KIND_ICO[m.kind] || "💊"}</span>
          <span class="quick-sched-name">
            <strong>${escapeHtml(m.name)}</strong>
            <span>${escapeHtml(m.dose || FREQ_LABEL[m.frequency] || "")}</span>
          </span>
        </button>
      </li>`).join("") + `
      <li class="quick-sched-divider">or</li>
      <li>
        <button type="button" class="quick-sched-pick quick-sched-new" data-med="new">
          <span class="quick-sched-ico">＋</span>
          <span class="quick-sched-name">
            <strong>Add a new medication</strong>
            <span>You can schedule it on the next step.</span>
          </span>
        </button>
      </li>`;
    list.querySelectorAll("[data-med]").forEach((btn) => {
      btn.addEventListener("click", () => {
        chooser.classList.remove("open");
        chooser.setAttribute("aria-hidden", "true");
        const v = btn.dataset.med;
        if (v === "new") {
          openMedModal(null);
          pendingDays = dayBit;
          paintScheduleEditor();
        } else {
          const m = meds.find((x) => x.id === +v);
          if (m) {
            openMedModal(m);
            pendingDays = dayBit;
            paintScheduleEditor();
            // Focus the time picker so the user can finish in one step.
            setTimeout(() => document.getElementById("sched-time")?.focus(), 80);
          }
        }
      });
    });
    chooser.classList.add("open");
    chooser.setAttribute("aria-hidden", "false");
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

  // --- Reaction helpers --------------------------------------------------
  async function sendMedReaction(name, reaction, comment) {
    try {
      const res = await fetchJson("/api/me/medications/react", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, reaction, comment }),
      });
      // Update local state for any cards using this med name.
      const target = meds.find((m) => m.name === name);
      if (target) {
        target.community = res.stats;
        target.myReaction = res.reaction;
        renderMeds();
      }
      applyCommunityToGlossary({ [medKey(name)]: { stats: res.stats, mine: res.reaction } });
      await loadTopPicks();
      if (reaction === "down") toast("Feedback sent to moderation", "ok");
      else if (reaction === "love") toast("Loved ❤", "ok");
      else toast("Vote cleared", "ok");
    } catch (err) {
      if (reaction === "down") {
        openMedDownComment(name, err.message);
      } else {
        toast(err.message || "Couldn't save reaction", "err");
      }
    }
  }

  function openMedDownComment(name, errMsg) {
    const modal = document.getElementById("med-down-modal");
    const form = document.getElementById("med-down-form");
    form.reset();
    form.medName.value = name;
    const status = document.getElementById("med-down-status");
    status.textContent = errMsg || "";
    status.className = errMsg ? "form-status err" : "form-status";
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  }

  document.getElementById("med-down-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.medName.value;
    const comment = form.comment.value.trim();
    const status = document.getElementById("med-down-status");
    status.textContent = ""; status.className = "form-status";
    if (comment.length < 10) {
      status.textContent = "At least 10 characters — be useful."; status.className = "form-status err"; return;
    }
    try {
      await sendMedReaction(name, "down", comment);
      const modal = document.getElementById("med-down-modal");
      modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
    } catch (err) {
      status.textContent = err.message || "Couldn't save."; status.className = "form-status err";
    }
  });

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
    const lovesTip = `${entry.loves} ${entry.loves === 1 ? "person" : "people"} on EndoMe love this`;
    const downsTip = entry.downs === 0
      ? "No one's flagged this as unhelpful yet"
      : `${entry.downs} ${entry.downs === 1 ? "person" : "people"} flagged this as unhelpful for them`;
    const usersTip = `${entry.users} ${entry.users === 1 ? "person is" : "people are"} currently taking this`;
    el.innerHTML = `
      <div class="top-pick-name">${KIND_ICO[entry.kind] || "💊"} <strong>${escapeHtml(entry.name)}</strong></div>
      <div class="top-pick-stats">
        <span class="tp-stat tp-stat-love" data-tip="${escapeHtml(lovesTip)}">❤ ${entry.loves}</span>
        <span class="tp-stat tp-stat-down" data-tip="${escapeHtml(downsTip)}">👎 ${entry.downs}</span>
        <span class="tp-stat tp-stat-users" data-tip="${escapeHtml(usersTip)}">👥 ${entry.users}</span>
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
    const status = document.getElementById("sched-status");
    const time = document.getElementById("sched-time").value;
    status.textContent = "";
    status.className = "form-status";
    if (!pendingDays) { status.textContent = "Pick at least one day."; status.className = "form-status err"; return; }
    if (!time) { status.textContent = "Pick a time."; status.className = "form-status err"; return; }
    // Brand-new med, no id yet — stash the slot in editingSchedules with a
    // negative placeholder id so paintScheduleEditor still renders it. The
    // form-submit handler walks pending entries (id < 0) after creating the
    // med and persists them via the schedules API.
    if (!editingMedId) {
      const placeholder = { id: -(editingSchedules.length + 1), daysMask: pendingDays, timeOfDay: time, pending: true };
      editingSchedules.push(placeholder);
      pendingDays = 0;
      document.getElementById("sched-time").value = "";
      document.querySelectorAll("#dow-row .dow-chip.on").forEach((b) => b.classList.remove("on"));
      paintScheduleEditor();
      toast("Slot queued — save medication to lock it in", "ok");
      return;
    }
    try {
      const res = await fetchJson(`/api/me/medications/${editingMedId}/schedules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ daysMask: pendingDays, timeOfDay: time }),
      });
      editingSchedules.push({ id: res.id, daysMask: pendingDays, timeOfDay: time });
      pendingDays = 0;
      document.getElementById("sched-time").value = "";
      document.querySelectorAll("#dow-row .dow-chip.on").forEach((b) => b.classList.remove("on"));
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
    if (!del) return;
    const schedId = +del.dataset.delSched;
    // Pending (not-yet-saved) entries have negative placeholder ids — just
    // drop them from the local queue, no API call needed.
    if (schedId < 0) {
      editingSchedules = editingSchedules.filter((s) => s.id !== schedId);
      paintScheduleEditor();
      return;
    }
    if (!editingMedId) return;
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
      // If the user queued any schedule rows BEFORE the med was saved
      // (negative placeholder ids), persist them now that we have a med id.
      // Either path — newly created med or existing med being edited.
      const newMedId = res.id || id;
      const pending = editingSchedules.filter((s) => s.id < 0);
      if (newMedId && pending.length) {
        for (const s of pending) {
          try {
            await fetchJson(`/api/me/medications/${newMedId}/schedules`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ daysMask: s.daysMask, timeOfDay: s.timeOfDay }),
            });
          } catch (err) { /* swallow per-row, keep going */ }
        }
      }
      toast(id ? "Medication updated" : "Medication added", "ok");
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
    if (e.target.closest("[data-close-quick-sched]")) {
      e.preventDefault();
      const m = document.getElementById("quick-sched-modal");
      m.classList.remove("open");
      m.setAttribute("aria-hidden", "true");
      return;
    }
    if (e.target.closest("[data-close-med-down]")) {
      e.preventDefault();
      const m = document.getElementById("med-down-modal");
      m.classList.remove("open");
      m.setAttribute("aria-hidden", "true");
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
      const already = react.classList.contains("on");
      // Thumbs-down switching ON requires a comment via the modal.
      if (wanted === "down" && !already) { openMedDownComment(name); return; }
      const reaction = already ? null : wanted;
      await sendMedReaction(name, reaction);
      return;
    }
    const greact = e.target.closest("[data-greact]");
    if (greact) {
      e.preventDefault();
      const name = greact.dataset.name;
      const wanted = greact.dataset.greact;
      const already = greact.classList.contains("on");
      if (wanted === "down" && !already) { openMedDownComment(name); return; }
      const reaction = already ? null : wanted;
      await sendMedReaction(name, reaction);
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
    const q = (glossarySearch.value || "").trim();
    const hasCategoryFilter = glossaryCategory && glossaryCategory !== "All";

    // No search + no category picked → show a "start typing" placeholder
    // rather than dumping the entire catalog. Keeps the page focused on the
    // user's actual meds and lets them search to discover the rest.
    if (!q && !hasCategoryFilter) {
      glossaryList.innerHTML = `<li class="glossary-placeholder">
        <span class="glossary-placeholder-emoji">🔎</span>
        <strong>Search the glossary</strong>
        <span>Start typing a medication, vitamin, brand or category — like "ibuprofen", "Slynd", "magnesium" or "birth control".</span>
      </li>`;
      return;
    }

    // Lightweight fuzzy ranking: score each entry by where the query lands
    // (name prefix > name contains > alias > category > summary). Tiered so
    // exact-ish matches surface to the top as the user keeps typing.
    const ql = q.toLowerCase();
    let items = catalog;
    if (hasCategoryFilter) items = items.filter((c) => (c.category || "Other") === glossaryCategory);

    if (ql) {
      const scored = [];
      for (const c of items) {
        const score = scoreGlossaryMatch(c, ql);
        if (score > 0) scored.push({ c, score });
      }
      scored.sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
      items = scored.slice(0, 60).map((x) => x.c);
    } else {
      items = items.slice(0, 60);
    }

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

  function scoreGlossaryMatch(c, ql) {
    const name = (c.name || "").toLowerCase();
    if (name === ql)            return 100;
    if (name.startsWith(ql))    return 80;
    if (name.includes(ql))      return 60;
    for (const a of (c.aliases || [])) {
      const al = a.toLowerCase();
      if (al === ql)         return 55;
      if (al.startsWith(ql)) return 45;
      if (al.includes(ql))   return 30;
    }
    const cat = (c.category || "").toLowerCase();
    if (cat.includes(ql))       return 20;
    const kind = (c.kind || "").toLowerCase();
    if (kind.includes(ql))      return 15;
    const sum = (c.summary || "").toLowerCase();
    if (sum.includes(ql))       return 10;
    return 0;
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
    const u = stats.users || 0;
    const l = stats.loves || 0;
    const d = stats.downs || 0;
    return `
      <span class="med-community-stat" data-tip="${u} ${u === 1 ? "person is" : "people are"} currently tracking this on EndoMe">👥 ${u} taking this</span>
      <div class="med-react">
        <button class="react-chip love ${mine === "love" ? "on" : ""}" data-greact="love" data-name="${escapeHtml(name)}" aria-label="Love this" data-tip="${l} ${l === 1 ? "EndoMe user loves" : "EndoMe users love"} this — tap to add yours">❤ <span>${l}</span></button>
        <button class="react-chip down ${mine === "down" ? "on" : ""}" data-greact="down" data-name="${escapeHtml(name)}" aria-label="Thumbs down" data-tip="${d === 0 ? "No one's flagged this yet — tap if it didn't work for you (comment required)" : d + " " + (d === 1 ? "person" : "people") + " flagged this as unhelpful"}">👎 <span>${d}</span></button>
      </div>
      ${downCommentsHtml(stats.downComments)}`;
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

  // --- Settings tab — dose policy preference --------------------------
  async function loadMedPrefs() {
    try {
      const data = await fetchJson("/api/me/med-prefs");
      const form = document.getElementById("med-prefs-form");
      if (!form) return;
      const policy = data.autoMarkTaken ? "auto" : "notify";
      const radio = form.querySelector(`input[name="dosePolicy"][value="${policy}"]`);
      if (radio) radio.checked = true;
    } catch {}
  }
  document.getElementById("med-prefs-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const policy = form.querySelector("input[name='dosePolicy']:checked")?.value || "notify";
    const status = document.getElementById("med-prefs-status");
    status.textContent = "Saving…"; status.className = "form-status";
    try {
      await fetchJson("/api/me/med-prefs", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          autoMarkTaken: policy === "auto" ? 1 : 0,
          notifyAtDose:  policy === "notify" ? 1 : 0,
        }),
      });
      status.textContent = "Saved."; status.className = "form-status ok";
      toast("Settings saved", "ok");
    } catch (err) {
      status.textContent = err.message || "Couldn't save."; status.className = "form-status err";
    }
  });
  // Wire on initial load + every time the user opens the Settings tab.
  loadMedPrefs();
  document.querySelectorAll("[data-tab-target='settings']").forEach((b) => b.addEventListener("click", loadMedPrefs));
})();
