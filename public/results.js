// /results — list of assessed test results + detail modal with rich
// infographics. Reads from /api/me/test-results and renders DNA, Bloods
// and Map (hormone) reports in distinct shapes — qualitative for DNA,
// marker-bar charts for Bloods + Hormone.
(() => {
  const KIND_META = {
    dna:    { emoji: "🧬", label: "EndoMe DNA",   tagline: "Genetic blueprint" },
    bloods: { emoji: "🩸", label: "EndoMe Bloods", tagline: "Blood biomarkers" },
    map:    { emoji: "🗺️", label: "EndoMe Map",   tagline: "Hormone profile" },
    hormone:{ emoji: "🗺️", label: "EndoMe Map",   tagline: "Hormone profile" },
  };
  let resultsCache = [];

  (async () => {
    try {
      const me = await fetchJson("/api/me/today");
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = me?.user?.displayName || me?.user?.username || "there";
      });
    } catch {}
    await loadResults();
    document.getElementById("page-loader")?.classList.add("is-hidden");
  })();

  async function loadResults() {
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
        <span>Once your tests are assessed they'll land here automatically — values, trends, and a write-up of what they mean. Order a panel from the <a href="/tests" style="color:#ff4e8a;font-weight:700">Tests</a> page to get started.</span>
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
        <a class="btn-soft small" href="/tests">Order</a>
      </li>`;
    }).join("");
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

      // Legend explaining the marker bar overlay symbols.
      body += `<section class="result-section">
        <h3>How to read the bars</h3>
        <ul class="marker-legend">
          <li><span class="marker-mark you"></span><span><strong>You</strong> — your current value</span></li>
          <li><span class="marker-mark cohort"></span><span><strong>Community avg</strong> — where other EndoMe users with the same panel typically sit</span></li>
          <li><span class="marker-mark prev"></span><span><strong>Previous</strong> — your reading from the last time you took this panel</span></li>
          <li><span class="legend-swatch"></span><span><strong>Reference range</strong> — pink-shaded area is the healthy band</span></li>
        </ul>
      </section>`;
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

  function markerRow(m) {
    const low = +m.low, high = +m.high;
    const span = Math.max(high - low, 0.0001);
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
})();
