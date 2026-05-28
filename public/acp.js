// /acp — Admin Control Panel.
// Server already blocks non-admins from this page; the JS just talks to /api/acp/*.
(() => {
  const views = {
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
      if (name === "users") loadUsers();
      if (name === "circles") loadCircles();
      if (name === "insights") loadInsightsTab();
    });
  });
  function showView(name) {
    views.users.hidden    = name !== "users";
    views.circles.hidden  = name !== "circles";
    views.circle.hidden   = name !== "circle";
    if (views.insights) views.insights.hidden = name !== "insights";
    if (views.system)   views.system.hidden   = name !== "system";
    window.scrollTo({ top: 0, behavior: "smooth" });
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
    await Promise.all([paintEngineStatus(), loadRecentRuns()]);
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

  // --- Bootstrap -------------------------------------------------------
  loadUsers();

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
