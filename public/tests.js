(() => {
  // ---- post-checkout return banner --------------------------------------
  const qs = new URLSearchParams(location.search);
  const checkout = qs.get("checkout");
  const justBoughtTest = qs.get("test");
  if (checkout) {
    const name = testName(justBoughtTest);
    if (checkout === "success") {
      // Webhook usually fires within a couple of seconds — refresh state
      // shortly after the page paints so the card flips to "ordered".
      setTimeout(refreshTests, 2500);
      toast(`${name} ordered — confirmation email on its way 🌸`);
    } else if (checkout === "cancelled") {
      toast("Order cancelled — no charge was made", "err");
    }
    history.replaceState({}, "", "/tests");
  }

  // ---- initial load -----------------------------------------------------
  fetch("/api/me/today", { credentials: "same-origin" })
    .then((r) => (r.status === 401 ? (location.href = "/login") : r.json()))
    .then((data) => {
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = data?.user?.displayName || data?.user?.username || "there";
      });
      paint(data?.tests || {});
    })
    .catch(() => {})
    .finally(() => {
      document.getElementById("page-loader")?.classList.add("is-hidden");
    });

  async function refreshTests() {
    try {
      const data = await fetch("/api/me/today", { credentials: "same-origin" }).then((r) => r.json());
      paint(data?.tests || {});
    } catch {}
  }

  function paint(tests) {
    for (const [testId, state] of Object.entries(tests)) {
      const card = document.querySelector(`.test-card[data-test="${testId}"]`);
      if (!card) continue;
      const btn = card.querySelector(".test-action");
      if (!btn) continue;

      // Clean prior states
      card.classList.remove("is-pending", "is-complete");

      if (state.resultsAt) {
        card.classList.add("is-complete");
        btn.outerHTML = `<span class="test-done">✓ Results received</span>`;
      } else if (state.orderedAt) {
        card.classList.add("is-pending");
        btn.dataset.action = "upload";
        btn.textContent = "Upload results";
      } else {
        btn.dataset.action = "order";
        btn.textContent = `Request ${testName(testId)}`;
      }
    }
  }

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".test-action");
    if (!btn) return;
    e.preventDefault();

    const testId  = btn.dataset.test;
    const action  = btn.dataset.action;
    const original = btn.textContent;
    btn.disabled = true;

    try {
      if (action === "order") {
        // Real Stripe Checkout — browser navigates to Stripe-hosted page.
        btn.textContent = "Opening Stripe…";
        const res = await fetch(`/api/me/checkout/${testId}`, {
          method: "POST",
          credentials: "same-origin",
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.url) {
          location.href = data.url;
          return; // leaving the page
        }
        toast(data.error || "Couldn't start checkout", "err");
      } else if (action === "upload") {
        btn.textContent = "Saving…";
        const res = await fetch(`/api/me/results/${testId}`, {
          method: "POST",
          credentials: "same-origin",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast(data.error || "Couldn't save", "err");
        } else {
          toast(`${testName(testId)} results recorded`);
          await refreshTests();
          return;
        }
      }
    } catch {
      toast("Network error", "err");
    } finally {
      // Only re-enable if the click didn't navigate away.
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  function testName(id) {
    return { dna: "EndoMe DNA", bloods: "EndoMe Bloods", map: "EndoMe Map" }[id] || "Test";
  }

  // ---- Sub-nav: Order tests / My results --------------------------------
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
      if (target === "results" && !resultsLoaded) loadResults();
      document.querySelector(".page-subnav")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  // ---- Results list ------------------------------------------------------
  const KIND_META = {
    dna:    { emoji: "🧬", label: "EndoMe DNA",   tagline: "Genetic blueprint" },
    bloods: { emoji: "🩸", label: "EndoMe Bloods", tagline: "Blood biomarkers" },
    map:    { emoji: "🗺️", label: "EndoMe Map",   tagline: "Hormone profile" },
    hormone:{ emoji: "🗺️", label: "EndoMe Map",   tagline: "Hormone profile" },
  };
  let resultsLoaded = false;
  let resultsCache = [];

  async function loadResults() {
    resultsLoaded = true;
    const list = document.getElementById("results-list");
    try {
      const data = await fetchJson("/api/me/test-results");
      resultsCache = data.results || [];
      paintResultsList();
      paintOrderSidebar();
    } catch (err) {
      list.innerHTML = `<li class="empty-state">${escapeHtml(err.message || "Couldn't load.")}</li>`;
    }
  }

  function paintResultsList() {
    const list = document.getElementById("results-list");
    if (!resultsCache.length) {
      list.innerHTML = `<li class="results-empty">
        <div class="results-empty-art">📊</div>
        <strong>No results in yet.</strong>
        <span>Once your tests are assessed they'll land here automatically — values, trends, and a write-up of what they mean.</span>
      </li>`;
      return;
    }
    list.innerHTML = resultsCache.map(resultCard).join("");
    list.querySelectorAll("[data-open-result]").forEach((el) => {
      el.addEventListener("click", () => openResult(+el.dataset.openResult));
    });
  }

  function resultCard(r) {
    const meta = KIND_META[r.kind] || KIND_META.dna;
    const d = new Date(r.assessedAt * 1000);
    const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return `<li class="result-card kind-${escapeHtml(r.kind)}" data-open-result="${r.id}">
      <div class="result-emoji">${meta.emoji}</div>
      <div class="result-body">
        <span class="result-eyebrow">${escapeHtml(meta.label)} · ${escapeHtml(date)}</span>
        <strong class="result-title">${escapeHtml(r.title)}</strong>
        <p class="result-summary">${escapeHtml(r.summary || "")}</p>
      </div>
      <span class="result-arrow">→</span>
    </li>`;
  }

  function paintOrderSidebar() {
    const el = document.getElementById("results-order-list");
    if (!el) return;
    const haveKinds = new Set(resultsCache.map((r) => r.kind));
    const missing = ["dna","bloods","map"].filter((k) => !haveKinds.has(k));
    if (!missing.length) {
      el.innerHTML = `<li class="results-side-done">✓ You've taken all three panels. New results show here as they're assessed.</li>`;
      return;
    }
    el.innerHTML = missing.map((k) => {
      const m = KIND_META[k];
      return `<li class="results-order-row">
        <span class="result-emoji small">${m.emoji}</span>
        <div>
          <strong>${escapeHtml(m.label)}</strong>
          <span class="results-order-tag">${escapeHtml(m.tagline)}</span>
        </div>
        <button type="button" class="btn-soft small" data-jump-order="${k}">Order</button>
      </li>`;
    }).join("");
    el.querySelectorAll("[data-jump-order]").forEach((b) => {
      b.addEventListener("click", () => {
        // Switch to the Order tab and scroll the matching card into view.
        document.querySelector(".subnav-tab[data-tab-target='order']")?.click();
        setTimeout(() => {
          const card = document.querySelector(`.test-card[data-test="${b.dataset.jumpOrder}"]`);
          card?.scrollIntoView({ behavior: "smooth", block: "center" });
          card?.classList.add("flash"); setTimeout(() => card?.classList.remove("flash"), 1400);
        }, 250);
      });
    });
  }

  // ---- Result detail modal ----------------------------------------------
  const resultModal = document.getElementById("result-modal");
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-result]")) {
      resultModal.classList.remove("open");
      resultModal.setAttribute("aria-hidden", "true");
    }
  });

  async function openResult(id) {
    const body = document.getElementById("result-modal-body");
    body.innerHTML = `<p class="empty-state small">Loading the full report…</p>`;
    resultModal.classList.add("open");
    resultModal.setAttribute("aria-hidden", "false");
    try {
      const data = await fetchJson(`/api/me/test-results/${id}`);
      paintResultDetail(data.result);
    } catch (err) {
      body.innerHTML = `<p class="empty-state small">${escapeHtml(err.message || "Couldn't load.")}</p>`;
    }
  }

  function paintResultDetail(r) {
    const meta = KIND_META[r.kind] || KIND_META.dna;
    const date = new Date(r.assessedAt * 1000)
      .toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const d = r.data || {};
    const themes = d.overview?.themes || [];

    let body = `
      <header class="result-hero kind-${escapeHtml(r.kind)}">
        <span class="result-hero-emoji">${meta.emoji}</span>
        <div>
          <p class="result-hero-eyebrow">${escapeHtml(meta.label)} · assessed ${escapeHtml(date)}</p>
          <h2>${escapeHtml(r.title)}</h2>
          ${r.summary ? `<p class="result-hero-summary">${escapeHtml(r.summary)}</p>` : ""}
        </div>
      </header>

      ${themes.length ? `<section class="result-section">
        <h3>At a glance</h3>
        <ul class="theme-list">
          ${themes.map((t) => `<li class="theme-pill theme-${escapeHtml(t.tone || "ok")}">
            <strong>${escapeHtml(t.label)}</strong>
            <span>${escapeHtml(t.score)}</span>
          </li>`).join("")}
        </ul>
      </section>` : ""}
    `;

    // DNA-style sections (qualitative)
    if (r.kind === "dna") {
      for (const sec of (d.sections || [])) {
        body += `<section class="result-section">
          <h3>${escapeHtml(sec.title)}</h3>
          <ul class="dna-list">
            ${sec.metrics.map(dnaRow).join("")}
          </ul>
        </section>`;
      }
      if (d.actions?.length) {
        body += `<section class="result-section">
          <h3>What to do this month</h3>
          <ul class="action-list">
            ${d.actions.map((a) => `<li class="action-row"><span>${escapeHtml(a.emoji || "✨")}</span><span>${escapeHtml(a.label)}</span></li>`).join("")}
          </ul>
        </section>`;
      }
    }

    // Bloods-style markers (quantitative bars)
    if (r.kind === "bloods" || r.kind === "map" || r.kind === "hormone") {
      const groups = r.kind === "bloods"
        ? [{ title: "Markers", items: d.markers || [] }]
        : [
            { title: "Oestrogens", items: d.estrogens || [] },
            { title: "Oestrogen metabolites", items: d.metabolites || [] },
            { title: "Progesterone", items: d.progesterone || [] },
            { title: "Cortisol rhythm", items: d.cortisol || [] },
            { title: "Androgens", items: d.androgens || [] },
          ];
      for (const g of groups) {
        if (!g.items?.length) continue;
        body += `<section class="result-section">
          <h3>${escapeHtml(g.title)}</h3>
          <ul class="marker-list">
            ${g.items.map(markerRow).join("")}
          </ul>
        </section>`;
      }
    }

    document.getElementById("result-modal-body").innerHTML = body;
  }

  function dnaRow(m) {
    const tone = m.status === "warn" ? "warn" : m.status === "slow" ? "warn" : "ok";
    return `<li class="dna-row tone-${tone}">
      <div class="dna-row-head">
        <strong>${escapeHtml(m.name)}</strong>
        <span class="dna-value">${escapeHtml(m.value)}</span>
      </div>
      <p class="dna-note">${escapeHtml(m.note || "")}</p>
    </li>`;
  }

  // Marker bar — visualises value vs reference range, with markers for the
  // community cohort average and the user's previous reading so trends are
  // immediately legible.
  function markerRow(m) {
    const low = +m.low, high = +m.high;
    const span = Math.max(high - low, 0.0001);
    // Render a bar that visually extends ~20% beyond each end of the range
    // so out-of-range values still land within the bar.
    const visualLow = low - span * 0.25;
    const visualHigh = high + span * 0.25;
    const vSpan = visualHigh - visualLow;
    const pctFor = (v) => Math.max(0, Math.min(100, ((+v - visualLow) / vSpan) * 100));
    const valuePct = pctFor(m.value);
    const lowPct = pctFor(low);
    const highPct = pctFor(high);
    const cohortPct = m.cohort != null ? pctFor(m.cohort) : null;
    const prevPct = m.prev != null ? pctFor(m.prev) : null;
    const tone = m.tone === "warn" ? "warn" : "ok";
    const delta = m.prev != null ? +m.value - +m.prev : null;
    const deltaArrow = delta == null ? "" : delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
    return `<li class="marker-row tone-${tone}">
      <div class="marker-head">
        <strong>${escapeHtml(m.name)}</strong>
        <span class="marker-value">${escapeHtml(String(m.value))} <em>${escapeHtml(m.unit || "")}</em>
          ${delta != null ? `<span class="marker-delta ${delta > 0 ? "up" : delta < 0 ? "down" : ""}">${deltaArrow} ${escapeHtml(String(Math.abs(Math.round(delta * 100) / 100)))}</span>` : ""}
        </span>
      </div>
      <div class="marker-bar-wrap" data-tip="Reference range ${escapeHtml(String(low))}–${escapeHtml(String(high))} ${escapeHtml(m.unit || "")}${m.cohort != null ? " · community avg " + escapeHtml(String(m.cohort)) : ""}${m.prev != null ? " · previous " + escapeHtml(String(m.prev)) : ""}">
        <div class="marker-bar">
          <div class="marker-range" style="left:${lowPct}%;right:${100 - highPct}%"></div>
          ${cohortPct != null ? `<span class="marker-mark cohort" style="left:${cohortPct}%" title="Community average"></span>` : ""}
          ${prevPct != null ? `<span class="marker-mark prev" style="left:${prevPct}%" title="Your previous"></span>` : ""}
          <span class="marker-fill ${tone}" style="left:0;width:${valuePct}%"></span>
          <span class="marker-mark you" style="left:${valuePct}%" title="You"></span>
        </div>
        <div class="marker-axis">
          <span>${escapeHtml(String(low))}</span>
          <span class="marker-axis-mid">range</span>
          <span>${escapeHtml(String(high))}</span>
        </div>
      </div>
      ${m.note ? `<p class="marker-note">${escapeHtml(m.note)}</p>` : ""}
    </li>`;
  }

  // ---- helpers -----------------------------------------------------------
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
    setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 250); }, 2400);
  }
})();
