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

  // Cached lists for client-side search + filter. We keep raw arrays in
  // memory after the initial fetch so typing into a search box doesn't
  // hit the server on every keystroke.
  let myCirclesAll = [];
  let discoverAll = [];
  let circleFilter = "all";
  let circleQuery = "";
  let storiesAll = [];
  let storySort = "recent";
  let storyQuery = "";
  let resourcesAll = [];
  let resourceCats = [];
  let resourceCat = "all";
  let resourceQuery = "";

  // Fuzzy-ish search: tokenise the query into words, require each word
  // to appear (substring, case-insensitive) inside ANY of the haystack
  // fields. This handles "letter pain" → matches a circle titled
  // "Pain after laparoscopy" with description "letters from members".
  // Cheap enough to run on every keystroke against a few hundred items.
  function fuzzyMatch(query, fields) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return true;
    const hay = fields.filter(Boolean).join(" \n ").toLowerCase();
    // Multi-word AND: every whitespace-separated token must be present.
    const tokens = q.split(/\s+/).filter(Boolean);
    return tokens.every((t) => hay.includes(t));
  }
  // Highlight matched substrings in escaped HTML.
  function highlight(text, query) {
    const t = String(text || "");
    const q = String(query || "").trim();
    if (!q) return escapeHtml(t);
    const tokens = q.split(/\s+/).filter((x) => x.length >= 2);
    if (!tokens.length) return escapeHtml(t);
    // Build a regex from the longest tokens first so overlapping matches
    // don't get re-wrapped. Escape regex specials before composing.
    const re = new RegExp(
      tokens
        .sort((a, b) => b.length - a.length)
        .map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|"),
      "gi"
    );
    return escapeHtml(t).replace(re, (m) => `<mark>${m}</mark>`);
  }
  // Debounce so typing N characters runs the filter once at the end,
  // not N times.
  function debounce(fn, ms = 120) {
    let h = null;
    return (...args) => {
      clearTimeout(h);
      h = setTimeout(() => fn(...args), ms);
    };
  }

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
    grid.innerHTML = `<p class="empty-state">Loading…</p>`;
    try {
      const data = await fetchJson("/api/community/stories");
      storiesAll = data.stories || [];
      renderStoriesView();
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

  // Renders the stories grid against the cached storiesAll list using
  // the current search query + sort. Cheap enough to call on every
  // keystroke against a few hundred items.
  function renderStoriesView() {
    const grid = document.getElementById("published-stories");
    const countEl = document.getElementById("stories-count");
    if (!grid) return;
    let list = storiesAll.filter((s) =>
      fuzzyMatch(storyQuery, [s.title, s.summary, s.author])
    );
    if (storySort === "title")  list = [...list].sort((a, b) => String(a.title || "").localeCompare(b.title || ""));
    if (storySort === "author") list = [...list].sort((a, b) => String(a.author || "").localeCompare(b.author || ""));
    if (storySort === "recent") list = [...list].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
    countEl.textContent = storiesAll.length
      ? (storyQuery ? `· ${list.length}/${storiesAll.length}` : `· ${storiesAll.length}`)
      : "";
    if (!list.length) {
      grid.innerHTML = `
        <div class="stories-empty">
          <span class="stories-empty-ico">📖</span>
          <h3>${storyQuery ? `No stories match "${escapeHtml(storyQuery)}"` : "No published stories yet"}</h3>
          <p>${storyQuery
            ? "Try a different keyword or clear the search."
            : "Be the first — share what you've learned, what helped, or what you're still figuring out."}</p>
          ${!storyQuery ? `<a class="btn btn-primary" href="/write-story">✍️ Start your story</a>` : ""}
        </div>`;
      return;
    }
    // Featured story = the most recent on the "recent" tab (or the top
    // result on title/author when a search is active). Big banner card
    // up top, rest in a grid below.
    const featured = (storySort === "recent" && !storyQuery) ? list[0] : null;
    const rest = featured ? list.slice(1) : list;
    grid.innerHTML = `
      ${featured ? featuredCard(featured) : ""}
      <div class="stories-cards">
        ${rest.map(storyCard).join("")}
      </div>`;
  }
  function storyCard(s) {
    const date = s.publishedAt ? new Date(s.publishedAt * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
    const minutes = estimateReadMinutes(s);
    const donorClass = s.authorIsDonor ? "is-donor" : "";
    const donorTag   = s.authorIsDonor ? ` <span class="donor-tag small" title="Patron">🎗️</span>` : "";
    return `
      <a class="story-card" href="/read-story?id=${s.id}">
        ${s.coverImageUrl
          ? `<div class="story-card-img"><img src="${escapeHtml(s.coverImageUrl)}" alt="" loading="lazy" /></div>`
          : `<div class="story-card-img story-card-img-empty">📖</div>`}
        <div class="story-card-body">
          ${minutes ? `<span class="story-card-read">⏱ ${minutes} min read</span>` : ""}
          <h3>${highlight(s.title, storyQuery)}</h3>
          ${s.summary ? `<p class="story-card-summary">${highlight(s.summary, storyQuery)}</p>` : ""}
          <div class="story-card-foot">
            <span class="story-card-author"><span class="${donorClass}">${highlight(s.author, storyQuery)}</span>${donorTag}</span>
            <span class="story-card-date">${escapeHtml(date)}</span>
          </div>
        </div>
      </a>`;
  }
  function featuredCard(s) {
    const date = s.publishedAt ? new Date(s.publishedAt * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
    const minutes = estimateReadMinutes(s);
    const donorClass = s.authorIsDonor ? "is-donor" : "";
    const donorTag   = s.authorIsDonor ? ` <span class="donor-tag" title="Patron">🎗️ Patron</span>` : "";
    return `
      <a class="story-featured" href="/read-story?id=${s.id}">
        <div class="story-featured-img">
          ${s.coverImageUrl
            ? `<img src="${escapeHtml(s.coverImageUrl)}" alt="" loading="lazy" />`
            : `<span class="story-featured-empty">📖</span>`}
          <span class="story-featured-tag">✨ Latest</span>
        </div>
        <div class="story-featured-body">
          ${minutes ? `<span class="story-card-read">⏱ ${minutes} min read</span>` : ""}
          <h2>${highlight(s.title, storyQuery)}</h2>
          ${s.summary ? `<p>${highlight(s.summary, storyQuery)}</p>` : ""}
          <div class="story-card-foot">
            <span class="story-card-author"><span class="${donorClass}">${highlight(s.author, storyQuery)}</span>${donorTag}</span>
            <span class="story-card-date">${escapeHtml(date)}</span>
          </div>
          <span class="story-featured-cta">Read story →</span>
        </div>
      </a>`;
  }
  // Rough estimate: average reading speed ~ 220 words/min. Falls back
  // to a minimum of 1 minute when content is short.
  function estimateReadMinutes(s) {
    const text = `${s.summary || ""} ${s.body || ""}`.trim();
    if (!text) return null;
    const words = text.split(/\s+/).length;
    return Math.max(1, Math.round(words / 220));
  }
  (function wireStoriesControls() {
    const input = document.getElementById("stories-search");
    const clear = document.getElementById("stories-search-clear");
    if (input) {
      const onInput = debounce(() => {
        storyQuery = input.value.trim();
        clear.hidden = !storyQuery;
        renderStoriesView();
      }, 80);
      input.addEventListener("input", onInput);
      clear.addEventListener("click", () => {
        input.value = ""; storyQuery = ""; clear.hidden = true;
        input.focus(); renderStoriesView();
      });
    }
    document.querySelectorAll("[data-story-sort]").forEach((b) => {
      b.addEventListener("click", () => {
        storySort = b.dataset.storySort;
        document.querySelectorAll("[data-story-sort]").forEach((x) =>
          x.classList.toggle("is-active", x === b));
        renderStoriesView();
      });
    });
  })();

  // --- Resources view -------------------------------------------------
  async function loadResourcesView() {
    const slot = document.getElementById("resources-slot");
    slot.innerHTML = `<p class="empty-state">Loading resources…</p>`;
    try {
      const data = await fetchJson("/api/community/resources");
      resourceCats = data.categories || [];
      resourcesAll = data.resources || [];
      renderResourcesChips();
      renderResourcesView();
    } catch (err) {
      slot.innerHTML = `<p class="empty-state">Couldn't load resources.</p>`;
    }
  }
  function renderResourcesChips() {
    const chips = document.getElementById("resources-cat-chips");
    if (!chips) return;
    const counts = new Map();
    for (const r of resourcesAll) counts.set(r.category, (counts.get(r.category) || 0) + 1);
    const items = [
      { key: "all", label: "🌟 All", count: resourcesAll.length },
      ...resourceCats.filter((c) => counts.get(c.key)).map((c) => ({
        key: c.key, label: `${c.icon} ${c.label}`, count: counts.get(c.key) || 0,
      })),
    ];
    chips.innerHTML = items.map((it) => `
      <button type="button" class="filter-chip ${it.key === resourceCat ? "is-active" : ""}" data-resource-cat="${escapeHtml(it.key)}">
        ${escapeHtml(it.label)} <span class="chip-count">${it.count}</span>
      </button>`).join("");
    chips.querySelectorAll("[data-resource-cat]").forEach((b) => {
      b.addEventListener("click", () => {
        resourceCat = b.dataset.resourceCat;
        chips.querySelectorAll("[data-resource-cat]").forEach((x) =>
          x.classList.toggle("is-active", x === b));
        renderResourcesView();
      });
    });
  }
  function renderResourcesView() {
    const slot = document.getElementById("resources-slot");
    if (!slot) return;
    const filtered = resourcesAll.filter((r) =>
      (resourceCat === "all" || r.category === resourceCat) &&
      fuzzyMatch(resourceQuery, [r.title, r.summary, r.category])
    );
    if (!filtered.length) {
      slot.innerHTML = `<p class="empty-state">${resourceQuery
        ? `No resources match "${escapeHtml(resourceQuery)}".`
        : "No resources in this category yet."}</p>`;
      return;
    }
    // Group by category for visual structure.
    const byCat = {};
    for (const r of filtered) (byCat[r.category] ||= []).push(r);
    slot.innerHTML = resourceCats
      .filter((c) => byCat[c.key]?.length)
      .map((c) => `
        <section class="community-section resource-cat">
          <div class="section-head">
            <h2>${c.icon} ${escapeHtml(c.label)} <span class="head-count">· ${byCat[c.key].length}</span></h2>
          </div>
          <div class="resources-grid">
            ${byCat[c.key].map((r) => `
              <article class="resource-card">
                <h3>${highlight(r.title, resourceQuery)}</h3>
                ${r.summary ? `<p>${highlight(r.summary, resourceQuery)}</p>` : ""}
                ${r.url ? `<a class="resource-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Visit ↗</a>` : ""}
              </article>`).join("")}
          </div>
        </section>`).join("");
  }
  (function wireResourcesControls() {
    const input = document.getElementById("resources-search");
    const clear = document.getElementById("resources-search-clear");
    if (input) {
      const onInput = debounce(() => {
        resourceQuery = input.value.trim();
        clear.hidden = !resourceQuery;
        renderResourcesView();
      }, 80);
      input.addEventListener("input", onInput);
      clear.addEventListener("click", () => {
        input.value = ""; resourceQuery = ""; clear.hidden = true;
        input.focus(); renderResourcesView();
      });
    }
  })();
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
    const donorClass = a.authorIsDonor ? "is-donor" : "";
    const donorTag   = a.authorIsDonor ? ` <span class="donor-tag small" title="Patron">🎗️</span>` : "";
    return `<li class="activity-item">
      <a href="/community?c=${encodeURIComponent(a.circleSlug)}" class="activity-link" data-open="${escapeHtml(a.circleSlug)}">
        <div class="${avatarClass}">${avatarInner}</div>
        <div class="activity-body">
          <div class="activity-head">
            <strong class="${donorClass}">${escapeHtml(a.authorName)}</strong>${donorTag}
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
      // Cache the raw lists; renderCirclesView re-renders against the
      // current search query + filter.
      myCirclesAll = my;
      discoverAll  = data.discover || [];
      renderCirclesView();

      const createBtn = document.getElementById("btn-create");
      createBtn.disabled = false;
      createBtn.title = "Create a new circle — open to everyone or invite-only.";
    } catch (err) {
      document.getElementById("discover-circles").innerHTML =
        `<p class="empty-state">Couldn't load circles right now.</p>`;
    }
  }

  function renderCirclesView() {
    const matchFilter = (c, isJoined) => {
      if (circleFilter === "all") return true;
      if (circleFilter === "joined") return isJoined;
      if (circleFilter === "open") return !!c.is_open;
      if (circleFilter === "private") return !c.is_open;
      return true;
    };
    const matchQuery = (c) => fuzzyMatch(circleQuery, [c.name, c.description]);
    const my = myCirclesAll.filter((c) => matchFilter(c, true) && matchQuery(c));
    const dis = discoverAll.filter((c) => matchFilter(c, false) && matchQuery(c));

    document.getElementById("my-circles-count").textContent =
      myCirclesAll.length ? `· ${my.length}/${myCirclesAll.length}` : "";
    document.getElementById("discover-count").textContent =
      discoverAll.length ? `· ${dis.length}/${discoverAll.length}` : "";

    // Joined-only filter hides Discover entirely; "All" + "Open"/"Private"
    // still show Discover but apply the filter to it too.
    const discoverSection = document.getElementById("discover-section");
    if (discoverSection) discoverSection.hidden = (circleFilter === "joined");

    renderCircles(document.getElementById("my-circles"), my, {
      showRole: true, query: circleQuery,
      emptyMessage: circleQuery
        ? `No matches in your circles for "${circleQuery}".`
        : (circleFilter === "joined" ? "You haven't joined any circles yet — try Discover below." : "You're in the official EndoMe circle above. Join others from Discover."),
    });
    renderCircles(document.getElementById("discover-circles"), dis, {
      showRole: false, withJoin: true, query: circleQuery,
      emptyMessage: circleQuery
        ? `No matches in Discover for "${circleQuery}".`
        : "No new circles to discover right now.",
    });
  }

  // Wire search + filter (idempotent — these listeners are added once at
  // bootstrap; renderCirclesView runs whenever any of them changes).
  (function wireCirclesControls() {
    const input = document.getElementById("circles-search");
    const clear = document.getElementById("circles-search-clear");
    if (input) {
      const onInput = debounce(() => {
        circleQuery = input.value.trim();
        clear.hidden = !circleQuery;
        renderCirclesView();
      }, 80);
      input.addEventListener("input", onInput);
      clear.addEventListener("click", () => {
        input.value = ""; circleQuery = ""; clear.hidden = true;
        input.focus(); renderCirclesView();
      });
    }
    document.querySelectorAll("[data-circle-filter]").forEach((b) => {
      b.addEventListener("click", () => {
        circleFilter = b.dataset.circleFilter;
        document.querySelectorAll("[data-circle-filter]").forEach((x) =>
          x.classList.toggle("is-active", x === b));
        renderCirclesView();
      });
    });
  })();

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
      container.innerHTML = `<p class="empty-state">${escapeHtml(opts.emptyMessage || "Nothing here yet.")}</p>`;
      return;
    }
    const q = opts.query || "";
    container.innerHTML = list.map((c) => `
      <article class="circle-card ${c.is_official ? "is-official" : ""}">
        <div class="circle-card-top">
          <div class="circle-card-icon">${c.is_official ? "🌸" : "💬"}</div>
          <div class="circle-card-body">
            <div class="circle-card-name">
              ${highlight(c.name, q)}
              ${c.is_official ? `<span class="official-pill small">Official</span>` : ""}
              <span class="type-pill small">${c.is_open ? "🌐 Open" : "🔒 Private"}</span>
              ${opts.showRole && c.role ? `<span class="role-pill role-${c.role}">${escapeHtml(c.role)}</span>` : ""}
            </div>
            <p class="circle-card-desc">${highlight(c.description || "", q)}</p>
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
  // Cached posts + members for the in-circle tabs (Feed / Saved / Members).
  let currentPosts = [];
  let currentMembers = [];
  let memberFilter = "all";
  let memberSearch = "";
  let activeCircleTab = "feed";

  async function loadCircle(slug) {
    try {
      const data = await fetchJson(`/api/me/community/circles/${encodeURIComponent(slug)}`);
      currentCircle = data.circle;
      currentPosts = data.posts || [];
      renderCircleHeader(data.circle);
      renderPosts(currentPosts);
      renderSavedPosts();
      // Only fetch members on first paint of the circle — the tab handler
      // refreshes if the user opens the Members tab.
      const countEl = document.getElementById("circle-members-count");
      if (countEl) countEl.textContent = data.circle.memberCount ? `· ${data.circle.memberCount}` : "";
      currentMembers = [];
      setCircleTab(activeCircleTab);
    } catch (err) {
      document.getElementById("posts-list").innerHTML =
        `<p class="empty-state">${escapeHtml(err.message || "Couldn't open this circle.")}</p>`;
    }
  }

  // --- Sub-tab handling (Feed · Saved · Members) -----------------------
  document.querySelectorAll(".circle-tab").forEach((b) => {
    b.addEventListener("click", () => setCircleTab(b.dataset.circleTab));
  });
  function setCircleTab(name) {
    activeCircleTab = name;
    document.querySelectorAll(".circle-tab").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.circleTab === name));
    document.getElementById("circle-tab-feed").hidden    = name !== "feed";
    document.getElementById("circle-tab-saved").hidden   = name !== "saved";
    document.getElementById("circle-tab-members").hidden = name !== "members";
    if (name === "members" && currentCircle) {
      if (!currentMembers.length) loadCircleMembers(currentCircle.slug);
      else renderMembers();
    }
    if (name === "saved") renderSavedPosts();
  }
  async function loadCircleMembers(slug) {
    const list = document.getElementById("members-list");
    if (list) list.innerHTML = `<li class="empty-state">Loading members…</li>`;
    try {
      const data = await fetchJson(`/api/me/community/circles/${encodeURIComponent(slug)}/members`);
      currentMembers = data.members || [];
      renderMembers();
    } catch (err) {
      if (list) list.innerHTML = `<li class="empty-state">${escapeHtml(err.message || "Couldn't load")}</li>`;
    }
  }
  function renderMembers() {
    const list = document.getElementById("members-list");
    if (!list) return;
    const q = (memberSearch || "").trim().toLowerCase();
    const visible = currentMembers.filter((m) => {
      if (memberFilter === "admin" && m.role !== "admin" && m.role !== "moderator") return false;
      if (memberFilter === "donor" && !m.isDonor) return false;
      if (q && !fuzzyMatch(q, [m.name, m.username, m.alias])) return false;
      return true;
    });
    if (!visible.length) {
      list.innerHTML = `<li class="empty-state">No members match.</li>`;
      return;
    }
    list.innerHTML = visible.map(memberCard).join("");
  }
  function memberCard(m) {
    const avatarInner = m.avatarUrl
      ? `<img src="${escapeHtml(m.avatarUrl)}" alt="" />`
      : m.avatar
        ? `<span class="emoji">${escapeHtml(m.avatar)}</span>`
        : escapeHtml(initials(m.name));
    const avatarClass = m.avatarUrl ? "member-avatar has-image"
      : m.avatar ? "member-avatar has-emoji" : "member-avatar";
    const roleLabel = m.role === "admin" ? "👑 Admin"
      : m.role === "moderator" ? "🛡 Mod" : "";
    const donorTag = m.isDonor ? `<span class="donor-tag small">🎗️</span>` : "";
    const nameClass = m.isDonor ? "is-donor" : "";
    return `<li class="member-row" data-open-member="${escapeHtml(m.userId)}">
      <div class="${avatarClass}">${avatarInner}</div>
      <div class="member-body">
        <div class="member-name-row">
          <strong class="${nameClass}">${escapeHtml(m.name)}</strong>
          ${donorTag}
          ${roleLabel ? `<span class="member-role">${roleLabel}</span>` : ""}
          ${m.isMe ? `<span class="member-role you">You</span>` : ""}
        </div>
        <div class="member-meta">
          ${m.postCount} post${m.postCount === 1 ? "" : "s"} · ${m.replyCount} repl${m.replyCount === 1 ? "y" : "ies"}
          ${m.joinedAt ? ` · joined ${shortDate(m.joinedAt)}` : ""}
        </div>
      </div>
      <span class="member-chev">›</span>
    </li>`;
  }
  function shortDate(unixSec) {
    if (!unixSec) return "";
    return new Date(unixSec * 1000).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }
  document.getElementById("members-search")?.addEventListener("input", debounce((e) => {
    memberSearch = e.target.value;
    renderMembers();
  }, 80));
  document.querySelectorAll("[data-member-filter]").forEach((b) => {
    b.addEventListener("click", () => {
      memberFilter = b.dataset.memberFilter;
      document.querySelectorAll("[data-member-filter]").forEach((x) =>
        x.classList.toggle("is-active", x === b));
      renderMembers();
    });
  });

  function renderSavedPosts() {
    const list = document.getElementById("saved-posts-list");
    if (!list) return;
    const saved = currentPosts.filter((p) => p.iSaved);
    if (!saved.length) {
      list.innerHTML = `<p class="empty-state">Nothing saved yet. Tap ⭐ on any post and it'll land here for later.</p>`;
      return;
    }
    list.innerHTML = saved.map(postHtml).join("");
  }

  // --- Mini profile popover --------------------------------------------
  async function openMiniProfile(userId) {
    const modal = document.getElementById("mini-profile-modal");
    const slot  = document.getElementById("mini-profile-content");
    if (!modal || !slot) return;
    slot.innerHTML = `<p class="empty-state">Loading…</p>`;
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    try {
      const data = await fetchJson(`/api/me/community/profiles/${encodeURIComponent(userId)}`);
      paintMiniProfile(data.profile);
    } catch (err) {
      slot.innerHTML = `<p class="empty-state">${escapeHtml(err.message || "Couldn't load")}</p>`;
    }
  }
  function paintMiniProfile(p) {
    if (!p) return;
    const slot = document.getElementById("mini-profile-content");
    const avatarInner = p.avatarUrl
      ? `<img src="${escapeHtml(p.avatarUrl)}" alt="" />`
      : p.avatar
        ? `<span class="emoji">${escapeHtml(p.avatar)}</span>`
        : escapeHtml(initials(p.name));
    const avatarClass = p.avatarUrl ? "mini-avatar has-image"
      : p.avatar ? "mini-avatar has-emoji" : "mini-avatar";
    const donorBadge = p.isDonor
      ? `<span class="donor-tag">🎗️ Patron${p.donorSince ? ` since ${shortDate(p.donorSince)}` : ""}</span>`
      : "";
    const friendBtn = (() => {
      if (p.friendStatus === "self") return "";
      if (p.friendStatus === "friends") return `<button type="button" class="btn-soft small" disabled>✓ Friends</button>`;
      if (p.friendStatus === "pending_outgoing") return `<button type="button" class="btn-soft small" disabled>Request sent</button>`;
      if (p.friendStatus === "pending_incoming")
        return `<button type="button" class="btn btn-primary small" data-mini-friend-accept="${escapeHtml(p.userId)}">Accept request</button>`;
      return `<button type="button" class="btn btn-primary small" data-mini-friend="${escapeHtml(p.userId)}">＋ Add friend</button>`;
    })();
    slot.innerHTML = `
      <div class="${avatarClass}">${avatarInner}</div>
      <h3 class="mini-name ${p.isDonor ? "is-donor" : ""}">${escapeHtml(p.name)}</h3>
      ${p.alias ? `<p class="mini-alias">@${escapeHtml(p.alias)}</p>` : (p.username ? `<p class="mini-alias">@${escapeHtml(p.username)}</p>` : "")}
      <div class="mini-badges">
        ${donorBadge}
        ${p.memberSince ? `<span class="mini-pill">📅 Joined ${shortDate(p.memberSince)}</span>` : ""}
      </div>
      ${p.bio ? `<p class="mini-bio">${escapeHtml(p.bio)}</p>` : ""}
      <div class="mini-actions">
        ${friendBtn}
        ${p.username ? `<a class="btn-soft small" href="/u/${encodeURIComponent(p.username)}">View full profile →</a>` : ""}
      </div>`;
  }
  // Close + friend actions
  document.querySelectorAll("[data-close-mini]").forEach((el) =>
    el.addEventListener("click", () => closeMiniProfile()));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMiniProfile();
  });
  function closeMiniProfile() {
    const modal = document.getElementById("mini-profile-modal");
    if (!modal) return;
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }
  // Click delegation for the member list + post author + friend actions.
  document.addEventListener("click", async (e) => {
    const open = e.target.closest?.("[data-open-member]");
    if (open) { e.preventDefault(); openMiniProfile(open.dataset.openMember); return; }
    const friend = e.target.closest?.("[data-mini-friend]");
    if (friend) {
      const id = friend.dataset.miniFriend;
      friend.disabled = true; friend.textContent = "Sending…";
      try {
        await fetchJson(`/api/me/friends/${encodeURIComponent(id)}`, { method: "POST" });
        friend.textContent = "Request sent"; toast("Friend request sent ✨");
      } catch (err) { toast(err.message || "Couldn't send", "err"); friend.disabled = false; friend.textContent = "＋ Add friend"; }
      return;
    }
    const accept = e.target.closest?.("[data-mini-friend-accept]");
    if (accept) {
      const id = accept.dataset.miniFriendAccept;
      accept.disabled = true; accept.textContent = "Accepting…";
      try {
        await fetchJson(`/api/me/friends/${encodeURIComponent(id)}/accept`, { method: "POST" });
        accept.textContent = "✓ Friends"; toast("You're now friends 🎉");
      } catch (err) { toast(err.message || "Couldn't accept", "err"); accept.disabled = false; accept.textContent = "Accept request"; }
      return;
    }
  });

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
    // Donors get a gold gradient name + a 🎗️ Patron tag inline. The
    // class is added to the author <strong> via .is-donor and the tag
    // is a sibling pill.
    const donorClass = p.authorIsDonor ? "is-donor" : "";
    const donorTag   = p.authorIsDonor ? `<span class="donor-tag" title="Supports endo research">🎗️ Patron</span>` : "";
    const canMod = currentCircle && (currentCircle.myRole === "admin" || currentCircle.myRole === "moderator");
    const pinBtn = canMod
      ? `<button class="post-mod-btn ${p.pinnedAt ? "on" : ""}" data-pin-post="${p.id}" title="${p.pinnedAt ? "Unpin" : "Pin to top"}">📌</button>`
      : "";
    const pinnedBadge = p.pinnedAt ? `<span class="post-pinned-badge">📌 Pinned</span>` : "";
    return `
      <article class="post-card ${p.isQuestion ? "is-question" : ""} ${p.pinnedAt ? "is-pinned" : ""}" data-post-id="${p.id}">
        ${pinnedBadge}
        <header class="post-head">
          <div class="post-author">
            <button type="button" class="author-link author-avatar-btn" data-open-member="${escapeHtml(p.authorId)}">
              <div class="${avatarClass}">${avatarInner}</div>
            </button>
            <div>
              <button type="button" class="author-link author-name-btn" data-open-member="${escapeHtml(p.authorId)}">
                <strong class="${donorClass}">${escapeHtml(p.authorName)}</strong>
              </button>
              ${donorTag}
              <span class="post-time">${relTime(p.createdAt)}${p.isQuestion ? " · ❓ Question" : ""}</span>
            </div>
          </div>
          <div class="post-head-actions">
            ${pinBtn}
            ${p.mine ? `<button class="post-delete" data-delete-post="${p.id}" title="Delete">×</button>` : ""}
          </div>
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
          <button class="react-btn save-btn ${p.iSaved ? "on" : ""}" data-save-post="${p.id}" title="${p.iSaved ? "Unsave" : "Save for later"}">
            <span>${p.iSaved ? "⭐" : "☆"}</span>
            <span class="react-label">${p.iSaved ? "Saved" : "Save"}</span>
          </button>
        </footer>
        <div class="replies-block" data-replies-block="${p.id}" hidden></div>
      </article>`;
  }

  document.addEventListener("click", async (e) => {
    const save = e.target.closest("[data-save-post]");
    if (save) {
      e.preventDefault();
      const id = +save.dataset.savePost;
      try {
        const data = await fetchJson(`/api/me/community/posts/${id}/save`, { method: "POST" });
        const post = currentPosts.find((x) => x.id === id);
        if (post) post.iSaved = !!data.saved;
        save.classList.toggle("on", !!data.saved);
        save.querySelector("span:first-child").textContent = data.saved ? "⭐" : "☆";
        const lbl = save.querySelector(".react-label");
        if (lbl) lbl.textContent = data.saved ? "Saved" : "Save";
        toast(data.saved ? "Saved" : "Removed from saved");
        if (activeCircleTab === "saved") renderSavedPosts();
      } catch (err) { toast(err.message || "Couldn't save", "err"); }
      return;
    }
    const pin = e.target.closest("[data-pin-post]");
    if (pin) {
      e.preventDefault();
      const id = +pin.dataset.pinPost;
      try {
        await fetchJson(`/api/me/community/posts/${id}/pin`, { method: "POST" });
        toast("Updated");
        if (currentCircle) await loadCircle(currentCircle.slug);
      } catch (err) { toast(err.message || "Couldn't pin", "err"); }
      return;
    }
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
    const donorClass = r.authorIsDonor ? "is-donor" : "";
    const donorTag   = r.authorIsDonor ? `<span class="donor-tag small" title="Supports endo research">🎗️</span>` : "";
    return `
      <li class="reply">
        ${profileHref
          ? `<a href="${profileHref}" class="author-link"><div class="${avatarClass}">${avatarInner}</div></a>`
          : `<div class="${avatarClass}">${avatarInner}</div>`}
        <div class="reply-body">
          <div class="reply-head">
            ${profileHref
              ? `<a href="${profileHref}" class="author-link"><strong class="${donorClass}">${escapeHtml(r.authorName)}</strong></a>`
              : `<strong class="${donorClass}">${escapeHtml(r.authorName)}</strong>`}
            ${donorTag}
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
