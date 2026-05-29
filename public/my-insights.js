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
    await loadInsights();
    await maybeShowAdmin();
    document.getElementById("page-loader")?.classList.add("is-hidden");
  })();

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
