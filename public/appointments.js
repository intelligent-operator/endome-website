// /appointments — interactive month-view calendar with per-appointment
// reminder preferences (in-app, email, lead time). Loads two weeks ahead by
// default for the upcoming list and the visible month's full range for the
// grid view, so prev/next don't refetch what we already have.
console.info("EndoMe appointments build v1");

(() => {
  const KINDS = [
    { id: "general",    label: "General",     emoji: "📅", color: "#7a5f6c" },
    { id: "gp",         label: "GP",          emoji: "🩺", color: "#3b82f6" },
    { id: "specialist", label: "Specialist",  emoji: "👩‍⚕️", color: "#ff4e8a" },
    { id: "surgery",    label: "Surgery",     emoji: "🏥", color: "#ef4444" },
    { id: "test",       label: "Test",        emoji: "🧪", color: "#22c55e" },
    { id: "imaging",    label: "Imaging",     emoji: "🔬", color: "#8b5cf6" },
    { id: "scan",       label: "Scan",        emoji: "📡", color: "#06b6d4" },
    { id: "therapy",    label: "Therapy",     emoji: "🧠", color: "#a855f7" },
    { id: "physio",     label: "Physio",      emoji: "🤸", color: "#14b8a6" },
    { id: "follow_up",  label: "Follow-up",   emoji: "🔁", color: "#f59e0b" },
    { id: "other",      label: "Other",       emoji: "✨", color: "#a08596" },
  ];
  const KIND_BY_ID = Object.fromEntries(KINDS.map((k) => [k.id, k]));

  // Calendar rendering state.
  let viewYear, viewMonth;       // Month currently displayed
  let weekAnchor = null;         // Monday of the visible week (Date)
  let appointments = [];         // Cache of appointments for the visible month
  let weekAppointments = [];     // Cache for the visible week window
  let editingId = null;

  // How many appointments to show in the "Next up" right sidebar. Kept small
  // so the rail stays the same visual height as the calendar card it sits
  // alongside.
  const NEXT_UP_CAP = 5;

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  (async () => {
    try {
      const me = await fetchJson("/api/me/today");
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = me?.user?.displayName || me?.user?.username || "there";
      });
    } catch {}
    populateKindSelect();
    paintLegend();
    paintDow();
    const today = new Date();
    viewYear = today.getFullYear();
    viewMonth = today.getMonth();
    weekAnchor = mondayOf(today);
    await Promise.all([loadMonth(), loadWeek()]);
    await loadNextUp();
    document.getElementById("page-loader")?.classList.add("is-hidden");

    // Deep-link: ?id=123 → open that appointment's modal.
    const id = new URLSearchParams(location.search).get("id");
    if (id) {
      try {
        const data = await fetchJson(`/api/me/appointments/${id}`);
        if (data.appointment) openModal(data.appointment);
      } catch {}
    }
  })();

  function populateKindSelect() {
    const sel = document.getElementById("appt-kind");
    if (!sel) return;
    sel.innerHTML = KINDS.map((k) =>
      `<option value="${k.id}">${k.emoji} ${k.label}</option>`
    ).join("");
  }
  function paintLegend() {
    const el = document.getElementById("cal-legend");
    if (!el) return;
    // Show the most common types in a compact legend bar.
    const show = ["gp","specialist","surgery","test","therapy"];
    el.innerHTML = show.map((id) => {
      const k = KIND_BY_ID[id];
      return `<span class="cal-legend-item"><span class="cal-dot" style="background:${k.color}"></span>${k.label}</span>`;
    }).join("");
  }
  function paintDow() {
    const dow = document.getElementById("cal-dow");
    const labels = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
    dow.innerHTML = labels.map((d) => `<div class="cal-dow-cell">${d}</div>`).join("");
  }

  // ------------------------------------------------------------------
  // Month grid
  // ------------------------------------------------------------------
  async function loadMonth() {
    const start = new Date(viewYear, viewMonth, 1);
    const end = new Date(viewYear, viewMonth + 1, 0, 23, 59, 59);
    // Pad the window by ±6 days so the leading/trailing grid cells from
    // adjacent months are populated too.
    const fromSec = Math.floor(start.getTime() / 1000) - 6 * 86400;
    const toSec   = Math.floor(end.getTime() / 1000) + 6 * 86400;
    try {
      const data = await fetchJson(`/api/me/appointments?from=${fromSec}&to=${toSec}`);
      appointments = data.appointments || [];
    } catch {
      appointments = [];
    }
    paintCalendar();
  }

  function paintCalendar() {
    const grid = document.getElementById("cal-grid");
    const title = document.getElementById("cal-title");
    const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    title.textContent = `${monthNames[viewMonth]} ${viewYear}`;

    // First Monday on or before the 1st of the month.
    const first = new Date(viewYear, viewMonth, 1);
    const firstDow = (first.getDay() + 6) % 7; // 0 = Mon
    const start = new Date(viewYear, viewMonth, 1 - firstDow);

    const todayKey = dateKey(new Date());

    let html = "";
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const inMonth = d.getMonth() === viewMonth;
      const key = dateKey(d);
      const dayAppts = appointmentsOn(d);
      const visible = dayAppts.slice(0, 3);
      const overflow = dayAppts.length - visible.length;
      html += `<div class="cal-cell ${inMonth ? "" : "is-out"} ${key === todayKey ? "is-today" : ""}" data-date="${key}">
        <button type="button" class="cal-cell-add" data-add-date="${key}" aria-label="Add appointment on ${d.toDateString()}">+</button>
        <span class="cal-day-num">${d.getDate()}</span>
        <ul class="cal-appt-list">
          ${visible.map((a) => apptChip(a)).join("")}
          ${overflow > 0 ? `<li class="cal-overflow" data-day-overflow="${key}">+${overflow} more</li>` : ""}
        </ul>
      </div>`;
    }
    grid.innerHTML = html;

    // Wire interactions.
    grid.querySelectorAll("[data-add-date]").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        openNewModalOnDate(b.dataset.addDate);
      });
    });
    grid.querySelectorAll(".cal-cell").forEach((cell) => {
      cell.addEventListener("click", (e) => {
        if (e.target.closest("[data-open-appt]") || e.target.closest("[data-add-date]")) return;
        // Tapping the empty area of a day cell also creates a new appointment.
        openNewModalOnDate(cell.dataset.date);
      });
    });
    grid.querySelectorAll("[data-open-appt]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const a = appointments.find((x) => x.id === +el.dataset.openAppt);
        if (a) openModal(a);
      });
    });
    grid.querySelectorAll("[data-day-overflow]").forEach((el) => {
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        // Jump the focused week view to the week containing that day, then
        // smooth-scroll + flash the matching day column so the overflow
        // appointments are immediately visible in full.
        const key = el.dataset.dayOverflow;
        const [y, m, d] = key.split("-").map(Number);
        weekAnchor = mondayOf(new Date(y, m - 1, d));
        await loadWeek();
        const wkGrid = document.querySelector("#week-grid");
        wkGrid?.scrollIntoView({ behavior: "smooth", block: "start" });
        wkGrid?.querySelectorAll(".week-day").forEach((dc) => {
          dc.classList.toggle("flash", dc.dataset.date === key);
        });
        setTimeout(() =>
          wkGrid?.querySelectorAll(".week-day.flash").forEach((dc) => dc.classList.remove("flash")),
        1800);
      });
    });
  }

  function apptChip(a) {
    const k = KIND_BY_ID[a.kind] || KIND_BY_ID.general;
    const color = a.color || k.color;
    const time = a.allDay ? "All-day" : formatHm(a.startsAt);
    return `<li class="cal-appt" style="--c:${color}" data-open-appt="${a.id}">
      <span class="cal-appt-time">${time}</span>
      <span class="cal-appt-title">${escapeHtml(a.title)}</span>
    </li>`;
  }

  function appointmentsOn(date) {
    const key = dateKey(date);
    return appointments
      .filter((a) => dateKey(new Date(a.startsAt * 1000)) === key)
      .sort((a, b) => (a.allDay ? 0 : a.startsAt) - (b.allDay ? 0 : b.startsAt));
  }

  // ------------------------------------------------------------------
  // Navigation
  // ------------------------------------------------------------------
  document.getElementById("cal-prev").addEventListener("click", async () => {
    viewMonth--;
    if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    await loadMonth();
  });
  document.getElementById("cal-next").addEventListener("click", async () => {
    viewMonth++;
    if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    await loadMonth();
  });
  document.getElementById("cal-today").addEventListener("click", async () => {
    const t = new Date();
    viewYear = t.getFullYear();
    viewMonth = t.getMonth();
    await loadMonth();
  });

  // ------------------------------------------------------------------
  // Week view (primary, focused)
  // ------------------------------------------------------------------
  async function loadWeek() {
    if (!weekAnchor) weekAnchor = mondayOf(new Date());
    const startSec = Math.floor(weekAnchor.getTime() / 1000);
    const endSec   = startSec + 7 * 86400 - 1;
    try {
      const data = await fetchJson(`/api/me/appointments?from=${startSec}&to=${endSec}`);
      weekAppointments = data.appointments || [];
    } catch {
      weekAppointments = [];
    }
    paintWeek();
  }

  function paintWeek() {
    const grid = document.getElementById("week-grid");
    const titleEl = document.getElementById("wk-title");
    const summaryEl = document.getElementById("wk-summary");
    if (!grid || !titleEl) return;

    // Title: "Mon 3 Jun – Sun 9 Jun" or with year if it crosses years.
    const start = new Date(weekAnchor);
    const end   = new Date(weekAnchor.getFullYear(), weekAnchor.getMonth(), weekAnchor.getDate() + 6);
    const fmtShort = { month: "short", day: "numeric" };
    const fmtFull  = { month: "short", day: "numeric", year: "numeric" };
    const sameYear = start.getFullYear() === end.getFullYear();
    titleEl.textContent = sameYear
      ? `${start.toLocaleDateString(undefined, fmtShort)} – ${end.toLocaleDateString(undefined, fmtFull)}`
      : `${start.toLocaleDateString(undefined, fmtFull)} – ${end.toLocaleDateString(undefined, fmtFull)}`;
    const count = weekAppointments.length;
    summaryEl.textContent = count
      ? `${count} appointment${count === 1 ? "" : "s"} this week`
      : "Nothing on the calendar this week";

    const todayKey = dateKey(new Date());
    let html = "";
    for (let i = 0; i < 7; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = dateKey(d);
      const isToday = key === todayKey;
      const dayAppts = weekAppointments
        .filter((a) => dateKey(new Date(a.startsAt * 1000)) === key)
        .sort((a, b) => (a.allDay ? 0 : a.startsAt) - (b.allDay ? 0 : b.startsAt));
      const dayName = d.toLocaleDateString(undefined, { weekday: "short" });
      const dayNum = d.getDate();
      html += `<div class="week-day ${isToday ? "is-today" : ""}" data-date="${key}">
        <header class="week-day-head">
          <span class="week-day-name">${dayName}</span>
          <span class="week-day-num">${dayNum}</span>
          <button type="button" class="week-day-add" data-add-date="${key}" aria-label="Add appointment on ${d.toDateString()}">+</button>
        </header>
        <ul class="week-day-list">
          ${dayAppts.length ? dayAppts.map((a) => weekChip(a)).join("") : `<li class="week-empty">No appointments</li>`}
        </ul>
      </div>`;
    }
    grid.innerHTML = html;

    grid.querySelectorAll("[data-add-date]").forEach((b) => {
      b.addEventListener("click", (e) => { e.stopPropagation(); openNewModalOnDate(b.dataset.addDate); });
    });
    grid.querySelectorAll(".week-day").forEach((cell) => {
      cell.addEventListener("click", (e) => {
        if (e.target.closest("[data-open-appt]") || e.target.closest("[data-add-date]")) return;
        openNewModalOnDate(cell.dataset.date);
      });
    });
    grid.querySelectorAll("[data-open-appt]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const a = weekAppointments.find((x) => x.id === +el.dataset.openAppt);
        if (a) openModal(a);
      });
    });
  }

  function weekChip(a) {
    const k = KIND_BY_ID[a.kind] || KIND_BY_ID.general;
    const color = a.color || k.color;
    const time = a.allDay ? "All-day" : formatHm(a.startsAt);
    return `<li class="week-appt" style="--c:${color}" data-open-appt="${a.id}">
      <span class="week-appt-time">${time}</span>
      <strong class="week-appt-title">${k.emoji} ${escapeHtml(a.title)}</strong>
      ${a.doctor ? `<span class="week-appt-sub">${escapeHtml(a.doctor)}</span>` : ""}
      ${a.location ? `<span class="week-appt-sub">📍 ${escapeHtml(a.location)}</span>` : ""}
    </li>`;
  }

  document.getElementById("wk-prev").addEventListener("click", async () => {
    weekAnchor = addDays(weekAnchor, -7);
    await loadWeek();
  });
  document.getElementById("wk-next").addEventListener("click", async () => {
    weekAnchor = addDays(weekAnchor, 7);
    await loadWeek();
  });
  document.getElementById("wk-today").addEventListener("click", async () => {
    weekAnchor = mondayOf(new Date());
    await loadWeek();
  });

  // ------------------------------------------------------------------
  // "Next up" sidebar — capped list of the next N appointments
  // ------------------------------------------------------------------
  async function loadNextUp() {
    const list = document.getElementById("next-up-list");
    const cap = document.getElementById("next-up-cap");
    if (cap) cap.textContent = String(NEXT_UP_CAP);
    try {
      const data = await fetchJson("/api/me/appointments/upcoming");
      const items = (data.appointments || []).slice(0, NEXT_UP_CAP);
      if (!items.length) {
        list.innerHTML = `<li class="next-up-empty">
          <span class="next-up-empty-art">📅</span>
          <span>Nothing booked yet. Tap <strong>+ Add appointment</strong> to start.</span>
        </li>`;
        return;
      }
      list.innerHTML = items.map((a) => nextUpRow(a)).join("");
      list.querySelectorAll("[data-open-appt]").forEach((el) => {
        el.addEventListener("click", () => {
          const a = items.find((x) => x.id === +el.dataset.openAppt);
          if (a) openModal(a);
        });
      });
    } catch {
      list.innerHTML = `<li class="next-up-empty">Couldn't load. Refresh to try again.</li>`;
    }
  }

  function nextUpRow(a) {
    const k = KIND_BY_ID[a.kind] || KIND_BY_ID.general;
    const color = a.color || k.color;
    const d = new Date(a.startsAt * 1000);
    return `<li class="next-up-row" data-open-appt="${a.id}" style="--c:${color}">
      <div class="next-up-date">
        <span class="next-up-day">${d.getDate()}</span>
        <span class="next-up-month">${d.toLocaleDateString(undefined, { month: "short" })}</span>
      </div>
      <div class="next-up-body">
        <strong>${escapeHtml(a.title)}</strong>
        <span class="next-up-meta">${k.emoji} ${escapeHtml(k.label)} · ${escapeHtml(a.allDay ? "All-day" : formatHm(a.startsAt))}</span>
        <span class="next-up-when">${escapeHtml(relativeWhen(a.startsAt))}</span>
      </div>
    </li>`;
  }

  function relativeWhen(unixSec) {
    const diffSec = unixSec - Math.floor(Date.now() / 1000);
    if (diffSec <= 0) return "happening now";
    const mins = Math.round(diffSec / 60);
    if (mins < 60) return `in ${mins} min`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `in ${hrs}h`;
    const days = Math.round(hrs / 24);
    if (days === 1) return "tomorrow";
    if (days < 7) return `in ${days} days`;
    const weeks = Math.round(days / 7);
    return weeks === 1 ? "next week" : `in ${weeks} weeks`;
  }

  // Mon=0 ... Sun=6, get the Monday of the week containing `d`.
  function mondayOf(d) {
    const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dow = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - dow);
    return date;
  }
  function addDays(d, n) {
    const out = new Date(d);
    out.setDate(out.getDate() + n);
    return out;
  }

  // ------------------------------------------------------------------
  // Add / edit modal
  // ------------------------------------------------------------------
  const modal = document.getElementById("appt-modal");
  document.getElementById("btn-add-appt").addEventListener("click", () => openNewModalOnDate(dateKey(new Date())));

  function openNewModalOnDate(dateStr) {
    editingId = null;
    const form = document.getElementById("appt-form");
    form.reset();
    form.id.value = "";
    form.date.value = dateStr;
    form.time.value = defaultStartTime();
    form.kind.value = "specialist";
    setLeadMins(60);
    document.getElementById("remind-in-app").checked = true;
    document.getElementById("remind-email").checked = false;
    document.getElementById("appt-all-day").checked = false;
    syncAllDay();
    document.getElementById("appt-modal-title").textContent = "New appointment";
    document.getElementById("btn-delete-appt").hidden = true;
    document.getElementById("appt-status").textContent = "";
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    setTimeout(() => form.title?.focus(), 80);
  }
  function openModal(a) {
    editingId = a.id;
    const form = document.getElementById("appt-form");
    form.reset();
    form.id.value = a.id;
    form.title.value = a.title;
    form.kind.value = a.kind || "general";
    form.doctor.value = a.doctor || "";
    form.location.value = a.location || "";
    form.notes.value = a.notes || "";
    const d = new Date(a.startsAt * 1000);
    form.date.value = dateKey(d);
    form.time.value = formatHm(a.startsAt, true);
    document.getElementById("appt-all-day").checked = !!a.allDay;
    syncAllDay();
    document.getElementById("remind-in-app").checked = !!a.remindInApp;
    document.getElementById("remind-email").checked = !!a.remindEmail;
    setLeadMins(a.remindMinutesBefore || 0);
    document.getElementById("appt-modal-title").textContent = "Edit appointment";
    document.getElementById("btn-delete-appt").hidden = false;
    document.getElementById("appt-status").textContent = "";
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  }
  function closeModal() {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-appt]")) { e.preventDefault(); closeModal(); }
  });

  // Lead-time chip picker → writes the picked value to the hidden input so
  // the form serialises cleanly without special-casing on submit.
  document.getElementById("lead-chips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-mins]");
    if (!chip) return;
    setLeadMins(+chip.dataset.mins);
  });
  function setLeadMins(mins) {
    document.getElementById("remind-mins").value = String(mins);
    document.querySelectorAll("#lead-chips .lead-chip").forEach((c) => {
      c.classList.toggle("on", +c.dataset.mins === mins);
    });
  }

  // All-day toggle: dim + ignore the time picker; remove "at the time" lead
  // since there's no specific time to anchor to.
  document.getElementById("appt-all-day").addEventListener("change", syncAllDay);
  function syncAllDay() {
    const allDay = document.getElementById("appt-all-day").checked;
    const time = document.getElementById("appt-time");
    time.disabled = allDay;
    if (allDay) time.value = "";
  }

  document.getElementById("appt-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const status = document.getElementById("appt-status");
    status.textContent = "Saving…"; status.className = "form-status";

    const date = form.date.value;
    if (!date) { status.textContent = "Pick a date."; status.className = "form-status err"; return; }
    const allDay = document.getElementById("appt-all-day").checked;
    let time = form.time.value;
    if (!allDay && !time) time = "09:00";
    const startsAt = Math.floor(new Date(`${date}T${allDay ? "00:00" : time}:00`).getTime() / 1000);

    const body = {
      title: form.title.value.trim(),
      kind: form.kind.value,
      doctor: form.doctor.value.trim() || null,
      location: form.location.value.trim() || null,
      notes: form.notes.value.trim() || null,
      startsAt,
      allDay,
      remindInApp: document.getElementById("remind-in-app").checked,
      remindEmail: document.getElementById("remind-email").checked,
      remindMinutesBefore: +document.getElementById("remind-mins").value || 0,
    };
    try {
      const url = editingId ? `/api/me/appointments/${editingId}` : "/api/me/appointments";
      const method = editingId ? "PUT" : "POST";
      await fetchJson(url, {
        method, headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      toast(editingId ? "Appointment updated" : "Appointment added ✨", "ok");
      closeModal();
      await Promise.all([loadMonth(), loadWeek(), loadNextUp()]);
    } catch (err) {
      status.textContent = err.message || "Couldn't save."; status.className = "form-status err";
    }
  });

  document.getElementById("btn-delete-appt").addEventListener("click", async () => {
    if (!editingId) return;
    if (!confirm("Delete this appointment? This can't be undone.")) return;
    try {
      await fetchJson(`/api/me/appointments/${editingId}`, { method: "DELETE" });
      toast("Appointment removed", "ok");
      closeModal();
      await Promise.all([loadMonth(), loadWeek(), loadNextUp()]);
    } catch (err) { toast(err.message || "Couldn't remove", "err"); }
  });

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function defaultStartTime() {
    // Round up to the next half-hour so the default isn't "in the past".
    const d = new Date();
    d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
    d.setSeconds(0);
    return d.toTimeString().slice(0, 5);
  }
  function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }
  function formatHm(unixSec, force24) {
    const d = new Date(unixSec * 1000);
    if (force24) {
      return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
    }
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
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
  function toast(text, tone = "ok") {
    const stack = document.getElementById("toast-stack");
    if (!stack) return;
    const t = document.createElement("div");
    t.className = `toast toast-${tone}`;
    t.textContent = text;
    stack.appendChild(t);
    requestAnimationFrame(() => t.classList.add("in"));
    setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 250); }, 2500);
  }
})();
