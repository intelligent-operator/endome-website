// /food — food diary, calorie + macro tracking with weekly plan.
console.info("EndoMe food build v1");

(() => {
  const MEALS = [
    { key: "breakfast", emoji: "🌅", label: "Breakfast" },
    { key: "lunch",     emoji: "☀️", label: "Lunch" },
    { key: "dinner",    emoji: "🌙", label: "Dinner" },
    { key: "snack",     emoji: "🍪", label: "Snacks" },
  ];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];           // Mon..Sun
  const DAY_NAMES = { 0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat" };

  let foods = [];        // saved foods
  let plans = [];        // weekly plan rows
  let dayLogs = [];      // today's logged items
  let dayTotals = { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 };
  let prefs = { dailyCalorieTarget: 2000, proteinTargetG: null, carbsTargetG: null, fatTargetG: null };

  // --- Bootstrap -------------------------------------------------------
  (async () => {
    try {
      const me = await fetchJson("/api/me/today");
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = me?.user?.displayName || me?.user?.username || "there";
      });
    } catch {}
    await loadAll();
    document.getElementById("page-loader")?.classList.add("is-hidden");
  })();

  async function loadAll() {
    const today = new Date().toISOString().slice(0, 10);
    const [day, fs, ps, pp, wk] = await Promise.all([
      fetchJson(`/api/me/food-logs?date=${today}`).catch(() => ({ logs: [], totals: { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 } })),
      fetchJson("/api/me/foods").catch(() => ({ foods: [] })),
      fetchJson("/api/me/food-plans").catch(() => ({ plans: [] })),
      fetchJson("/api/me/food-prefs").catch(() => prefs),
      fetchJson("/api/me/food-logs/week").catch(() => ({ days: [] })),
    ]);
    dayLogs = day.logs || [];
    dayTotals = day.totals || dayTotals;
    foods = fs.foods || [];
    plans = ps.plans || [];
    prefs = pp.dailyCalorieTarget ? pp : prefs;
    paintToday();
    paintWeek(wk.days || []);
    paintFoods();
    paintRightRail(wk.days || []);
    paintFoodPicker();
    paintPrefsForm();
    loadCravings();
  }

  // --- Cravings (fast log) ---------------------------------------------
  // One tap = logged. Recent ones appear below as removable chips.
  async function loadCravings() {
    const recent = document.getElementById("cravings-recent");
    if (!recent) return;
    try {
      const data = await fetchJson("/api/me/cravings");
      const items = data.cravings || [];
      if (!items.length) { recent.innerHTML = `<li class="cravings-empty">No cravings logged yet — they cluster in the luteal phase.</li>`; return; }
      const LABEL = { salty:"🧂 Salty", sweet:"🍬 Sweet", fatty:"🥑 Fatty", carbs:"🍞 Carbs",
        chocolate:"🍫 Chocolate", spicy:"🌶 Spicy", protein:"🥩 Protein", cold:"🍦 Cold",
        sour:"🍋 Sour", other:"＋ Other" };
      // Group by day so the user sees their per-day cravings instead of
      // a flat aggregated chip list. Newest day first; only show the
      // last 14 days to keep it tidy.
      const byDay = new Map();
      for (const c of items) {
        if (!byDay.has(c.log_date)) byDay.set(c.log_date, []);
        byDay.get(c.log_date).push(c);
      }
      const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14);
      const fmtDay = (iso) => {
        const today = new Date(); today.setHours(0,0,0,0);
        const d = new Date(iso + "T00:00:00");
        const diff = Math.round((today - d) / 86400000);
        if (diff === 0) return "Today";
        if (diff === 1) return "Yesterday";
        return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
      };
      recent.innerHTML = days.map(([date, dayItems]) => `
        <li class="cravings-day">
          <div class="cravings-day-head">
            <strong>${escapeHtml(fmtDay(date))}</strong>
            <span class="cravings-day-count">${dayItems.length} craving${dayItems.length === 1 ? "" : "s"}</span>
          </div>
          <div class="cravings-day-chips">
            ${dayItems.map((c) => `
              <span class="cravings-chip-log" data-cid="${c.id}">
                ${escapeHtml(LABEL[c.craving] || c.craving)}
                <button type="button" data-del-craving="${c.id}" aria-label="Remove">×</button>
              </span>`).join("")}
          </div>
        </li>`).join("");
      recent.querySelectorAll("[data-del-craving]").forEach((b) =>
        b.addEventListener("click", async () => {
          try { await fetchJson(`/api/me/cravings/${b.dataset.delCraving}`, { method: "DELETE" }); loadCravings(); }
          catch (err) { toast(err.message || "Couldn't remove", "err"); }
        })
      );
    } catch {}
  }
  // Multi-select: tapping a chip toggles it. Nothing is logged until the
  // user hits "Log cravings", so they can pick several at once.
  const cravingChips = document.getElementById("cravings-chips");
  const cravingLogBtn = document.getElementById("cravings-log-btn");
  const cravingCount = document.getElementById("cravings-selected-count");

  function selectedCravings() {
    return [...(cravingChips?.querySelectorAll("button.selected") || [])].map((b) => b.dataset.craving);
  }
  function refreshCravingLogBtn() {
    const n = selectedCravings().length;
    if (cravingLogBtn) {
      cravingLogBtn.disabled = n === 0;
      cravingLogBtn.textContent = n > 1 ? `Log ${n} cravings` : "Log cravings";
    }
    if (cravingCount) cravingCount.textContent = n ? `${n} selected` : "";
  }

  cravingChips?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-craving]");
    if (!btn) return;
    btn.classList.toggle("selected");
    refreshCravingLogBtn();
  });

  cravingLogBtn?.addEventListener("click", async () => {
    const picks = selectedCravings();
    if (!picks.length) return;
    cravingLogBtn.disabled = true;
    const prev = cravingLogBtn.textContent;
    cravingLogBtn.textContent = "Logging…";
    try {
      // Log each selected craving (the API takes one at a time).
      await Promise.all(picks.map((craving) =>
        fetchJson("/api/me/cravings", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ craving, intensity: 3 }),
        })
      ));
      toast(picks.length > 1 ? `${picks.length} cravings logged ✨` : "Logged ✨", "ok");
      // Clear selection + flash the logged state briefly.
      cravingChips.querySelectorAll("button.selected").forEach((b) => {
        b.classList.remove("selected");
        b.classList.add("logged");
        setTimeout(() => b.classList.remove("logged"), 800);
      });
      refreshCravingLogBtn();
      loadCravings();
    } catch (err) {
      toast(err.message || "Couldn't log", "err");
      cravingLogBtn.disabled = false;
      cravingLogBtn.textContent = prev;
    }
  });

  // --- Sub-nav tabs ----------------------------------------------------
  document.querySelectorAll(".subnav-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tabTarget;
      document.querySelectorAll(".subnav-tab").forEach((t) => {
        t.classList.toggle("on", t === tab);
        t.setAttribute("aria-selected", t === tab ? "true" : "false");
      });
      document.querySelectorAll("[data-tab]").forEach((p) => {
        p.hidden = p.dataset.tab !== target;
      });
    });
  });

  // --- Today rendering -------------------------------------------------
  function paintToday() {
    // Ring
    const target = prefs.dailyCalorieTarget || 2000;
    const cal = dayTotals.calories || 0;
    const pct = Math.min(100, Math.round((cal / target) * 100));
    const ring = document.getElementById("food-ring-progress");
    if (ring) {
      const circumference = 2 * Math.PI * 60;
      ring.setAttribute("stroke-dasharray", circumference);
      ring.setAttribute("stroke-dashoffset", circumference * (1 - pct / 100));
    }
    document.getElementById("food-ring-pct").textContent = pct + "%";
    document.getElementById("food-ring-sub").textContent = `${cal} / ${target} kcal`;

    // Macro bars
    paintMacro("protein", dayTotals.proteinG, prefs.proteinTargetG || 100, "g");
    paintMacro("carbs",   dayTotals.carbsG,   prefs.carbsTargetG   || 250, "g");
    paintMacro("fat",     dayTotals.fatG,     prefs.fatTargetG     || 70,  "g");
    paintMacro("fiber",   dayTotals.fiberG,   30,                          "g");

    // Meal groups
    const wrap = document.getElementById("meal-groups");
    wrap.innerHTML = MEALS.map((m) => {
      const logs = dayLogs.filter((l) => l.meal === m.key);
      const total = logs.reduce((a, l) => a + (l.calories || 0), 0);
      return `<div class="meal-group" data-meal="${m.key}">
        <header class="meal-group-head">
          <span class="meal-emoji">${m.emoji}</span>
          <h3>${m.label}</h3>
          <span class="meal-total">${total} kcal</span>
          <button type="button" class="meal-add" data-meal-add="${m.key}">+ Log</button>
        </header>
        <ul class="meal-group-list">
          ${logs.length ? logs.map(mealRow).join("") : `<li class="empty">Nothing yet — tap +Log to add something.</li>`}
        </ul>
      </div>`;
    }).join("");
    wrap.querySelectorAll("[data-meal-add]").forEach((b) => {
      b.addEventListener("click", () => openLogModal({ meal: b.dataset.mealAdd }));
    });
    wrap.querySelectorAll("[data-del-log]").forEach((b) => {
      b.addEventListener("click", () => deleteLog(+b.dataset.delLog));
    });
  }
  function mealRow(l) {
    const macros = [
      l.proteinG != null ? `${l.proteinG}p` : null,
      l.carbsG   != null ? `${l.carbsG}c`   : null,
      l.fatG     != null ? `${l.fatG}f`     : null,
    ].filter(Boolean).join(" · ");
    return `<li class="meal-row">
      <div class="meal-row-info">
        <strong>${escapeHtml(l.name)}${l.servings !== 1 ? ` × ${l.servings}` : ""}</strong>
        <span class="meal-row-meta">${macros || "—"}</span>
      </div>
      <span class="meal-row-cal">${l.calories || 0} kcal</span>
      <button type="button" class="meal-row-del" data-del-log="${l.id}" aria-label="Delete">×</button>
    </li>`;
  }
  function paintMacro(macro, value, target, unit) {
    const el = document.querySelector(`[data-macro="${macro}"]`);
    if (!el) return;
    const v = value || 0;
    const pct = target > 0 ? Math.min(100, (v / target) * 100) : 0;
    el.querySelector(".macro-fill").style.width = `${pct}%`;
    el.querySelector(".macro-val").textContent = `${Math.round(v)}${unit} / ${Math.round(target)}${unit}`;
  }

  // --- Weekly plan / chart ---------------------------------------------
  function paintWeek(weekDays) {
    const table = document.getElementById("food-week");
    const today = new Date().getDay();
    let html = "<thead><tr>";
    for (const i of DAY_ORDER) {
      html += `<th class="${i === today ? "is-today" : ""}">${DAY_NAMES[i]}${i === today ? " · today" : ""}</th>`;
    }
    html += "</tr></thead><tbody><tr>";
    for (const i of DAY_ORDER) {
      const isToday = i === today;
      const bit = 1 << i;
      const dayPlans = plans.filter((p) => p.daysMask & bit)
                            .sort((a, b) => MEALS.findIndex(m=>m.key===a.meal) - MEALS.findIndex(m=>m.key===b.meal));
      html += `<td class="${isToday ? "is-today" : ""}">`;
      html += dayPlans.map((p) => {
        const emoji = MEALS.find((m) => m.key === p.meal)?.emoji || "🍽";
        return `<div class="food-plan-slot">
          <span class="meal-tag">${emoji} ${escapeHtml(p.meal)}</span>
          <strong>${escapeHtml(p.name)}${p.servings !== 1 ? ` × ${p.servings}` : ""}</strong>
          <span class="kcal">${p.calories || 0} kcal</span>
          <button type="button" class="meal-row-del" data-del-plan="${p.id}" aria-label="Remove">×</button>
        </div>`;
      }).join("");
      html += `<button type="button" class="food-plan-add" data-add-plan-day="${bit}">+ Add to ${DAY_NAMES[i]}</button>`;
      html += "</td>";
    }
    html += "</tr></tbody>";
    table.innerHTML = html;
    table.querySelectorAll("[data-del-plan]").forEach((b) => {
      b.addEventListener("click", () => deletePlan(+b.dataset.delPlan));
    });
    table.querySelectorAll("[data-add-plan-day]").forEach((b) => {
      b.addEventListener("click", () => promptAddPlan(+b.dataset.addPlanDay));
    });

    // 7-day calorie trend
    const trend = document.getElementById("food-trend");
    if (!weekDays.length) { trend.innerHTML = `<p class="empty-state small">No data yet.</p>`; return; }
    const target = prefs.dailyCalorieTarget || 2000;
    const max = Math.max(target, ...weekDays.map((d) => d.calories));
    trend.innerHTML = weekDays.map((d) => {
      const h = (d.calories / max) * 100;
      const over = d.calories > target * 1.1;
      const label = d.date.slice(5);
      return `<div class="food-trend-col" title="${escapeHtml(d.date)}: ${d.calories} kcal">
        <span class="day-cal">${d.calories || ""}</span>
        <div class="bar ${over ? "over" : ""}" style="height:${h.toFixed(1)}%"></div>
        <span class="day-label">${escapeHtml(label)}</span>
      </div>`;
    }).join("");
  }

  // --- Right rail ------------------------------------------------------
  function paintRightRail(weekDays) {
    const logged = weekDays.filter((d) => d.calories > 0);
    const total = logged.reduce((a, d) => a + d.calories, 0);
    const avg = logged.length ? Math.round(total / logged.length) : 0;
    const best = weekDays.reduce((b, d) => d.calories > 0 && d.calories <= (prefs.dailyCalorieTarget * 1.05) ? d : b, null);
    // Streak: count days back from today with at least one log
    let streak = 0;
    for (let i = weekDays.length - 1; i >= 0; i--) {
      if (weekDays[i].calories > 0) streak++;
      else break;
    }
    const stats = document.getElementById("food-week-stats");
    stats.innerHTML = [
      `<div><span>Avg kcal/day</span><strong>${avg.toLocaleString()}</strong></div>`,
      `<div><span>Days logged</span><strong>${logged.length}/7</strong></div>`,
      `<div><span>Best day</span><strong>${best ? best.date.slice(5) : "—"}</strong></div>`,
      `<div><span>Streak</span><strong>${streak} day${streak === 1 ? "" : "s"}</strong></div>`,
    ].join("");

    const quick = document.getElementById("food-quick-list");
    if (!foods.length) {
      quick.innerHTML = `<li class="empty-state small">Add a food to see it here.</li>`;
    } else {
      quick.innerHTML = foods.slice(0, 6).map((f) => `<li>
        <button type="button" data-quick-food="${f.id}">
          <strong>${escapeHtml(f.name)}</strong>
          <span class="kcal">${f.calories || 0} kcal</span>
        </button>
      </li>`).join("");
      quick.querySelectorAll("[data-quick-food]").forEach((b) => {
        b.addEventListener("click", () => openLogModal({ foodId: +b.dataset.quickFood }));
      });
    }
  }

  // --- My foods --------------------------------------------------------
  function paintFoods() {
    const list = document.getElementById("food-list");
    if (!foods.length) {
      list.innerHTML = `<li class="empty-state">No saved foods yet. Tap <strong>+ Add food</strong> to build your shortcut list.</li>`;
      return;
    }
    list.innerHTML = foods.map((f) => `<li class="food-card">
      <header class="food-card-head">
        <div>
          <strong>${escapeHtml(f.name)}</strong>
          <span class="food-card-meta">${escapeHtml(f.servingSize || "1 serving")}${f.brand ? " · " + escapeHtml(f.brand) : ""}</span>
        </div>
        <span class="food-cal">${f.calories || "—"} kcal</span>
      </header>
      <div class="food-card-macros">
        ${f.proteinG != null ? `<span>${f.proteinG}g protein</span>` : ""}
        ${f.carbsG != null ? `<span>${f.carbsG}g carbs</span>` : ""}
        ${f.fatG != null ? `<span>${f.fatG}g fat</span>` : ""}
        ${f.fiberG != null ? `<span>${f.fiberG}g fiber</span>` : ""}
      </div>
      <div class="food-card-actions">
        <button class="btn btn-primary small" data-log-food="${f.id}">+ Log</button>
        <button class="btn-soft small" data-edit-food="${f.id}">Edit</button>
        <button class="btn-soft small danger" data-del-food="${f.id}">Remove</button>
      </div>
    </li>`).join("");
    list.querySelectorAll("[data-log-food]").forEach((b) => b.addEventListener("click", () => openLogModal({ foodId: +b.dataset.logFood })));
    list.querySelectorAll("[data-edit-food]").forEach((b) => b.addEventListener("click", () => openFoodModal(foods.find((f) => f.id === +b.dataset.editFood))));
    list.querySelectorAll("[data-del-food]").forEach((b) => b.addEventListener("click", () => deleteFood(+b.dataset.delFood)));
  }
  function paintFoodPicker() {
    const sel = document.getElementById("flog-picker");
    sel.innerHTML = `<option value="">— pick a saved food —</option>` +
      foods.map((f) => `<option value="${f.id}">${escapeHtml(f.name)} (${f.calories || "?"} kcal)</option>`).join("");
  }

  // --- Add / Edit food modal ------------------------------------------
  const foodModal = document.getElementById("food-modal");
  document.getElementById("btn-add-food").addEventListener("click", () => openFoodModal(null));
  function openFoodModal(f) {
    const form = document.getElementById("food-form");
    form.reset();
    form.id.value = f?.id || "";
    document.getElementById("food-modal-title").textContent = f ? "Edit food" : "Add a food";
    if (f) {
      form.name.value = f.name || "";
      form.brand.value = f.brand || "";
      form.calories.value = f.calories ?? "";
      form.servingSize.value = f.servingSize || "";
      form.proteinG.value = f.proteinG ?? "";
      form.carbsG.value = f.carbsG ?? "";
      form.fatG.value = f.fatG ?? "";
      form.fiberG.value = f.fiberG ?? "";
      form.notes.value = f.notes || "";
    }
    foodModal.classList.add("open"); foodModal.setAttribute("aria-hidden", "false");
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-food]")) {
      foodModal.classList.remove("open"); foodModal.setAttribute("aria-hidden", "true");
    }
    if (e.target.closest("[data-close-flog]")) {
      logModal.classList.remove("open"); logModal.setAttribute("aria-hidden", "true");
    }
  });
  document.getElementById("food-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const id = form.id.value;
    const body = {
      name: form.name.value.trim(),
      brand: form.brand.value.trim() || null,
      calories: form.calories.value || null,
      servingSize: form.servingSize.value.trim() || null,
      proteinG: form.proteinG.value || null,
      carbsG: form.carbsG.value || null,
      fatG: form.fatG.value || null,
      fiberG: form.fiberG.value || null,
      notes: form.notes.value.trim() || null,
    };
    const status = document.getElementById("food-status");
    status.textContent = "Saving…"; status.className = "form-status";
    try {
      await fetchJson(id ? `/api/me/foods/${id}` : "/api/me/foods", {
        method: id ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      toast(id ? "Food updated" : "Food added", "ok");
      foodModal.classList.remove("open"); foodModal.setAttribute("aria-hidden", "true");
      await loadAll();
    } catch (err) {
      status.textContent = err.message || "Couldn't save."; status.className = "form-status err";
    }
  });
  async function deleteFood(id) {
    if (!confirm("Remove this food? Past logs stay.")) return;
    try { await fetchJson(`/api/me/foods/${id}`, { method: "DELETE" }); await loadAll(); }
    catch (err) { toast(err.message || "Couldn't remove", "err"); }
  }

  // --- Log a food modal -----------------------------------------------
  const logModal = document.getElementById("food-log-modal");
  document.getElementById("btn-quick-log").addEventListener("click", () => openLogModal({}));

  // --- Smart log (AI free-text parser) --------------------------------
  // Opens its own modal, takes "bacon egg roll" and POSTs to
  // /api/me/food/parse — server uses Claude Haiku to itemise + cost
  // calories/macros, then user reviews + saves each item to the diary.
  // Bind via delegation so mobile Safari can never miss the tap on a
  // newly-rendered button, and so a missing modal node doesn't throw.
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#btn-smart-log")) return;
    e.preventDefault();
    openSmartLog();
  });
  function openSmartLog() {
    const smartModal = document.getElementById("smart-log-modal");
    if (!smartModal) { toast("Smart log unavailable — refresh the page.", "err"); return; }
    smartModal.classList.add("open");
    smartModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    const inp = document.getElementById("smart-log-input");
    if (inp) inp.value = "";
    const result = document.getElementById("smart-log-result");
    if (result) result.hidden = true;
    const saveBtn = document.getElementById("smart-log-save-btn");
    if (saveBtn) saveBtn.disabled = true;
    smartModal.querySelectorAll("[data-close-modal]").forEach((el) => {
      el.onclick = () => {
        smartModal.classList.remove("open");
        document.body.classList.remove("modal-open");
      };
    });
    // Only focus on desktop — on mobile the keyboard popping shoves the
    // modal up and ends up unreachable.
    if (!matchMedia("(max-width: 820px)").matches && inp) {
      setTimeout(() => inp.focus(), 80);
    }
  }
  // Reference kept for the existing close handler in the rest of this fn.
  const smartModal = document.getElementById("smart-log-modal");
  document.getElementById("smart-log-parse-btn")?.addEventListener("click", async () => {
    const text = document.getElementById("smart-log-input").value.trim();
    if (!text) { toast("Type what you ate first", "err"); return; }
    const btn = document.getElementById("smart-log-parse-btn");
    btn.disabled = true; btn.textContent = "✨ Parsing…";
    try {
      const data = await fetchJson("/api/me/food/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      paintSmartResult(data);
      document.getElementById("smart-log-result").hidden = false;
      document.getElementById("smart-log-save-btn").disabled = false;
    } catch (err) {
      toast(err.message || "Couldn't parse", "err");
    } finally {
      btn.disabled = false; btn.textContent = "✨ Parse";
    }
  });
  // Smart-log items live here while the modal is open. Every field is
  // editable in place (name, servings, calories, macros); users can
  // also "Replace" any row from the curated food DB, or "+ Add" a row
  // (e.g. tomato sauce on a hot dog) without re-running the AI.
  let smartItems = [];
  function smartItemRow(it, i) {
    return `
      <li class="smart-item" data-i="${i}">
        <label class="smart-item-keep">
          <input type="checkbox" data-keep="${i}" ${it.keep === false ? "" : "checked"} />
        </label>
        <div class="smart-item-body">
          <div class="smart-item-row">
            <input type="text" class="smart-item-name" data-field="name" data-i="${i}" value="${escapeAttr(it.name)}" placeholder="Item name" />
            <button type="button" class="btn-soft tiny" data-replace-i="${i}" title="Swap with a food from the database">🔁 Replace</button>
            <button type="button" class="btn-soft tiny danger" data-remove-i="${i}" title="Remove this item">×</button>
          </div>
          <div class="smart-item-grid">
            <label>Servings <input type="number" step="0.5" min="0" data-field="servings"  data-i="${i}" value="${it.servings ?? 1}" /></label>
            <label>kcal     <input type="number" step="1"   min="0" data-field="calories"  data-i="${i}" value="${it.calories ?? 0}" /></label>
            <label>P (g)    <input type="number" step="0.1" min="0" data-field="protein_g" data-i="${i}" value="${it.protein_g ?? 0}" /></label>
            <label>C (g)    <input type="number" step="0.1" min="0" data-field="carbs_g"   data-i="${i}" value="${it.carbs_g ?? 0}" /></label>
            <label>F (g)    <input type="number" step="0.1" min="0" data-field="fat_g"     data-i="${i}" value="${it.fat_g ?? 0}" /></label>
            <label>Fibre    <input type="number" step="0.1" min="0" data-field="fiber_g"   data-i="${i}" value="${it.fiber_g ?? 0}" /></label>
          </div>
          <div class="smart-item-picker" data-picker-i="${i}" hidden></div>
        </div>
      </li>`;
  }
  function paintSmartResult(data) {
    smartItems = (data?.items || []).map((it) => ({
      name: it.name || "",
      servings: +it.servings || 1,
      calories: +it.calories || 0,
      protein_g: +it.protein_g || 0,
      carbs_g:   +it.carbs_g   || 0,
      fat_g:     +it.fat_g     || 0,
      fiber_g:   +it.fiber_g   || 0,
      keep: true,
    }));
    renderSmartList();
  }
  function renderSmartList() {
    const list = document.getElementById("smart-result-list");
    if (!list) return;
    list.innerHTML = smartItems.length
      ? smartItems.map(smartItemRow).join("")
      : `<li class="smart-empty">No items — tap "＋ Add item" to start.</li>`;
    paintSmartTotals();
  }
  function paintSmartTotals() {
    const t = smartItems.reduce((s, it) => {
      if (it.keep === false) return s;
      const m = +it.servings || 1;
      s.calories  += (+it.calories  || 0) * m;
      s.protein_g += (+it.protein_g || 0) * m;
      s.carbs_g   += (+it.carbs_g   || 0) * m;
      s.fat_g     += (+it.fat_g     || 0) * m;
      s.fiber_g   += (+it.fiber_g   || 0) * m;
      return s;
    }, { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 });
    const r1 = (n) => Math.round(n * 10) / 10;
    document.getElementById("smart-result-totals").innerHTML =
      `<strong>Total:</strong> ${Math.round(t.calories)} kcal · P ${r1(t.protein_g)}g · C ${r1(t.carbs_g)}g · F ${r1(t.fat_g)}g · Fibre ${r1(t.fiber_g)}g`;
  }

  // Field edits + checkbox toggles + remove + replace + add-item — all
  // wired via delegation off the result list so re-renders don't lose
  // listeners.
  document.getElementById("smart-result-list")?.addEventListener("input", (e) => {
    const inp = e.target;
    const i = +inp.dataset?.i;
    const field = inp.dataset?.field;
    if (Number.isFinite(i) && field && smartItems[i]) {
      smartItems[i][field] = field === "name" ? inp.value : (+inp.value || 0);
      paintSmartTotals();
    }
  });
  document.getElementById("smart-result-list")?.addEventListener("change", (e) => {
    const cb = e.target.closest("[data-keep]");
    if (!cb) return;
    const i = +cb.dataset.keep;
    if (smartItems[i]) { smartItems[i].keep = cb.checked; paintSmartTotals(); }
  });
  document.getElementById("smart-result-list")?.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove-i]");
    if (rm) {
      const i = +rm.dataset.removeI;
      smartItems.splice(i, 1);
      renderSmartList();
      return;
    }
    const rep = e.target.closest("[data-replace-i]");
    if (rep) {
      const i = +rep.dataset.replaceI;
      toggleReplacePicker(i);
      return;
    }
  });
  document.getElementById("smart-add-item-btn")?.addEventListener("click", () => {
    smartItems.push({ name: "", servings: 1, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, keep: true });
    renderSmartList();
    // Auto-open the picker on the new row so the user immediately gets
    // an autocomplete against the food DB.
    setTimeout(() => toggleReplacePicker(smartItems.length - 1, ""), 30);
  });

  // ----- Replace / pick a food from the curated DB --------------------
  async function toggleReplacePicker(i, initialQuery) {
    const wrap = document.querySelector(`[data-picker-i="${i}"]`);
    if (!wrap) return;
    if (!wrap.hidden && initialQuery == null) { wrap.hidden = true; wrap.innerHTML = ""; return; }
    const seed = initialQuery != null ? initialQuery : (smartItems[i]?.name || "");
    wrap.hidden = false;
    wrap.innerHTML = `
      <div class="smart-picker">
        <input type="text" class="smart-picker-input" placeholder="Search foods (e.g. wholemeal, sourdough, tomato sauce)…" value="${escapeAttr(seed)}" />
        <ul class="smart-picker-list"><li class="smart-empty">Type to search the food database…</li></ul>
      </div>`;
    const input = wrap.querySelector("input");
    const list  = wrap.querySelector(".smart-picker-list");
    let token = 0;
    const runSearch = async () => {
      const q = input.value.trim();
      const mine = ++token;
      list.innerHTML = `<li class="smart-empty">Searching…</li>`;
      try {
        const data = await fetchJson(`/api/me/foods/search?q=${encodeURIComponent(q)}`);
        if (mine !== token) return;
        const items = data?.items || [];
        if (!items.length) {
          list.innerHTML = `<li class="smart-empty">No matches. Type a different keyword.</li>`;
          return;
        }
        list.innerHTML = items.map((f) => `
          <li>
            <button type="button" class="smart-picker-row" data-food-id="${f.id}">
              <strong>${escapeHtml(f.name)}</strong>
              <span class="smart-picker-meta">${escapeHtml(f.serving_size || "")} · ${f.calories} kcal · P ${f.protein_g}g · C ${f.carbs_g}g · F ${f.fat_g}g</span>
              ${f.category ? `<span class="smart-picker-cat">${escapeHtml(f.category)}</span>` : ""}
            </button>
          </li>`).join("");
        list.querySelectorAll("[data-food-id]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const food = items.find((x) => x.id === +btn.dataset.foodId);
            if (!food) return;
            smartItems[i] = {
              ...smartItems[i],
              name: food.name + (food.serving_size ? ` · ${food.serving_size}` : ""),
              calories: food.calories,
              protein_g: food.protein_g,
              carbs_g: food.carbs_g,
              fat_g: food.fat_g,
              fiber_g: food.fiber_g,
              keep: true,
            };
            renderSmartList();
          });
        });
      } catch (err) {
        if (mine !== token) return;
        list.innerHTML = `<li class="smart-empty">Couldn't search. ${escapeHtml(err.message || "")}</li>`;
      }
    };
    const debounced = (() => {
      let h = null;
      return () => { clearTimeout(h); h = setTimeout(runSearch, 120); };
    })();
    input.addEventListener("input", debounced);
    if (seed) runSearch();
    else input.focus();
  }
  function escapeAttr(s) {
    return String(s ?? "").replace(/"/g, "&quot;").replace(/&/g, "&amp;");
  }
  document.getElementById("smart-log-save-btn")?.addEventListener("click", async () => {
    const mealEl = document.querySelector('#smart-meal-pick button.on');
    const meal = mealEl?.dataset.val || "snack";
    const btn = document.getElementById("smart-log-save-btn");
    btn.disabled = true; btn.textContent = "Saving…";
    // Save every item the user kept ticked, using their (possibly edited)
    // name + macros. Drops empty-name rows so an accidental "+ Add" doesn't
    // create a blank food log.
    const keep = smartItems
      .filter((it) => it.keep !== false && (it.name || "").trim())
      .map((it) => ({
        name: it.name.trim(),
        servings:  +it.servings  || 1,
        calories:  +it.calories  || 0,
        protein_g: +it.protein_g || 0,
        carbs_g:   +it.carbs_g   || 0,
        fat_g:     +it.fat_g     || 0,
        fiber_g:   +it.fiber_g   || 0,
      }));
    if (!keep.length) { toast("Nothing selected", "err"); btn.disabled = false; btn.textContent = "Save all to diary"; return; }
    try {
      await Promise.all(keep.map((it) => fetchJson("/api/me/food-logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: it.name, meal,
          calories: it.calories, proteinG: it.protein_g, carbsG: it.carbs_g,
          fatG: it.fat_g, fiberG: it.fiber_g, servings: it.servings,
        }),
      })));
      toast(`${keep.length} item${keep.length === 1 ? "" : "s"} logged ✨`);
      smartModal.classList.remove("open");
      document.body.classList.remove("modal-open");
      paintToday();
    } catch (err) {
      toast(err.message || "Couldn't save", "err");
    } finally {
      btn.disabled = false; btn.textContent = "Save all to diary";
    }
  });
  // Chip toggle on meal pick
  document.getElementById("smart-meal-pick")?.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    document.querySelectorAll("#smart-meal-pick button").forEach((x) => x.classList.toggle("on", x === b));
  });
  function openLogModal({ foodId = null, meal = null } = {}) {
    const form = document.getElementById("food-log-form");
    form.reset();
    form.servings.value = 1;
    if (foodId) form.picker.value = String(foodId);
    if (meal)   form.meal.value = meal;
    document.getElementById("flog-status").textContent = "";
    logModal.classList.add("open"); logModal.setAttribute("aria-hidden", "false");
  }
  document.getElementById("food-log-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const pickerId = form.picker.value;
    const freeName = form.name.value.trim();
    if (!pickerId && !freeName) {
      document.getElementById("flog-status").textContent = "Pick a food or type a name.";
      document.getElementById("flog-status").className = "form-status err";
      return;
    }
    const body = {
      foodId: pickerId ? +pickerId : null,
      name: freeName || (foods.find((f) => f.id === +pickerId)?.name) || "Food",
      meal: form.meal.value,
      servings: +form.servings.value || 1,
      calories: form.calories.value || null,
      proteinG: form.proteinG.value || null,
      carbsG: form.carbsG.value || null,
      fatG: form.fatG.value || null,
    };
    const status = document.getElementById("flog-status");
    status.textContent = "Saving…"; status.className = "form-status";
    try {
      await fetchJson("/api/me/food-logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      toast("Logged ✨", "ok");
      logModal.classList.remove("open"); logModal.setAttribute("aria-hidden", "true");
      await loadAll();
    } catch (err) {
      status.textContent = err.message || "Couldn't save."; status.className = "form-status err";
    }
  });
  async function deleteLog(id) {
    try { await fetchJson(`/api/me/food-logs/${id}`, { method: "DELETE" }); await loadAll(); }
    catch (err) { toast(err.message || "Couldn't delete", "err"); }
  }

  // --- Plan add / delete ----------------------------------------------
  function promptAddPlan(dayBit) {
    if (!foods.length) {
      toast("Add a food first, then plan it.", "err");
      const tab = document.querySelector("[data-tab-target='foods']");
      if (tab) tab.click();
      return;
    }
    const food = window.prompt("Type the name of a saved food to plan for this day:\n\n" +
                               foods.map((f) => `• ${f.name}`).join("\n"), foods[0].name);
    if (!food) return;
    const match = foods.find((f) => f.name.toLowerCase() === food.toLowerCase());
    if (!match) { toast("No saved food with that name", "err"); return; }
    const meal = window.prompt("Meal? breakfast / lunch / dinner / snack", "breakfast");
    if (!meal) return;
    addPlan(match.id, meal.toLowerCase(), dayBit, 1);
  }
  async function addPlan(foodId, meal, daysMask, servings) {
    try {
      await fetchJson("/api/me/food-plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ foodId, meal, daysMask, servings }),
      });
      toast("Plan added", "ok");
      await loadAll();
    } catch (err) { toast(err.message || "Couldn't add", "err"); }
  }
  async function deletePlan(id) {
    try { await fetchJson(`/api/me/food-plans/${id}`, { method: "DELETE" }); await loadAll(); }
    catch (err) { toast(err.message || "Couldn't remove", "err"); }
  }

  // --- Settings form ---------------------------------------------------
  function paintPrefsForm() {
    const form = document.getElementById("food-prefs-form");
    if (!form) return;
    form.dailyCalorieTarget.value = prefs.dailyCalorieTarget || 2000;
    form.proteinTargetG.value = prefs.proteinTargetG ?? "";
    form.carbsTargetG.value = prefs.carbsTargetG ?? "";
    form.fatTargetG.value = prefs.fatTargetG ?? "";
  }
  document.getElementById("food-prefs-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const body = {
      dailyCalorieTarget: +form.dailyCalorieTarget.value,
      proteinTargetG: form.proteinTargetG.value || null,
      carbsTargetG: form.carbsTargetG.value || null,
      fatTargetG: form.fatTargetG.value || null,
    };
    const status = document.getElementById("food-prefs-status");
    status.textContent = "Saving…"; status.className = "form-status";
    try {
      const r = await fetchJson("/api/me/food-prefs", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      prefs = r; status.textContent = "Saved."; status.className = "form-status ok";
      toast("Targets saved", "ok");
      paintToday(); paintRightRail([]);
    } catch (err) {
      status.textContent = err.message || "Couldn't save."; status.className = "form-status err";
    }
  });

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
    return String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&#39;" })[c]);
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
