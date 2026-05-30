// /my-insights — list of EndoMe insight cards built from the user's logged
// health data. Each card shows the latest write-up; a refresh button re-runs
// the underlying prompt. Admin users see an extra config panel to tune the
// prompts themselves.
console.info("EndoMe insights build v2");

(() => {
  let engineInfo = { aiConfigured: false, aiBackend: null };
  let insights = [];

  (async () => {
    try {
      const me = await fetchJson("/api/me/today");
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = me?.user?.displayName || me?.user?.username || "there";
      });
    } catch {}
    await Promise.all([loadInsights(), loadCycleCorrelation()]);
    await maybeShowAdmin();
    document.getElementById("page-loader")?.classList.add("is-hidden");
  })();

  // --- Symptom-by-cycle correlation chart -------------------------------
  // Pure data viz, no Bedrock — averages each tracked metric (pain, fatigue,
  // bloating, mood-low) per cycle day across the user's last ~3 cycles.
  async function loadCycleCorrelation() {
    let data;
    try { data = await fetchJson("/api/me/cycle-correlation"); } catch { return; }
    const section = document.getElementById("cycle-corr-section");
    const days = data.days || [];
    const anyData = days.some((d) => Object.entries(d).some(([k, v]) => k !== "day" && k !== "phase" && typeof v === "number" && v > 0));
    if (!anyData) { section.hidden = true; return; }
    section.hidden = false;
    paintCycleCorrelation(data);
  }

  function paintCycleCorrelation(data) {
    const legend = document.getElementById("cycle-corr-legend");
    legend.innerHTML = data.groups.map((g) =>
      `<button type="button" class="cc-leg-chip on" data-group="${g.key}" style="--cc-color:${g.color}">
        <span class="cc-leg-dot"></span>${escapeHtml(g.label)}
      </button>`).join("");
    const visible = new Set(data.groups.map((g) => g.key));
    legend.querySelectorAll(".cc-leg-chip").forEach((b) => {
      b.addEventListener("click", () => {
        const key = b.dataset.group;
        if (visible.has(key) && visible.size > 1) { visible.delete(key); b.classList.remove("on"); }
        else { visible.add(key); b.classList.add("on"); }
        drawChart();
      });
    });

    const chart = document.getElementById("cycle-corr-chart");
    const caption = document.getElementById("cycle-corr-caption");
    document.getElementById("cycle-corr-sub").textContent =
      `Averaged from your last ${data.cyclesCovered} cycle${data.cyclesCovered === 1 ? "" : "s"} · ${data.sampleSize.symptoms} symptom entries`;

    function drawChart() {
      const W = 720, H = 240, padL = 36, padR = 12, padT = 16, padB = 32;
      const innerW = W - padL - padR, innerH = H - padT - padB;
      const xs = (day) => padL + ((day - 1) / 34) * innerW;
      const ys = (v) => padT + innerH - (v / 100) * innerH;

      // Phase background bands so the cycle context is visible at a glance.
      const phaseBand = (from, to, color) =>
        `<rect x="${xs(from)}" y="${padT}" width="${xs(to) - xs(from)}" height="${innerH}" fill="${color}" opacity=".55"/>`;
      const bands = [
        phaseBand(1, 5,  "#ffe6ef"),
        phaseBand(5, 13, "#fff8f0"),
        phaseBand(13, 16, "#fff0f9"),
        phaseBand(16, 35, "#f6f0ff"),
      ].join("");

      // Phase labels at the top of each band.
      const phaseLabels = `
        <text x="${xs(3)}"  y="${padT - 4}" class="cc-phase">menstrual</text>
        <text x="${xs(9)}"  y="${padT - 4}" class="cc-phase">follicular</text>
        <text x="${xs(14.5)}" y="${padT - 4}" class="cc-phase">ovul.</text>
        <text x="${xs(25)}" y="${padT - 4}" class="cc-phase">luteal</text>`;

      // X-axis day ticks every 7 days.
      let xTicks = "";
      for (let d = 1; d <= 35; d += 7) {
        xTicks += `<line x1="${xs(d)}" y1="${padT + innerH}" x2="${xs(d)}" y2="${padT + innerH + 4}" stroke="#ffd6e0"/>
          <text x="${xs(d)}" y="${padT + innerH + 16}" class="cc-axis">${d}</text>`;
      }
      // Y-axis 0/50/100.
      let yGrid = "";
      for (const v of [0, 25, 50, 75, 100]) {
        const y = ys(v);
        yGrid += `<line x1="${padL}" y1="${y}" x2="${padL + innerW}" y2="${y}" stroke="#fff0f5"/>
          <text x="${padL - 6}" y="${y + 3}" class="cc-axis cc-axis-right">${v}</text>`;
      }

      // One line per visible group.
      const series = data.groups.filter((g) => visible.has(g.key)).map((g) => {
        const pts = data.days
          .map((d) => d[g.key] != null ? `${xs(d.day)},${ys(d.day === 0 ? 0 : d[g.key])}` : null)
          .filter(Boolean);
        if (pts.length < 2) return "";
        return `<polyline points="${pts.join(" ")}" fill="none" stroke="${g.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>` +
               data.days.filter((d) => d[g.key] != null).map((d) =>
                 `<circle cx="${xs(d.day)}" cy="${ys(d[g.key])}" r="3" fill="${g.color}" data-day="${d.day}" data-group="${g.key}"/>`
               ).join("");
      }).join("");

      // "You are here" marker.
      let today = "";
      if (data.todayCycleDay && data.todayCycleDay >= 1 && data.todayCycleDay <= 35) {
        today = `<line x1="${xs(data.todayCycleDay)}" y1="${padT}" x2="${xs(data.todayCycleDay)}" y2="${padT + innerH}" stroke="#ff4e8a" stroke-width="1.5" stroke-dasharray="3 3"/>
          <text x="${xs(data.todayCycleDay)}" y="${padT - 4}" class="cc-today">today</text>`;
      }

      chart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="cc-svg">
        ${bands}${phaseLabels}${yGrid}${xTicks}${series}${today}
      </svg>`;

      chart.querySelectorAll("circle[data-day]").forEach((c) => {
        c.addEventListener("mouseenter", () => {
          const day = +c.dataset.day;
          const bucket = data.days.find((d) => d.day === day);
          if (!bucket) return;
          const parts = data.groups
            .filter((g) => bucket[g.key] != null)
            .map((g) => `<span style="color:${g.color}"><strong>${escapeHtml(g.label)}</strong>: ${bucket[g.key]}</span>`)
            .join(" · ");
          caption.innerHTML = `<strong>Day ${day}</strong> (${escapeHtml(bucket.phase)}) — ${parts}`;
        });
      });
    }

    drawChart();
  }

  async function loadInsights() {
    try {
      const data = await fetchJson("/api/me/insights");
      engineInfo = data;
      insights = data.insights || [];
      paintInsights();
    } catch (err) {
      document.getElementById("insights-list").innerHTML =
        `<li class="empty-state">${escapeHtml(err.message || "Couldn't load.")}</li>`;
    }
  }

  function paintInsights() {
    const list = document.getElementById("insights-list");
    if (!insights.length) {
      list.innerHTML = `<li class="empty-state">No insights configured yet.</li>`;
      return;
    }
    list.innerHTML = insights.map(insightCard).join("");
    list.querySelectorAll("[data-run-insight]").forEach((b) => {
      b.addEventListener("click", () => runInsight(b.dataset.runInsight, b));
    });
  }

  function insightCard(it) {
    const r = it.latest;
    const running = r?.status === "running";
    const error   = r?.status === "error";
    const ok      = r?.status === "ok";
    const ts = r ? new Date(r.generatedAt * 1000).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }) : null;
    const body = !r
      ? `<p class="insight-empty">Nothing generated yet. Hit <strong>Run insight</strong> to build your first write-up.</p>`
      : running
        ? `<p class="insight-running"><span class="spinner"></span> Reading through your data…</p>`
        : error
          ? `<p class="insight-error">⚠ ${escapeHtml(r.error || "Couldn't generate this insight just yet.")}</p>`
          : `<div class="insight-output">${renderMarkdown(r.outputMd || "")}</div>`;
    // Token counters are admin-only diagnostics, not user copy — hide them
    // unless the URL explicitly asks for the debug view.
    const tokens = "";
    return `<li class="insight-card ${ok ? "is-ok" : ""} ${error ? "is-error" : ""}">
      <header class="insight-card-head">
        <div class="insight-card-title">
          <span class="insight-emoji">${escapeHtml(it.emoji || "✨")}</span>
          <div>
            <strong>${escapeHtml(it.title)}</strong>
            <p>${escapeHtml(it.description || "")}</p>
          </div>
        </div>
        <button type="button" class="btn-soft small" data-run-insight="${escapeHtml(it.slug)}" ${running ? "disabled" : ""}>
          ${running ? "Running…" : r ? "Refresh" : "Run insight"}
        </button>
      </header>
      <div class="insight-card-body">${body}</div>
      <footer class="insight-card-foot">
        ${ts ? `<span class="insight-time">Last generated ${escapeHtml(ts)}</span>` : ""}
        ${tokens}
      </footer>
    </li>`;
  }

  async function runInsight(slug, btn) {
    if (!engineInfo.aiConfigured) {
      toast("Insights engine isn't connected — give it a moment, then try again.", "err");
      return;
    }
    btn.disabled = true;
    btn.textContent = "Running…";
    try {
      await fetchJson(`/api/me/insights/${slug}/run`, { method: "POST" });
      // Server fires the engine call in ctx.waitUntil so the POST returns fast.
      // Poll the list a few times until status flips to ok/error.
      let tries = 0;
      const poll = async () => {
        tries++;
        await loadInsights();
        const target = insights.find((x) => x.slug === slug);
        if (target?.latest?.status === "running" && tries < 30) {
          setTimeout(poll, 1500);
        }
      };
      setTimeout(poll, 800);
    } catch (err) {
      toast(err.message || "Couldn't run insight", "err");
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------------
  // Admin: prompt configuration
  // ------------------------------------------------------------------
  async function maybeShowAdmin() {
    try {
      const r = await fetch("/api/acp/me", { credentials: "same-origin" });
      if (!r.ok) return; // not admin
      const data = await r.json();
      if (!data.admin) return;
      document.getElementById("admin-config-section").hidden = false;
    } catch {}
  }

  // ------------------------------------------------------------------
  // Tiny markdown renderer — handles headings, bold, italics, code,
  // bullet lists, numbered lists, paragraphs. Good enough for insight
  // output without pulling in a full markdown library.
  // ------------------------------------------------------------------
  function renderMarkdown(md) {
    const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<":"&lt;",">":"&gt;","&":"&amp;" })[c]);
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const lines = String(md || "").split(/\r?\n/);
    const out = [];
    let listKind = null;       // "ul" | "ol" | null
    let para = [];
    const flushPara = () => {
      if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; }
    };
    const closeList = () => {
      if (listKind) { out.push(`</${listKind}>`); listKind = null; }
    };
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { flushPara(); closeList(); continue; }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { flushPara(); closeList(); out.push(`<h${h[1].length+2}>${inline(h[2])}</h${h[1].length+2}>`); continue; }
      const ul = line.match(/^[-*•]\s+(.*)$/);
      if (ul) {
        flushPara();
        if (listKind !== "ul") { closeList(); out.push("<ul>"); listKind = "ul"; }
        out.push(`<li>${inline(ul[1])}</li>`);
        continue;
      }
      const ol = line.match(/^\d+[\.\)]\s+(.*)$/);
      if (ol) {
        flushPara();
        if (listKind !== "ol") { closeList(); out.push("<ol>"); listKind = "ol"; }
        out.push(`<li>${inline(ol[1])}</li>`);
        continue;
      }
      closeList();
      para.push(line);
    }
    flushPara(); closeList();
    return out.join("\n");
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
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
    setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 250); }, 2800);
  }
})();
