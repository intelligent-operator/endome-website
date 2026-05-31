// /acp — Admin Control Panel.
// Server already blocks non-admins from this page; the JS just talks to /api/acp/*.
(() => {
  const views = {
    overview:  document.getElementById("view-overview"),
    users:     document.getElementById("view-users"),
    circles:   document.getElementById("view-circles"),
    circle:    document.getElementById("view-circle"),
    insights:  document.getElementById("view-insights"),
    stories:   document.getElementById("view-stories"),
    resources: document.getElementById("view-resources"),
    foods:     document.getElementById("view-foods"),
    system:    document.getElementById("view-system"),
  };
  let allUsersCache = []; // for the add-member dropdown
  let currentCircleId = null;

  // --- Tabs ------------------------------------------------------------
  document.querySelectorAll(".acp-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      document.querySelectorAll(".acp-tab").forEach((t) => t.classList.toggle("active", t === tab));
      showView(name);
      if (name === "overview") loadOverview();
      if (name === "users") loadUsers();
      if (name === "circles") loadCircles();
      if (name === "insights") loadInsightsTab();
      if (name === "stories") loadStoriesTab();
      if (name === "resources") loadResourcesTab();
      if (name === "foods") loadFoodsTab();
    });
  });
  function showView(name) {
    if (views.overview) views.overview.hidden = name !== "overview";
    views.users.hidden    = name !== "users";
    views.circles.hidden  = name !== "circles";
    views.circle.hidden   = name !== "circle";
    if (views.insights)  views.insights.hidden  = name !== "insights";
    if (views.stories)   views.stories.hidden   = name !== "stories";
    if (views.resources) views.resources.hidden = name !== "resources";
    if (views.foods)     views.foods.hidden     = name !== "foods";
    if (views.system)    views.system.hidden    = name !== "system";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // --- Overview --------------------------------------------------------
  async function loadOverview() {
    try {
      const data = await fetchJson("/api/acp/dashboard");
      paintOverview(data);
      paintRightRail(data);
    } catch (err) {
      document.getElementById("overview-refreshed").textContent =
        "Couldn't load: " + (err.message || "failed");
    }
  }

  function paintOverview(d) {
    const fmt = (n) => (n ?? 0).toLocaleString();
    const tiles = document.getElementById("overview-stats");
    tiles.innerHTML = [
      tile("Total users",         fmt(d.counts.users.total)),
      tile("New (24h)",           fmt(d.counts.users.new24h)),
      tile("New (7d)",            fmt(d.counts.users.new7d)),
      tile("New (30d)",           fmt(d.counts.users.new30d)),
      tile("Insights ok (30d)",   fmt(d.ai.runs.ok30d)),
      tile("Insights errored (30d)", fmt(d.ai.runs.err30d), "danger"),
      tile("Tokens in (30d)",     fmt(d.ai.tokens.input30d)),
      tile("Tokens out (30d)",    fmt(d.ai.tokens.output30d)),
    ].join("");

    const act = document.getElementById("overview-activity");
    act.innerHTML = [
      miniStat("Symptoms logged",  fmt(d.counts.symptoms7d)),
      miniStat("Daily check-ins",  fmt(d.counts.dailyLogs7d)),
      miniStat("Community posts",  fmt(d.counts.posts7d)),
    ].join("");

    paintChart(d.aiCallsDaily || []);
    document.getElementById("overview-refreshed").textContent =
      "Refreshed " + new Date(d.generatedAt * 1000).toLocaleTimeString();
  }
  function tile(label, value, cls = "") {
    return `<div class="acp-stat-tile ${cls}">
      <span class="acp-stat-label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>`;
  }
  function miniStat(label, value) {
    return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
  }
  function paintChart(series) {
    const wrap = document.getElementById("ai-chart");
    if (!series.length) { wrap.innerHTML = `<p class="acp-empty">No calls yet.</p>`; return; }
    // Scale by the busiest day so the tallest bar fills the 160px chart.
    const max = Math.max(1, ...series.map((d) => (d.ok || 0) + (d.error || 0)));
    const cols = series.map((d) => {
      const total = (d.ok || 0) + (d.error || 0);
      const heightPct = (total / max) * 100;
      const okPct  = total ? (d.ok    / total) * heightPct : 0;
      const errPct = total ? (d.error / total) * heightPct : 0;
      const date = d.date.slice(5); // MM-DD
      const tip = `${d.date}: ${d.ok} ok, ${d.error} err`;
      return `<div class="acp-chart-col" data-tip="${escapeHtml(tip)}" style="height:${heightPct.toFixed(1)}%">
        <div class="ok"  style="height:${(total ? okPct  / heightPct * 100 : 0).toFixed(1)}%"></div>
        <div class="err" style="height:${(total ? errPct / heightPct * 100 : 0).toFixed(1)}%"></div>
      </div>`;
    }).join("");
    const axis = series.map((d) => `<span>${escapeHtml(d.date.slice(5))}</span>`).join("");
    wrap.innerHTML = `<div class="acp-chart" style="display:flex;gap:6px;align-items:flex-end;height:160px">${cols}</div>
      <div class="acp-chart-axis">${axis}</div>`;
  }

  function paintRightRail(d) {
    // Recent registrations
    const su = document.getElementById("side-users");
    if (!d.recentUsers.length) {
      su.innerHTML = `<li class="acp-side-empty">No sign-ups yet.</li>`;
    } else {
      su.innerHTML = d.recentUsers.map((u) => `<li>
        <span class="strong">${escapeHtml(u.displayName || u.username || u.id.slice(0,8))}</span>
        <span class="meta">${escapeHtml(u.email || u.username || "—")} · ${escapeHtml(timeAgo(u.createdAt))}</span>
      </li>`).join("");
    }

    // Recent engine errors
    const se = document.getElementById("side-errors");
    if (!d.recentErrors.length) {
      se.innerHTML = `<li class="acp-side-empty">No engine errors. 🎉</li>`;
    } else {
      se.innerHTML = d.recentErrors.map((r) => `<li>
        <span class="strong">${escapeHtml(r.displayName || r.username || r.userId.slice(0,8))}</span>
        <span class="meta">${escapeHtml(r.slug)} · ${escapeHtml(timeAgo(r.generatedAt))}</span>
        <span class="err-snippet" title="${escapeHtml(r.error || "")}">${escapeHtml((r.error || "").slice(0, 90))}</span>
      </li>`).join("");
    }

    // Bedrock counts
    const sb = document.getElementById("side-bedrock");
    sb.innerHTML = [
      `<div><span>OK (24h)</span><strong>${d.ai.runs.ok24h}</strong></div>`,
      `<div><span>Errors (24h)</span><strong>${d.ai.runs.err24h}</strong></div>`,
      `<div><span>OK (7d)</span><strong>${d.ai.runs.ok7d}</strong></div>`,
      `<div><span>Errors (7d)</span><strong>${d.ai.runs.err7d}</strong></div>`,
    ].join("");
  }

  function timeAgo(secs) {
    if (!secs) return "—";
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - secs);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  // --- Users -----------------------------------------------------------
  let userSearchTimer = null;
  document.getElementById("user-search").addEventListener("input", (e) => {
    clearTimeout(userSearchTimer);
    const q = e.target.value;
    userSearchTimer = setTimeout(() => loadUsers(q), 220);
  });

  async function loadUsers(q = "") {
    const card = document.getElementById("users-card");
    try {
      const url = q ? `/api/acp/users?q=${encodeURIComponent(q)}` : "/api/acp/users";
      const data = await fetchJson(url);
      allUsersCache = data.users || [];
      if (!allUsersCache.length) {
        card.innerHTML = `<p class="acp-empty">No users match "${escapeHtml(q)}".</p>`;
        return;
      }
      card.innerHTML = `
        <table class="acp-table">
          <thead><tr>
            <th>User</th><th>Email</th><th>Joined</th><th>Endo</th><th>Research</th><th>Circles</th><th>Symptoms</th>
          </tr></thead>
          <tbody>${allUsersCache.map(userRow).join("")}</tbody>
        </table>`;
    } catch (err) {
      card.innerHTML = `<p class="acp-empty">Couldn't load users: ${escapeHtml(err.message || "")}</p>`;
    }
  }
  function endoBadge(u) {
    if (u.endoStatus === "diagnosed") {
      const stageLabel = ({ stage_1:"S1", stage_2:"S2", stage_3:"S3", stage_4:"S4", unsure:"?" })[u.endoStage] || "";
      return `<span class="acp-pill" style="background:#ffe6ef;color:#a3174f">Dx${stageLabel ? ` · ${stageLabel}` : ""}</span>`;
    }
    if (u.endoStatus === "unknown") return `<span class="acp-pill" style="background:#fff5e6;color:#a16213">Watching</span>`;
    return `<span class="acp-meta">—</span>`;
  }
  function researchBadge(u) {
    return u.researchShareConsent
      ? `<span class="acp-pill" style="background:#dff5e0;color:#2b6f1f">✓ Sharing</span>`
      : `<span class="acp-meta">—</span>`;
  }
  function userRow(u) {
    return `<tr>
      <td>
        <div class="acp-username">${escapeHtml(u.displayName || u.username)}</div>
        <div class="acp-meta">@${escapeHtml(u.username)}</div>
      </td>
      <td>${escapeHtml(u.email || "—")}</td>
      <td>${fmtDate(u.createdAt)}</td>
      <td>${endoBadge(u)}</td>
      <td>${researchBadge(u)}</td>
      <td>${u.circleCount}</td>
      <td>${u.symptomCount}</td>
    </tr>`;
  }

  // --- Circles ---------------------------------------------------------
  async function loadCircles() {
    const card = document.getElementById("circles-card");
    try {
      const data = await fetchJson("/api/acp/circles");
      const list = data.circles || [];
      if (!list.length) {
        card.innerHTML = `<p class="acp-empty">No circles yet.</p>`;
        return;
      }
      card.innerHTML = `
        <table class="acp-table">
          <thead><tr>
            <th>Name</th><th>Slug</th><th>Members</th><th>Posts</th><th></th>
          </tr></thead>
          <tbody>${list.map(circleRow).join("")}</tbody>
        </table>`;
    } catch (err) {
      card.innerHTML = `<p class="acp-empty">Couldn't load circles: ${escapeHtml(err.message || "")}</p>`;
    }
  }
  function circleRow(c) {
    return `<tr class="acp-circle-row" data-circle-id="${c.id}" data-circle-name="${escapeHtml(c.name)}">
      <td>
        ${escapeHtml(c.name)} ${c.isOfficial ? `<span class="acp-pill official">Official</span>` : ""}
        ${c.description ? `<div class="acp-meta">${escapeHtml(c.description).slice(0, 100)}</div>` : ""}
      </td>
      <td><code>${escapeHtml(c.slug)}</code></td>
      <td>${c.memberCount}</td>
      <td>${c.postCount}</td>
      <td><div class="acp-actions"><button class="acp-btn primary" data-open="${c.id}">Manage</button></div></td>
    </tr>`;
  }
  document.getElementById("circles-card").addEventListener("click", (e) => {
    const row = e.target.closest("[data-circle-id]");
    if (!row) return;
    openCircle(+row.dataset.circleId, row.dataset.circleName);
  });

  // --- Circle detail (members) -----------------------------------------
  document.getElementById("back-to-circles").addEventListener("click", () => {
    document.querySelector('.acp-tab[data-tab="circles"]').click();
  });
  async function openCircle(id, name) {
    currentCircleId = id;
    document.getElementById("circle-title").textContent = name;
    document.querySelectorAll(".acp-tab").forEach((t) => t.classList.remove("active"));
    showView("circle");
    await loadMembers(id);
  }
  async function loadMembers(id) {
    const card = document.getElementById("members-card");
    try {
      const data = await fetchJson(`/api/acp/circles/${id}/members`);
      document.getElementById("circle-title").textContent = data.circle?.name || "Circle";
      const members = data.members || [];
      if (!members.length) {
        card.innerHTML = `<p class="acp-empty">No members yet.</p>`;
        return;
      }
      card.innerHTML = `
        <table class="acp-table">
          <thead><tr>
            <th>User</th><th>Email</th><th>Joined</th><th>Role</th><th></th>
          </tr></thead>
          <tbody>${members.map(memberRow).join("")}</tbody>
        </table>`;
    } catch (err) {
      card.innerHTML = `<p class="acp-empty">Couldn't load members: ${escapeHtml(err.message || "")}</p>`;
    }
  }
  function memberRow(m) {
    const roles = ["member", "moderator", "admin"];
    return `<tr data-member-id="${escapeHtml(m.userId)}">
      <td>
        <div class="acp-username">${escapeHtml(m.displayName || m.username || m.userId)}</div>
        ${m.username ? `<div class="acp-meta">@${escapeHtml(m.username)}</div>` : ""}
      </td>
      <td>${escapeHtml(m.email || "—")}</td>
      <td>${fmtDate(m.joinedAt)}</td>
      <td>
        <select class="acp-role-select" data-set-role="${escapeHtml(m.userId)}">
          ${roles.map((r) => `<option value="${r}" ${m.role===r?"selected":""}>${labelFor(r)}</option>`).join("")}
        </select>
      </td>
      <td><div class="acp-actions"><button class="acp-btn danger" data-remove="${escapeHtml(m.userId)}">Remove</button></div></td>
    </tr>`;
  }
  function labelFor(r) {
    return r === "admin" ? "👑 Admin" : r === "moderator" ? "🛡 Moderator" : "💖 Member";
  }

  document.getElementById("members-card").addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-set-role]");
    if (!sel) return;
    const userId = sel.dataset.setRole;
    const role = sel.value;
    sel.disabled = true;
    try {
      await fetchJson(`/api/acp/circles/${currentCircleId}/members/${encodeURIComponent(userId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      toast(`Role set to ${labelFor(role)}`);
    } catch (err) {
      toast(err.message || "Couldn't update role", "err");
    } finally {
      sel.disabled = false;
    }
  });

  document.getElementById("members-card").addEventListener("click", async (e) => {
    const rm = e.target.closest("[data-remove]");
    if (!rm) return;
    const userId = rm.dataset.remove;
    if (!confirm("Remove this member from the circle?")) return;
    rm.disabled = true;
    try {
      await fetchJson(`/api/acp/circles/${currentCircleId}/members/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
      toast("Member removed");
      await loadMembers(currentCircleId);
    } catch (err) {
      toast(err.message || "Couldn't remove", "err");
      rm.disabled = false;
    }
  });

  // --- Add member modal ------------------------------------------------
  const addModal = document.getElementById("add-modal");
  document.getElementById("btn-add-member").addEventListener("click", async () => {
    if (!currentCircleId) return;
    // Fetch the full user list so the dropdown is populated.
    try {
      if (!allUsersCache.length) {
        const data = await fetchJson("/api/acp/users");
        allUsersCache = data.users || [];
      }
    } catch {}
    const select = document.getElementById("add-user-id");
    select.innerHTML = allUsersCache.map((u) =>
      `<option value="${escapeHtml(u.id)}">${escapeHtml(u.displayName || u.username)} — ${escapeHtml(u.email || u.username)}</option>`
    ).join("");
    document.getElementById("add-role").value = "member";
    document.getElementById("add-status").textContent = "";
    addModal.classList.add("open");
    addModal.setAttribute("aria-hidden", "false");
  });
  document.querySelectorAll("[data-close-modal]").forEach((el) =>
    el.addEventListener("click", () => {
      addModal.classList.remove("open");
      addModal.setAttribute("aria-hidden", "true");
    })
  );
  document.getElementById("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const userId = document.getElementById("add-user-id").value;
    const role = document.getElementById("add-role").value;
    const status = document.getElementById("add-status");
    status.textContent = "Adding…"; status.className = "acp-form-status";
    try {
      await fetchJson(`/api/acp/circles/${currentCircleId}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, role }),
      });
      toast(`Added as ${labelFor(role)}`);
      addModal.classList.remove("open");
      addModal.setAttribute("aria-hidden", "true");
      await loadMembers(currentCircleId);
    } catch (err) {
      status.textContent = err.message || "Couldn't add.";
      status.className = "acp-form-status err";
    }
  });

  // --- Schema bootstrap button (System tab) ----------------------------
  document.getElementById("btn-bootstrap")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const out = document.getElementById("bootstrap-results");
    btn.disabled = true; btn.textContent = "Running…";
    out.innerHTML = `<p style="color:#7a5f6c;font-size:13px;margin:0">Working…</p>`;
    try {
      const res = await fetch("/api/acp/bootstrap", { method: "POST", credentials: "same-origin" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
      const rows = (data.results || []).map((r) => `
        <li style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #fff0f5;font-size:13px">
          <span><strong>${escapeHtml(r.name)}</strong>${r.error ? ` — <span style='color:#c4344b'>${escapeHtml(r.error)}</span>` : ""}</span>
          <span style="color:${r.ok ? "#2b9b48" : "#c4344b"};font-weight:700">${r.ok ? "✓ ok" : "✗ failed"}</span>
        </li>`).join("");
      out.innerHTML = `<ul style="list-style:none;padding:0;margin:0">${rows}</ul>`;
      toast("Bootstrap complete", "ok");
    } catch (err) {
      out.innerHTML = `<p style="color:#c4344b;font-size:13px;margin:0">${escapeHtml(err.message || "Failed")}</p>`;
      toast(err.message || "Bootstrap failed", "err");
    } finally {
      btn.disabled = false; btn.textContent = "Run schema bootstrap now";
    }
  });

  // --- Insights tab ----------------------------------------------------
  async function loadInsightsTab() {
    await Promise.all([paintEngineStatus(), loadRecentRuns(), loadInsightConfigs()]);
  }

  async function paintEngineStatus() {
    const el = document.getElementById("engine-status");
    if (!el) return;
    el.innerHTML = `<span class="acp-pill">Loading…</span>`;
    try {
      const data = await fetchJson("/api/me/insights");
      // /api/me/insights is auth-only (not /acp), so this works because the
      // admin is also a signed-in user. It returns engine connection state.
      const ok = !!data.aiConfigured;
      const backendLabel = data.aiBackend === "bedrock" ? "Bedrock"
                         : data.aiBackend === "anthropic" ? "Direct API"
                         : "none";
      el.innerHTML = [
        `<span class="acp-pill" style="background:${ok ? "#dff5e0" : "#ffe0e0"};color:${ok ? "#2b6f1f" : "#a63a3a"}">${ok ? "✓ Ready" : "✗ Offline"}</span>`,
        `<span class="acp-pill">Backend: ${escapeHtml(backendLabel)}</span>`,
      ].join("");
    } catch (err) {
      el.innerHTML = `<span class="acp-pill" style="background:#ffe0e0;color:#a63a3a">Status check failed</span>`;
    }
  }

  document.getElementById("btn-engine-test")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const out = document.getElementById("engine-test-out");
    btn.disabled = true; btn.textContent = "Pinging engine…";
    out.hidden = false; out.textContent = "Calling engine…";
    try {
      const res = await fetch("/api/acp/insights/test", { method: "POST", credentials: "same-origin" });
      const data = await res.json();
      out.textContent = JSON.stringify(data, null, 2);
      out.style.borderColor = data.ok ? "#3a7a2e" : "#a04444";
      out.style.background  = data.ok ? "#1b1224" : "#2a1418";
      toast(data.ok ? "Engine responded" : "Engine error — see output", data.ok ? "ok" : "err");
    } catch (err) {
      out.textContent = "Request failed: " + (err?.message || err);
      out.style.borderColor = "#a04444";
    } finally {
      btn.disabled = false; btn.textContent = "⚡ Test engine connection";
    }
  });

  document.getElementById("btn-list-profiles")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const out = document.getElementById("profiles-out");
    btn.disabled = true; btn.textContent = "Listing…";
    out.innerHTML = `<p style="font-size:13px;color:#7a5f6c;margin:0">Calling Bedrock…</p>`;
    try {
      const data = await fetchJson("/api/acp/insights/profiles");
      if (!data.ok) {
        out.innerHTML = `<p style="color:#c4344b;font-size:13px;margin:0">${escapeHtml(data.error || "Failed")}</p>`;
        return;
      }
      if (!data.profiles.length) {
        out.innerHTML = `<p style="font-size:13px;color:#7a5f6c;margin:0">No inference profiles visible in <strong>${escapeHtml(data.region)}</strong>. Enable cross-region inference for the model in the Bedrock console.</p>`;
        return;
      }
      out.innerHTML = `
        <p style="font-size:12px;color:#7a5f6c;margin:0 0 8px">${data.count} profile(s) in ${escapeHtml(data.region)}. Click an id to copy.</p>
        <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px">
          ${data.profiles.map((p) => `
            <li style="background:#fff5f9;border:1px solid #ffe2eb;border-radius:10px;padding:10px 12px;font-size:13px">
              <strong>${escapeHtml(p.name || p.id)}</strong>
              <span style="color:#7a5f6c"> · ${escapeHtml(p.type || "")} · ${escapeHtml(p.status || "")}</span>
              <div style="margin-top:4px"><button class="acp-btn" data-copy="${escapeHtml(p.id)}" style="font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:4px 8px">${escapeHtml(p.id)}</button></div>
            </li>`).join("")}
        </ul>`;
      out.querySelectorAll("[data-copy]").forEach((b) => {
        b.addEventListener("click", () => {
          navigator.clipboard?.writeText(b.dataset.copy);
          toast("Copied: " + b.dataset.copy, "ok");
        });
      });
    } catch (err) {
      out.innerHTML = `<p style="color:#c4344b;font-size:13px;margin:0">${escapeHtml(err.message || "Failed")}</p>`;
    } finally {
      btn.disabled = false; btn.textContent = "List available profiles";
    }
  });

  async function loadRecentRuns() {
    const out = document.getElementById("runs-out");
    if (!out) return;
    out.innerHTML = `<p style="font-size:13px;color:#7a5f6c;margin:0">Loading…</p>`;
    try {
      const data = await fetchJson("/api/acp/insights/runs");
      if (!data.runs.length) {
        out.innerHTML = `<p style="font-size:13px;color:#7a5f6c;margin:0">No runs recorded yet.</p>`;
        return;
      }
      out.innerHTML = `
        <table class="acp-table" style="font-size:13px">
          <thead><tr><th>When</th><th>User</th><th>Insight</th><th>Status</th><th>Tokens</th><th>Error</th></tr></thead>
          <tbody>
            ${data.runs.map((r) => `
              <tr>
                <td>${escapeHtml(new Date(r.generatedAt * 1000).toLocaleString(undefined, { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" }))}</td>
                <td>${escapeHtml(r.displayName || r.username || r.userId.slice(0,8))}</td>
                <td><code>${escapeHtml(r.slug)}</code></td>
                <td><span style="color:${r.status === "ok" ? "#2b9b48" : r.status === "running" ? "#c2811a" : "#c4344b"};font-weight:700">${escapeHtml(r.status)}</span></td>
                <td style="color:#7a5f6c">${r.inputTokens || "—"} / ${r.outputTokens || "—"}</td>
                <td style="color:#c4344b;max-width:360px;font-size:12px">${escapeHtml((r.error || "").slice(0,200))}</td>
              </tr>`).join("")}
          </tbody>
        </table>`;
    } catch (err) {
      out.innerHTML = `<p style="color:#c4344b;font-size:13px;margin:0">${escapeHtml(err.message || "Failed")}</p>`;
    }
  }
  document.getElementById("btn-runs-refresh")?.addEventListener("click", loadRecentRuns);

  // --- Insight config editor (the prompt admin) ------------------------
  let insightConfigs = [];
  async function loadInsightConfigs() {
    const list = document.getElementById("insight-config-list");
    if (!list) return;
    list.innerHTML = `<li style="color:#7a5f6c;font-size:13px">Loading…</li>`;
    try {
      const data = await fetchJson("/api/acp/insights");
      insightConfigs = data.configs || [];
      if (!insightConfigs.length) {
        list.innerHTML = `<li style="color:#7a5f6c;font-size:13px">No insights configured.</li>`;
        return;
      }
      list.innerHTML = insightConfigs.map(insightConfigRow).join("");
      list.querySelectorAll("[data-edit-cfg]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const cfg = insightConfigs.find((c) => c.slug === btn.dataset.editCfg);
          if (cfg) openCfgModal(cfg);
        });
      });
    } catch (err) {
      list.innerHTML = `<li style="color:#c4344b;font-size:13px">${escapeHtml(err.message || "Couldn't load configs")}</li>`;
    }
  }

  function insightConfigRow(c) {
    const scope = (c.dataScope || []).join(", ") || "—";
    const refresh = c.refreshHours >= 720 ? "30 days"
                  : c.refreshHours >= 168 ? "7 days"
                  : c.refreshHours >= 72 ? "3 days"
                  : c.refreshHours >= 24 ? "24 hours"
                  : c.refreshHours + "h";
    return `<li style="background:#fff5f9;border:1px solid #ffe2eb;border-radius:14px;padding:14px 16px;display:flex;gap:14px;align-items:flex-start">
      <span style="font-size:28px;line-height:1">${escapeHtml(c.emoji || "✨")}</span>
      <div style="flex:1;min-width:0">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
          <strong style="font-size:15px;color:#3a2330">${escapeHtml(c.title)}</strong>
          <span style="font-size:11px;font-weight:700;color:${c.enabled ? "#2b9b48" : "#a63a3a"};background:${c.enabled ? "#dff5e0" : "#ffe0e0"};padding:3px 8px;border-radius:999px">${c.enabled ? "ENABLED" : "DISABLED"}</span>
        </div>
        <p style="margin:4px 0 6px;font-size:12px;color:#7a5f6c">slug <code>${escapeHtml(c.slug)}</code> · refresh ${escapeHtml(refresh)} · model ${c.model ? `<code>${escapeHtml(c.model)}</code>` : "default"}</p>
        <p style="margin:0 0 6px;font-size:12px;color:#7a5f6c">scope: ${escapeHtml(scope)}</p>
        <p style="margin:0 0 10px;font-size:12px;color:#5a3a48;line-height:1.5;font-family:ui-monospace,Menlo,monospace;background:#fff;border:1px solid #ffe2eb;padding:8px 10px;border-radius:8px;max-height:84px;overflow:hidden">${escapeHtml(String(c.promptTemplate || "").slice(0, 320))}${c.promptTemplate?.length > 320 ? "…" : ""}</p>
        <button type="button" class="acp-btn" data-edit-cfg="${escapeHtml(c.slug)}">Edit prompt</button>
      </div>
    </li>`;
  }

  const cfgModal = document.getElementById("cfg-modal");
  function openCfgModal(cfg) {
    const form = document.getElementById("cfg-form");
    form.reset();
    form.slug.value = cfg.slug;
    form.title.value = cfg.title || "";
    form.emoji.value = cfg.emoji || "";
    form.description.value = cfg.description || "";
    form.promptTemplate.value = cfg.promptTemplate || "";
    form.refreshHours.value = String(cfg.refreshHours || 24);
    form.model.value = cfg.model || "";
    form.enabled.checked = !!cfg.enabled;
    document.querySelectorAll("#cfg-scope-grid input[type='checkbox']").forEach((cb) => {
      cb.checked = (cfg.dataScope || []).includes(cb.value);
    });
    document.getElementById("cfg-title").textContent = `Edit insight — ${cfg.title}`;
    document.getElementById("cfg-status").textContent = "";
    // Reset the profile picker for a fresh open
    const list = document.getElementById("cfg-profiles-list");
    if (list) { list.style.display = "none"; list.innerHTML = ""; }
    const ps = document.getElementById("cfg-profiles-status");
    if (ps) ps.textContent = "";
    cfgModal.classList.add("open");
    cfgModal.setAttribute("aria-hidden", "false");
  }

  // Inference profile picker — lets admins discover which model ids are
  // actually callable in the configured Bedrock region without leaving the
  // page. Hits /api/acp/insights/profiles (a thin wrapper around Bedrock's
  // ListInferenceProfiles) and renders a clickable list that drops the
  // chosen id into the model field.
  document.getElementById("cfg-clear-model")?.addEventListener("click", () => {
    const input = document.getElementById("cfg-model-input");
    if (input) input.value = "";
  });
  document.getElementById("cfg-list-profiles")?.addEventListener("click", async () => {
    const status = document.getElementById("cfg-profiles-status");
    const list = document.getElementById("cfg-profiles-list");
    const input = document.getElementById("cfg-model-input");
    if (!status || !list || !input) return;
    status.textContent = "Loading…";
    list.style.display = "none";
    list.innerHTML = "";
    try {
      const data = await fetchJson("/api/acp/insights/profiles");
      if (!data.ok) {
        status.textContent = data.error || "Couldn't list profiles.";
        return;
      }
      const profiles = data.profiles || [];
      if (!profiles.length) {
        status.textContent = `No inference profiles found in ${data.region || "region"}.`;
        return;
      }
      status.textContent = `${profiles.length} profile${profiles.length === 1 ? "" : "s"} in ${data.region}. Click one to use it.`;
      list.innerHTML = profiles.map((p) => `
        <li data-profile-id="${escapeHtml(p.id)}" style="padding:10px 12px;border-bottom:1px solid #ffe2eb;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:10px">
          <div style="min-width:0;flex:1">
            <div style="font-size:13px;color:#3a2330;font-weight:600">${escapeHtml(p.name || p.id)}</div>
            <code style="font-size:11px;color:#7a5f6c;word-break:break-all">${escapeHtml(p.id)}</code>
          </div>
          <span style="font-size:11px;color:#7a5f6c;background:#fff;border:1px solid #ffe2eb;padding:2px 8px;border-radius:999px">${escapeHtml(p.type || "")}</span>
        </li>`).join("");
      list.style.display = "block";
      list.querySelectorAll("[data-profile-id]").forEach((li) => {
        li.addEventListener("click", () => {
          input.value = li.dataset.profileId;
          status.textContent = `Selected ${li.dataset.profileId}.`;
          list.style.display = "none";
        });
      });
    } catch (err) {
      status.textContent = err.message || "Couldn't list profiles.";
    }
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-cfg]")) {
      cfgModal.classList.remove("open");
      cfgModal.setAttribute("aria-hidden", "true");
    }
  });
  document.getElementById("cfg-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const slug = form.slug.value;
    const scope = Array.from(document.querySelectorAll("#cfg-scope-grid input:checked")).map((c) => c.value);
    const body = {
      title: form.title.value.trim(),
      emoji: form.emoji.value.trim() || null,
      description: form.description.value.trim() || null,
      promptTemplate: form.promptTemplate.value,
      dataScope: scope,
      refreshHours: +form.refreshHours.value,
      model: form.model.value.trim() || null,
      enabled: form.enabled.checked,
    };
    const status = document.getElementById("cfg-status");
    status.textContent = "Saving…"; status.style.color = "#7a5f6c";
    try {
      await fetchJson(`/api/acp/insights/${encodeURIComponent(slug)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      toast("Prompt saved. Users see it on their next refresh.", "ok");
      cfgModal.classList.remove("open");
      cfgModal.setAttribute("aria-hidden", "true");
      await loadInsightConfigs();
    } catch (err) {
      status.textContent = err.message || "Couldn't save."; status.style.color = "#c4344b";
    }
  });

  // --- Bootstrap -------------------------------------------------------
  // Default to Overview, but honour `#insights`/`#users`/etc. URL hash so
  // deep-links from /my-insights ("→ Admin → Insights") land on the right tab.
  const hashTab = (location.hash || "").replace(/^#/, "").toLowerCase();
  const startTab = hashTab && views[hashTab] ? hashTab : "overview";
  document.querySelectorAll(".acp-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === startTab));
  showView(startTab);
  if (startTab === "overview") loadOverview();
  if (startTab === "users") loadUsers();
  if (startTab === "circles") loadCircles();
  if (startTab === "insights") loadInsightsTab();
  if (startTab === "stories") loadStoriesTab();
  if (startTab === "resources") loadResourcesTab();
  if (startTab === "foods") loadFoodsTab();
  // Always populate the right rail on first load so it has data immediately,
  // even if the admin starts on a non-Overview tab.
  if (startTab !== "overview") loadOverview();

  // ====================================================================
  // STORY MODERATION
  // ====================================================================
  let storyFilter = "submitted";
  async function loadStoriesTab() {
    const list = document.getElementById("acp-story-list");
    if (!list) return;
    list.innerHTML = `<li class="empty-state">Loading…</li>`;
    try {
      const data = await fetchJson(`/api/acp/stories?status=${encodeURIComponent(storyFilter)}`);
      const stories = data.stories || [];
      if (!stories.length) {
        list.innerHTML = `<li class="empty-state">No stories in this view.</li>`;
        return;
      }
      list.innerHTML = stories.map((s) => `
        <li class="acp-story-row" data-id="${s.id}">
          <div class="acp-story-thumb">
            ${s.coverImageUrl ? `<img src="${escapeHtml(s.coverImageUrl)}" alt="" />` : `<span>📖</span>`}
          </div>
          <div class="acp-story-body">
            <div class="acp-story-head">
              <strong>${escapeHtml(s.title)}</strong>
              <span class="acp-status-pill status-${s.status}">${s.status}</span>
            </div>
            <div class="acp-story-meta">
              by <strong>${escapeHtml(s.author_name)}</strong> (${escapeHtml(s.author_username || "—")})
              · ${s.chapter_count} chapter${s.chapter_count === 1 ? "" : "s"}
              ${s.submitted_at ? ` · submitted ${new Date(s.submitted_at * 1000).toLocaleString()}` : ""}
            </div>
            ${s.summary ? `<p class="acp-story-summary">${escapeHtml(s.summary)}</p>` : ""}
            ${s.reject_reason ? `<p class="acp-reject">Reviewer: ${escapeHtml(s.reject_reason)}</p>` : ""}
            <div class="acp-story-actions">
              <button class="btn btn-ghost btn-small" data-act="view">👁 Preview</button>
              ${s.status === "submitted" ? `
                <button class="btn btn-primary btn-small" data-act="approve">✓ Approve &amp; publish</button>
                <button class="btn btn-ghost btn-small" data-act="reject">✕ Request changes</button>
              ` : ""}
              ${s.status === "published" ? `<button class="btn btn-ghost btn-small" data-act="unpublish">↩ Unpublish</button>` : ""}
              <button class="btn btn-ghost btn-small acp-danger" data-act="delete">🗑 Delete</button>
            </div>
          </div>
        </li>`).join("");
    } catch (err) {
      list.innerHTML = `<li class="empty-state">Couldn't load: ${escapeHtml(err.message)}</li>`;
    }
  }

  document.addEventListener("click", async (e) => {
    const filter = e.target.closest?.("[data-story-filter]");
    if (filter) {
      storyFilter = filter.dataset.storyFilter;
      document.querySelectorAll("[data-story-filter]").forEach((b) => b.classList.toggle("on", b === filter));
      loadStoriesTab();
      return;
    }
    const row = e.target.closest?.(".acp-story-row");
    if (!row) return;
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    const id = +row.dataset.id;
    if (act === "view") {
      try {
        const d = await fetchJson(`/api/acp/stories/${id}`);
        showStoryPreview(d);
      } catch (err) { alert("Couldn't load: " + err.message); }
    } else if (act === "approve") {
      if (!confirm("Approve and publish this story?")) return;
      try { await fetchJson(`/api/acp/stories/${id}/approve`, { method: "POST", body: "{}" }); loadStoriesTab(); }
      catch (err) { alert(err.message); }
    } else if (act === "reject") {
      const reason = prompt("Feedback for the author (will be visible to them):", "Needs more detail before publishing.");
      if (!reason) return;
      try {
        await fetchJson(`/api/acp/stories/${id}/reject`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }),
        });
        loadStoriesTab();
      } catch (err) { alert(err.message); }
    } else if (act === "unpublish") {
      if (!confirm("Take this story off the public list?")) return;
      try { await fetchJson(`/api/acp/stories/${id}/unpublish`, { method: "POST" }); loadStoriesTab(); }
      catch (err) { alert(err.message); }
    } else if (act === "delete") {
      if (!confirm("Permanently delete this story?")) return;
      try { await fetchJson(`/api/acp/stories/${id}`, { method: "DELETE" }); loadStoriesTab(); }
      catch (err) { alert(err.message); }
    }
  });

  function showStoryPreview(data) {
    const { story, chapters } = data;
    const w = window.open("", "_blank");
    if (!w) { alert("Pop-up blocked"); return; }
    const cov = story.coverImageUrl ? `<img style="width:100%;max-height:300px;object-fit:cover" src="${story.coverImageUrl}">` : "";
    const body = chapters.map((c) => `
      <section style="margin:24px 0;padding:18px;border:1px solid #eee;border-radius:10px">
        ${c.heading ? `<h2>${escapeHtml(c.heading)}</h2>` : ""}
        ${c.imageUrl ? `<img style="width:100%;border-radius:8px;margin:8px 0" src="${c.imageUrl}">` : ""}
        <div>${String(c.body || "").split(/\n\n+/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("")}</div>
      </section>`).join("");
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(story.title)}</title>
      <body style="font-family:Poppins,sans-serif;max-width:760px;margin:24px auto;padding:0 18px;color:#2b1922">
      ${cov}<h1>${escapeHtml(story.title)}</h1>
      <p><em>by ${escapeHtml(story.author_name)} — status: ${story.status}</em></p>
      ${story.summary ? `<p style="font-size:16px;color:#555">${escapeHtml(story.summary)}</p>` : ""}
      ${body}</body>`);
    w.document.close();
  }

  // ====================================================================
  // COMMUNITY RESOURCES (CMS)
  // ====================================================================
  async function loadResourcesTab() {
    const slot = document.getElementById("acp-resources-by-cat");
    if (!slot) return;
    slot.innerHTML = `<p class="empty-state">Loading…</p>`;
    try {
      const data = await fetchJson("/api/acp/resources");
      const cats = data.categories || [];
      const byCat = {};
      for (const r of (data.resources || [])) (byCat[r.category] ||= []).push(r);
      slot.innerHTML = cats.map((c) => `
        <section class="acp-rcat" data-cat="${c.key}">
          <h3>${c.icon} ${escapeHtml(c.label)} <span class="muted">${(byCat[c.key] || []).length}</span></h3>
          ${(byCat[c.key] || []).length === 0
            ? `<p class="empty-state small">Nothing in this category yet.</p>`
            : `<ul class="acp-resource-list">${(byCat[c.key] || []).map((r) => `
                <li class="acp-resource-row" data-id="${r.id}">
                  <div class="acp-rr-body">
                    <strong>${escapeHtml(r.title)}</strong>
                    ${r.is_published ? "" : `<span class="acp-status-pill" style="background:#fff5d6;color:#7a5500">unpublished</span>`}
                    ${r.summary ? `<p>${escapeHtml(r.summary)}</p>` : ""}
                    ${r.url ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.url)}</a>` : ""}
                  </div>
                  <div class="acp-rr-actions">
                    <button class="btn btn-ghost btn-small" data-act="edit">✏️ Edit</button>
                    <button class="btn btn-ghost btn-small acp-danger" data-act="delete">🗑</button>
                  </div>
                </li>`).join("")}</ul>`}
        </section>`).join("");
    } catch (err) {
      slot.innerHTML = `<p class="empty-state">Couldn't load: ${escapeHtml(err.message)}</p>`;
    }
  }

  document.getElementById("acp-add-resource")?.addEventListener("click", () => openResourceEditor(null));

  document.addEventListener("click", async (e) => {
    const row = e.target.closest?.(".acp-resource-row");
    if (!row) return;
    const act = e.target.closest("[data-act]")?.dataset.act;
    const id = +row.dataset.id;
    if (act === "delete") {
      if (!confirm("Delete this resource?")) return;
      try { await fetchJson(`/api/acp/resources/${id}`, { method: "DELETE" }); loadResourcesTab(); }
      catch (err) { alert(err.message); }
    } else if (act === "edit") {
      // We need the full record. Fetch fresh list and grab it.
      try {
        const data = await fetchJson("/api/acp/resources");
        const r = (data.resources || []).find((x) => x.id === id);
        if (r) openResourceEditor(r);
      } catch (err) { alert(err.message); }
    }
  });

  function openResourceEditor(existing) {
    // Proper modal — replaces the prompt() flow that silently saved as
    // a draft whenever an admin hit Cancel/Esc on the "Publish now?"
    // confirm. Defaults to PUBLISHED for new resources so the most
    // common path (admin adds a resource → wants it live) is one click.
    const modal = document.getElementById("resource-modal");
    const form = document.getElementById("resource-form");
    if (!modal || !form) {
      // Fallback if the modal markup is missing (older deploys) — still
      // works, just less polished.
      alert("Resource editor markup missing — refresh the page.");
      return;
    }
    form.reset();
    document.getElementById("resource-modal-title").textContent = existing ? "Edit resource" : "Add resource";
    document.getElementById("resource-status").textContent = "";
    form.id.value = existing?.id || "";
    form.category.value = existing?.category || "organisations";
    form.title.value    = existing?.title    || "";
    form.summary.value  = existing?.summary  || "";
    form.url.value      = existing?.url      || "";
    form.position.value = existing?.position != null ? existing.position : 100;
    // Default: PUBLISHED for new, current status for edits.
    form.is_published.checked = existing ? !!existing.is_published : true;
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-resource]")) {
      const modal = document.getElementById("resource-modal");
      modal?.classList.remove("open");
      modal?.setAttribute("aria-hidden", "true");
    }
  });
  document.getElementById("resource-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const status = document.getElementById("resource-status");
    status.textContent = "Saving…"; status.style.color = "#7a5f6c";
    const id = form.id.value ? +form.id.value : null;
    const payload = {
      category: form.category.value,
      title: form.title.value.trim(),
      summary: form.summary.value.trim() || null,
      url: form.url.value.trim() || null,
      position: +form.position.value || 100,
      is_published: form.is_published.checked,
    };
    if (!payload.title) {
      status.textContent = "Title required."; status.style.color = "#c4344b"; return;
    }
    try {
      await fetchJson(
        id ? `/api/acp/resources/${id}` : `/api/acp/resources`,
        { method: id ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload) }
      );
      toast(payload.is_published ? "Saved and published" : "Saved as draft", "ok");
      document.getElementById("resource-modal").classList.remove("open");
      document.getElementById("resource-modal").setAttribute("aria-hidden", "true");
      await loadResourcesTab();
    } catch (err) {
      status.textContent = err.message || "Couldn't save."; status.style.color = "#c4344b";
    }
  });

  // --- Helpers ---------------------------------------------------------
  async function fetchJson(url, init = {}) {
    const res = await fetch(url, { credentials: "same-origin", ...init });
    if (res.status === 401 || res.status === 403) {
      location.href = "/login";
      throw new Error("Not authorized");
    }
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
  function fmtDate(unixSec) {
    if (!unixSec) return "—";
    const d = new Date(unixSec * 1000);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
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

  // ====================================================================
  // FOOD DB TAB — curated food + macros for the Smart-Log autocomplete.
  // (Uses var so the bootstrap above can call loadFoodsTab before these
  // declarations are reached — the function is hoisted but its closure
  // over `let` vars would otherwise hit the TDZ.)
  // ====================================================================
  var foodsCache = [];
  var foodsQuery = "";
  var foodsCategory = "";

  async function loadFoodsTab() {
    const list = document.getElementById("acp-foods-list");
    list.innerHTML = `<p class="empty-state">Loading…</p>`;
    try {
      const params = new URLSearchParams();
      if (foodsQuery) params.set("q", foodsQuery);
      if (foodsCategory) params.set("category", foodsCategory);
      const data = await fetchJson(`/api/acp/foods?${params}`);
      foodsCache = data.items || [];
      document.getElementById("acp-foods-count").textContent =
        `${foodsCache.length} of ${data.total || 0} foods`;
      if (!foodsCache.length) {
        list.innerHTML = `<p class="empty-state">No foods match. Click "+ Add food" to add one.</p>`;
        return;
      }
      list.innerHTML = foodsCache.map(foodRow).join("");
      list.querySelectorAll("[data-edit-food]").forEach((b) =>
        b.addEventListener("click", () => openFoodModal(foodsCache.find((f) => f.id === +b.dataset.editFood))));
      list.querySelectorAll("[data-del-food]").forEach((b) =>
        b.addEventListener("click", async () => {
          if (!confirm(`Delete "${b.dataset.delFoodName}"?`)) return;
          try {
            await fetchJson(`/api/acp/foods/${b.dataset.delFood}`, { method: "DELETE" });
            toast("Deleted", "ok");
            loadFoodsTab();
          } catch (err) { toast(err.message || "Couldn't delete", "err"); }
        }));
    } catch (err) {
      list.innerHTML = `<p class="empty-state">Couldn't load: ${escapeHtml(err.message)}</p>`;
    }
  }
  function foodRow(f) {
    const macros = `${f.calories}kcal · P${f.protein_g} · C${f.carbs_g} · F${f.fat_g} · Fib${f.fiber_g}`;
    return `<div class="acp-food-row" style="background:#fff;border:1px solid #ffeaf2;border-radius:12px;padding:12px 14px;display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;margin-bottom:8px">
      <div style="min-width:0">
        <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">
          <strong style="font-size:14px;color:#2b1922">${escapeHtml(f.name)}</strong>
          ${f.brand ? `<span style="font-size:11px;color:#7a5f6c">${escapeHtml(f.brand)}</span>` : ""}
          ${f.category ? `<span style="font-size:10px;background:#fff5f8;color:#c4344b;padding:2px 8px;border-radius:999px;font-weight:700;text-transform:uppercase;letter-spacing:.04em">${escapeHtml(f.category)}</span>` : ""}
          ${f.source === "seed" ? `<span style="font-size:10px;color:#7a5f6c">· seed</span>` : ""}
        </div>
        <div style="font-size:12px;color:#7a5f6c;margin-top:3px">
          ${escapeHtml(f.serving_size || "")} · <code style="background:#fff5f8;padding:2px 6px;border-radius:5px;font-size:11px">${macros}</code>
          ${f.tags ? ` · tags: <em>${escapeHtml(f.tags)}</em>` : ""}
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="acp-btn" data-edit-food="${f.id}" style="font-size:12px;padding:6px 12px">Edit</button>
        <button class="acp-btn" data-del-food="${f.id}" data-del-food-name="${escapeAttr(f.name)}" style="font-size:12px;padding:6px 12px;color:#c4344b">Delete</button>
      </div>
    </div>`;
  }

  // Search + category filter wiring (debounced).
  let foodsSearchDeb = null;
  document.getElementById("acp-foods-search")?.addEventListener("input", (e) => {
    clearTimeout(foodsSearchDeb);
    foodsSearchDeb = setTimeout(() => {
      foodsQuery = e.target.value.trim();
      loadFoodsTab();
    }, 200);
  });
  document.getElementById("acp-foods-category")?.addEventListener("change", (e) => {
    foodsCategory = e.target.value;
    loadFoodsTab();
  });
  document.getElementById("acp-foods-add")?.addEventListener("click", () => openFoodModal(null));

  // Modal --------------------------------------------------------------
  const foodModal = document.getElementById("food-modal");
  function openFoodModal(food) {
    const form = document.getElementById("food-form");
    form.reset();
    if (food) {
      document.getElementById("food-modal-title").textContent = "Edit food";
      form.id.value = food.id;
      form.name.value = food.name || "";
      form.brand.value = food.brand || "";
      form.category.value = food.category || "";
      form.serving_size.value = food.serving_size || "";
      form.serving_grams.value = food.serving_grams || "";
      form.calories.value = food.calories || 0;
      form.protein_g.value = food.protein_g || 0;
      form.carbs_g.value = food.carbs_g || 0;
      form.fat_g.value = food.fat_g || 0;
      form.fiber_g.value = food.fiber_g || 0;
      form.tags.value = food.tags || "";
    } else {
      document.getElementById("food-modal-title").textContent = "Add food";
    }
    document.getElementById("food-status").textContent = "";
    foodModal.classList.add("open");
    foodModal.setAttribute("aria-hidden", "false");
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-food]")) {
      foodModal.classList.remove("open");
      foodModal.setAttribute("aria-hidden", "true");
    }
  });
  document.getElementById("food-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const status = document.getElementById("food-status");
    status.textContent = "Saving…"; status.style.color = "#7a5f6c";
    const body = {
      id: form.id.value ? +form.id.value : null,
      name: form.name.value.trim(),
      brand: form.brand.value.trim() || null,
      category: form.category.value || null,
      serving_size: form.serving_size.value.trim() || null,
      serving_grams: form.serving_grams.value ? +form.serving_grams.value : null,
      calories: +form.calories.value || 0,
      protein_g: +form.protein_g.value || 0,
      carbs_g: +form.carbs_g.value || 0,
      fat_g: +form.fat_g.value || 0,
      fiber_g: +form.fiber_g.value || 0,
      tags: form.tags.value.trim(),
    };
    try {
      await fetchJson(`/api/acp/foods${body.id ? `/${body.id}` : ""}`, {
        method: body.id ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      toast("Saved", "ok");
      foodModal.classList.remove("open");
      foodModal.setAttribute("aria-hidden", "true");
      await loadFoodsTab();
    } catch (err) {
      status.textContent = err.message || "Couldn't save."; status.style.color = "#c4344b";
    }
  });
  function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/&/g, "&amp;"); }
})();
