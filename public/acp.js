// /acp — Admin Control Panel.
// Server already blocks non-admins from this page; the JS just talks to /api/acp/*.
(() => {
  const views = {
    overview: document.getElementById("view-overview"),
    users:    document.getElementById("view-users"),
    circles:  document.getElementById("view-circles"),
    circle:   document.getElementById("view-circle"),
    insights: document.getElementById("view-insights"),
    system:   document.getElementById("view-system"),
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
    });
  });
  function showView(name) {
    if (views.overview) views.overview.hidden = name !== "overview";
    views.users.hidden    = name !== "users";
    views.circles.hidden  = name !== "circles";
    views.circle.hidden   = name !== "circle";
    if (views.insights) views.insights.hidden = name !== "insights";
    if (views.system)   views.system.hidden   = name !== "system";
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
            <th>User</th><th>Email</th><th>Joined</th><th>Circles</th><th>Symptoms</th>
          </tr></thead>
          <tbody>${allUsersCache.map(userRow).join("")}</tbody>
        </table>`;
    } catch (err) {
      card.innerHTML = `<p class="acp-empty">Couldn't load users: ${escapeHtml(err.message || "")}</p>`;
    }
  }
  function userRow(u) {
    return `<tr>
      <td>
        <div class="acp-username">${escapeHtml(u.displayName || u.username)}</div>
        <div class="acp-meta">@${escapeHtml(u.username)}</div>
      </td>
      <td>${escapeHtml(u.email || "—")}</td>
      <td>${fmtDate(u.createdAt)}</td>
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
    cfgModal.classList.add("open");
    cfgModal.setAttribute("aria-hidden", "false");
  }
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
  // Always populate the right rail on first load so it has data immediately,
  // even if the admin starts on a non-Overview tab.
  if (startTab !== "overview") loadOverview();

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
})();
