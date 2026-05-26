// /explore — research constellation. A tree of problems rendered as a
// radial SVG node graph. Click a node to see its detail (progress + people
// working on it) in the side panel.
console.info("EndoMe explore build v1");

(() => {
  // ====================================================================
  // Data: hand-tuned tree of problems. Designed so the centre (endo) has
  // a handful of immediate sub-problems, each of which can drill down 1–2
  // more levels. Contributors + progress are illustrative for now.
  // ====================================================================
  const PROBLEMS = [
    { id: "endo", parent: null, label: "Endometriosis",       level: 0, progress: 9,
      desc: "The root disease. Tissue similar to the uterine lining grows where it shouldn't, causing pain, inflammation and (often) infertility. Everything below is a piece of it we can attack.",
      contributors: 312 },

    // Tier 1 — main moving parts
    { id: "inflammation", parent: "endo", label: "Inflammation",       level: 1, progress: 28,
      desc: "Chronic inflammation drives lesion growth and pain signalling.",
      contributors: 87 },
    { id: "hormones",     parent: "endo", label: "Hormone imbalance",  level: 1, progress: 18,
      desc: "Lesions are oestrogen-driven and progesterone-resistant.",
      contributors: 64 },
    { id: "immune",       parent: "endo", label: "Immune dysfunction", level: 1, progress: 14,
      desc: "The immune system fails to clear misplaced tissue. Why?",
      contributors: 41 },
    { id: "nerve",        parent: "endo", label: "Nerve sensitisation",level: 1, progress: 12,
      desc: "New pain fibres grow into lesions; the central nervous system amplifies the signal.",
      contributors: 38 },
    { id: "pain",         parent: "endo", label: "Pain management",    level: 1, progress: 22,
      desc: "What actually works to control acute and chronic pelvic pain.",
      contributors: 124 },
    { id: "lifestyle",    parent: "endo", label: "Lifestyle factors",  level: 1, progress: 33,
      desc: "Sleep, movement, stress, food. What moves the needle, what's noise.",
      contributors: 168 },

    // Tier 2 — Inflammation
    { id: "food",      parent: "inflammation", label: "Food triggers", level: 2, progress: 35, contributors: 92,
      desc: "Specific foods that correlate with flares across the community." },
    { id: "stress",    parent: "inflammation", label: "Stress",        level: 2, progress: 41, contributors: 78,
      desc: "Cortisol drives inflammatory cascades. Where stress meets pain." },
    { id: "gut",       parent: "inflammation", label: "Gut microbiome",level: 2, progress: 19, contributors: 52,
      desc: "Endo-belly bloating, dysbiosis, and the gut-immune axis." },
    { id: "sleep",     parent: "inflammation", label: "Sleep quality", level: 2, progress: 27, contributors: 60,
      desc: "Sleep deprivation tracks with next-day pain. How tight is the link?" },

    // Tier 2 — Hormones
    { id: "oestrogen", parent: "hormones", label: "Oestrogen excess",  level: 2, progress: 24, contributors: 47,
      desc: "Local oestrogen production by lesions; aromatase inhibition." },
    { id: "progesterone", parent: "hormones", label: "Progesterone resistance", level: 2, progress: 16, contributors: 29,
      desc: "Why progestins fail in some patients and work in others." },
    { id: "cortisol",  parent: "hormones", label: "Cortisol",          level: 2, progress: 11, contributors: 18,
      desc: "HPA axis dysregulation and chronic stress response." },

    // Tier 2 — Immune
    { id: "nk-cells",  parent: "immune", label: "NK cells",            level: 2, progress: 15, contributors: 12,
      desc: "Natural-killer-cell activity is lower in people with endo." },
    { id: "macros",    parent: "immune", label: "Macrophages",         level: 2, progress: 9,  contributors: 8,
      desc: "M2 'repair' macrophages dominate lesion sites and feed growth." },

    // Tier 2 — Nerve
    { id: "ngf",       parent: "nerve",  label: "Nerve growth factor", level: 2, progress: 13, contributors: 14,
      desc: "Lesions grow new pain fibres via NGF. Anti-NGF antibodies are in trial." },
    { id: "central",   parent: "nerve",  label: "Central sensitisation",level:2,progress: 22, contributors: 40,
      desc: "Spinal-cord rewiring amplifies pain signals over years." },

    // Tier 2 — Pain
    { id: "nsaid",     parent: "pain",   label: "NSAIDs",              level: 2, progress: 56, contributors: 200,
      desc: "First-line endo pain relief. What works, when, and at what dose." },
    { id: "pelvic",    parent: "pain",   label: "Pelvic-floor therapy",level: 2, progress: 31, contributors: 73,
      desc: "Physiotherapy and pelvic-floor work for chronic pelvic pain." },
    { id: "neuromod",  parent: "pain",   label: "Neuromodulation",     level: 2, progress: 14, contributors: 21,
      desc: "TENS, vagus stimulation, low-dose tricyclics." },

    // Tier 2 — Lifestyle
    { id: "exercise",  parent: "lifestyle", label: "Movement",         level: 2, progress: 38, contributors: 110,
      desc: "Yoga, walking, swimming. What helps without flaring." },
    { id: "mental",    parent: "lifestyle", label: "Mental health",    level: 2, progress: 29, contributors: 145,
      desc: "Anxiety, depression, the cost of being unheard for years." },

    // Tier 3 — Food (drill into "Food triggers")
    { id: "sugar",     parent: "food", label: "Sugar",       level: 3, progress: 49, contributors: 70,
      desc: "High sugar intake correlates with inflammation markers." },
    { id: "dairy",     parent: "food", label: "Dairy",       level: 3, progress: 38, contributors: 53,
      desc: "Casein and lactose effects on bloating and pain." },
    { id: "gluten",    parent: "food", label: "Gluten",      level: 3, progress: 42, contributors: 60,
      desc: "A subset of patients report large improvements on gluten-free diets." },
    { id: "alcohol",   parent: "food", label: "Alcohol",     level: 3, progress: 24, contributors: 38,
      desc: "Inflammatory + oestrogenic effects. How often, how much, what type." },
    { id: "redmeat",   parent: "food", label: "Red meat",    level: 3, progress: 21, contributors: 26,
      desc: "Saturated fat, arachidonic acid and prostaglandin pathways." },
    { id: "caffeine",  parent: "food", label: "Caffeine",    level: 3, progress: 16, contributors: 30,
      desc: "Effects on oestrogen clearance and sleep quality." },
  ];

  const COLOURS = {
    0: { fill: "#dc2626", stroke: "#991b1b", text: "#fff", glow: "rgba(220,38,38,.45)" }, // endo
    1: { fill: "#f97316", stroke: "#c2410c", text: "#fff", glow: "rgba(249,115,22,.35)" }, // sub-problem
    2: { fill: "#3b82f6", stroke: "#1d4ed8", text: "#fff", glow: "rgba(59,130,246,.30)" }, // drill-down
    3: { fill: "#10b981", stroke: "#047857", text: "#fff", glow: "rgba(16,185,129,.30)" }, // specific
  };

  const W = 1000, H = 700, CX = 500, CY = 350;

  // ====================================================================
  // Layout — radial. Tier 1 around root, Tier 2 around each tier-1, Tier 3
  // around each tier-2 they belong to.
  // ====================================================================
  function computeLayout() {
    const byId = Object.fromEntries(PROBLEMS.map((p) => [p.id, { ...p, children: [] }]));
    PROBLEMS.forEach((p) => { if (p.parent) byId[p.parent].children.push(p.id); });

    // Tier 0
    byId.endo.x = CX; byId.endo.y = CY;

    // Tier 1 — equally spaced around the root at radius R1
    const tier1 = byId.endo.children;
    const R1 = 200;
    tier1.forEach((id, i) => {
      const angle = (-Math.PI / 2) + (i / tier1.length) * 2 * Math.PI;
      byId[id].x = CX + Math.cos(angle) * R1;
      byId[id].y = CY + Math.sin(angle) * R1;
      byId[id].angle = angle;
    });

    // Tier 2 — fan out from each tier-1 along the SAME direction it sits.
    const R2 = 110; // distance from tier-1 to tier-2
    tier1.forEach((parentId) => {
      const parent = byId[parentId];
      const kids = parent.children;
      if (!kids.length) return;
      const spread = Math.PI / 3; // 60° fan
      const base = parent.angle;
      kids.forEach((kid, i) => {
        const t = kids.length === 1 ? 0 : (i / (kids.length - 1)) - 0.5;
        const angle = base + t * spread;
        byId[kid].x = parent.x + Math.cos(angle) * R2;
        byId[kid].y = parent.y + Math.sin(angle) * R2;
        byId[kid].angle = angle;
      });
    });

    // Tier 3 — same trick, from tier-2 outward
    const R3 = 80;
    PROBLEMS.filter((p) => p.level === 2).forEach((p) => {
      const parent = byId[p.id];
      const kids = parent.children;
      if (!kids.length) return;
      const spread = Math.PI / 2;
      const base = parent.angle;
      kids.forEach((kid, i) => {
        const t = kids.length === 1 ? 0 : (i / (kids.length - 1)) - 0.5;
        const angle = base + t * spread;
        byId[kid].x = parent.x + Math.cos(angle) * R3;
        byId[kid].y = parent.y + Math.sin(angle) * R3;
        byId[kid].angle = angle;
      });
    });

    return byId;
  }

  const nodes = computeLayout();
  const NODE_RADIUS = { 0: 44, 1: 28, 2: 18, 3: 13 };

  // ====================================================================
  // Render
  // ====================================================================
  const edgesG = document.getElementById("explore-edges");
  const nodesG = document.getElementById("explore-nodes");

  // Edges
  for (const id in nodes) {
    const n = nodes[id];
    if (!n.parent) continue;
    const p = nodes[n.parent];
    edgesG.insertAdjacentHTML("beforeend",
      `<line class="explore-edge edge-l${n.level}" x1="${p.x}" y1="${p.y}" x2="${n.x}" y2="${n.y}" />`);
  }

  // Nodes
  for (const id in nodes) {
    const n = nodes[id];
    const c = COLOURS[n.level] || COLOURS[3];
    const r = NODE_RADIUS[n.level] || 12;
    const label = n.level <= 1 ? n.label : ""; // tier 2+ get labels only on hover/selected
    nodesG.insertAdjacentHTML("beforeend", `
      <g class="explore-node level-${n.level}" data-id="${id}" tabindex="0" role="button"
         transform="translate(${n.x},${n.y})" style="--glow:${c.glow}">
        <circle class="node-glow" r="${r + 8}" fill="url(#node-glow)"/>
        <circle class="node-circle" r="${r}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>
        <text class="node-label" text-anchor="middle" dy="${r + 18}" font-size="${n.level <= 1 ? 13 : 11}" font-weight="${n.level === 0 ? 800 : 700}" fill="#2b1922" font-family="Poppins,sans-serif">${escapeHtml(n.label)}</text>
        ${n.level === 0 ? `<text text-anchor="middle" dy="5" font-size="13" font-weight="800" fill="${c.text}">${n.progress}%</text>` : ""}
      </g>`);
  }

  // ====================================================================
  // Interaction
  // ====================================================================
  let selectedId = null;
  document.querySelectorAll(".explore-node").forEach((g) => {
    const id = g.dataset.id;
    g.addEventListener("click", () => selectNode(id));
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectNode(id); } });
  });

  function selectNode(id) {
    selectedId = id;
    document.querySelectorAll(".explore-node").forEach((g) =>
      g.classList.toggle("is-selected", g.dataset.id === id));
    document.querySelectorAll(".explore-edge").forEach((l) => l.classList.remove("is-active"));

    // Highlight path back to root
    let cur = id;
    while (cur && nodes[cur].parent) {
      const parentId = nodes[cur].parent;
      // Find the edge between cur and parentId
      const candidates = document.querySelectorAll(".explore-edge");
      const targetX = nodes[cur].x, targetY = nodes[cur].y;
      const sourceX = nodes[parentId].x, sourceY = nodes[parentId].y;
      candidates.forEach((line) => {
        const x1 = +line.getAttribute("x1"), y1 = +line.getAttribute("y1");
        const x2 = +line.getAttribute("x2"), y2 = +line.getAttribute("y2");
        const matches =
          (Math.abs(x1 - sourceX) < 0.5 && Math.abs(y1 - sourceY) < 0.5 && Math.abs(x2 - targetX) < 0.5 && Math.abs(y2 - targetY) < 0.5) ||
          (Math.abs(x1 - targetX) < 0.5 && Math.abs(y1 - targetY) < 0.5 && Math.abs(x2 - sourceX) < 0.5 && Math.abs(y2 - sourceY) < 0.5);
        if (matches) line.classList.add("is-active");
      });
      cur = parentId;
    }
    paintPanel(nodes[id]);
  }

  // Mock contributors (community members "working on" a problem). Deterministic
  // per-node so the list doesn't flicker on re-select.
  const AVATARS = ["🌸","🌷","🌻","🌼","🌹","🌺","🦋","🐝","🐞","🐰","🐱","🐶","🍓","🍑","🍊","🍋","🥑","✨","💖","🌙","⭐","🍀","🌈","🍵"];
  const NAMES   = ["Sasha","Rosie","Ariel","Beth","Cleo","Dani","Eden","Frankie","Gen","Hari","Imani","Jess","Kira","Liv","Mira","Nora","Olive","Pippa","Quinn","Rae","Sam","Tess","Uma","Vee","Wren","Xan","Yara","Zoe"];
  function contributorsFor(node) {
    const count = Math.max(3, Math.min(8, Math.round(node.contributors / 20)));
    const out = [];
    let seed = (node.id.charCodeAt(0) * 31 + node.id.length * 7) % 9973;
    for (let i = 0; i < count; i++) {
      seed = (seed * 16807) % 2147483647;
      out.push({
        avatar: AVATARS[seed % AVATARS.length],
        name:   NAMES[(seed >> 4) % NAMES.length] + (i > 4 ? " " + ((i - 4) * 3) : ""),
      });
    }
    return out;
  }

  function paintPanel(n) {
    document.getElementById("explore-panel-empty").hidden = true;
    const c = document.getElementById("explore-panel-content");
    c.hidden = false;

    // Breadcrumb from root
    const crumbs = [];
    let cur = n;
    while (cur) { crumbs.unshift(cur.label); cur = cur.parent ? nodes[cur.parent] : null; }
    document.getElementById("ep-breadcrumb").textContent = crumbs.join(" › ");

    document.getElementById("ep-title").textContent = n.label;
    document.getElementById("ep-desc").textContent  = n.desc || "";

    document.getElementById("ep-progress-pct").textContent = n.progress + "%";
    document.getElementById("ep-progress-bar-fill").style.width = n.progress + "%";
    document.getElementById("ep-progress-meta").textContent =
      n.progress < 25 ? "Just getting going. Plenty of room to help."
      : n.progress < 50 ? "Underway. Researchers + members actively contributing."
      : n.progress < 75 ? "Real momentum. Several findings published already."
      :                   "Closing in. Final validation steps left.";

    const contribs = contributorsFor(n);
    const list = document.getElementById("ep-contributors-list");
    list.innerHTML = contribs.map((c) => `
      <li><span class="ep-contrib-avatar">${escapeHtml(c.avatar)}</span><span>${escapeHtml(c.name)}</span></li>`).join("");
    document.getElementById("ep-contrib-count").textContent = `· ${n.contributors} people`;

    // Children list
    const kids = PROBLEMS.filter((p) => p.parent === n.id);
    const kidsWrap = document.getElementById("ep-children-wrap");
    const kidsList = document.getElementById("ep-children-list");
    if (kids.length) {
      kidsWrap.hidden = false;
      kidsList.innerHTML = kids.map((k) => `
        <li><button type="button" data-jump="${k.id}">
          <strong>${escapeHtml(k.label)}</strong>
          <span>${k.progress}% · ${k.contributors} people</span>
        </button></li>`).join("");
      kidsList.querySelectorAll("[data-jump]").forEach((b) =>
        b.addEventListener("click", () => selectNode(b.dataset.jump)));
    } else {
      kidsWrap.hidden = true;
      kidsList.innerHTML = "";
    }
  }

  document.getElementById("ep-join").addEventListener("click", () => {
    if (!selectedId) return;
    toast(`You're on the team for ${escapeHtml(nodes[selectedId].label)}. We'll be in touch.`, "ok");
  });

  // Default: open the root so the panel isn't empty on first load.
  setTimeout(() => selectNode("endo"), 60);

  // ====================================================================
  // Boot
  // ====================================================================
  (async () => {
    try {
      const me = await fetch("/api/me/today", { credentials: "same-origin" }).then((r) => r.json());
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = me?.user?.displayName || me?.user?.username || "there";
      });
    } catch {}
    document.getElementById("page-loader")?.classList.add("is-hidden");
  })();

  // ====================================================================
  // Helpers
  // ====================================================================
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
    setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 250); }, 2600);
  }
})();
