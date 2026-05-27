// /profile — view + edit your EndoMe profile, manage friends.
console.info("EndoMe profile build v1");

(() => {
  const AVATARS = [
    "🌸","🌷","🌻","🌼","🌹","🌺","🌿","🌱",
    "🦋","🐝","🐞","🐰","🐱","🐶","🐢","🐧",
    "🍓","🍑","🍊","🍋","🍒","🥑","🍇","🍉",
    "✨","💖","🌙","⭐","🍀","🌈","☀️","🍵",
  ];
  const DEFAULT_AVATAR = "🌸";

  let me = null;          // /api/me/today snapshot
  let profile = null;     // /api/me/profile

  // --- Avatar grid -----------------------------------------------------
  const grid = document.getElementById("avatar-grid");
  for (const a of AVATARS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "avatar-chip";
    btn.dataset.avatar = a;
    btn.textContent = a;
    btn.setAttribute("aria-label", `Pick ${a} as your avatar`);
    btn.addEventListener("click", () => setSelectedAvatar(a));
    grid.appendChild(btn);
  }
  function setSelectedAvatar(a) {
    document.querySelectorAll(".avatar-chip").forEach((el) =>
      el.classList.toggle("on", el.dataset.avatar === a));
    document.getElementById("profile-avatar").textContent = a || DEFAULT_AVATAR;
    grid.dataset.selected = a || "";
  }

  // --- Bootstrap -------------------------------------------------------
  (async () => {
    try {
      me = await fetchJson("/api/me/today");
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = me?.user?.displayName || me?.user?.username || "there";
      });
    } catch {}
    await Promise.all([loadProfile(), loadFriends()]);
    document.getElementById("page-loader")?.classList.add("is-hidden");
  })();

  async function loadProfile() {
    try {
      const data = await fetchJson("/api/me/profile");
      profile = data.profile;
      paintProfile(profile);
    } catch (err) {
      toast(err.message || "Couldn't load profile", "err");
    }
  }
  function paintProfile(p) {
    document.getElementById("profile-name").textContent = p.name;
    document.getElementById("profile-handle").textContent = "@" + p.username;
    document.getElementById("profile-bio").textContent =
      p.bio || "Add a bio below — it shows on your profile.";
    paintAvatarDisplay(p);
    document.getElementById("stat-posts").textContent   = p.postCount   || 0;
    document.getElementById("stat-circles").textContent = p.circleCount || 0;
    document.getElementById("stat-friends").textContent = p.friendCount || 0;

    const form = document.getElementById("profile-form");
    form.alias.value = p.alias || "";
    form.bio.value   = p.bio   || "";
    setSelectedAvatar(p.avatar || DEFAULT_AVATAR);
  }

  // Paint the big hero avatar + the small upload preview tile. Uploaded
  // image wins; otherwise the chosen emoji; otherwise the default 🌸.
  function paintAvatarDisplay(p) {
    const hero = document.getElementById("profile-avatar");
    const preview = document.getElementById("avatar-upload-preview");
    const removeBtn = document.getElementById("avatar-remove");
    if (p.avatarUrl) {
      const url = p.avatarUrl;
      hero.textContent = "";
      hero.style.backgroundImage = `url("${url}")`;
      hero.classList.add("has-image");
      if (preview) {
        preview.textContent = "";
        preview.style.backgroundImage = `url("${url}")`;
        preview.classList.add("has-image");
      }
      if (removeBtn) removeBtn.hidden = false;
    } else {
      hero.textContent = p.avatar || DEFAULT_AVATAR;
      hero.style.backgroundImage = "";
      hero.classList.remove("has-image");
      if (preview) {
        preview.textContent = p.avatar || DEFAULT_AVATAR;
        preview.style.backgroundImage = "";
        preview.classList.remove("has-image");
      }
      if (removeBtn) removeBtn.hidden = true;
    }
  }

  // --- Upload / remove photo -----------------------------------------
  document.getElementById("avatar-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const status = document.getElementById("avatar-status");
    status.textContent = "Uploading…"; status.className = "form-status";
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/me/avatar", {
        method: "POST", credentials: "same-origin", body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      status.textContent = "Photo uploaded ✨"; status.className = "form-status ok";
      // Reload profile so the new avatar URL paints everywhere.
      await loadProfile();
      // Bust the topbar avatar too.
      paintTopbarAvatar({ ...me?.user, avatarUrl: data.avatarUrl });
    } catch (err) {
      status.textContent = err.message || "Couldn't upload."; status.className = "form-status err";
    } finally {
      e.target.value = "";
    }
  });
  document.getElementById("avatar-remove").addEventListener("click", async () => {
    if (!confirm("Remove your uploaded photo and go back to the chosen emoji?")) return;
    const status = document.getElementById("avatar-status");
    status.textContent = "Removing…"; status.className = "form-status";
    try {
      await fetchJson("/api/me/avatar", { method: "DELETE" });
      status.textContent = "Photo removed."; status.className = "form-status ok";
      await loadProfile();
      paintTopbarAvatar({ ...me?.user, avatarUrl: null });
    } catch (err) {
      status.textContent = err.message || "Couldn't remove."; status.className = "form-status err";
    }
  });

  // Topbar avatar swap — replaces the inline SVG with the uploaded image.
  function paintTopbarAvatar(u) {
    if (!u?.avatarUrl) return;
    document.querySelectorAll(".dash-topbar .avatar, .account-toggle .avatar").forEach((el) => {
      el.innerHTML = `<img src="${u.avatarUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`;
    });
  }

  // --- Save profile ----------------------------------------------------
  document.getElementById("profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const status = document.getElementById("profile-status");
    status.textContent = "Saving…"; status.className = "form-status";
    const body = {
      alias:  form.alias.value.trim() || null,
      bio:    form.bio.value.trim()   || null,
      avatar: grid.dataset.selected   || DEFAULT_AVATAR,
    };
    try {
      const data = await fetchJson("/api/me/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      profile = data.profile;
      paintProfile(profile);
      status.textContent = "Saved ✨";
      status.className = "form-status ok";
      toast("Profile updated", "ok");
    } catch (err) {
      status.textContent = err.message || "Couldn't save.";
      status.className = "form-status err";
    }
  });

  // --- Friends ---------------------------------------------------------
  async function loadFriends() {
    try {
      const data = await fetchJson("/api/me/friends");
      paintFriends(data);
    } catch (err) {
      document.getElementById("friends-list").innerHTML =
        `<li class="empty-state">Couldn't load friends.</li>`;
    }
  }
  function paintFriends({ friends, incoming, outgoing }) {
    // Incoming
    const incSec = document.getElementById("incoming-section");
    const incList = document.getElementById("incoming-list");
    const incBadge = document.getElementById("incoming-badge");
    if (incoming?.length) {
      incSec.hidden = false;
      incBadge.textContent = String(incoming.length);
      incList.innerHTML = incoming.map((u) => friendRow(u, "incoming")).join("");
    } else {
      incSec.hidden = true;
    }
    // Friends
    const fList = document.getElementById("friends-list");
    if (!friends?.length) {
      fList.innerHTML = `<li class="empty-state">No friends yet — visit someone's profile from the community and tap "Add friend".</li>`;
    } else {
      fList.innerHTML = friends.map((u) => friendRow(u, "friend")).join("");
    }
    // Outgoing
    const outSec = document.getElementById("outgoing-section");
    const outList = document.getElementById("outgoing-list");
    if (outgoing?.length) {
      outSec.hidden = false;
      outList.innerHTML = outgoing.map((u) => friendRow(u, "outgoing")).join("");
    } else {
      outSec.hidden = true;
    }
  }
  function friendRow(u, kind) {
    const actions = kind === "incoming"
      ? `<button class="btn btn-primary small" data-accept="${escapeHtml(u.id)}">Accept</button>
         <button class="btn-soft small" data-decline="${escapeHtml(u.id)}">Decline</button>`
      : kind === "outgoing"
      ? `<button class="btn-soft small" data-cancel="${escapeHtml(u.id)}">Cancel request</button>`
      : `<a class="btn-soft small" href="/u/${encodeURIComponent(u.username)}">View profile</a>
         <button class="btn-soft small" data-unfriend="${escapeHtml(u.id)}">Unfriend</button>`;
    return `<li class="friend-card">
      <a href="/u/${encodeURIComponent(u.username)}" class="friend-link">
        <div class="friend-avatar">${escapeHtml(u.avatar || "🌸")}</div>
        <div class="friend-body">
          <strong>${escapeHtml(u.name)}</strong>
          <span class="friend-handle">@${escapeHtml(u.username)}</span>
          ${u.bio ? `<p class="friend-bio">${escapeHtml(u.bio)}</p>` : ""}
        </div>
      </a>
      <div class="friend-actions">${actions}</div>
    </li>`;
  }

  document.addEventListener("click", async (e) => {
    const accept = e.target.closest("[data-accept]");
    if (accept) { return doFriendAction(accept, accept.dataset.accept, "accept", "Friend added 💖"); }
    const decline = e.target.closest("[data-decline]");
    if (decline) { return doFriendAction(decline, decline.dataset.decline, "decline", "Declined"); }
    const cancel = e.target.closest("[data-cancel]");
    if (cancel) { return doFriendAction(cancel, cancel.dataset.cancel, "cancel", "Request cancelled"); }
    const unfriend = e.target.closest("[data-unfriend]");
    if (unfriend) {
      if (!confirm("Unfriend this person?")) return;
      return doFriendAction(unfriend, unfriend.dataset.unfriend, "unfriend", "Unfriended");
    }
  });

  async function doFriendAction(btn, otherId, kind, successMsg) {
    btn.disabled = true;
    try {
      const url = `/api/me/friends/${encodeURIComponent(otherId)}` + (kind === "accept" ? "/accept" : kind === "decline" ? "/decline" : "");
      const method = (kind === "accept" || kind === "decline") ? "POST" : "DELETE";
      await fetchJson(url, { method });
      toast(successMsg, "ok");
      await Promise.all([loadFriends(), loadProfile()]);
    } catch (err) {
      toast(err.message || "Couldn't do that", "err");
      btn.disabled = false;
    }
  }

  // --- Helpers ---------------------------------------------------------
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
