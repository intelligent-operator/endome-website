// /meds — manage user's medications + log doses + searchable catalog.
console.info("EndoMe meds build v2");

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
  let meds = [];
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
    document.getElementById("page-loader")?.classList.add("is-hidden");
  })();

  async function load() {
    try {
      const data = await fetchJson("/api/me/medications");
      meds = data.medications || [];
      renderMeds();
      await renderRecentLogs();
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
      ${m.insight ? `<div class="med-insight"><span class="med-insight-tag">ℹ️ Why this</span><p>${escapeHtml(m.insight)}</p>${m.link ? `<a href="${escapeHtml(m.link)}" target="_blank" rel="noopener">More info →</a>` : ""}</div>` : (m.link ? `<a class="med-link" href="${escapeHtml(m.link)}" target="_blank" rel="noopener">Reference →</a>` : "")}
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

  // --- Add / Edit -------------------------------------------------------
  document.getElementById("btn-add-med").addEventListener("click", () => openMedModal(null));
  function openMedModal(m) {
    const form = document.getElementById("med-form");
    form.reset();
    form.id.value = m?.id || "";
    document.getElementById("med-modal-title").textContent = m ? "Edit medication" : "Add a medication";
    document.getElementById("med-status").textContent = "";
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
    medModal.classList.add("open"); medModal.setAttribute("aria-hidden", "false");
  }
  function closeMedModal() { medModal.classList.remove("open"); medModal.setAttribute("aria-hidden", "true"); }

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
      await fetchJson(id ? `/api/me/medications/${id}` : "/api/me/medications", {
        method: id ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      toast(id ? "Medication updated" : "Medication added", "ok");
      closeMedModal();
      await load();
    } catch (err) {
      status.textContent = err.message || "Couldn't save.";
      status.className = "form-status err";
    }
  });

  // --- Log / Edit / Delete actions -------------------------------------
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
      // Show a curated top-of-list when the field is empty/focused.
      matches = catalog.filter((c) => ["Ibuprofen","Paracetamol","Magnesium","Vitamin D","Omega-3","Iron","NAC (N-Acetyl Cysteine)","PEA (Palmitoylethanolamide)","Dienogest"].includes(c.name));
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
  }

  function glossaryItem(c) {
    const aliases = (c.aliases || []).slice(0, 4).join(", ");
    const KIND_ICO = { medication: "💊", vitamin: "🌿", supplement: "🧴", herbal: "🍃" };
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
