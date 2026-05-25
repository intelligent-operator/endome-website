(() => {
  const viewHub    = document.getElementById("view-hub");
  const viewCircle = document.getElementById("view-circle");
  let myTier = null;
  let currentCircle = null;

  // --- Routing -----------------------------------------------------------
  function parseRoute() {
    const params = new URLSearchParams(location.search);
    const slug = params.get("c");
    return slug ? { kind: "circle", slug } : { kind: "hub" };
  }
  function goHub(push = true) {
    if (push) history.pushState({}, "", "/community");
    showView("hub");
    loadHub();
  }
  function goCircle(slug, push = true) {
    if (push) history.pushState({}, "", `/community?c=${encodeURIComponent(slug)}`);
    showView("circle");
    loadCircle(slug);
  }
  function showView(name) {
    viewHub.hidden    = name !== "hub";
    viewCircle.hidden = name !== "circle";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  window.addEventListener("popstate", () => {
    const r = parseRoute();
    if (r.kind === "circle") goCircle(r.slug, false);
    else goHub(false);
  });

  // --- Bootstrap --------------------------------------------------------
  (async () => {
    try {
      const me = await fetchJson("/api/me/today");
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = me?.user?.displayName || me?.user?.username || "there";
      });
    } catch {}
    const r = parseRoute();
    if (r.kind === "circle") await loadCircle(r.slug);
    else await loadHub();
    document.getElementById("page-loader")?.classList.add("is-hidden");
  })();

  // --- Hub --------------------------------------------------------------
  async function loadHub() {
    try {
      const data = await fetchJson("/api/me/community");
      myTier = data.tier;
      renderTier(data.tier);
      renderCircles(document.getElementById("my-circles"), data.myCircles || [], { showRole: true });
      renderCircles(document.getElementById("discover-circles"), data.discover || [], { showRole: false, withJoin: true });
      const createBtn = document.getElementById("btn-create");
      createBtn.disabled = !data.tier.canCreateCircle;
      createBtn.title = data.tier.canCreateCircle
        ? "Create a new circle"
        : `Unlocks at the Trusted tier (${data.tier.nextMinDays ?? 30}+ logged days)`;
    } catch (err) {
      document.getElementById("discover-circles").innerHTML =
        `<p class="empty-state">Couldn't load circles right now.</p>`;
    }
  }

  function renderTier(t) {
    document.getElementById("tier-label").textContent = t.label;
    const card = document.getElementById("tier-card");
    card.dataset.tier = t.key;
    const meta = document.getElementById("tier-meta");
    if (t.canCreateCircle) {
      meta.textContent = `${t.distinctLogDays} logged days · you can create circles ✨`;
    } else if (t.nextLabel) {
      const left = Math.max(0, (t.nextMinDays || 0) - (t.distinctLogDays || 0));
      meta.textContent = `${t.distinctLogDays} logged days · ${left} more to reach ${t.nextLabel}`;
    } else {
      meta.textContent = `${t.distinctLogDays} logged days`;
    }
  }

  function renderCircles(container, list, opts = {}) {
    if (!list.length) {
      container.innerHTML = opts.withJoin
        ? `<p class="empty-state">No new circles to discover right now. Once Trusted, you can create your own.</p>`
        : `<p class="empty-state">You'll see your circles here once you're in one.</p>`;
      return;
    }
    container.innerHTML = list.map((c) => `
      <article class="circle-card ${c.is_official ? "is-official" : ""}">
        <div class="circle-card-top">
          <div class="circle-card-icon">${c.is_official ? "🌸" : "💬"}</div>
          <div class="circle-card-body">
            <div class="circle-card-name">
              ${escapeHtml(c.name)}
              ${c.is_official ? `<span class="official-pill small">Official</span>` : ""}
              ${opts.showRole && c.role ? `<span class="role-pill role-${c.role}">${c.role}</span>` : ""}
            </div>
            <p class="circle-card-desc">${escapeHtml(c.description || "")}</p>
            <div class="circle-card-meta">
              <span>${c.member_count || 0} member${(c.member_count||0)===1?"":"s"}</span>
              ${c.post_count != null ? `<span>· ${c.post_count} post${c.post_count===1?"":"s"}</span>` : ""}
            </div>
          </div>
        </div>
        <div class="circle-card-foot">
          ${opts.withJoin
            ? `<button class="btn-soft" data-join="${escapeHtml(c.slug)}">Join</button>
               <button class="btn btn-primary" data-open="${escapeHtml(c.slug)}">Open →</button>`
            : `<button class="btn btn-primary" data-open="${escapeHtml(c.slug)}">Open →</button>`
          }
        </div>
      </article>`).join("");
  }

  document.addEventListener("click", async (e) => {
    const open = e.target.closest("[data-open]");
    if (open) { e.preventDefault(); goCircle(open.dataset.open); return; }
    const join = e.target.closest("[data-join]");
    if (join) {
      e.preventDefault();
      const slug = join.dataset.join;
      join.disabled = true;
      try {
        await fetchJson(`/api/me/community/circles/${slug}/join`, { method: "POST" });
        toast("Joined ✨");
        goCircle(slug);
      } catch (err) {
        toast(err.message || "Couldn't join", "err");
        join.disabled = false;
      }
      return;
    }
    if (e.target.closest("[data-go-hub]")) { e.preventDefault(); goHub(); return; }
  });

  // --- Create circle modal ----------------------------------------------
  const createModal = document.getElementById("create-circle-modal");
  document.getElementById("btn-create").addEventListener("click", () => {
    if (!myTier?.canCreateCircle) {
      toast(`Trusted tier needed — keep logging, you'll get there.`, "err");
      return;
    }
    openModal();
  });
  function openModal() { createModal.classList.add("open"); createModal.setAttribute("aria-hidden", "false"); }
  function closeModal() { createModal.classList.remove("open"); createModal.setAttribute("aria-hidden", "true"); }
  document.querySelectorAll("[data-close-modal]").forEach((el) =>
    el.addEventListener("click", (e) => { e.preventDefault(); closeModal(); })
  );
  document.getElementById("create-circle-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const status = document.getElementById("create-status");
    status.textContent = "Creating…"; status.className = "form-status";
    try {
      const data = await fetchJson("/api/me/community/circles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: form.name.value, description: form.description.value }),
      });
      toast("Circle created 🌸");
      closeModal();
      form.reset();
      goCircle(data.slug);
    } catch (err) {
      status.textContent = err.message || "Couldn't create circle.";
      status.className = "form-status err";
    }
  });

  // --- Circle view ------------------------------------------------------
  async function loadCircle(slug) {
    try {
      const data = await fetchJson(`/api/me/community/circles/${encodeURIComponent(slug)}`);
      currentCircle = data.circle;
      renderCircleHeader(data.circle);
      renderPosts(data.posts || []);
    } catch (err) {
      document.getElementById("posts-list").innerHTML =
        `<p class="empty-state">${escapeHtml(err.message || "Couldn't open this circle.")}</p>`;
    }
  }

  function renderCircleHeader(c) {
    document.getElementById("circle-name").textContent = c.name;
    document.getElementById("circle-desc").textContent = c.description || "A space to share, ask, and support each other.";
    const off = document.getElementById("circle-official");
    off.hidden = !c.isOfficial;
    document.getElementById("circle-members").textContent = `${c.memberCount} member${c.memberCount === 1 ? "" : "s"}`;
    const roleEl = document.getElementById("circle-role");
    if (c.myRole) {
      roleEl.hidden = false;
      roleEl.textContent = c.myRole === "admin" ? "👑 Admin" : c.myRole === "moderator" ? "🛡 Moderator" : "💖 Member";
      roleEl.className = `role-pill role-${c.myRole}`;
    } else {
      roleEl.hidden = true;
    }
    const joinBtn = document.getElementById("circle-join");
    const leaveBtn = document.getElementById("circle-leave");
    const composeCard = document.getElementById("compose-card");
    if (c.myRole) {
      joinBtn.hidden = true;
      leaveBtn.hidden = c.isOfficial; // can't leave official
      composeCard.hidden = false;
    } else {
      joinBtn.hidden = false;
      leaveBtn.hidden = true;
      composeCard.hidden = true;
    }
  }

  document.getElementById("circle-join").addEventListener("click", async () => {
    if (!currentCircle) return;
    try {
      await fetchJson(`/api/me/community/circles/${currentCircle.slug}/join`, { method: "POST" });
      toast("Joined ✨");
      await loadCircle(currentCircle.slug);
    } catch (err) {
      toast(err.message || "Couldn't join", "err");
    }
  });
  document.getElementById("circle-leave").addEventListener("click", async () => {
    if (!currentCircle) return;
    if (!confirm("Leave this circle?")) return;
    try {
      await fetchJson(`/api/me/community/circles/${currentCircle.slug}/leave`, { method: "POST" });
      toast("Left circle");
      goHub();
    } catch (err) {
      toast(err.message || "Couldn't leave", "err");
    }
  });

  // Compose post
  const composeBody = document.getElementById("compose-body");
  const composeBtn = document.getElementById("compose-post");
  composeBody.addEventListener("input", () => {
    composeBtn.disabled = composeBody.value.trim().length < 1;
  });
  composeBtn.addEventListener("click", async () => {
    if (!currentCircle) return;
    const body = composeBody.value.trim();
    if (!body) return;
    const isQuestion = document.getElementById("compose-question").checked;
    composeBtn.disabled = true;
    composeBtn.textContent = "Posting…";
    try {
      await fetchJson(`/api/me/community/circles/${currentCircle.slug}/posts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, isQuestion }),
      });
      composeBody.value = "";
      document.getElementById("compose-question").checked = false;
      toast("Posted ✨");
      await loadCircle(currentCircle.slug);
    } catch (err) {
      toast(err.message || "Couldn't post", "err");
    } finally {
      composeBtn.disabled = composeBody.value.trim().length < 1;
      composeBtn.textContent = "Post";
    }
  });

  // Render posts
  function renderPosts(posts) {
    const list = document.getElementById("posts-list");
    if (!posts.length) {
      list.innerHTML = `<p class="empty-state">No posts yet. Be the first — questions and small wins both welcome.</p>`;
      return;
    }
    list.innerHTML = posts.map(postHtml).join("");
  }
  function postHtml(p) {
    return `
      <article class="post-card ${p.isQuestion ? "is-question" : ""}" data-post-id="${p.id}">
        <header class="post-head">
          <div class="post-author">
            <div class="author-avatar">${escapeHtml(initials(p.authorName))}</div>
            <div>
              <strong>${escapeHtml(p.authorName)}</strong>
              <span class="post-time">${relTime(p.createdAt)}${p.isQuestion ? " · ❓ Question" : ""}</span>
            </div>
          </div>
          ${p.mine ? `<button class="post-delete" data-delete-post="${p.id}" title="Delete">×</button>` : ""}
        </header>
        <p class="post-body">${escapeHtml(p.body)}</p>
        <footer class="post-foot">
          <button class="react-btn ${p.iHearted ? "on" : ""}" data-react-post="${p.id}">
            <span>${p.iHearted ? "💖" : "🤍"}</span>
            <span class="react-count">${p.heartCount || 0}</span>
          </button>
          <button class="react-btn" data-toggle-replies="${p.id}">
            <span>💬</span>
            <span class="react-count">${p.replyCount || 0}</span>
          </button>
        </footer>
        <div class="replies-block" data-replies-block="${p.id}" hidden></div>
      </article>`;
  }

  document.addEventListener("click", async (e) => {
    const react = e.target.closest("[data-react-post]");
    if (react) {
      e.preventDefault();
      const id = react.dataset.reactPost;
      try {
        const data = await fetchJson(`/api/me/community/posts/${id}/react`, { method: "POST" });
        // optimistic
        const heartIcon = react.querySelector("span:first-child");
        const count     = react.querySelector(".react-count");
        const cur = parseInt(count.textContent || "0", 10) || 0;
        if (data.hearted) {
          react.classList.add("on"); heartIcon.textContent = "💖"; count.textContent = cur + 1;
        } else {
          react.classList.remove("on"); heartIcon.textContent = "🤍"; count.textContent = Math.max(0, cur - 1);
        }
      } catch (err) {
        toast(err.message || "Couldn't react", "err");
      }
      return;
    }
    const del = e.target.closest("[data-delete-post]");
    if (del) {
      e.preventDefault();
      if (!confirm("Delete this post?")) return;
      try {
        await fetchJson(`/api/me/community/posts/${del.dataset.deletePost}`, { method: "DELETE" });
        toast("Deleted");
        await loadCircle(currentCircle.slug);
      } catch (err) {
        toast(err.message || "Couldn't delete", "err");
      }
      return;
    }
    const toggle = e.target.closest("[data-toggle-replies]");
    if (toggle) {
      e.preventDefault();
      const id = toggle.dataset.toggleReplies;
      const block = document.querySelector(`[data-replies-block="${id}"]`);
      if (!block) return;
      if (block.hidden) {
        block.hidden = false;
        await loadReplies(id, block);
      } else {
        block.hidden = true;
      }
      return;
    }
    const replyBtn = e.target.closest("[data-send-reply]");
    if (replyBtn) {
      e.preventDefault();
      const id = replyBtn.dataset.sendReply;
      const block = document.querySelector(`[data-replies-block="${id}"]`);
      const input = block.querySelector("textarea");
      const body = input.value.trim();
      if (!body) return;
      replyBtn.disabled = true;
      try {
        await fetchJson(`/api/me/community/posts/${id}/replies`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body }),
        });
        input.value = "";
        await loadReplies(id, block);
        // refresh post reply count
        await loadCircle(currentCircle.slug);
      } catch (err) {
        toast(err.message || "Couldn't reply", "err");
      } finally {
        replyBtn.disabled = false;
      }
      return;
    }
    const reactReply = e.target.closest("[data-react-reply]");
    if (reactReply) {
      e.preventDefault();
      const id = reactReply.dataset.reactReply;
      try {
        const data = await fetchJson(`/api/me/community/replies/${id}/react`, { method: "POST" });
        const heartIcon = reactReply.querySelector("span:first-child");
        const count     = reactReply.querySelector(".react-count");
        const cur = parseInt(count.textContent || "0", 10) || 0;
        if (data.hearted) {
          reactReply.classList.add("on"); heartIcon.textContent = "💖"; count.textContent = cur + 1;
        } else {
          reactReply.classList.remove("on"); heartIcon.textContent = "🤍"; count.textContent = Math.max(0, cur - 1);
        }
      } catch (err) {
        toast(err.message || "Couldn't react", "err");
      }
    }
  });

  async function loadReplies(postId, block) {
    block.innerHTML = `<p class="empty-state small">Loading replies…</p>`;
    try {
      const data = await fetchJson(`/api/me/community/posts/${postId}/replies`);
      const replies = data.replies || [];
      block.innerHTML = `
        <ul class="replies-list">
          ${replies.map(replyHtml).join("")}
        </ul>
        <div class="reply-compose">
          <textarea placeholder="Write a kind reply…" maxlength="1000" rows="2"></textarea>
          <button class="btn btn-primary small" data-send-reply="${postId}">Reply</button>
        </div>`;
    } catch (err) {
      block.innerHTML = `<p class="empty-state small">${escapeHtml(err.message || "Couldn't load replies")}</p>`;
    }
  }

  function replyHtml(r) {
    return `
      <li class="reply">
        <div class="author-avatar small">${escapeHtml(initials(r.authorName))}</div>
        <div class="reply-body">
          <div class="reply-head">
            <strong>${escapeHtml(r.authorName)}</strong>
            <span class="post-time">${relTime(r.createdAt)}</span>
          </div>
          <p>${escapeHtml(r.body)}</p>
          <button class="react-btn small ${r.iHearted ? "on" : ""}" data-react-reply="${r.id}">
            <span>${r.iHearted ? "💖" : "🤍"}</span>
            <span class="react-count">${r.heartCount || 0}</span>
          </button>
        </div>
      </li>`;
  }

  // --- Helpers ----------------------------------------------------------
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
  function initials(name) {
    if (!name) return "?";
    const parts = String(name).trim().split(/\s+/);
    return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
  }
  function relTime(unixSec) {
    if (!unixSec) return "";
    const diff = Math.floor(Date.now() / 1000) - unixSec;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
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
