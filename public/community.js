// Community — sub-tabs (Dashboard / Circles / Stories / Resources) +
// individual circle view. Routing via the ?tab=… and ?c=… query params.
console.info("EndoMe community build v2");

(() => {
  const views = {
    dashboard: document.getElementById("view-dashboard"),
    circles:   document.getElementById("view-circles"),
    stories:   document.getElementById("view-stories"),
    resources: document.getElementById("view-resources"),
    circle:    document.getElementById("view-circle"),
  };
  const TABS = ["dashboard", "circles", "stories", "resources"];

  let myTier = null;
  let currentCircle = null;
  let me = null;

  // --- Routing ----------------------------------------------------------
  function parseRoute() {
    const params = new URLSearchParams(location.search);
    const slug = params.get("c");
    if (slug) return { kind: "circle", slug };
    const tab = params.get("tab");
    if (TABS.includes(tab)) return { kind: "tab", tab };
    return { kind: "tab", tab: "dashboard" };
  }
  function goTab(tab, push = true) {
    if (!TABS.includes(tab)) tab = "dashboard";
    if (push) {
      const u = new URL(location.href);
      u.searchParams.delete("c");
      if (tab === "dashboard") u.searchParams.delete("tab");
      else u.searchParams.set("tab", tab);
      history.pushState({}, "", u.toString());
    }
    showView(tab);
    paintActiveTab(tab);
    if (tab === "dashboard") loadDashboard();
    if (tab === "circles")   loadCirclesHub();
    if (tab === "stories")   loadStoriesView();
    if (tab === "resources") loadResourcesView();
  }

  // --- Stories view ---------------------------------------------------
  async function loadStoriesView() {
    const grid = document.getElementById("published-stories");
    const countEl = document.getElementById("stories-count");
    grid.innerHTML = `<p class="empty-state">Loading…</p>`;
    try {
      const data = await fetchJson("/api/community/stories");
      const stories = data.stories || [];
      countEl.textContent = stories.length ? `${stories.length} published` : "";
      if (!stories.length) {
        grid.innerHTML = `<p class="empty-state">No stories published yet — be the first to share yours.</p>`;
      } else {
        grid.innerHTML = stories.map((s) => `
          <a class="story-card" href="/read-story?id=${s.id}">
            ${s.coverImageUrl
              ? `<div class="story-card-img"><img src="${escapeHtml(s.coverImageUrl)}" alt="" loading="lazy" /></div>`
              : `<div class="story-card-img story-card-img-empty">📖</div>`}
            <div class="story-card-body">
              <h3>${escapeHtml(s.title)}</h3>
              ${s.summary ? `<p class="story-card-summary">${escapeHtml(s.summary)}</p>` : ""}
              <div class="story-card-foot">
                <span class="story-card-author">${escapeHtml(s.author)}</span>
                <span class="story-card-date">${s.publishedAt ? new Date(s.publishedAt * 1000).toLocaleDateString() : ""}</span>
              </div>
            </div>
          </a>`).join("");
      }
    } catch (err) {
      grid.innerHTML = `<p class="empty-state">Couldn't load stories.</p>`;
    }
    // Always show "my drafts" if user has any
    try {
      const mine = await fetchJson("/api/me/stories");
      const list = mine.stories || [];
      const section = document.getElementById("my-stories-section");
      const ul = document.getElementById("my-stories");
      if (!list.length) { section.hidden = true; return; }
      section.hidden = false;
      const STATUS_LBL = {
        draft:"Draft", submitted:"Awaiting review", approved:"Approved",
        rejected:"Needs changes", published:"Published ✨",
      };
      ul.innerHTML = list.map((s) => `
        <li class="my-story-row">
          <a href="/write-story?id=${s.id}">
            <strong>${escapeHtml(s.title)}</strong>
            <span class="my-story-status status-${escapeHtml(s.status)}">${STATUS_LBL[s.status] || s.status}</span>
          </a>
        </li>`).join("");
    } catch {}
  }

  // --- Resources view -------------------------------------------------
  async function loadResourcesView() {
    const slot = document.getElementById("resources-slot");
    slot.innerHTML = `<p class="empty-state">Loading resources…</p>`;
    try {
      const data = await fetchJson("/api/community/resources");
      const cats = data.categories || [];
      const byCat = {};
      for (const r of (data.resources || [])) (byCat[r.category] ||= []).push(r);
      const html = cats
        .filter((c) => byCat[c.key]?.length)
        .map((c) => `
          <section class="community-section resource-cat">
            <div class="section-head">
              <h2>${c.icon} ${escapeHtml(c.label)}</h2>
              <span class="section-hint">${byCat[c.key].length} link${byCat[c.key].length === 1 ? "" : "s"}</span>
            </div>
            <div class="resources-grid">
              ${byCat[c.key].map((r) => `
                <article class="resource-card">
                  <h3>${escapeHtml(r.title)}</h3>
                  ${r.summary ? `<p>${escapeHtml(r.summary)}</p>` : ""}
                  ${r.url ? `<a class="resource-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Visit →</a>` : ""}
                </article>`).join("")}
            </div>
          </section>`).join("");
      slot.innerHTML = html || `<p class="empty-state">No resources published yet.</p>`;
    } catch (err) {
      slot.innerHTML = `<p class="empty-state">Couldn't load resources.</p>`;
    }
  }
  function goCircle(slug, push = true) {
    if (push) history.pushState({}, "", `/community?c=${encodeURIComponent(slug)}`);
    showView("circle");
    paintActiveTab("circles"); // circle is "inside" circles
    loadCircle(slug);
  }
  function showView(name) {
    for (const [k, el] of Object.entries(views)) {
      if (!el) continue;
      el.hidden = k !== name;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function paintActiveTab(tab) {
    document.querySelectorAll(".csn-tab").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.tab === tab);
      b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false");
    });
  }
  window.addEventListener("popstate", () => {
    const r = parseRoute();
    if (r.kind === "circle") goCircle(r.slug, false);
    else goTab(r.tab, false);
  });

  // Sub-nav tab clicks
  document.querySelectorAll(".csn-tab").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      goTab(btn.dataset.tab);
    });
  });
  document.addEventListener("click", (e) => {
    const tabLink = e.target.closest("[data-tab-link]");
    if (tabLink) { e.preventDefault(); goTab(tabLink.dataset.tabLink); }
    if (e.target.closest("[data-go-circles]")) { e.preventDefault(); goTab("circles"); }
  });

  // --- Bootstrap --------------------------------------------------------
  (async () => {
    try {
      me = await fetchJson("/api/me/today");
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = me?.user?.displayName || me?.user?.username || "there";
      });
    } catch {}
    const r = parseRoute();
    if (r.kind === "circle") await loadCircle(r.slug);
    else goTab(r.tab, false);
    document.getElementById("page-loader")?.classList.add("is-hidden");
  })();

  // ====================================================================
  // DASHBOARD VIEW — community-wide stats + top circles + recent activity
  // ====================================================================
  async function loadDashboard() {
    // The hub call gives us tier + my circles for the official-circle hero;
    // stats gives the KPI numbers and activity list.
    const [hub, stats] = await Promise.all([
      fetchJson("/api/me/community").catch(() => null),
      fetchJson("/api/me/community/stats").catch(() => null),
    ]);
    if (hub) {
      myTier = hub.tier;
      renderTier(hub.tier);
    }
    if (stats) renderStats(stats);
    else renderStatsError();
  }

  function renderTier(t) {
    if (!t) return;
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

  function renderStats(s) {
    const t = s.totals || {};
    const w = s.thisWeek || {};
    setNum("stat-members", t.members);
    setNum("stat-circles", t.circles);
    const mix = document.getElementById("stat-circles-mix");
    if (mix) mix.textContent = (t.openCircles || t.privateCircles)
      ? `${t.openCircles} open · ${t.privateCircles} private` : "";
    setNum("stat-posts",   t.posts);
    setNum("stat-hearts",  t.hearts);
    setNum("stat-stories", t.stories);
    setNum("stat-active",  w.activeMembers);

    document.querySelectorAll(".stat-tile[data-skel]").forEach((el) => el.removeAttribute("data-skel"));

    // Top circles grid (mini cards)
    const tcEl = document.getElementById("top-circles");
    const tops = s.topCircles || [];
    if (!tops.length) {
      tcEl.innerHTML = `<p class="empty-state">No circles yet.</p>`;
    } else {
      tcEl.innerHTML = tops.map(miniCircleCard).join("");
    }

    // Recent activity
    const raEl = document.getElementById("recent-activity");
    const acts = s.recentActivity || [];
    if (!acts.length) {
      raEl.innerHTML = `<li class="empty-state">Nothing posted yet — be the first.</li>`;
    } else {
      raEl.innerHTML = acts.map(activityRow).join("");
    }
  }
  function renderStatsError() {
    document.querySelectorAll(".stat-tile-num").forEach((el) => el.textContent = "—");
  }
  function setNum(id, n) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = formatNum(n);
  }
  function formatNum(n) {
    if (n == null) return "—";
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
    return String(n);
  }
  function miniCircleCard(c) {
    return `<a class="circle-card mini ${c.isOfficial ? "is-official" : ""}" href="/community?c=${encodeURIComponent(c.slug)}" data-open="${escapeHtml(c.slug)}">
      <div class="circle-card-top">
        <div class="circle-card-icon">${c.isOfficial ? "🌸" : "💬"}</div>
        <div class="circle-card-body">
          <div class="circle-card-name">
            ${escapeHtml(c.name)}
            ${c.isOfficial ? `<span class="official-pill small">Official</span>` : ""}
            <span class="type-pill small">${c.isOpen ? "Open" : "Private"}</span>
          </div>
          <div class="circle-card-meta">
            <span>👥 ${c.memberCount}</span>
            <span>· 💬 ${c.postCount}</span>
          </div>
        </div>
      </div>
    </a>`;
  }
  function activityRow(a) {
    // Uploaded photo wins, then chosen emoji, then initials fallback.
    const avatarInner = a.authorAvatarUrl
      ? `<img src="${escapeHtml(a.authorAvatarUrl)}" alt="" />`
      : a.authorAvatar
        ? `<span class="emoji">${escapeHtml(a.authorAvatar)}</span>`
        : escapeHtml(initials(a.authorName));
    const avatarClass = a.authorAvatarUrl
      ? "activity-avatar has-image"
      : a.authorAvatar ? "activity-avatar has-emoji" : "activity-avatar";
    return `<li class="activity-item">
      <a href="/community?c=${encodeURIComponent(a.circleSlug)}" class="activity-link" data-open="${escapeHtml(a.circleSlug)}">
        <div class="${avatarClass}">${avatarInner}</div>
        <div class="activity-body">
          <div class="activity-head">
            <strong>${escapeHtml(a.authorName)}</strong>
            <span class="activity-meta">in ${escapeHtml(a.circleName)}${a.circleOfficial ? " · 🌸" : ""}${a.isQuestion ? " · ❓" : ""}</span>
          </div>
          <p class="activity-body-text">${escapeHtml(a.body)}</p>
          <span class="activity-time">${relTime(a.createdAt)}</span>
        </div>
      </a>
    </li>`;
  }

  // ====================================================================
  // CIRCLES HUB VIEW
  // ====================================================================
  async function loadCirclesHub() {
    try {
      const data = await fetchJson("/api/me/community");
      myTier = data.tier;
      renderTier(data.tier);

      const my = data.myCircles || [];
      const officialIdx = my.findIndex((c) => c.is_official);
      const official = officialIdx >= 0 ? my.splice(officialIdx, 1)[0] : null;
      renderOfficial(official);
      renderCircles(document.getElementById("my-circles"), my, { showRole: true });
      renderCircles(document.getElementById("discover-circles"), data.discover || [], { showRole: false, withJoin: true });

      const createBtn = document.getElementById("btn-create");
      createBtn.disabled = false;
      createBtn.title = "Create a new circle — open to everyone or invite-only.";
    } catch (err) {
      document.getElementById("discover-circles").innerHTML =
        `<p class="empty-state">Couldn't load circles right now.</p>`;
    }
  }

  function renderOfficial(c) {
    const section = document.getElementById("official-section");
    const slot = document.getElementById("official-card-slot");
    if (!c) { section.hidden = true; return; }
    section.hidden = false;
    const desc = c.description || "The home for everyone here. Share stories, ask questions, lift each other up.";
    slot.innerHTML = `
      <article class="circle-hero-card" data-open="${escapeHtml(c.slug)}">
        <div class="circle-hero-card-icon">🌸</div>
        <div class="circle-hero-card-body">
          <div class="circle-hero-card-top">
            <h2>${escapeHtml(c.name)}</h2>
            <span class="official-pill">Official</span>
            <span class="type-pill">Open · everyone welcome</span>
            ${c.role ? `<span class="role-pill role-${c.role}">${roleLabel(c.role)}</span>` : ""}
          </div>
          <p>${escapeHtml(desc)}</p>
          <div class="circle-hero-card-meta">
            <span>👥 ${c.member_count || 0} member${(c.member_count||0)===1?"":"s"}</span>
            <span>📝 ${c.post_count || 0} post${(c.post_count||0)===1?"":"s"}</span>
          </div>
        </div>
        <div class="circle-hero-card-actions">
          <button class="btn btn-primary" data-open="${escapeHtml(c.slug)}">Open EndoMe →</button>
        </div>
      </article>`;
  }
  function roleLabel(r) {
    return r === "admin" ? "👑 Admin" : r === "moderator" ? "🛡 Moderator" : "💖 Member";
  }

  function renderCircles(container, list, opts = {}) {
    if (!list.length) {
      container.innerHTML = opts.withJoin
        ? `<p class="empty-state">No new circles to discover right now. Once Trusted, you can create your own.</p>`
        : `<p class="empty-state">You're in the official EndoMe circle above. Join others from "Discover" below or create your own once you're Trusted.</p>`;
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
              <span class="type-pill small">${c.is_open ? "Open" : "Private"}</span>
              ${opts.showRole && c.role ? `<span class="role-pill role-${c.role}">${c.role}</span>` : ""}
            </div>
            <p class="circle-card-desc">${escapeHtml(c.description || "")}</p>
            <div class="circle-card-meta">
              <span>👥 ${c.member_count || 0} member${(c.member_count||0)===1?"":"s"}</span>
              ${c.post_count != null ? `<span>· 💬 ${c.post_count} post${c.post_count===1?"":"s"}</span>` : ""}
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
  });

  // --- Create circle modal ----------------------------------------------
  const createModal = document.getElementById("create-circle-modal");
  document.getElementById("btn-create").addEventListener("click", () => {
    openCreateModal();
  });
  function openCreateModal() { createModal.classList.add("open"); createModal.setAttribute("aria-hidden", "false"); }
  function closeCreateModal() { createModal.classList.remove("open"); createModal.setAttribute("aria-hidden", "true"); }
  document.querySelectorAll("[data-close-modal]").forEach((el) =>
    el.addEventListener("click", (e) => { e.preventDefault(); closeCreateModal(); })
  );
  document.getElementById("create-circle-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const status = document.getElementById("create-status");
    status.textContent = "Creating…"; status.className = "form-status";
    try {
      const isOpen = (form.querySelector('input[name="isOpen"]:checked')?.value ?? "true") === "true";
      const data = await fetchJson("/api/me/community/circles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: form.name.value, description: form.description.value, isOpen }),
      });
      toast("Circle created 🌸");
      closeCreateModal();
      form.reset();
      goCircle(data.slug);
    } catch (err) {
      status.textContent = err.message || "Couldn't create circle.";
      status.className = "form-status err";
    }
  });

  // ====================================================================
  // INDIVIDUAL CIRCLE VIEW
  // ====================================================================
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
    document.getElementById("circle-members").textContent = `👥 ${c.memberCount} member${c.memberCount === 1 ? "" : "s"}`;
    document.getElementById("circle-posts-count").textContent =
      `💬 ${c.postsCount ?? "—"} post${(c.postsCount ?? 0) === 1 ? "" : "s"}`;
    const tp = document.getElementById("circle-type-pill");
    if (tp) {
      tp.textContent = c.isOpen ? "Open" : "Private";
      tp.classList.toggle("is-private", !c.isOpen);
    }
    const roleEl = document.getElementById("circle-role");
    if (c.myRole) {
      roleEl.hidden = false;
      roleEl.textContent = roleLabel(c.myRole);
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
      const avatar = document.getElementById("compose-avatar");
      if (avatar) avatar.textContent = initials(me?.user?.displayName || me?.user?.username || "Y");
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
      goTab("circles");
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
    const avatarInner = p.authorAvatarUrl
      ? `<img src="${escapeHtml(p.authorAvatarUrl)}" alt="" />`
      : p.authorAvatar
        ? `<span class="emoji">${escapeHtml(p.authorAvatar)}</span>`
        : escapeHtml(initials(p.authorName));
    const avatarClass = p.authorAvatarUrl
      ? "author-avatar has-image"
      : p.authorAvatar ? "author-avatar has-emoji" : "author-avatar";
    const profileHref = p.authorUsername ? `/u/${encodeURIComponent(p.authorUsername)}` : null;
    return `
      <article class="post-card ${p.isQuestion ? "is-question" : ""}" data-post-id="${p.id}">
        <header class="post-head">
          <div class="post-author">
            ${profileHref
              ? `<a href="${profileHref}" class="author-link"><div class="${avatarClass}">${avatarInner}</div></a>`
              : `<div class="${avatarClass}">${avatarInner}</div>`}
            <div>
              ${profileHref
                ? `<a href="${profileHref}" class="author-link"><strong>${escapeHtml(p.authorName)}</strong></a>`
                : `<strong>${escapeHtml(p.authorName)}</strong>`}
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
            <span class="react-label">Comment${(p.replyCount||0)===1?"":"s"}</span>
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
    const avatarInner = r.authorAvatarUrl
      ? `<img src="${escapeHtml(r.authorAvatarUrl)}" alt="" />`
      : r.authorAvatar
        ? `<span class="emoji">${escapeHtml(r.authorAvatar)}</span>`
        : escapeHtml(initials(r.authorName));
    const avatarClass = r.authorAvatarUrl
      ? "author-avatar small has-image"
      : r.authorAvatar ? "author-avatar small has-emoji" : "author-avatar small";
    const profileHref = r.authorUsername ? `/u/${encodeURIComponent(r.authorUsername)}` : null;
    return `
      <li class="reply">
        ${profileHref
          ? `<a href="${profileHref}" class="author-link"><div class="${avatarClass}">${avatarInner}</div></a>`
          : `<div class="${avatarClass}">${avatarInner}</div>`}
        <div class="reply-body">
          <div class="reply-head">
            ${profileHref
              ? `<a href="${profileHref}" class="author-link"><strong>${escapeHtml(r.authorName)}</strong></a>`
              : `<strong>${escapeHtml(r.authorName)}</strong>`}
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
