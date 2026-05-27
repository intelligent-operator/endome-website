(() => {
  const phasesEl     = document.getElementById("story-phases");
  const ringProgress = document.getElementById("ring-progress");
  const ringPercent  = document.getElementById("ring-percent");
  const ringFraction = document.getElementById("ring-fraction");
  const infoModal    = document.getElementById("story-info-modal");
  const RING_CIRC    = 2 * Math.PI * 76;
  // Keeps the most recent step list so we can rebuild the info modal without
  // making another network round-trip on every card click.
  let lastSteps = [];
  let lastStepNum = new Map();

  // Display name in the topbar — consistent across pages.
  fetch("/api/me/today", { credentials: "same-origin" })
    .then((r) => (r.status === 401 ? (location.href = "/login") : r.json()))
    .then((data) => {
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = data?.user?.displayName || data?.user?.username || "there";
      });
    }).catch(() => {});

  async function load() {
    try {
      const res = await fetch("/api/me/story", { credentials: "same-origin" });
      if (res.status === 401) return (location.href = "/login");
      let data = {};
      try { data = await res.json(); } catch {}
      if (!res.ok || !Array.isArray(data.steps)) {
        phasesEl.innerHTML = `<p class="story-empty">Couldn't load your story. ${escapeHtml(data.error || "Refresh to try again.")}</p>`;
        return;
      }
      render(data);
    } catch {
      phasesEl.innerHTML = `<p class="story-empty">Couldn't load your story. Refresh to try again.</p>`;
    } finally {
      document.getElementById("page-loader")?.classList.add("is-hidden");
    }
  }

  function render(data) {
    const steps = Array.isArray(data.steps) ? data.steps : [];
    const total = Number.isFinite(data.total) ? data.total : steps.length;
    const completed = Number.isFinite(data.completed)
      ? data.completed
      : steps.filter((s) => s.completed).length;
    const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((completed / total) * 100))) : 0;

    ringProgress.style.strokeDashoffset = String(RING_CIRC * (1 - pct / 100));
    ringPercent.textContent  = `${pct}%`;
    ringFraction.textContent = `${completed} of ${total} steps`;

    // Group by phase, preserving the order they appear in the server response.
    const order = [];
    const grouped = new Map();
    for (const s of steps) {
      if (!grouped.has(s.phase)) { grouped.set(s.phase, []); order.push(s.phase); }
      grouped.get(s.phase).push(s);
    }

    let stepNum = 0;
    let html = "";
    lastSteps = steps;
    lastStepNum = new Map();
    for (const phaseName of order) {
      const group = grouped.get(phaseName);
      const phaseDone = group.filter((s) => s.completed).length;
      const phaseDesc = group[0]?.phaseDesc || "";
      html += `
        <section class="phase">
          <header class="phase-head">
            <div class="phase-head-text">
              <p class="phase-eyebrow">Phase ${order.indexOf(phaseName) + 1}</p>
              <h2>${escapeHtml(phaseName)}</h2>
              ${phaseDesc ? `<p class="phase-desc">${escapeHtml(phaseDesc)}</p>` : ""}
            </div>
            <span class="phase-pill ${phaseDone === group.length ? "complete" : ""}">${phaseDone}/${group.length}</span>
          </header>
          <div class="step-grid">
            ${group.map((s) => { lastStepNum.set(s.id, ++stepNum); return stepCard(s, stepNum); }).join("")}
          </div>
        </section>`;
    }
    phasesEl.innerHTML = html;
  }

  // ---- Step info modal -------------------------------------------------
  function openInfoModal(stepId) {
    const s = lastSteps.find((x) => x.id === stepId);
    if (!s || !infoModal) return;
    const num = lastStepNum.get(stepId) || 0;
    document.getElementById("story-info-emoji").textContent = s.icon || "📖";
    document.getElementById("story-info-eyebrow").textContent = `${s.phase || ""} · Step ${String(num).padStart(2,"0")}`;
    document.getElementById("story-info-title").textContent = s.title || "";
    document.getElementById("story-info-desc").textContent = s.desc || "";
    document.getElementById("story-info-why-head").textContent = s.why || "Why this matters";
    document.getElementById("story-info-details").textContent = s.details || "We'll add more context for this step soon.";

    const stats = document.getElementById("story-info-stats");
    const status = s.completed ? "Completed" : (s.locked ? "Locked" : (s.type === "auto" ? "Tracking" : "To do"));
    const statusClass = s.completed ? "is-done" : s.locked ? "is-locked" : "is-todo";
    const dateLine = s.completed && s.completedAt
      ? new Date(s.completedAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
      : null;
    stats.innerHTML = `
      <span class="story-info-pill ${statusClass}">${escapeHtml(status)}</span>
      ${dateLine ? `<span class="story-info-pill is-meta">📅 ${escapeHtml(dateLine)}</span>` : ""}
      <span class="story-info-pill is-meta">${escapeHtml(s.phase || "")}</span>`;

    const actions = document.getElementById("story-info-actions");
    if (s.completed) {
      actions.innerHTML = `<button class="btn-soft" type="button" data-close-story-info>Close</button>`;
    } else if (s.locked) {
      actions.innerHTML = `<p class="story-info-locked">🔒 Complete the previous step to unlock this one.</p>
        <button class="btn-soft" type="button" data-close-story-info>Close</button>`;
    } else if (s.type === "action") {
      actions.innerHTML = `<button class="btn btn-primary" type="button" data-action="${escapeHtml(s.id)}" data-endpoint="${escapeHtml(s.actionEndpoint || "")}">${escapeHtml(s.actionLabel || "Start")} →</button>
        <button class="btn-soft" type="button" data-close-story-info>Maybe later</button>`;
    } else if (s.type === "auto") {
      actions.innerHTML = `<p class="story-info-auto">${escapeHtml(s.autoLabel || "We'll mark this for you as you log day to day.")}</p>
        <button class="btn-soft" type="button" data-close-story-info>Close</button>`;
    } else {
      actions.innerHTML = `<button class="btn btn-primary" type="button" data-check="${escapeHtml(s.id)}">✓ Mark complete</button>
        <button class="btn-soft" type="button" data-close-story-info>Close</button>`;
    }

    infoModal.classList.add("open");
    infoModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
  }
  function closeInfoModal() {
    if (!infoModal) return;
    infoModal.classList.remove("open");
    infoModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }

  function stepCard(s, n) {
    const stateClass = s.completed ? "is-done" : s.locked ? "is-locked" : "is-todo";
    return `
      <article class="step ${stateClass}" data-step-id="${s.id}">
        <div class="step-top">
          <div class="step-icon">${s.icon || "•"}</div>
          <div class="step-num">${n.toString().padStart(2, "0")}</div>
        </div>
        <div class="step-body">
          <h3>${escapeHtml(s.title)}</h3>
          <p>${escapeHtml(s.desc)}</p>
        </div>
        <div class="step-tail">
          ${tailHtml(s)}
        </div>
      </article>`;
  }

  function tailHtml(s) {
    if (s.completed) {
      const date = s.completedAt ? new Date(s.completedAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
      const verb = s.type === "action" ? (s.id === "order_dna" ? "Ordered" : s.id === "dna_results" ? "Received" : "Done") : "Done";
      return `
        <div class="step-done-state">
          <div class="step-check checked" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12l4 4L19 6" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
          <span class="step-done-meta">${verb}${date ? ` · ${date}` : ""}</span>
        </div>`;
    }
    if (s.locked) {
      return `<div class="step-locked-state">🔒 Order your DNA test first</div>`;
    }
    if (s.type === "action") {
      return `<button class="step-action" data-action="${escapeHtml(s.id)}" data-endpoint="${escapeHtml(s.actionEndpoint || "")}" data-info-skip>${escapeHtml(s.actionLabel || "Start")} →</button>`;
    }
    if (s.type === "auto") {
      return `<div class="step-auto-state">${escapeHtml(s.autoLabel || "Tracks automatically")}</div>`;
    }
    // manual
    return `<button class="step-check" data-check="${escapeHtml(s.id)}" data-info-skip aria-label="Mark complete"></button>`;
  }

  document.addEventListener("click", async (e) => {
    // Close-info clicks first so they win over anything below.
    if (e.target.closest("[data-close-story-info]")) {
      e.preventDefault();
      closeInfoModal();
      return;
    }

    const action  = e.target.closest("[data-action]");
    const check   = e.target.closest("[data-check]");
    const uncheck = e.target.closest("[data-uncheck]");

    // Card body click (anywhere not on an explicit control) → open info modal.
    const card = e.target.closest(".step[data-step-id]");
    if (card && !action && !check && !uncheck && !e.target.closest("[data-info-skip]")) {
      openInfoModal(card.dataset.stepId);
      return;
    }

    if (action) {
      e.preventDefault();
      const endpoint = action.dataset.endpoint;
      if (!endpoint) return;
      action.disabled = true;
      action.textContent = "Saving…";
      try {
        const res  = await fetch(endpoint, { method: "POST", credentials: "same-origin" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { toast(data.error || "Couldn't save", "err"); action.disabled = false; return; }
        // Friendly success messages per action
        if (action.dataset.action === "order_dna") {
          toast("EndoMe DNA test requested 🌸 we'll be in touch soon");
        } else if (action.dataset.action === "dna_results") {
          toast("Results recorded — well done");
        } else {
          toast("Saved");
        }
        closeInfoModal();
        await load();
      } catch {
        toast("Network error", "err");
        action.disabled = false;
      }
      return;
    }

    if (check || uncheck) {
      e.preventDefault();
      const stepId = (check || uncheck).dataset.check || (check || uncheck).dataset.uncheck;
      const url    = check ? "/api/me/story/check" : "/api/me/story/uncheck";
      try {
        const res  = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stepId }),
          credentials: "same-origin",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { toast(data.error || "Couldn't update", "err"); return; }
        render(data);
        closeInfoModal();
        toast(check ? "Marked complete ✨" : "Unmarked");
      } catch {
        toast("Network error", "err");
      }
      return;
    }
  });

  // Allow clicking anywhere on a done card to toggle off manual steps.
  document.addEventListener("click", (e) => {
    const card = e.target.closest(".step.is-done");
    if (!card) return;
    if (e.target.closest(".step-action, [data-check], [data-uncheck]")) return;
    // Only manual steps can be unchecked from here. Use the existing button's
    // data attribute if present — otherwise (auto/action) ignore the click.
    // We don't render uncheck for non-manual steps so this is just a no-op.
  });

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
  function escapeHtml(s) {
    return String(s ?? "").replace(/[<>&"']/g, (c) => ({
      "<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&#39;"
    })[c]);
  }

  load();
})();
