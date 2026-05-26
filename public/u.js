// /u/:username — public profile viewer. Shared HTML rendered by the JS
// based on the URL path.
console.info("EndoMe u-profile build v1");

(() => {
  const parts = location.pathname.split("/").filter(Boolean); // ["u","alice"]
  const username = parts[1] ? decodeURIComponent(parts[1]) : "";

  (async () => {
    try {
      const me = await fetchJson("/api/me/today");
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = me?.user?.displayName || me?.user?.username || "there";
      });
    } catch {}
    if (!username) {
      document.getElementById("profile-body").innerHTML =
        `<p class="empty-state">No profile in this URL.</p>`;
      done();
      return;
    }
    await loadProfile(username);
    done();
  })();

  function done() { document.getElementById("page-loader")?.classList.add("is-hidden"); }

  async function loadProfile(name) {
    const body = document.getElementById("profile-body");
    body.innerHTML = `<p class="empty-state">Loading…</p>`;
    try {
      const data = await fetchJson(`/api/users/${encodeURIComponent(name)}`);
      render(data.profile);
    } catch (err) {
      body.innerHTML = `<p class="empty-state">${escapeHtml(err.message || "Couldn't load this profile.")}</p>`;
    }
  }

  function statusPill(status) {
    if (status === "friends")          return `<span class="public-status-pill is-friends">💖 Friends</span>`;
    if (status === "pending_outgoing") return `<span class="public-status-pill is-pending">Request sent</span>`;
    if (status === "pending_incoming") return `<span class="public-status-pill is-pending">Wants to be friends</span>`;
    return "";
  }
  function actionsFor(p) {
    if (p.isSelf) {
      return `<a class="btn btn-primary small" href="/profile">Edit your profile</a>`;
    }
    if (p.friendStatus === "friends") {
      return `<button class="btn-soft small" data-unfriend="${escapeHtml(p.id)}">Unfriend</button>`;
    }
    if (p.friendStatus === "pending_outgoing") {
      return `<button class="btn-soft small" data-cancel="${escapeHtml(p.id)}">Cancel request</button>`;
    }
    if (p.friendStatus === "pending_incoming") {
      return `<button class="btn btn-primary small" data-accept="${escapeHtml(p.id)}">Accept friend request</button>
              <button class="btn-soft small" data-decline="${escapeHtml(p.id)}">Decline</button>`;
    }
    return `<button class="btn btn-primary small" data-add="${escapeHtml(p.id)}">+ Add friend</button>`;
  }

  function render(p) {
    document.title = `${p.name} – EndoMe`;
    const body = document.getElementById("profile-body");
    body.innerHTML = `
      <header class="profile-hero">
        <div class="profile-avatar-wrap">
          <div class="profile-avatar">${escapeHtml(p.avatar || "🌸")}</div>
        </div>
        <div class="profile-hero-body">
          <h1>${escapeHtml(p.name)} ${statusPill(p.friendStatus)}</h1>
          <p class="profile-handle">@${escapeHtml(p.username)}</p>
          <p class="profile-bio">${escapeHtml(p.bio || "No bio yet.")}</p>
          <div class="profile-stats">
            <span><strong>${p.postCount   || 0}</strong> posts</span>
            <span><strong>${p.circleCount || 0}</strong> circles</span>
            <span><strong>${p.friendCount || 0}</strong> friends</span>
          </div>
          <div class="public-actions">${actionsFor(p)}</div>
        </div>
      </header>`;
  }

  document.addEventListener("click", async (e) => {
    const add = e.target.closest("[data-add]");
    if (add) return doAction(add, add.dataset.add, "request", "Friend request sent ✨");
    const accept = e.target.closest("[data-accept]");
    if (accept) return doAction(accept, accept.dataset.accept, "accept", "Friend added 💖");
    const decline = e.target.closest("[data-decline]");
    if (decline) return doAction(decline, decline.dataset.decline, "decline", "Declined");
    const cancel = e.target.closest("[data-cancel]");
    if (cancel) return doAction(cancel, cancel.dataset.cancel, "cancel", "Request cancelled");
    const unfriend = e.target.closest("[data-unfriend]");
    if (unfriend) {
      if (!confirm("Unfriend this person?")) return;
      return doAction(unfriend, unfriend.dataset.unfriend, "unfriend", "Unfriended");
    }
  });

  async function doAction(btn, otherId, kind, successMsg) {
    btn.disabled = true;
    try {
      const url    = `/api/me/friends/${encodeURIComponent(otherId)}` +
                     (kind === "accept" ? "/accept" : kind === "decline" ? "/decline" : "");
      const method = (kind === "request") ? "POST"
                   : (kind === "accept" || kind === "decline") ? "POST"
                   : "DELETE";
      await fetchJson(url, { method });
      toast(successMsg, "ok");
      // Reload current profile to refresh the status pill + actions.
      await loadProfile(username);
    } catch (err) {
      toast(err.message || "Couldn't do that", "err");
      btn.disabled = false;
    }
  }

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
