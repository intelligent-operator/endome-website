// /research — signed-in dashboard view of the donation roadmap.
// home-donate.js paints the chart + milestone modal + the instant-donate row.
// This file is responsible for the username bind + leaderboard + page loader.
console.info("EndoMe research build v1");

(() => {
  (async () => {
    try {
      const me = await fetch("/api/me/today", { credentials: "same-origin" }).then((r) => r.json());
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = me?.user?.displayName || me?.user?.username || "there";
      });
    } catch {}

    await loadLeaderboard();
    document.getElementById("page-loader")?.classList.add("is-hidden");
  })();

  async function loadLeaderboard() {
    const el = document.getElementById("board-list");
    try {
      const data = await fetch("/api/donations/leaderboard").then((r) => r.json());
      const donors = data.donors || [];
      if (!donors.length) {
        el.innerHTML = `<li class="empty-state">Be the first hero on the wall. Tap a donate amount above.</li>`;
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

  function fmtMoney(cents) {
    const d = (cents || 0) / 100;
    return "$" + d.toLocaleString(undefined, { minimumFractionDigits: d % 1 ? 2 : 0, maximumFractionDigits: 2 });
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
