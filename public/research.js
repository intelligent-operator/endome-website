// /research — signed-in dashboard view of the donation roadmap.
// home-donate.js paints the chart + milestone modal + the instant-donate row.
// This file is responsible for the username bind + leaderboard + page loader
// + the milestone-list rendered beneath the donate button.
console.info("EndoMe research build v3");

(() => {
  (async () => {
    try {
      const me = await fetch("/api/me/today", { credentials: "same-origin" }).then((r) => r.json());
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = me?.user?.displayName || me?.user?.username || "there";
      });
    } catch {}

    await Promise.all([loadLeaderboard(), loadMilestoneList()]);
    document.getElementById("page-loader")?.classList.add("is-hidden");
  })();

  // ----- Milestone list (under the donate button) ---------------------
  async function loadMilestoneList() {
    const el = document.getElementById("ms-list");
    if (!el) return;
    try {
      const data = await fetch("/api/donations/totals").then((r) => r.json());
      const milestones = data.milestones || [];
      if (!milestones.length) { el.innerHTML = ""; return; }
      el.innerHTML = milestones.map((m, i) => {
        const state = m.reached ? "reached" : (i === data.activeIndex ? "active" : "locked");
        const stateLabel = m.reached ? "✓ Unlocked" : i === data.activeIndex ? "In progress" : "Locked";
        return `<li class="ms-row is-${state}" data-i="${i}">
          <span class="ms-emoji">${escapeHtml(m.emoji)}</span>
          <div class="ms-body">
            <strong>${escapeHtml(m.title)}</strong>
            <span class="ms-sub">Step ${i + 1} of ${milestones.length} · cumulative ${fmtMoney(m.cumulativeCents)}</span>
            <div class="ms-bar"><div class="ms-bar-fill" style="width:${m.progress || 0}%"></div></div>
          </div>
          <div class="ms-amount">
            <strong>${fmtShort(m.targetCents)}</strong>
            <span class="ms-state ms-state-${state}">${stateLabel}</span>
          </div>
        </li>`;
      }).join("");
      // Tap a row → open the same milestone modal home-donate.js wires up,
      // by faking a click on the matching SVG marker.
      el.querySelectorAll(".ms-row").forEach((row) => {
        row.addEventListener("click", () => {
          const i = +row.dataset.i;
          const marker = document.querySelector(`.dg-marker[data-i="${i}"]`);
          if (marker) marker.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
      });
    } catch {
      el.innerHTML = `<li class="empty-state small">Couldn't load milestones.</li>`;
    }
  }

  function fmtMoney(cents) {
    const d = (cents || 0) / 100;
    return "$" + d.toLocaleString(undefined, { minimumFractionDigits: d % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function fmtShort(cents) {
    const d = (cents || 0) / 100;
    if (d >= 1_000_000) return "$" + (d / 1_000_000).toFixed(d % 1_000_000 ? 1 : 0) + "M";
    if (d >= 1000) return "$" + Math.round(d / 1000) + "k";
    return "$" + Math.round(d);
  }

  async function loadLeaderboard() {
    const el = document.getElementById("board-list");
    try {
      const data = await fetch("/api/donations/leaderboard").then((r) => r.json());
      const donors = data.donors || [];
      if (!donors.length) {
        el.innerHTML = `
          <li class="empty-state board-empty">
            <div class="board-empty-art">🏆</div>
            <strong>Be the first hero on the wall.</strong>
            <span>Tap any amount on the donate strip below and your name lands here.</span>
          </li>`;
        return;
      }
      el.innerHTML = donors.map((d, i) => `
        <li class="board-row ${i < 3 ? "is-top" : ""}">
          <span class="board-rank">${i + 1}</span>
          <div class="board-body">
            <strong>${escapeHtml(d.name || "Anonymous")}</strong>
            ${d.message ? `<p class="board-msg">"${escapeHtml(d.message)}"</p>` : ""}
          </div>
          <span class="board-amount">${fmtMoney(d.amountCents)}</span>
        </li>`).join("");
    } catch {
      el.innerHTML = `<li class="empty-state">Couldn't load donor list.</li>`;
    }
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[<>&"']/g, (c) => ({
      "<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&#39;",
    })[c]);
  }

  // Donation success/cancelled toast on return from Stripe (when redirected
  // back to /research via the checkout success_url — see worker).
  const params = new URLSearchParams(location.search);
  if (params.get("donation") === "success") {
    toast("Thank you. Your donation is processing 💖", "ok");
    history.replaceState({}, "", "/research");
    setTimeout(loadLeaderboard, 2000);
  } else if (params.get("donation") === "cancelled") {
    toast("Donation cancelled.", "err");
    history.replaceState({}, "", "/research");
  }
  function toast(text, tone = "ok") {
    const stack = document.getElementById("toast-stack");
    if (!stack) return;
    const t = document.createElement("div");
    t.className = `toast toast-${tone}`;
    t.textContent = text;
    stack.appendChild(t);
    requestAnimationFrame(() => t.classList.add("in"));
    setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 250); }, 3000);
  }
})();
