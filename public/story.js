(() => {
  const phasesEl = document.getElementById("story-phases");
  const ringProgress = document.getElementById("ring-progress");
  const ringPercent  = document.getElementById("ring-percent");
  const ringFraction = document.getElementById("ring-fraction");
  const RING_CIRC = 2 * Math.PI * 52;

  // Pull display name for the topbar — keeps consistent across pages.
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
        phasesEl.innerHTML = `<p class="empty-state">Couldn't load your story. ${escapeHtml(data.error || "Refresh to try again.")}</p>`;
        return;
      }
      render(data);
    } catch {
      phasesEl.innerHTML = `<p class="empty-state">Couldn't load your story. Refresh to try again.</p>`;
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
    ringFraction.textContent = `${completed} of ${total}`;
    data.steps = steps; // continue with safe value below

    // Phases
    const phases = {};
    for (const s of data.steps) {
      (phases[s.phase] = phases[s.phase] || []).push(s);
    }

    let html = "";
    let stepNum = 1;
    for (const phaseName of Object.keys(phases)) {
      const steps = phases[phaseName];
      const phaseDone = steps.filter((s) => s.completed).length;
      html += `
        <section class="story-phase">
          <header class="phase-head">
            <h2>${escapeHtml(phaseName)}</h2>
            <span class="phase-pill">${phaseDone}/${steps.length}</span>
          </header>
          <ol class="story-steps">
            ${steps.map((s) => stepHtml(s, stepNum++)).join("")}
          </ol>
        </section>`;
    }
    phasesEl.innerHTML = html;
  }

  function stepHtml(s, n) {
    const stateClass = s.completed ? "done" : "todo";
    const checkbox = s.completed
      ? `<button class="step-check checked" data-uncheck="${s.id}" aria-label="Uncheck">
           <svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12l4 4L19 6" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
         </button>`
      : `<button class="step-check" data-check="${s.id}" aria-label="Mark complete"></button>`;

    const meta = s.completed
      ? `<span class="step-meta ${s.completedBy}">${s.completedBy === "auto" ? "auto-marked" : "completed"}</span>`
      : `<span class="step-meta">${s.auto ? "auto when ready" : "you'll mark this"}</span>`;

    return `
      <li class="story-step ${stateClass}">
        <div class="step-num">${n}</div>
        <div class="step-icon">${s.icon}</div>
        <div class="step-body">
          <h3>${escapeHtml(s.title)}</h3>
          <p>${escapeHtml(s.desc)}</p>
          ${meta}
        </div>
        ${checkbox}
      </li>`;
  }

  // Toggle handlers (delegated)
  document.addEventListener("click", async (e) => {
    const check = e.target.closest("[data-check]");
    const uncheck = e.target.closest("[data-uncheck]");
    if (!check && !uncheck) return;
    e.preventDefault();
    const stepId = (check || uncheck).dataset.check || (check || uncheck).dataset.uncheck;
    const url = check ? "/api/me/story/check" : "/api/me/story/uncheck";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stepId }),
        credentials: "same-origin",
      });
      const data = await res.json();
      if (res.ok) {
        render(data);
        toast(check ? "Marked complete ✨" : "Unmarked");
      } else {
        toast(data.error || "Couldn't update — try again", "err");
      }
    } catch {
      toast("Network error", "err");
    }
  });

  function toast(text, tone = "ok") {
    const stack = document.getElementById("toast-stack");
    if (!stack) return;
    const t = document.createElement("div");
    t.className = `toast toast-${tone}`;
    t.textContent = text;
    stack.appendChild(t);
    requestAnimationFrame(() => t.classList.add("in"));
    setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 250); }, 2200);
  }
  function escapeHtml(s) {
    return String(s || "").replace(/[<>&"']/g, (c) => ({
      "<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&#39;"
    })[c]);
  }

  load();
})();
