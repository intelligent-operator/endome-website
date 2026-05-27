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
  let pendingMethodSteps = [];   // for the step-list editor
  let lastFoodLookup = [];       // cache for autocomplete
  let editingId = null;          // null = new recipe; otherwise recipe id
  let pendingPhotoFile = null;   // File chosen for upload on next save
  let pendingPhotoPreviewUrl = null; // object-url for the in-modal preview

  // -- Fraction helpers --------------------------------------------------
  // Common fraction strings (and the unicode variants) → decimal value.
  // Lets users type "1/4", "1 1/2", "½", "1½" and get back a number.
  const UNICODE_FRACTIONS = {
    "¼":0.25, "½":0.5, "¾":0.75, "⅓":1/3, "⅔":2/3,
    "⅕":0.2, "⅖":0.4, "⅗":0.6, "⅘":0.8,
    "⅙":1/6, "⅚":5/6, "⅛":0.125, "⅜":0.375, "⅝":0.625, "⅞":0.875,
  };
  // Parse a string into a decimal (rounded to 4dp). Returns null if blank,
  // or NaN if it can't be parsed at all.
  function parseQty(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    // Unicode fraction in the string: split on it and add the leading whole.
    // Handles both "1½" and "1 ½" without parsing "1 0.5" as a single number.
    for (const [u, v] of Object.entries(UNICODE_FRACTIONS)) {
      if (s.includes(u)) {
        const wholePart = s.split(u)[0].trim();
        const whole = wholePart === "" ? 0 : Number(wholePart);
        if (!Number.isFinite(whole)) return NaN;
        return round4((whole < 0 ? -1 : 1) * (Math.abs(whole) + v));
      }
    }
    // ASCII mixed "1 1/2"
    const mixed = s.match(/^(-?\d+)\s+(\d+)\s*\/\s*(\d+)$/);
    if (mixed) {
      const whole = +mixed[1], num = +mixed[2], den = +mixed[3];
      if (!den) return NaN;
      return round4((Math.sign(whole) || 1) * (Math.abs(whole) + num / den));
    }
    // ASCII fraction "1/4"
    const frac = s.match(/^(-?\d+)\s*\/\s*(\d+)$/);
    if (frac) {
      const num = +frac[1], den = +frac[2];
      if (!den) return NaN;
      return round4(num / den);
    }
    // Decimal / integer.
    const n = Number(s);
    if (!Number.isFinite(n)) return NaN;
    return round4(n);
  }
  function round4(n) { return Math.round(n * 10000) / 10000; }

  // Decimal → display string, preferring fractions where they're close to a
  // common one. Mixed numbers are written as "1 ½" with a thin space.
  const FRACTION_GLYPH = {
    "0.25":"¼", "0.5":"½", "0.75":"¾",
    "0.3333":"⅓", "0.6667":"⅔",
    "0.2":"⅕", "0.4":"⅖", "0.6":"⅗", "0.8":"⅘",
    "0.1667":"⅙", "0.8333":"⅚",
    "0.125":"⅛", "0.375":"⅜", "0.625":"⅝", "0.875":"⅞",
  };
  // Tiny inline avatar badge for the recipe card + detail header. Uploaded
  // photo wins; otherwise the emoji avatar; otherwise nothing (the name
  // alone carries the byline).
  function authorBadge(r) {
    if (r.authorAvatarUrl) {
      return `<span class="recipe-author-pic"><img src="${escapeHtml(r.authorAvatarUrl)}" alt="" /></span>`;
    }
    if (r.authorAvatar) {
      return `<span class="recipe-author-pic emoji">${escapeHtml(r.authorAvatar)}</span>`;
    }
    return "";
  }

  function formatQty(q) {
    if (q == null) return "";
    if (!Number.isFinite(q)) return "";
    const sign = q < 0 ? "-" : "";
    const abs = Math.abs(q);
    const whole = Math.floor(abs);
    const frac = round4(abs - whole);
    if (frac < 1e-4) return sign + String(whole);
    // Try to match a glyph fraction within tolerance.
    const key = frac.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    const glyph = FRACTION_GLYPH[key] || FRACTION_GLYPH[frac.toFixed(4)] ||
      Object.entries(FRACTION_GLYPH).find(([k]) => Math.abs(+k - frac) < 0.01)?.[1];
    if (glyph) return whole ? `${sign}${whole} ${glyph}` : `${sign}${glyph}`;
    // Fallback: short decimal.
    return sign + (Math.round(abs * 100) / 100).toString();
  }

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
    await Promise.all([loadRecipes(), loadFoods(), loadTopRecipes()]);
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
        if (e.target.closest("[data-react]") || e.target.closest("[data-edit-recipe]")) return;
        openRecipeDetail(+el.dataset.openRecipe);
      });
    });
    // Owner-only edit button on cards → fetch full recipe (with ingredients)
    // then open the modal in edit mode.
    grid.querySelectorAll("[data-edit-recipe]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          const data = await fetchJson(`/api/me/recipes/${btn.dataset.editRecipe}`);
          if (data.recipe) openRecipeModal(data.recipe);
        } catch (err) { toast(err.message || "Couldn't load recipe", "err"); }
      });
    });
  }

  function recipeCardHtml(r) {
    const cat = categories.find((c) => c.id === r.category) || { emoji: "🍳", label: r.category || "Other" };
    // Photo tile sits on top — full-width hero on the card. Falls back to a
    // gradient + category emoji when there's no upload yet.
    const tile = r.imageUrl
      ? `<div class="recipe-tile" style="background-image:url('${escapeHtml(r.imageUrl)}')"></div>`
      : `<div class="recipe-tile recipe-tile-empty"><span>${escapeHtml(cat.emoji)}</span></div>`;
    return `<li class="recipe-card" data-open-recipe="${r.id}">
      ${tile}
      <div class="recipe-card-body">
        <header class="recipe-card-head">
          <span class="recipe-cat-pill">${escapeHtml(cat.emoji)} ${escapeHtml(cat.label)}</span>
          ${r.isMine ? `<button class="recipe-edit-btn" data-edit-recipe="${r.id}" title="Edit">✎</button>` : ""}
        </header>
        <h3>${escapeHtml(r.title)}</h3>
        ${r.summary ? `<p class="recipe-summary">${escapeHtml(r.summary)}</p>` : ""}
        <div class="recipe-meta">
          ${r.servings ? `<span>🍽 ${r.servings} serv.</span>` : ""}
          ${r.prepMinutes != null ? `<span>⏱ ${r.prepMinutes}m prep</span>` : ""}
          ${r.cookMinutes != null ? `<span>🔥 ${r.cookMinutes}m cook</span>` : ""}
        </div>
        <footer class="recipe-card-foot">
          <span class="recipe-author">${authorBadge(r)} by ${escapeHtml(r.author || "Member")}</span>
          <div class="recipe-react">
            <button class="react-chip love ${r.myReaction === "love" ? "on" : ""}" data-react="love" data-id="${r.id}" aria-label="Love">❤ <span>${r.loves}</span></button>
            <button class="react-chip down ${r.myReaction === "down" ? "on" : ""}" data-react="down" data-id="${r.id}" aria-label="Thumbs down">👎 <span>${r.downs}</span></button>
          </div>
        </footer>
      </div>
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
    const hero = r.imageUrl
      ? `<div class="recipe-detail-hero" style="background-image:url('${escapeHtml(r.imageUrl)}')"></div>`
      : "";
    // Owner CTA: floats over the hero photo (top-right) when there's a
    // hero, otherwise sits inline next to the meta row. Either way, it
    // stays on-brand and aligned with the page's pink palette.
    const ownerControls = r.isMine
      ? `<button type="button" class="btn recipe-edit-cta" data-detail-edit="${r.id}">✎ Edit recipe</button>`
      : "";
    body.innerHTML = `
      ${hero ? `<div class="recipe-detail-hero-wrap">${hero}${ownerControls && hero ? `<div class="recipe-detail-owner-actions">${ownerControls}</div>` : ""}</div>` : ""}
      <header class="recipe-detail-head">
        ${!hero && ownerControls ? `<div class="recipe-detail-owner-inline">${ownerControls}</div>` : ""}
        <p class="recipe-detail-eyebrow">${escapeHtml(cat.emoji)} ${escapeHtml(cat.label)} · ${authorBadge(r)} by ${escapeHtml(r.author || "Member")}</p>
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
    // Owner "Edit" button inside the detail modal → close detail, open edit.
    body.querySelectorAll("[data-detail-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        closeDetailModal();
        openRecipeModal(r);
      });
    });
  }

  // ------------------------------------------------------------------
  // Top recipes sidebar
  // ------------------------------------------------------------------
  async function loadTopRecipes() {
    const list = document.getElementById("top-recipes-list");
    if (!list) return;
    try {
      const data = await fetchJson("/api/me/recipes/top");
      const items = data.recipes || [];
      if (!items.length) {
        list.innerHTML = `<li class="top-recipes-empty">
          <span class="top-recipes-empty-art">🍳</span>
          <span>Once people start hearting recipes, the top picks land here.</span>
        </li>`;
        return;
      }
      list.innerHTML = items.map((r) => {
        const cat = categories.find((c) => c.id === r.category) || { emoji: "🍳", label: r.category || "Other" };
        const tile = r.imageUrl
          ? `<div class="top-recipe-tile" style="background-image:url('${escapeHtml(r.imageUrl)}')"></div>`
          : `<div class="top-recipe-tile top-recipe-tile-empty"><span>${escapeHtml(cat.emoji)}</span></div>`;
        return `<li class="top-recipe-row" data-open-recipe="${r.id}">
          ${tile}
          <div class="top-recipe-body">
            <span class="top-recipe-cat">${escapeHtml(cat.emoji)} ${escapeHtml(cat.label)}</span>
            <strong>${escapeHtml(r.title)}</strong>
            <span class="top-recipe-meta">❤ ${r.loves} · by ${escapeHtml(r.author)}</span>
          </div>
        </li>`;
      }).join("");
      list.querySelectorAll("[data-open-recipe]").forEach((el) => {
        el.addEventListener("click", () => openRecipeDetail(+el.dataset.openRecipe));
      });
    } catch {
      list.innerHTML = `<li class="top-recipes-empty">Couldn't load — try refreshing.</li>`;
    }
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

  function openRecipeModal(recipe) {
    const form = document.getElementById("recipe-form");
    form.reset();
    editingId = recipe?.id || null;
    pendingIngredients = recipe?.ingredients ? recipe.ingredients.map((i) => ({ ...i })) : [];
    pendingMethodSteps = recipe?.body ? parseStepsFromBulk(recipe.body) : [];
    pendingPhotoFile = null;
    if (pendingPhotoPreviewUrl) URL.revokeObjectURL(pendingPhotoPreviewUrl);
    pendingPhotoPreviewUrl = null;

    const bulk = document.getElementById("method-bulk-input");
    if (bulk) bulk.value = pendingMethodSteps.join("\n");
    paintIngredientList();
    paintMethodSteps();
    paintPhotoPreview(recipe?.imageUrl || null);

    // Hydrate form fields when editing. The hidden field is named
    // "recipeId" — never "id" — because `form.id` is the form element's own
    // DOM property (the form's id attribute), not the named input. A field
    // called "id" silently no-ops on assignment and gives us a confusing
    // "edit is broken" experience.
    if (recipe) {
      form.recipeId.value = recipe.id;
      form.title.value = recipe.title || "";
      form.category.value = recipe.category || "other";
      form.summary.value = recipe.summary || "";
      form.servings.value = recipe.servings || "";
      form.prepMinutes.value = recipe.prepMinutes ?? "";
      form.cookMinutes.value = recipe.cookMinutes ?? "";
    } else {
      form.recipeId.value = "";
    }

    document.querySelector("#recipe-modal .modal-h h3").textContent =
      recipe ? "Edit your recipe" : "Post a recipe";
    document.getElementById("recipe-submit").textContent =
      recipe ? "Save changes" : "Publish recipe";
    document.getElementById("recipe-delete-btn").hidden = !recipe;
    document.getElementById("recipe-status").textContent = "";
    document.getElementById("recipe-photo-status").textContent = "";
    recipeModal.classList.add("open");
    recipeModal.setAttribute("aria-hidden", "false");
    setTimeout(() => form.title?.focus(), 80);
  }

  function paintPhotoPreview(url) {
    const preview = document.getElementById("recipe-photo-preview");
    const removeBtn = document.getElementById("recipe-photo-remove");
    if (url) {
      preview.style.backgroundImage = `url("${url}")`;
      preview.classList.add("has-image");
      preview.textContent = "";
      removeBtn.hidden = false;
    } else {
      preview.style.backgroundImage = "";
      preview.classList.remove("has-image");
      preview.textContent = "📷";
      removeBtn.hidden = true;
    }
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
  // Stepper buttons for servings / prep / cook
  // ------------------------------------------------------------------
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".stepper-btn");
    if (!btn) return;
    const name = btn.dataset.step;
    const delta = +btn.dataset.delta;
    const input = document.querySelector(`#recipe-form [name='${name}']`);
    if (!input) return;
    const min = input.min ? +input.min : 0;
    const max = input.max ? +input.max : 9999;
    const current = input.value === "" ? (name === "servings" ? 1 : 0) : (+input.value || 0);
    const next = Math.max(min, Math.min(max, current + delta));
    input.value = next;
  });

  // ------------------------------------------------------------------
  // Method editor — single textarea (one step per line). Steps parse live
  // as the user types/pastes; the rendered preview list below supports
  // edit, remove and drag-to-reorder. No per-step "add" loop.
  // ------------------------------------------------------------------
  function paintMethodSteps() {
    const list = document.getElementById("method-step-list");
    if (!list) return;
    if (!pendingMethodSteps.length) {
      list.innerHTML = `<li class="method-empty">Steps will appear here. Drag to reorder, ✏️ to edit, × to remove.</li>`;
      const body = document.getElementById("method-body");
      if (body) body.value = "";
      return;
    }
    list.innerHTML = pendingMethodSteps.map((s, idx) => `
      <li class="method-step" draggable="true" data-idx="${idx}">
        <span class="method-step-num">${idx + 1}</span>
        <span class="method-step-text" data-edit-step="${idx}" title="Click to edit">${escapeHtml(s)}</span>
        <div class="method-step-actions">
          <button type="button" class="method-step-btn" data-move-step="${idx}" data-dir="-1" aria-label="Move up">↑</button>
          <button type="button" class="method-step-btn" data-move-step="${idx}" data-dir="1" aria-label="Move down">↓</button>
          <button type="button" class="method-step-btn danger" data-del-step="${idx}" aria-label="Remove">×</button>
        </div>
      </li>`).join("");
    const body = document.getElementById("method-body");
    if (body) body.value = pendingMethodSteps.map((s, i) => `${i + 1}. ${s}`).join("\n");

    list.querySelectorAll("[data-del-step]").forEach((b) => {
      b.addEventListener("click", () => {
        pendingMethodSteps.splice(+b.dataset.delStep, 1);
        syncBulkFromSteps();
        paintMethodSteps();
      });
    });
    list.querySelectorAll("[data-move-step]").forEach((b) => {
      b.addEventListener("click", () => {
        const i = +b.dataset.moveStep;
        const dir = +b.dataset.dir;
        const j = i + dir;
        if (j < 0 || j >= pendingMethodSteps.length) return;
        [pendingMethodSteps[i], pendingMethodSteps[j]] = [pendingMethodSteps[j], pendingMethodSteps[i]];
        syncBulkFromSteps();
        paintMethodSteps();
      });
    });
    list.querySelectorAll("[data-edit-step]").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = +el.dataset.editStep;
        const next = prompt("Edit this step:", pendingMethodSteps[idx]);
        if (next == null) return;
        const trimmed = next.trim();
        if (!trimmed) return;
        pendingMethodSteps[idx] = trimmed;
        syncBulkFromSteps();
        paintMethodSteps();
      });
    });
    // Drag-to-reorder (desktop). Mobile users have the up/down buttons.
    let dragIdx = null;
    list.querySelectorAll(".method-step").forEach((li) => {
      li.addEventListener("dragstart", () => { dragIdx = +li.dataset.idx; li.classList.add("dragging"); });
      li.addEventListener("dragend", () => { li.classList.remove("dragging"); dragIdx = null; });
      li.addEventListener("dragover", (e) => { e.preventDefault(); });
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        const target = +li.dataset.idx;
        if (dragIdx == null || target === dragIdx) return;
        const moved = pendingMethodSteps.splice(dragIdx, 1)[0];
        pendingMethodSteps.splice(target, 0, moved);
        syncBulkFromSteps();
        paintMethodSteps();
      });
    });
  }

  // Split a free-form blob into clean steps. Splits on newlines; strips
  // leading numbering ("1.", "1)", "Step 1:"), bullets ("-", "*", "•") and
  // empty lines.
  function parseStepsFromBulk(text) {
    return String(text || "")
      .split(/\r?\n+/)
      .map((line) => line
        .replace(/^\s*(?:step\s*)?\d+[\.\):\-]\s*/i, "")  // "1." / "1)" / "Step 1:"
        .replace(/^\s*[-*•]\s*/, "")                      // "- " / "* " / "• "
        .trim())
      .filter(Boolean);
  }

  function syncBulkFromSteps() {
    const bulk = document.getElementById("method-bulk-input");
    if (bulk) bulk.value = pendingMethodSteps.join("\n");
  }

  // Live parse: every keystroke in the bulk textarea re-derives the steps.
  // This means typing is the only thing the user has to do; the preview
  // updates as they go.
  const bulkInput = document.getElementById("method-bulk-input");
  if (bulkInput) {
    let bulkTimer = null;
    bulkInput.addEventListener("input", () => {
      clearTimeout(bulkTimer);
      bulkTimer = setTimeout(() => {
        pendingMethodSteps = parseStepsFromBulk(bulkInput.value);
        paintMethodSteps();
      }, 150);
    });
  }
  document.getElementById("method-bulk-apply")?.addEventListener("click", () => {
    if (!bulkInput) return;
    pendingMethodSteps = parseStepsFromBulk(bulkInput.value);
    paintMethodSteps();
    const list = document.getElementById("method-step-list");
    list?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  document.getElementById("method-bulk-clear")?.addEventListener("click", () => {
    if (bulkInput) bulkInput.value = "";
    pendingMethodSteps = [];
    paintMethodSteps();
    bulkInput?.focus();
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
    list.innerHTML = pendingIngredients.map((i, idx) => {
      const cat = foodCategoryFor(i.foodId, i.foodName);
      return `<li class="ingredient-row">
        <span class="food-cat-dot food-cat-${escapeHtml(cat)}"></span>
        <span class="ing-qty">${i.quantity != null ? escapeHtml(formatQty(i.quantity)) : ""}${i.unit ? " " + escapeHtml(UNIT_LABEL[i.unit] || i.unit) : ""}</span>
        <span class="ing-name">${escapeHtml(i.foodName)}</span>
        ${i.notes ? `<span class="ing-note">${escapeHtml(i.notes)}</span>` : ""}
        <button type="button" class="ing-del" data-del-ing="${idx}" aria-label="Remove">×</button>
      </li>`;
    }).join("");
    list.querySelectorAll("[data-del-ing]").forEach((b) => {
      b.addEventListener("click", () => {
        pendingIngredients.splice(+b.dataset.delIng, 1);
        paintIngredientList();
      });
    });
  }

  // Look up the food category for the coloured dot. Falls back to "other"
  // when the food isn't in the library (e.g. typed inline).
  function foodCategoryFor(id, name) {
    if (id) {
      const f = foods.find((x) => x.id === id);
      if (f?.category) return f.category;
    }
    const lower = String(name || "").toLowerCase();
    const f = foods.find((x) => x.name.toLowerCase() === lower);
    return f?.category || "other";
  }

  function addPendingIngredient() {
    const nameInput = document.getElementById("ingredient-name");
    const qtyInput = document.getElementById("ingredient-qty");
    const name = nameInput.value.trim();
    const qtyRaw = qtyInput.value.trim();
    const unit = document.getElementById("ingredient-unit").value || null;
    const notes = document.getElementById("ingredient-notes").value.trim() || null;
    const status = document.getElementById("ingredient-status");
    status.textContent = ""; status.className = "form-status";
    if (!name) {
      status.textContent = "Pick or type a food.";
      status.className = "form-status err";
      nameInput.focus();
      return false;
    }
    let quantity = null;
    if (qtyRaw) {
      const parsed = parseQty(qtyRaw);
      if (parsed == null || !Number.isFinite(parsed) || parsed < 0) {
        status.textContent = `"${qtyRaw}" isn't a quantity I can read. Try 1, 1/4, or 1 1/2.`;
        status.className = "form-status err";
        qtyInput.focus();
        return false;
      }
      quantity = parsed;
    }
    const match = lastFoodLookup.find((f) => f.name.toLowerCase() === name.toLowerCase());
    pendingIngredients.push({
      foodId: match?.id || null,
      foodName: name,
      quantity,
      unit,
      notes,
    });
    paintIngredientList();
    // Wipe + keep focus on the name field for rapid entry.
    nameInput.value = "";
    qtyInput.value = "";
    document.getElementById("ingredient-unit").value = "";
    document.getElementById("ingredient-notes").value = "";
    document.getElementById("food-autocomplete").hidden = true;
    nameInput.focus();
    return true;
  }

  document.getElementById("ingredient-add-btn").addEventListener("click", addPendingIngredient);

  // Enter anywhere in the ingredient row → add it. Saves a trip to the mouse.
  ["ingredient-name", "ingredient-qty", "ingredient-notes"].forEach((id) => {
    document.getElementById(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        // Don't hijack Enter on the name field when an autocomplete row is
        // already focused — the autocomplete handler handles that.
        if (id === "ingredient-name" && !document.getElementById("food-autocomplete").hidden) {
          // If a row is highlighted, let the autocomplete pick handler run.
          const hover = document.querySelector("#food-autocomplete li.is-hover");
          if (hover) return;
        }
        e.preventDefault();
        addPendingIngredient();
      }
    });
  });

  // Quick fraction chips: tap → fill the qty field. If qty already has a
  // value, the chip replaces it so taps stay snappy.
  document.getElementById("qty-quick-row").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-qty]");
    if (!chip) return;
    const qty = document.getElementById("ingredient-qty");
    qty.value = chip.dataset.qty;
    qty.focus();
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
    // Auto-add a half-typed ingredient that the user forgot to click "Add" on.
    if (document.getElementById("ingredient-name").value.trim()) addPendingIngredient();
    const bodyText = pendingMethodSteps.length
      ? pendingMethodSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")
      : (form.body.value.trim() || null);
    try {
      const body = {
        title: form.title.value.trim(),
        category: form.category.value,
        summary: form.summary.value.trim() || null,
        body: bodyText,
        servings: form.servings.value || null,
        prepMinutes: form.prepMinutes.value || null,
        cookMinutes: form.cookMinutes.value || null,
        ingredients: pendingIngredients,
      };
      let recipeId = editingId;
      if (editingId) {
        await fetchJson(`/api/me/recipes/${editingId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        const res = await fetchJson("/api/me/recipes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        recipeId = res.id;
      }

      // If the user picked a new photo, push it now that we have an id.
      if (pendingPhotoFile && recipeId) {
        try {
          const fd = new FormData();
          fd.append("file", pendingPhotoFile);
          const res = await fetch(`/api/me/recipes/${recipeId}/image`, {
            method: "POST", credentials: "same-origin", body: fd,
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || "Couldn't upload photo");
          }
        } catch (err) {
          toast(err.message || "Photo upload failed", "err");
        }
      }

      toast(editingId ? "Recipe updated ✨" : "Recipe published ✨", "ok");
      if (!editingId) celebrate();
      closeRecipeModal();
      await Promise.all([loadRecipes(), loadTopRecipes()]);
    } catch (err) {
      status.textContent = err.message || "Couldn't save."; status.className = "form-status err";
    }
  });

  // -------------- Photo input wiring --------------
  document.getElementById("recipe-photo-file")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) {
      document.getElementById("recipe-photo-status").textContent = "Photo too large — max 6MB.";
      document.getElementById("recipe-photo-status").className = "form-status err";
      e.target.value = ""; return;
    }
    pendingPhotoFile = file;
    if (pendingPhotoPreviewUrl) URL.revokeObjectURL(pendingPhotoPreviewUrl);
    pendingPhotoPreviewUrl = URL.createObjectURL(file);
    paintPhotoPreview(pendingPhotoPreviewUrl);
    document.getElementById("recipe-photo-status").textContent = "Photo ready — saves when you publish.";
    document.getElementById("recipe-photo-status").className = "form-status ok";
    e.target.value = "";
  });
  document.getElementById("recipe-photo-remove")?.addEventListener("click", async () => {
    pendingPhotoFile = null;
    if (pendingPhotoPreviewUrl) { URL.revokeObjectURL(pendingPhotoPreviewUrl); pendingPhotoPreviewUrl = null; }
    paintPhotoPreview(null);
    // If we're editing an existing recipe with a stored photo, ask the server
    // to delete it too. New-recipe drafts just clear locally.
    if (editingId) {
      try {
        await fetchJson(`/api/me/recipes/${editingId}/image`, { method: "DELETE" });
        toast("Photo removed", "ok");
        await loadRecipes();
      } catch (err) { toast(err.message || "Couldn't remove photo", "err"); }
    }
  });

  // -------------- Delete from inside the modal --------------
  document.getElementById("recipe-delete-btn")?.addEventListener("click", async () => {
    if (!editingId) return;
    if (!confirm("Delete this recipe? This can't be undone.")) return;
    try {
      await fetchJson(`/api/me/recipes/${editingId}`, { method: "DELETE" });
      toast("Recipe removed", "ok");
      closeRecipeModal();
      await Promise.all([loadRecipes(), loadTopRecipes()]);
    } catch (err) { toast(err.message || "Couldn't remove", "err"); }
  });

  // Tiny confetti burst on publish — keeps the moment feeling fun without
  // pulling in a library. Each particle is a single emoji that drifts and
  // fades. Self-cleans after 1.6 seconds.
  function celebrate() {
    const stage = document.createElement("div");
    stage.className = "confetti-stage";
    document.body.appendChild(stage);
    const glyphs = ["🍳","🥗","🍰","🥑","🍓","🥕","🌿","✨","🍯","🍋"];
    for (let i = 0; i < 28; i++) {
      const piece = document.createElement("span");
      piece.className = "confetti-piece";
      piece.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
      piece.style.left = Math.random() * 100 + "%";
      piece.style.animationDelay = (Math.random() * 0.25) + "s";
      piece.style.animationDuration = (1.1 + Math.random() * 0.6) + "s";
      piece.style.fontSize = (16 + Math.random() * 18) + "px";
      stage.appendChild(piece);
    }
    setTimeout(() => stage.remove(), 1800);
  }

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

  // Card-level delete now happens inside the edit modal (Delete recipe
  // button). The previous floating × on the card has been removed in favour
  // of an ✎ Edit button that takes the user to the full editor.

  // ------------------------------------------------------------------
  // Food library
  // ------------------------------------------------------------------
  async function loadFoods() {
    // Pre-fetch the catalog once so search is instant. We just don't render
    // anything until the user types — the visible list stays a placeholder.
    try {
      const data = await fetchJson("/api/me/recipe-foods");
      foods = data.foods || [];
    } catch {}
  }
  function paintFoods() {
    const grid = document.getElementById("food-library-grid");
    const raw = document.getElementById("food-library-search").value || "";
    const q = raw.trim().toLowerCase();
    if (!q) {
      // Empty search → friendly placeholder, no dump of every food.
      grid.innerHTML = `<li class="food-library-placeholder">
        <span class="food-library-placeholder-emoji">🔎</span>
        <strong>Type to search the food library</strong>
        <span>We hide the full list to keep the page light — start typing and matching foods appear here.</span>
      </li>`;
      return;
    }
    // Fuzzy ranking so name-prefix wins over category match.
    const ranked = [];
    for (const f of foods) {
      const score = scoreFoodMatch(f, q);
      if (score > 0) ranked.push({ f, score });
    }
    ranked.sort((a, b) => b.score - a.score || a.f.name.localeCompare(b.f.name));
    const items = ranked.slice(0, 60).map((x) => x.f);
    if (!items.length) {
      grid.innerHTML = `<li class="food-library-placeholder">
        <span class="food-library-placeholder-emoji">🌱</span>
        <strong>"${escapeHtml(raw)}" isn't in the library yet</strong>
        <span>Tap "+ Add a food" to add it — it'll show up in the recipe builder right away.</span>
      </li>`;
      return;
    }
    grid.innerHTML = items.map((f) => `
      <li class="food-pill">
        <span class="food-cat-dot food-cat-${escapeHtml(f.category || "other")}"></span>
        <strong>${escapeHtml(f.name)}</strong>
        <span class="food-pill-unit">${f.defaultUnit ? escapeHtml(UNIT_LABEL[f.defaultUnit] || f.defaultUnit) : ""}</span>
      </li>`).join("");
  }
  function scoreFoodMatch(f, q) {
    const n = (f.name || "").toLowerCase();
    if (n === q) return 100;
    if (n.startsWith(q)) return 80;
    if (n.includes(q)) return 50;
    const c = (f.category || "").toLowerCase();
    if (c.includes(q)) return 20;
    return 0;
  }
  // Debounce so we don't repaint on every keystroke for fast typers.
  let foodSearchTimer = null;
  document.getElementById("food-library-search").addEventListener("input", () => {
    clearTimeout(foodSearchTimer);
    foodSearchTimer = setTimeout(paintFoods, 120);
  });

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
