// /recipes — community cookbook. Posts, hearts, thumbs-down with a required
// useful comment, category filtering, fuzzy search, and a shared food library
// that the future food tracker will also lean on.
console.info("EndoMe recipes build v1");

(() => {
  // Static fallback categories. Server also returns the canonical list at
  // /api/me/recipe-categories so the modal stays in sync if it ever changes.
  const FALLBACK_CATEGORIES = [
    { id: "breakfast",   label: "Breakfast",     emoji: "🥣" },
    { id: "lunch",       label: "Lunch",         emoji: "🥗" },
    { id: "dinner",      label: "Dinner",        emoji: "🍽" },
    { id: "family_meal", label: "Family meals",  emoji: "👨‍👩‍👧" },
    { id: "quick_fast",  label: "Quick & fast",  emoji: "⚡" },
    { id: "dessert",     label: "Desserts",      emoji: "🍰" },
    { id: "snack",       label: "Snacks",        emoji: "🍪" },
    { id: "drink",       label: "Drinks",        emoji: "🥤" },
    { id: "other",       label: "Other",         emoji: "🍳" },
  ];
  const UNIT_LABEL = {
    g:"g", kg:"kg", mg:"mg", ml:"ml", l:"l", tsp:"tsp", tbsp:"tbsp",
    cup:"cup", piece:"piece", slice:"slice", clove:"clove",
    pinch:"pinch", to_taste:"to taste", stalk:"stalk", bunch:"bunch",
    can:"can", packet:"packet",
  };

  let categories = FALLBACK_CATEGORIES;
  let recipes = [];
  let foods = [];
  let currentCategory = "";
  let currentScope = "all";
  let currentQuery = "";
  let pendingIngredients = [];   // for the post-recipe modal
  let lastFoodLookup = [];       // cache for autocomplete

  const recipeModal = document.getElementById("recipe-modal");
  const detailModal = document.getElementById("recipe-detail-modal");
  const downModal   = document.getElementById("down-comment-modal");
  const foodModal   = document.getElementById("food-modal");

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  (async () => {
    try {
      const me = await fetchJson("/api/me/today");
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = me?.user?.displayName || me?.user?.username || "there";
      });
    } catch {}
    await loadCategories();
    paintCategoryChips();
    populateCategorySelect();
    await Promise.all([loadRecipes(), loadFoods()]);
    document.getElementById("page-loader")?.classList.add("is-hidden");
  })();

  async function loadCategories() {
    try {
      const data = await fetchJson("/api/me/recipe-categories");
      if (Array.isArray(data.categories) && data.categories.length) categories = data.categories;
    } catch {}
  }

  function paintCategoryChips() {
    const wrap = document.getElementById("recipes-categories");
    if (!wrap) return;
    wrap.innerHTML = `<button type="button" class="cat-chip ${!currentCategory ? "on" : ""}" data-cat="">All</button>` +
      categories.map((c) =>
        `<button type="button" class="cat-chip ${currentCategory === c.id ? "on" : ""}" data-cat="${escapeHtml(c.id)}">${escapeHtml(c.emoji)} ${escapeHtml(c.label)}</button>`
      ).join("");
  }
  function populateCategorySelect() {
    const sel = document.getElementById("recipe-category");
    if (!sel) return;
    sel.innerHTML = categories.map((c) =>
      `<option value="${escapeHtml(c.id)}">${escapeHtml(c.emoji)} ${escapeHtml(c.label)}</option>`
    ).join("");
  }

  // ------------------------------------------------------------------
  // Recipes list
  // ------------------------------------------------------------------
  async function loadRecipes() {
    const grid = document.getElementById("recipes-grid");
    grid.innerHTML = `<li class="empty-state">Loading…</li>`;
    const params = new URLSearchParams();
    if (currentCategory) params.set("category", currentCategory);
    if (currentScope === "mine") params.set("scope", "mine");
    if (currentQuery) params.set("q", currentQuery);
    try {
      const data = await fetchJson(`/api/me/recipes?${params.toString()}`);
      recipes = data.recipes || [];
      paintRecipes();
    } catch (err) {
      grid.innerHTML = `<li class="empty-state">${escapeHtml(err.message || "Couldn't load recipes.")}</li>`;
    }
  }

  function paintRecipes() {
    const grid = document.getElementById("recipes-grid");
    if (!recipes.length) {
      grid.innerHTML = `<li class="empty-state recipe-empty">
        <div class="recipe-empty-art">🍳</div>
        <strong>No recipes here yet.</strong>
        <span>${currentScope === "mine" ? "Post your first one — the community will see it." : "Be the first to share what's worked for you. Tap <strong>+ Post a recipe</strong> above."}</span>
      </li>`;
      return;
    }
    grid.innerHTML = recipes.map(recipeCardHtml).join("");
    grid.querySelectorAll("[data-open-recipe]").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest("[data-react]") || e.target.closest("[data-delete-recipe]")) return;
        openRecipeDetail(+el.dataset.openRecipe);
      });
    });
  }

  function recipeCardHtml(r) {
    const cat = categories.find((c) => c.id === r.category) || { emoji: "🍳", label: r.category || "Other" };
    return `<li class="recipe-card" data-open-recipe="${r.id}">
      <header class="recipe-card-head">
        <span class="recipe-cat-pill">${escapeHtml(cat.emoji)} ${escapeHtml(cat.label)}</span>
        ${r.isMine ? `<button class="recipe-delete-btn" data-delete-recipe="${r.id}" title="Remove">×</button>` : ""}
      </header>
      <h3>${escapeHtml(r.title)}</h3>
      ${r.summary ? `<p class="recipe-summary">${escapeHtml(r.summary)}</p>` : ""}
      <div class="recipe-meta">
        ${r.servings ? `<span>🍽 ${r.servings} serv.</span>` : ""}
        ${r.prepMinutes != null ? `<span>⏱ ${r.prepMinutes}m prep</span>` : ""}
        ${r.cookMinutes != null ? `<span>🔥 ${r.cookMinutes}m cook</span>` : ""}
      </div>
      <footer class="recipe-card-foot">
        <span class="recipe-author">by ${escapeHtml(r.author || "Member")}</span>
        <div class="recipe-react">
          <button class="react-chip love ${r.myReaction === "love" ? "on" : ""}" data-react="love" data-id="${r.id}" aria-label="Love">❤ <span>${r.loves}</span></button>
          <button class="react-chip down ${r.myReaction === "down" ? "on" : ""}" data-react="down" data-id="${r.id}" aria-label="Thumbs down">👎 <span>${r.downs}</span></button>
        </div>
      </footer>
    </li>`;
  }

  // ------------------------------------------------------------------
  // Recipe detail modal
  // ------------------------------------------------------------------
  async function openRecipeDetail(id) {
    const body = document.getElementById("recipe-detail-body");
    body.innerHTML = `<p class="empty-state small">Loading…</p>`;
    detailModal.classList.add("open");
    detailModal.setAttribute("aria-hidden", "false");
    try {
      const data = await fetchJson(`/api/me/recipes/${id}`);
      paintRecipeDetail(data.recipe);
    } catch (err) {
      body.innerHTML = `<p class="empty-state small">${escapeHtml(err.message || "Couldn't load.")}</p>`;
    }
  }

  function paintRecipeDetail(r) {
    const body = document.getElementById("recipe-detail-body");
    const cat = categories.find((c) => c.id === r.category) || { emoji: "🍳", label: r.category || "Other" };
    body.innerHTML = `
      <header class="recipe-detail-head">
        <p class="recipe-detail-eyebrow">${escapeHtml(cat.emoji)} ${escapeHtml(cat.label)} · by ${escapeHtml(r.author || "Member")}</p>
        <h2>${escapeHtml(r.title)}</h2>
        ${r.summary ? `<p class="recipe-detail-summary">${escapeHtml(r.summary)}</p>` : ""}
        <div class="recipe-detail-meta">
          ${r.servings ? `<span>🍽 ${r.servings} servings</span>` : ""}
          ${r.prepMinutes != null ? `<span>⏱ ${r.prepMinutes}m prep</span>` : ""}
          ${r.cookMinutes != null ? `<span>🔥 ${r.cookMinutes}m cook</span>` : ""}
        </div>
      </header>

      <section class="recipe-detail-section">
        <h3>Ingredients</h3>
        <ul class="recipe-detail-ings">
          ${(r.ingredients || []).map((i) => `<li>
            <span class="ing-qty">${i.quantity != null ? escapeHtml(formatQty(i.quantity)) : ""}${i.unit ? " " + escapeHtml(UNIT_LABEL[i.unit] || i.unit) : ""}</span>
            <span class="ing-name">${escapeHtml(i.foodName)}</span>
            ${i.notes ? `<span class="ing-note">${escapeHtml(i.notes)}</span>` : ""}
          </li>`).join("") || `<li class="empty-state small">No ingredients listed.</li>`}
        </ul>
      </section>

      ${r.body ? `<section class="recipe-detail-section">
        <h3>Method</h3>
        <div class="recipe-body">${escapeHtml(r.body).replace(/\n/g, "<br>")}</div>
      </section>` : ""}

      <section class="recipe-detail-section recipe-detail-react">
        <h3>What the community says</h3>
        <div class="recipe-react large">
          <button class="react-chip love ${r.myReaction === "love" ? "on" : ""}" data-detail-react="love" data-id="${r.id}">❤ Love it <span>${r.loves}</span></button>
          <button class="react-chip down ${r.myReaction === "down" ? "on" : ""}" data-detail-react="down" data-id="${r.id}">👎 Didn't work <span>${r.downs}</span></button>
        </div>
        ${r.downComments && r.downComments.length ? `
          <h4 class="down-comments-head">Constructive feedback</h4>
          <ul class="down-comments-list">
            ${r.downComments.map((c) => `<li>
              <span class="down-comment-text">"${escapeHtml(c.comment)}"</span>
              <span class="down-comment-date">${relTime(c.createdAt)}</span>
            </li>`).join("")}
          </ul>` : ""}
      </section>
    `;
  }

  function formatQty(q) {
    if (q == null) return "";
    if (Number.isInteger(q)) return String(q);
    return String(Math.round(q * 100) / 100);
  }

  // ------------------------------------------------------------------
  // Toolbar wiring
  // ------------------------------------------------------------------
  document.getElementById("recipes-categories").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-cat]");
    if (!chip) return;
    currentCategory = chip.dataset.cat;
    paintCategoryChips();
    loadRecipes();
  });

  document.querySelector(".recipes-scope").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-scope]");
    if (!chip) return;
    currentScope = chip.dataset.scope;
    document.querySelectorAll(".scope-chip").forEach((b) => b.classList.toggle("on", b === chip));
    loadRecipes();
  });

  let searchTimer = null;
  document.getElementById("recipes-search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => {
      currentQuery = v.trim();
      loadRecipes();
    }, 220);
  });

  // ------------------------------------------------------------------
  // Post a recipe
  // ------------------------------------------------------------------
  document.getElementById("btn-add-recipe").addEventListener("click", () => openRecipeModal());

  function openRecipeModal() {
    document.getElementById("recipe-form").reset();
    pendingIngredients = [];
    paintIngredientList();
    document.getElementById("recipe-status").textContent = "";
    recipeModal.classList.add("open");
    recipeModal.setAttribute("aria-hidden", "false");
  }
  function closeRecipeModal() {
    recipeModal.classList.remove("open");
    recipeModal.setAttribute("aria-hidden", "true");
  }
  function closeDetailModal() {
    detailModal.classList.remove("open");
    detailModal.setAttribute("aria-hidden", "true");
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-recipe]")) {
      e.preventDefault(); closeRecipeModal(); closeDetailModal(); return;
    }
    if (e.target.closest("[data-close-down]")) {
      e.preventDefault();
      downModal.classList.remove("open"); downModal.setAttribute("aria-hidden", "true");
      return;
    }
    if (e.target.closest("[data-close-food]")) {
      e.preventDefault();
      foodModal.classList.remove("open"); foodModal.setAttribute("aria-hidden", "true");
      return;
    }
  });

  // ------------------------------------------------------------------
  // Ingredient editor
  // ------------------------------------------------------------------
  function paintIngredientList() {
    const list = document.getElementById("ingredient-list");
    if (!pendingIngredients.length) {
      list.innerHTML = `<li class="ingredient-empty">No ingredients yet. Add the first one below.</li>`;
      return;
    }
    list.innerHTML = pendingIngredients.map((i, idx) => `
      <li class="ingredient-row">
        <span class="ing-qty">${i.quantity != null ? escapeHtml(formatQty(i.quantity)) : ""}${i.unit ? " " + escapeHtml(UNIT_LABEL[i.unit] || i.unit) : ""}</span>
        <span class="ing-name">${escapeHtml(i.foodName)}</span>
        ${i.notes ? `<span class="ing-note">${escapeHtml(i.notes)}</span>` : ""}
        <button type="button" class="btn-soft small danger" data-del-ing="${idx}">Remove</button>
      </li>`).join("");
    list.querySelectorAll("[data-del-ing]").forEach((b) => {
      b.addEventListener("click", () => {
        pendingIngredients.splice(+b.dataset.delIng, 1);
        paintIngredientList();
      });
    });
  }

  document.getElementById("ingredient-add-btn").addEventListener("click", () => {
    const name = document.getElementById("ingredient-name").value.trim();
    const qtyRaw = document.getElementById("ingredient-qty").value;
    const unit = document.getElementById("ingredient-unit").value || null;
    const notes = document.getElementById("ingredient-notes").value.trim() || null;
    const status = document.getElementById("ingredient-status");
    status.textContent = ""; status.className = "form-status";
    if (!name) { status.textContent = "Pick or type a food."; status.className = "form-status err"; return; }
    const match = lastFoodLookup.find((f) => f.name.toLowerCase() === name.toLowerCase());
    pendingIngredients.push({
      foodId: match?.id || null,
      foodName: name,
      quantity: qtyRaw === "" ? null : +qtyRaw,
      unit,
      notes,
    });
    paintIngredientList();
    document.getElementById("ingredient-name").value = "";
    document.getElementById("ingredient-qty").value = "";
    document.getElementById("ingredient-unit").value = "";
    document.getElementById("ingredient-notes").value = "";
    document.getElementById("food-autocomplete").hidden = true;
    document.getElementById("ingredient-name").focus();
  });

  // Food autocomplete inside the ingredient editor
  const ingNameInput = document.getElementById("ingredient-name");
  const foodAc = document.getElementById("food-autocomplete");
  let foodAcHover = -1;
  ingNameInput.addEventListener("input", () => paintFoodAutocomplete(ingNameInput.value.trim()));
  ingNameInput.addEventListener("focus", () => paintFoodAutocomplete(ingNameInput.value.trim()));
  ingNameInput.addEventListener("keydown", (e) => {
    if (foodAc.hidden) return;
    const items = foodAc.querySelectorAll("li");
    if (e.key === "ArrowDown") { e.preventDefault(); foodAcHover = Math.min(items.length - 1, foodAcHover + 1); items.forEach((it, i) => it.classList.toggle("is-hover", i === foodAcHover)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); foodAcHover = Math.max(0, foodAcHover - 1); items.forEach((it, i) => it.classList.toggle("is-hover", i === foodAcHover)); }
    else if (e.key === "Enter" && foodAcHover >= 0) { e.preventDefault(); items[foodAcHover]?.click(); }
    else if (e.key === "Escape") { foodAc.hidden = true; }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".food-autocomplete-wrap")) foodAc.hidden = true;
  });

  function paintFoodAutocomplete(q) {
    const ql = q.toLowerCase();
    if (!ql) { foodAc.hidden = true; return; }
    const matches = foods
      .map((f) => ({ f, score: scoreFood(f, ql) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.f);
    lastFoodLookup = matches;
    foodAcHover = -1;
    if (!matches.length) { foodAc.hidden = true; return; }
    foodAc.innerHTML = matches.map((m) => `
      <li data-name="${escapeHtml(m.name)}" data-id="${m.id}" data-unit="${escapeHtml(m.defaultUnit || "")}">
        <span class="ac-name">${escapeHtml(m.name)}</span>
        <span class="ac-meta">${escapeHtml(m.category || "")}${m.defaultUnit ? " · " + escapeHtml(UNIT_LABEL[m.defaultUnit] || m.defaultUnit) : ""}</span>
      </li>`).join("");
    foodAc.querySelectorAll("li").forEach((li) => {
      li.addEventListener("click", () => {
        ingNameInput.value = li.dataset.name;
        if (li.dataset.unit && !document.getElementById("ingredient-unit").value) {
          document.getElementById("ingredient-unit").value = li.dataset.unit;
        }
        foodAc.hidden = true;
        document.getElementById("ingredient-qty").focus();
      });
    });
    foodAc.hidden = false;
  }
  function scoreFood(f, ql) {
    const n = (f.name || "").toLowerCase();
    if (n === ql) return 100;
    if (n.startsWith(ql)) return 70;
    if (n.includes(ql)) return 40;
    return 0;
  }

  // Submit a new recipe
  document.getElementById("recipe-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const status = document.getElementById("recipe-status");
    status.textContent = "Saving…"; status.className = "form-status";
    if (!pendingIngredients.length) {
      status.textContent = "Add at least one ingredient."; status.className = "form-status err"; return;
    }
    try {
      const body = {
        title: form.title.value.trim(),
        category: form.category.value,
        summary: form.summary.value.trim() || null,
        body: form.body.value.trim() || null,
        servings: form.servings.value || null,
        prepMinutes: form.prepMinutes.value || null,
        cookMinutes: form.cookMinutes.value || null,
        ingredients: pendingIngredients,
      };
      await fetchJson("/api/me/recipes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      toast("Recipe posted ✨", "ok");
      closeRecipeModal();
      await loadRecipes();
    } catch (err) {
      status.textContent = err.message || "Couldn't save."; status.className = "form-status err";
    }
  });

  // ------------------------------------------------------------------
  // Reactions
  // ------------------------------------------------------------------
  document.addEventListener("click", async (e) => {
    const card = e.target.closest("[data-react]");
    const inDetail = e.target.closest("[data-detail-react]");
    const target = card || inDetail;
    if (!target) return;
    const id = +target.dataset.id;
    const wanted = (card?.dataset.react || inDetail?.dataset.detailReact);
    const already = target.classList.contains("on");
    if (wanted === "down") {
      if (already) {
        // Toggle off → clear vote.
        await sendReaction(id, null);
      } else {
        openDownComment(id);
      }
      return;
    }
    if (wanted === "love") {
      await sendReaction(id, already ? null : "love");
    }
  });

  async function sendReaction(id, reaction, comment) {
    try {
      const res = await fetchJson(`/api/me/recipes/${id}/react`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reaction, comment }),
      });
      // Update the matching card in place
      const r = recipes.find((x) => x.id === id);
      if (r) {
        r.myReaction = res.reaction;
        if (res.loves != null) r.loves = res.loves;
        if (res.downs != null) r.downs = res.downs;
        paintRecipes();
      }
      if (detailModal.classList.contains("open")) {
        await openRecipeDetail(id);
      }
      if (reaction === "down") toast("Feedback sent to moderation", "ok");
      else if (reaction === "love") toast("Loved ❤", "ok");
      else toast("Vote cleared", "ok");
    } catch (err) {
      toast(err.message || "Couldn't save reaction", "err");
      // If the server forced us to provide a comment, re-open the prompt.
      if (reaction === "down") openDownComment(id);
    }
  }

  function openDownComment(id) {
    const form = document.getElementById("down-comment-form");
    form.reset();
    form.recipeId.value = id;
    document.getElementById("down-comment-status").textContent = "";
    downModal.classList.add("open");
    downModal.setAttribute("aria-hidden", "false");
  }
  document.getElementById("down-comment-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const id = +form.recipeId.value;
    const comment = form.comment.value.trim();
    const status = document.getElementById("down-comment-status");
    status.textContent = ""; status.className = "form-status";
    if (comment.length < 10) {
      status.textContent = "At least 10 characters — be useful."; status.className = "form-status err"; return;
    }
    try {
      await fetchJson(`/api/me/recipes/${id}/react`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reaction: "down", comment }),
      });
      downModal.classList.remove("open");
      downModal.setAttribute("aria-hidden", "true");
      toast("Feedback sent — thank you", "ok");
      await loadRecipes();
      if (detailModal.classList.contains("open")) await openRecipeDetail(id);
    } catch (err) {
      status.textContent = err.message || "Couldn't save."; status.className = "form-status err";
    }
  });

  // Recipe delete (owner only)
  document.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-delete-recipe]");
    if (!del) return;
    e.stopPropagation();
    if (!confirm("Remove this recipe? This can't be undone.")) return;
    try {
      await fetchJson(`/api/me/recipes/${del.dataset.deleteRecipe}`, { method: "DELETE" });
      toast("Recipe removed", "ok");
      await loadRecipes();
    } catch (err) { toast(err.message || "Couldn't remove", "err"); }
  });

  // ------------------------------------------------------------------
  // Food library
  // ------------------------------------------------------------------
  async function loadFoods() {
    try {
      const data = await fetchJson("/api/me/recipe-foods");
      foods = data.foods || [];
      paintFoods();
    } catch {
      document.getElementById("food-library-grid").innerHTML =
        `<li class="empty-state">Couldn't load foods.</li>`;
    }
  }
  function paintFoods() {
    const grid = document.getElementById("food-library-grid");
    const q = (document.getElementById("food-library-search").value || "").trim().toLowerCase();
    let items = foods;
    if (q) items = items.filter((f) => f.name.toLowerCase().includes(q) || (f.category || "").includes(q));
    items = items.slice(0, 240);
    if (!items.length) {
      grid.innerHTML = `<li class="empty-state">Nothing matches. Add a new food →</li>`;
      return;
    }
    grid.innerHTML = items.map((f) => `
      <li class="food-pill">
        <span class="food-cat-dot food-cat-${escapeHtml(f.category || "other")}"></span>
        <strong>${escapeHtml(f.name)}</strong>
        <span class="food-pill-unit">${f.defaultUnit ? escapeHtml(UNIT_LABEL[f.defaultUnit] || f.defaultUnit) : ""}</span>
      </li>`).join("");
  }
  document.getElementById("food-library-search").addEventListener("input", () => paintFoods());

  document.getElementById("btn-add-food").addEventListener("click", () => {
    document.getElementById("food-form").reset();
    document.getElementById("food-status").textContent = "";
    foodModal.classList.add("open");
    foodModal.setAttribute("aria-hidden", "false");
  });
  document.getElementById("food-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const status = document.getElementById("food-status");
    status.textContent = "Saving…"; status.className = "form-status";
    try {
      await fetchJson("/api/me/recipe-foods", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.name.value.trim(),
          category: form.category.value,
          defaultUnit: form.defaultUnit.value,
          notes: form.notes.value.trim() || null,
        }),
      });
      foodModal.classList.remove("open");
      foodModal.setAttribute("aria-hidden", "true");
      toast("Food added ✨", "ok");
      await loadFoods();
    } catch (err) {
      status.textContent = err.message || "Couldn't save."; status.className = "form-status err";
    }
  });

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
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
  function relTime(unixSec) {
    if (!unixSec) return "";
    const diff = Math.floor(Date.now() / 1000) - unixSec;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
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
