(() => {
  const stage      = document.getElementById("pet-stage");
  const statsEl    = document.getElementById("pet-stats");
  const actionsEl  = document.getElementById("pet-actions");
  const nameRow    = document.getElementById("pet-name-row");
  const nameEl     = document.getElementById("pet-name");
  const levelEl    = document.getElementById("pet-level");
  const moodEl     = document.getElementById("pet-mood");

  const xpFill    = document.getElementById("stat-xp-fill");
  const xpText    = document.getElementById("stat-xp-text");
  const happyFill = document.getElementById("stat-happy-fill");
  const happyText = document.getElementById("stat-happy-text");
  const hungerFill = document.getElementById("stat-hunger-fill");
  const hungerText = document.getElementById("stat-hunger-text");

  let pet = null;
  let petEl = null;       // wandering DOM element when hatched
  let wanderTimer = null;
  let stateTimer = null;
  let thoughtTimer = null;

  // --- Bootstrap ----------------------------------------------------------
  bootstrap();

  let inventory = [];
  let recentRewards = [];

  async function bootstrap() {
    try {
      const me = await fetchJson("/api/me/today");
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = me?.user?.displayName || me?.user?.username || "there";
      });
      await reloadState();
    } catch (err) {
      stage.innerHTML = `<p class="pet-empty">Couldn't load your EndoPet. Refresh to try again.</p>`;
    } finally {
      hideLoader();
    }
  }

  async function reloadState() {
    const data = await fetchJson("/api/me/pet/state");
    pet           = data.pet;
    inventory     = data.inventory || [];
    recentRewards = data.recentRewards || [];
    render();
    renderLifecycle();
    renderInventory();
    renderRecentRewards();
  }

  async function fetchJson(url, init) {
    const res = await fetch(url, { credentials: "same-origin", ...(init || {}) });
    if (res.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `request failed (${res.status})`);
    }
    return res.json();
  }

  function hideLoader() {
    document.getElementById("page-loader")?.classList.add("is-hidden");
  }

  // --- Render -------------------------------------------------------------
  function render() {
    if (!pet) return;
    clearTimers();
    if (!pet.isHatched) {
      renderEgg();
    } else {
      renderHatched();
    }
    renderStats();
  }

  function renderStats() {
    nameRow.hidden = !pet.isHatched;
    statsEl.hidden = !pet.isHatched;
    actionsEl.hidden = !pet.isHatched;
    if (!pet.isHatched) return;

    nameEl.textContent  = pet.name;
    levelEl.textContent = `Level ${pet.level}`;
    moodEl.textContent  = capitalize(pet.mood);
    moodEl.className    = `pet-mood-badge mood-${pet.mood}`;

    const xpPct = Math.max(0, Math.min(100, (pet.xp / pet.xpForNext) * 100));
    xpFill.style.width = `${xpPct}%`;
    xpText.textContent = `${pet.xp} / ${pet.xpForNext}`;

    happyFill.style.width = `${pet.happiness}%`;
    happyText.textContent = `${pet.happiness}%`;
    happyFill.dataset.tone = pet.happiness > 70 ? "good" : pet.happiness > 40 ? "okay" : "bad";

    hungerFill.style.width = `${pet.hunger}%`;
    hungerText.textContent = `${pet.hunger}%`;
    hungerFill.dataset.tone = pet.hunger < 40 ? "good" : pet.hunger < 70 ? "okay" : "bad";
  }

  // --- Egg state ----------------------------------------------------------
  function renderEgg() {
    stage.dataset.state = "egg";
    stage.style.setProperty("--color-shift", `${pet.colorSeed || 0}deg`);
    stage.innerHTML = `
      <div class="egg-scene">
        <div class="egg-shadow"></div>
        <div class="egg" id="egg" tabindex="0" role="button" aria-label="Tap or double-click to hatch your EndoPet">
          <svg viewBox="0 0 120 140" width="160" height="180" aria-hidden="true">
            <ellipse cx="60" cy="120" rx="42" ry="6" fill="#ffd6e0" opacity=".5"/>
            <defs>
              <linearGradient id="eggGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"  stop-color="#fff5f8"/>
                <stop offset="100%" stop-color="#ff9bb3"/>
              </linearGradient>
            </defs>
            <ellipse cx="60" cy="78" rx="42" ry="54" fill="url(#eggGrad)" stroke="#ff7aa6" stroke-width="2"/>
            <path d="M50 30 q3 8 -2 16 q5 -2 8 6" stroke="#ff5d8f" stroke-width="2" fill="none" stroke-linecap="round" opacity=".5"/>
            <ellipse cx="48" cy="56" rx="9" ry="5" fill="#fff" opacity=".55"/>
            <circle cx="42" cy="92" r="3" fill="#ff5d8f" opacity=".35"/>
            <circle cx="78" cy="78" r="4" fill="#ff5d8f" opacity=".35"/>
            <circle cx="68" cy="100" r="2.5" fill="#ff5d8f" opacity=".35"/>
          </svg>
        </div>
        <p class="egg-hint">Tap the egg twice (or use the button) to meet your EndoPet 🌸</p>
        <button class="egg-hatch-btn" id="egg-hatch-btn" type="button">Hatch my EndoPet ✨</button>
      </div>`;
    const egg = document.getElementById("egg");
    const btn = document.getElementById("egg-hatch-btn");

    let lastTap = 0;
    const tryHatchOnDouble = () => {
      const now = Date.now();
      if (now - lastTap < 450) { hatch(); lastTap = 0; }
      else { lastTap = now; }
    };

    egg.addEventListener("dblclick", hatch);
    egg.addEventListener("click", () => {
      egg.classList.remove("nudge");
      void egg.offsetWidth;
      egg.classList.add("nudge");
      tryHatchOnDouble();
    });
    btn.addEventListener("click", hatch);
  }

  async function hatch() {
    const egg = document.getElementById("egg");
    const btn = document.getElementById("egg-hatch-btn");
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    if (egg) egg.classList.add("cracking");
    try {
      const data = await fetchJson("/api/me/pet/hatch", { method: "POST" });
      pet = data.pet;
      toast("Welcome to the world, little one ✨");
      setTimeout(() => render(), 900);
    } catch (err) {
      toast(err.message || "Couldn't hatch right now.", "err");
      if (egg) egg.classList.remove("cracking");
      if (btn) btn.disabled = false;
    }
  }

  // --- Hatched pet --------------------------------------------------------
  function renderHatched() {
    stage.dataset.state = "live";
    stage.style.setProperty("--color-shift", `${pet.colorSeed || 0}deg`);
    stage.innerHTML = `
      <div class="pet-scene">
        <div class="pet-cloud cloud-a"></div>
        <div class="pet-cloud cloud-b"></div>
        <div class="pet-cloud cloud-c"></div>
        <div class="pet" id="pet" data-pet="${pet.type}" data-mood="${pet.mood}">
          <div class="pet-thought" id="pet-thought" hidden></div>
          <div class="pet-shadow"></div>
          <div class="pet-body">${petSvg(pet.type)}</div>
        </div>
        <div class="pet-floor"></div>
      </div>`;
    petEl = document.getElementById("pet");
    petEl.addEventListener("click", () => {
      petEl.dataset.action = "bounce";
      setTimeout(() => delete petEl.dataset.action, 450);
      showThought(randomFromState(), 1600);
    });
    startBehaviorLoop();
  }

  // --- Wandering + state loop ---------------------------------------------
  function startBehaviorLoop() {
    if (!stage || !petEl) return;
    // initial drift
    wander();
    // pick a random ambient action every ~6s
    stateTimer = setInterval(() => {
      const next = ambientState();
      petEl.dataset.state = next;
      if (next === "walk") wander();
    }, 6000);
    // occasional thought bubbles
    thoughtTimer = setInterval(() => {
      const t = needBasedThought();
      if (t) showThought(t, 2400);
    }, 7500);
  }

  function ambientState() {
    if (pet.happiness < 35) return Math.random() < 0.4 ? "sad" : "idle";
    if (pet.hunger    > 70) return Math.random() < 0.4 ? "hungry" : "idle";
    const options = ["idle", "walk", "idle", "look", "walk"];
    return options[Math.floor(Math.random() * options.length)];
  }

  function wander() {
    if (!petEl || !stage) return;
    const stageW = stage.clientWidth - 110;
    if (stageW <= 0) return;
    const x = Math.floor(Math.random() * stageW);
    const flip = Math.random() < 0.5 ? -1 : 1;
    petEl.style.setProperty("--pet-x", `${x}px`);
    petEl.style.setProperty("--pet-flip", flip);
  }

  function needBasedThought() {
    if (pet.hunger > 75) return "🍎";
    if (pet.happiness < 30) return "😢";
    if (pet.happiness > 85) return "💖";
    if (Math.random() < 0.45) {
      const idle = ["💭","🌸","✨","🎵","💫","🌷"];
      return idle[Math.floor(Math.random() * idle.length)];
    }
    return null;
  }
  function randomFromState() {
    if (pet.hunger > 65) return "🍎";
    if (pet.happiness > 70) return "💖";
    const idle = ["💭","🌸","✨","🎵","💖","🌷"];
    return idle[Math.floor(Math.random() * idle.length)];
  }
  function showThought(emoji, duration = 2200) {
    const bubble = document.getElementById("pet-thought");
    if (!bubble) return;
    bubble.textContent = emoji;
    bubble.hidden = false;
    clearTimeout(showThought._t);
    showThought._t = setTimeout(() => { bubble.hidden = true; }, duration);
  }

  function clearTimers() {
    clearInterval(wanderTimer); wanderTimer = null;
    clearInterval(stateTimer);  stateTimer = null;
    clearInterval(thoughtTimer); thoughtTimer = null;
  }

  // --- Lifecycle / Glow Points display -----------------------------------
  function renderLifecycle() {
    const card = document.getElementById("pet-lifecycle");
    if (!card || !pet) return;
    card.hidden = !pet.isHatched;

    document.getElementById("glow-points").textContent = pet.glowPoints ?? 0;
    document.getElementById("lc-stage-key").textContent  = pet.stageLabel || "—";
    document.getElementById("lc-stage-copy").textContent = pet.stageCopy  || "";

    // 6-segment lifecycle bar
    const bar = document.getElementById("lc-progress");
    if (bar) {
      const total = 6;
      const filled = (pet.stageIdx ?? 0) + 1;
      bar.innerHTML = "";
      for (let i = 0; i < total; i++) {
        const seg = document.createElement("div");
        seg.className = "lc-seg" + (i < filled ? " on" : "") + (pet.regressionLevels > 0 && i >= filled && i < (pet.baseStageIdx + 1) ? " ghost" : "");
        bar.appendChild(seg);
      }
    }

    // Next stage hint
    const next = document.getElementById("lc-next");
    if (next) {
      if (pet.stageIdx >= 5) {
        next.textContent = "Your pet is in their wisest, cosiest era. Keep showing up.";
      } else if (pet.regressionLevels > 0) {
        next.textContent = "Your pet is cocooning gently — a check-in helps them remember their sparkle.";
      } else {
        next.textContent = `Next: ${pet.nextStageLabel} at level ${pet.nextStageMinLevel} · ${pet.nextStageMinDays} logged days (you have ${pet.distinctLogDays}).`;
      }
    }

    // Rest mode button state
    const restLabel = document.getElementById("rest-label");
    const restHint  = document.getElementById("rest-hint");
    if (restLabel && restHint) {
      if (pet.restActive && pet.restModeUntil) {
        const hours = Math.max(1, Math.ceil((pet.restModeUntil - Math.floor(Date.now()/1000)) / 3600));
        const days = Math.max(1, Math.round(hours / 24));
        restLabel.textContent = "End Rest";
        restHint.textContent = `${days} day${days > 1 ? "s" : ""} cosy`;
      } else {
        restLabel.textContent = "Rest Mode";
        restHint.textContent = "pause regression";
      }
    }
  }

  // --- Inventory ----------------------------------------------------------
  function renderInventory() {
    const card = document.getElementById("pet-inventory-card");
    const grid = document.getElementById("inv-grid");
    const count = document.getElementById("inv-count");
    if (!card || !grid) return;
    card.hidden = !pet?.isHatched;
    const owned = inventory.filter((i) => (i.quantity || 0) > 0);
    count.textContent = `${owned.length} item${owned.length !== 1 ? "s" : ""}`;
    if (!owned.length) {
      grid.innerHTML = `<p class="inv-empty">Nothing collected yet — open the shop to start your little cosy stash.</p>`;
      return;
    }
    grid.innerHTML = owned.map(invCardHtml).join("");
  }

  function invCardHtml(row) {
    const it = row.item;
    const act = it.consumable
      ? `<button class="inv-act" data-inv-use="${row.key}">Use</button>`
      : it.equippable
        ? `<button class="inv-act ${row.equipped ? "on" : ""}" data-inv-equip="${row.key}">${row.equipped ? "Equipped" : "Equip"}</button>`
        : "";
    const qty = (row.quantity || 0) > 1 ? `<span class="inv-qty">×${row.quantity}</span>` : "";
    return `
      <div class="inv-tile rarity-${it.rarity || "common"}${row.equipped ? " is-equipped" : ""}">
        <div class="inv-icon" aria-hidden="true">${it.icon || "?"}${qty}</div>
        <div class="inv-meta">
          <strong>${escapeHtml(it.name)}</strong>
          <span class="inv-cat">${escapeHtml(it.category || "")}</span>
        </div>
        ${act}
      </div>`;
  }

  // --- Recent rewards ----------------------------------------------------
  const REWARD_LABEL = {
    morning_checkin: "Morning check-in", evening_checkin: "Evening reflection",
    symptom: "Symptom logged", flare: "Flare logged",
  };
  function renderRecentRewards() {
    const card = document.getElementById("pet-rewards-card");
    const list = document.getElementById("rewards-list");
    if (!card || !list) return;
    card.hidden = !pet?.isHatched || recentRewards.length === 0;
    list.innerHTML = recentRewards.map((r) => `
      <li>
        <span class="r-label">${escapeHtml(REWARD_LABEL[r.sourceType] || r.sourceType)}</span>
        <span class="r-gain">${r.xp ? `⭐ +${r.xp}` : ""} ${r.glow ? `✨ +${r.glow}` : ""}</span>
        <span class="r-time">${relTime(r.at)}</span>
      </li>`).join("");
  }

  function relTime(unixSec) {
    if (!unixSec) return "";
    const diff = Math.floor(Date.now() / 1000) - unixSec;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[<>&"']/g, (c) => ({
      "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  // --- Shop modal --------------------------------------------------------
  let shopFilter = "all";
  let shopState = null;

  async function openShop() {
    document.getElementById("shop-modal").hidden = false;
    document.body.classList.add("modal-open");
    try {
      shopState = await fetchJson("/api/me/pet/shop");
      renderShop();
    } catch (err) {
      document.getElementById("shop-grid").innerHTML = `<p class="inv-empty">Couldn't open the shop.</p>`;
    }
  }
  function closeShop() {
    document.getElementById("shop-modal").hidden = true;
    document.body.classList.remove("modal-open");
  }

  function renderShop() {
    if (!shopState) return;
    document.getElementById("shop-balance-value").textContent = shopState.glowPoints ?? 0;
    const grid = document.getElementById("shop-grid");
    const items = (shopState.items || []).filter((i) => shopFilter === "all" || i.category === shopFilter);
    if (!items.length) { grid.innerHTML = `<p class="inv-empty">Nothing in this category yet.</p>`; return; }
    grid.innerHTML = items.map(shopCardHtml).join("");
  }

  function shopCardHtml(it) {
    const canAfford = (shopState.glowPoints || 0) >= it.price;
    let actionBtn;
    if (it.locked) {
      actionBtn = `<button class="shop-buy" disabled>🔒 Locked</button>`;
    } else if (it.owned && !it.consumable) {
      actionBtn = `<button class="shop-buy owned" disabled>Owned</button>`;
    } else if (!canAfford) {
      actionBtn = `<button class="shop-buy" disabled>${it.price} ✨</button>`;
    } else {
      actionBtn = `<button class="shop-buy" data-buy="${it.key}">${it.price} ✨</button>`;
    }
    return `
      <div class="shop-item rarity-${it.rarity || "common"}">
        <div class="shop-item-icon">${it.icon || "?"}</div>
        <div class="shop-item-meta">
          <strong>${escapeHtml(it.name)}</strong>
          <span class="shop-item-cat">${escapeHtml(it.category)}${it.consumable ? " · consumable" : ""}</span>
        </div>
        ${actionBtn}
      </div>`;
  }

  document.addEventListener("click", async (e) => {
    if (e.target.closest("[data-close-shop]")) { closeShop(); return; }
    if (e.target.closest(".shop-filter")) {
      const btn = e.target.closest(".shop-filter");
      document.querySelectorAll(".shop-filter").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      shopFilter = btn.dataset.filter;
      renderShop();
      return;
    }
    const buyBtn = e.target.closest("[data-buy]");
    if (buyBtn) {
      e.preventDefault();
      const itemKey = buyBtn.dataset.buy;
      buyBtn.disabled = true; buyBtn.textContent = "…";
      try {
        await fetchJson("/api/me/pet/buy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ itemKey }),
        });
        toast(`Added to your stash 🌸`);
        shopState = await fetchJson("/api/me/pet/shop");
        renderShop();
        await reloadState();
      } catch (err) {
        toast(err.message || "Couldn't buy", "err");
        buyBtn.disabled = false;
      }
      return;
    }
    const useBtn = e.target.closest("[data-inv-use]");
    if (useBtn) {
      e.preventDefault();
      useBtn.disabled = true;
      try {
        await fetchJson("/api/me/pet/use", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ itemKey: useBtn.dataset.invUse }),
        });
        toast("Used — your pet looks brighter ✨");
        await reloadState();
      } catch (err) {
        toast(err.message || "Couldn't use", "err");
        useBtn.disabled = false;
      }
      return;
    }
    const equipBtn = e.target.closest("[data-inv-equip]");
    if (equipBtn) {
      e.preventDefault();
      equipBtn.disabled = true;
      try {
        await fetchJson("/api/me/pet/equip", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ itemKey: equipBtn.dataset.invEquip }),
        });
        await reloadState();
      } catch (err) {
        toast(err.message || "Couldn't equip", "err");
        equipBtn.disabled = false;
      }
      return;
    }
  });

  // --- Actions ------------------------------------------------------------
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".pet-action");
    if (!btn) return;
    e.preventDefault();
    const action = btn.dataset.action;

    // Special non-API actions
    if (action === "shop") { openShop(); return; }
    if (action === "rest") {
      btn.disabled = true;
      try {
        const url = pet?.restActive ? "/api/me/pet/rest/end" : "/api/me/pet/rest";
        await fetchJson(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ days: 3 }),
        });
        toast(pet?.restActive ? "Welcome back. We saved your spot." : "Rest Mode on — your pet is resting with you 🌙");
        await reloadState();
      } catch (err) {
        toast(err.message || "Couldn't toggle Rest Mode", "err");
      } finally {
        btn.disabled = false;
      }
      return;
    }

    btn.disabled = true;
    try {
      const data = await fetchJson(`/api/me/pet/${action}`, { method: "POST" });
      pet = { ...pet, ...(data.pet || {}) };
      if (petEl) {
        petEl.dataset.action = actionAnim(action);
        showThought(actionEmoji(action), 1600);
        setTimeout(() => { if (petEl) delete petEl.dataset.action; }, 900);
      }
      renderStats();
      renderLifecycle();
      toast(actionToast(action, data.leveledUp));
    } catch (err) {
      toast(err.message || "Couldn't do that", "err");
    } finally {
      btn.disabled = false;
    }
  });

  function actionAnim(a)  { return a === "play" ? "bounce" : a === "feed" ? "eat" : "wiggle"; }
  function actionEmoji(a) { return a === "play" ? "🎾" : a === "feed" ? "😋" : "💖"; }
  function actionToast(a, leveledUp) {
    const base = a === "play" ? "Playtime — +25 happy, +3 XP"
               : a === "feed" ? "Fed and full — happiness goes up too"
               :                "A little pat goes a long way 💖";
    return leveledUp ? `${base} · 🎉 Level up!` : base;
  }

  // --- Toast / helpers ----------------------------------------------------
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
  function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : ""; }

  // Wander on resize
  window.addEventListener("resize", () => { if (petEl) wander(); });

  // --- Pet SVG library (one per type) ------------------------------------
  function petSvg(type) {
    switch (type) {
      case "poppy": return SVG.poppy;
      case "mochi": return SVG.mochi;
      case "sunny": return SVG.sunny;
      case "coco":  return SVG.coco;
      case "kiki":  return SVG.kiki;
      default:      return SVG.luna;
    }
  }

  const SVG = {
    luna: `
      <svg class="pet-svg" viewBox="0 0 160 160" width="120" height="120">
        <ellipse cx="80" cy="138" rx="50" ry="8" fill="rgba(0,0,0,.06)"/>
        <path d="M44 60 L30 26 L52 50 Z" fill="var(--pet-mid)"/>
        <path d="M116 60 L130 26 L108 50 Z" fill="var(--pet-mid)"/>
        <path d="M48 56 L40 38 L56 50 Z" fill="var(--pet-light)"/>
        <path d="M112 56 L120 38 L104 50 Z" fill="var(--pet-light)"/>
        <ellipse cx="80" cy="106" rx="38" ry="30" fill="var(--pet-mid)"/>
        <circle cx="80" cy="80" r="36" fill="var(--pet-light)"/>
        <ellipse class="pet-eye left"  cx="66" cy="82" rx="5" ry="6" fill="#2c1320"/>
        <ellipse class="pet-eye right" cx="94" cy="82" rx="5" ry="6" fill="#2c1320"/>
        <circle cx="68" cy="80" r="1.6" fill="#fff"/>
        <circle cx="96" cy="80" r="1.6" fill="#fff"/>
        <path d="M80 92 l-2 3 h4 z" fill="#ff5d8f"/>
        <path d="M76 96 q4 4 8 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/>
        <ellipse cx="60" cy="93" rx="6" ry="3" fill="#ff5d8f" opacity=".35"/>
        <ellipse cx="100" cy="93" rx="6" ry="3" fill="#ff5d8f" opacity=".35"/>
      </svg>`,
    poppy: `
      <svg class="pet-svg" viewBox="0 0 160 160" width="120" height="120">
        <ellipse cx="80" cy="138" rx="50" ry="8" fill="rgba(0,0,0,.06)"/>
        <ellipse cx="50" cy="88" rx="16" ry="22" fill="var(--pet-mid)"/>
        <ellipse cx="110" cy="88" rx="16" ry="22" fill="var(--pet-mid)"/>
        <ellipse cx="80" cy="100" rx="40" ry="32" fill="var(--pet-light)"/>
        <circle cx="80" cy="78" r="34" fill="var(--pet-light)"/>
        <circle cx="80" cy="66" r="14" fill="var(--pet-mid)"/>
        <ellipse class="pet-eye left"  cx="68" cy="80" rx="5" ry="6" fill="#2c1320"/>
        <ellipse class="pet-eye right" cx="92" cy="80" rx="5" ry="6" fill="#2c1320"/>
        <ellipse cx="80" cy="92" rx="3.5" ry="2.5" fill="#2c1320"/>
        <path d="M76 98 q4 4 8 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      </svg>`,
    mochi: `
      <svg class="pet-svg" viewBox="0 0 160 160" width="120" height="120">
        <ellipse cx="80" cy="138" rx="50" ry="8" fill="rgba(0,0,0,.06)"/>
        <ellipse cx="58" cy="40" rx="10" ry="26" fill="var(--pet-mid)"/>
        <ellipse cx="102" cy="40" rx="10" ry="26" fill="var(--pet-mid)"/>
        <ellipse cx="58" cy="42" rx="4" ry="16" fill="#ffb6c8"/>
        <ellipse cx="102" cy="42" rx="4" ry="16" fill="#ffb6c8"/>
        <ellipse cx="80" cy="106" rx="40" ry="32" fill="var(--pet-mid)"/>
        <circle cx="80" cy="82" r="32" fill="var(--pet-light)"/>
        <ellipse class="pet-eye left"  cx="68" cy="84" rx="5" ry="6" fill="#2c1320"/>
        <ellipse class="pet-eye right" cx="92" cy="84" rx="5" ry="6" fill="#2c1320"/>
        <path d="M78 94 l2 2 l2 -2 z" fill="#ff7a99"/>
        <path d="M76 100 q4 3 8 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      </svg>`,
    sunny: `
      <svg class="pet-svg" viewBox="0 0 160 160" width="120" height="120">
        <ellipse cx="80" cy="138" rx="50" ry="8" fill="rgba(0,0,0,.06)"/>
        <path d="M44 44 L56 70 L36 64 Z" fill="var(--pet-mid)"/>
        <path d="M116 44 L104 70 L124 64 Z" fill="var(--pet-mid)"/>
        <ellipse cx="80" cy="108" rx="38" ry="28" fill="var(--pet-mid)"/>
        <ellipse cx="80" cy="112" rx="22" ry="18" fill="#fff"/>
        <circle cx="80" cy="82" r="34" fill="var(--pet-light)"/>
        <path d="M80 70 Q60 84 64 102 Q80 96 80 96 Q80 96 96 102 Q100 84 80 70 Z" fill="#fff"/>
        <ellipse class="pet-eye left"  cx="68" cy="82" rx="5" ry="6" fill="#2c1320"/>
        <ellipse class="pet-eye right" cx="92" cy="82" rx="5" ry="6" fill="#2c1320"/>
        <ellipse cx="80" cy="94" rx="3.5" ry="2.5" fill="#2c1320"/>
        <path d="M76 100 q4 4 8 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      </svg>`,
    coco: `
      <svg class="pet-svg" viewBox="0 0 160 160" width="120" height="120">
        <ellipse cx="80" cy="138" rx="50" ry="8" fill="rgba(0,0,0,.06)"/>
        <ellipse cx="80" cy="110" rx="40" ry="30" fill="var(--pet-mid)"/>
        <circle cx="40" cy="64" r="18" fill="var(--pet-mid)"/>
        <circle cx="120" cy="64" r="18" fill="var(--pet-mid)"/>
        <circle cx="40" cy="64" r="10" fill="#f4cce3"/>
        <circle cx="120" cy="64" r="10" fill="#f4cce3"/>
        <circle cx="80" cy="78" r="34" fill="var(--pet-light)"/>
        <ellipse class="pet-eye left"  cx="68" cy="78" rx="5" ry="6" fill="#2c1320"/>
        <ellipse class="pet-eye right" cx="92" cy="78" rx="5" ry="6" fill="#2c1320"/>
        <ellipse cx="80" cy="94" rx="10" ry="8" fill="#2c1320"/>
        <path d="M70 106 q10 4 20 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      </svg>`,
    kiki: `
      <svg class="pet-svg" viewBox="0 0 160 160" width="120" height="120">
        <ellipse cx="80" cy="138" rx="50" ry="8" fill="rgba(0,0,0,.06)"/>
        <ellipse cx="62" cy="40" rx="7" ry="22" fill="var(--pet-mid)"/>
        <ellipse cx="98" cy="40" rx="7" ry="22" fill="var(--pet-mid)"/>
        <ellipse cx="80" cy="110" rx="40" ry="30" fill="var(--pet-mid)"/>
        <ellipse cx="80" cy="80" rx="30" ry="28" fill="var(--pet-light)"/>
        <ellipse class="pet-eye left"  cx="70" cy="78" rx="5" ry="6" fill="#2c1320"/>
        <ellipse class="pet-eye right" cx="90" cy="78" rx="5" ry="6" fill="#2c1320"/>
        <ellipse cx="80" cy="90" rx="3.5" ry="2.5" fill="#2c1320"/>
        <path d="M76 96 q4 4 8 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      </svg>`,
  };
})();
