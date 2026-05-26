// /donate — research crowdfunding page with milestone roadmap + Stripe.
console.info("EndoMe donate build v1");

(() => {
  const fmtMoney = (cents, withCurrency = false) => {
    const dollars = (cents || 0) / 100;
    const s = dollars >= 1000
      ? "$" + Math.round(dollars).toLocaleString()
      : "$" + dollars.toLocaleString(undefined, { minimumFractionDigits: dollars % 1 ? 2 : 0, maximumFractionDigits: 2 });
    return withCurrency ? `${s} AUD` : s;
  };

  let selectedCents = 2500;
  const modal = document.getElementById("donate-modal");

  // --- Boot ----------------------------------------------------------
  (async () => {
    await Promise.all([loadTotals(), loadLeaderboard()]);
    // If we just came back from a successful Stripe redirect, celebrate.
    const params = new URLSearchParams(location.search);
    if (params.get("donation") === "success") {
      toast("Thank you — your donation is processing 💖", "ok");
      // Webhook handler timestamps the completion; refresh shortly after.
      setTimeout(() => { loadTotals(); loadLeaderboard(); }, 2000);
      history.replaceState({}, "", "/donate");
    } else if (params.get("donation") === "cancelled") {
      toast("Donation cancelled.", "err");
      history.replaceState({}, "", "/donate");
    }
  })();

  // --- Totals + roadmap ---------------------------------------------
  async function loadTotals() {
    try {
      const data = await fetchJson("/api/donations/totals");
      paintTotals(data);
      // Graph rendering + milestone-detail modal handled by home-donate.js
      // (shared between this page and the homepage).
    } catch (err) {
      document.getElementById("raise-next").textContent = "Couldn't load roadmap.";
    }
  }
  function paintTotals(d) {
    document.getElementById("raised-amount").textContent = fmtMoney(d.totalCents);
    document.getElementById("raised-goal").textContent   = `of ${fmtMoney(d.totalGoalCents)} total roadmap`;
    document.getElementById("raised-count").textContent  = d.donationCount;
    const pct = Math.min(100, (d.totalCents / d.totalGoalCents) * 100);
    document.getElementById("raise-bar-fill").style.width = pct + "%";
    // Highlight next milestone in the header card.
    const next = d.milestones[d.activeIndex >= 0 ? d.activeIndex : d.milestones.length - 1];
    const remaining = Math.max(0, next.cumulativeCents - d.totalCents);
    document.getElementById("raise-next").innerHTML = d.activeIndex < 0
      ? `<strong>All milestones unlocked.</strong> Thank you. We're still raising — keep going.`
      : `<strong>${fmtMoney(remaining)}</strong> away from <strong>${next.emoji} ${escapeHtml(next.title)}</strong>`;
  }

  function paintRoadmap(d) {
    const list = document.getElementById("roadmap-list");
    list.innerHTML = d.milestones.map((m, i) => {
      const isActive = i === d.activeIndex;
      const state = m.reached ? "reached" : isActive ? "active" : "locked";
      return `<li class="roadmap-item is-${state}" data-key="${m.key}">
        <div class="roadmap-dot">
          <span class="roadmap-step">${i + 1}</span>
          ${m.reached ? `<span class="roadmap-check">✓</span>` : ""}
        </div>
        <div class="roadmap-card">
          <div class="roadmap-head">
            <span class="roadmap-emoji">${m.emoji}</span>
            <div>
              <strong>${escapeHtml(m.title)}</strong>
              <span class="roadmap-amount">${fmtMoney(m.targetCents)}</span>
            </div>
            <span class="roadmap-state-pill">${m.reached ? "Unlocked" : isActive ? "In progress" : "Locked"}</span>
          </div>
          <p class="roadmap-summary">${escapeHtml(m.summary)}</p>
          <div class="roadmap-bar"><div class="roadmap-bar-fill" style="width:${m.progress}%"></div></div>
          <div class="roadmap-meta">
            <span>${m.progress}% of this milestone</span>
            <span>Cumulative goal: ${fmtMoney(m.cumulativeCents)}</span>
          </div>
        </div>
      </li>`;
    }).join("");
  }

  // --- Leaderboard --------------------------------------------------
  async function loadLeaderboard() {
    const el = document.getElementById("board-list");
    try {
      const data = await fetchJson("/api/donations/leaderboard");
      const donors = data.donors || [];
      if (!donors.length) {
        el.innerHTML = `<li class="empty-state">Be the first hero on the wall. Tap Donate above.</li>`;
        return;
      }
      el.innerHTML = donors.map((d, i) => `
        <li class="board-row ${i < 3 ? "is-top" : ""}">
          <span class="board-rank">${i + 1}</span>
          <div class="board-body">
            <strong>${escapeHtml(d.name)}</strong>
            ${d.message ? `<p class="board-msg">"${escapeHtml(d.message)}"</p>` : ""}
          </div>
          <span class="board-amount">${fmtMoney(d.amountCents)}</span>
        </li>`).join("");
    } catch {
      el.innerHTML = `<li class="empty-state">Couldn't load donor list.</li>`;
    }
  }

  // --- Modal --------------------------------------------------------
  document.getElementById("donate-cta").addEventListener("click", openModal);
  document.querySelectorAll("[data-close-donate]").forEach((el) =>
    el.addEventListener("click", closeModal));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("open")) closeModal();
  });
  function openModal() {
    modal.classList.add("open"); modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
  }
  function closeModal() {
    modal.classList.remove("open"); modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }

  // Preset amounts
  document.querySelectorAll(".amt-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".amt-chip").forEach((c) => c.classList.toggle("on", c === chip));
      selectedCents = +chip.dataset.amount;
      document.getElementById("custom-amount").value = "";
      updateGoLabel();
    });
  });

  document.getElementById("custom-amount").addEventListener("input", (e) => {
    const dollars = Number(e.target.value);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      selectedCents = 2500; // fall back to default $25 if cleared
    } else {
      selectedCents = Math.round(dollars * 100);
      document.querySelectorAll(".amt-chip").forEach((c) => c.classList.remove("on"));
    }
    updateGoLabel();
  });

  function updateGoLabel() {
    document.getElementById("donate-go-amount").textContent = fmtMoney(selectedCents);
  }

  // Submit → create Stripe Checkout session → redirect
  document.getElementById("donate-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = document.getElementById("donate-status");
    const btn    = document.getElementById("donate-go");
    if (selectedCents < 200) {
      status.textContent = "Minimum donation is $2.";
      status.className = "form-status err";
      return;
    }
    status.textContent = "Redirecting to Stripe…";
    status.className = "form-status";
    btn.disabled = true;
    try {
      const data = await fetchJson("/api/donations/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amountCents: selectedCents,
          donorName:    document.getElementById("donor-name").value.trim() || null,
          donorMessage: document.getElementById("donor-message").value.trim() || null,
          anonymous:    document.getElementById("donor-anonymous").checked,
        }),
      });
      if (!data.url) throw new Error("Checkout URL missing.");
      location.href = data.url;
    } catch (err) {
      status.textContent = err.message || "Couldn't start checkout.";
      status.className = "form-status err";
      btn.disabled = false;
    }
  });

  // --- Helpers ------------------------------------------------------
  async function fetchJson(url, init = {}) {
    const res = await fetch(url, { credentials: "same-origin", ...init });
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
    setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 250); }, 3500);
  }
})();
