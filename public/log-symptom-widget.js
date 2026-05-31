// Log-symptom FAB + modal, self-injected onto any authed page that
// includes this script. Mirrors the modal in dashboard.html so the same
// "+ Log symptom" button is available everywhere, not just /dashboard.
//
// Skipped automatically on /dashboard (it already owns the original
// modal) and on /login / /register / /onboarding (no auth shell).
(() => {
  if (typeof document === "undefined") return;
  const path = location.pathname;
  if (path === "/dashboard" || path.startsWith("/dashboard/")) return;
  if (path === "/login" || path === "/register" || path.startsWith("/onboarding")) return;
  // If a page already has its own #modal-symptom (shouldn't happen now,
  // but belt + braces), don't double-inject.
  if (document.getElementById("modal-symptom")) return;

  // -----------------------------------------------------------------
  // INJECTION — minimal CSS for the FAB (modal/chip styles come from
  // dashboard.css which every authed page already loads) + the markup.
  // -----------------------------------------------------------------
  const STYLE = `
  .lsw-fab{
    position:fixed;right:24px;bottom:24px;z-index:55;
    background:linear-gradient(135deg,#ff8aab,#ff4e8a);
    color:#fff;border:0;border-radius:999px;
    padding:14px 22px;font-family:inherit;font-weight:700;font-size:14px;
    display:inline-flex;align-items:center;gap:10px;cursor:pointer;
    box-shadow:0 14px 30px rgba(255,77,138,.45);
    transition:transform .14s, box-shadow .14s;
  }
  .lsw-fab:hover{transform:translateY(-2px);box-shadow:0 18px 38px rgba(255,77,138,.55)}
  .lsw-fab:focus-visible{outline:3px solid rgba(255,255,255,.7);outline-offset:2px}
  .lsw-fab svg{width:20px;height:20px;flex-shrink:0}
  @media (max-width:640px){
    .lsw-fab{right:14px;bottom:96px;padding:12px 18px;font-size:13px}
    .lsw-fab span{display:none}
    .lsw-fab svg{width:22px;height:22px}
  }
  /* Sidebar Log card injected after .side-nav on every authed page so the
     "Log Symptom" button is always visible, not just floating bottom-right. */
  .lsw-side-card{
    background:#fff;border-radius:18px;padding:16px;
    box-shadow:0 4px 14px rgba(255,77,138,.06);
    text-align:center;display:flex;flex-direction:column;gap:8px;
  }
  .lsw-side-head{display:flex;align-items:center;justify-content:center;gap:6px;font-size:14px;color:#3a2330;font-weight:700}
  .lsw-side-card p{font-size:12px;color:#7a5f6c;margin:0 0 6px}
  .lsw-side-btn{
    background:linear-gradient(135deg,#ff8aab,#ff4e8a);color:#fff;
    border:0;border-radius:999px;padding:11px 14px;cursor:pointer;
    font-family:inherit;font-weight:700;font-size:13px;width:100%;
    display:inline-flex;align-items:center;justify-content:center;gap:8px;
    box-shadow:0 6px 14px rgba(255,77,138,.28);
    transition:transform .14s, box-shadow .14s;
  }
  .lsw-side-btn:hover{transform:translateY(-1px);box-shadow:0 10px 22px rgba(255,77,138,.36)}
  `;
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);

  const FAB_HTML = `
    <button id="lsw-fab" class="lsw-fab" type="button" aria-label="Log a symptom">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 5v14M5 12h14" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>
      </svg>
      <span>Log symptom</span>
    </button>`;

  const MODAL_HTML = `
  <div class="modal" id="modal-symptom" aria-hidden="true" role="dialog" aria-modal="true" aria-labelledby="lsw-title">
    <div class="modal-backdrop" data-lsw-close></div>
    <div class="modal-card modal-xl">
      <button class="modal-close" type="button" data-lsw-close aria-label="Close">×</button>
      <header class="modal-h">
        <span class="modal-emoji">📝</span>
        <h3 id="lsw-title">What are you feeling?</h3>
        <p>Log it now — we'll spot the pattern later.</p>
      </header>
      <form id="lsw-form" novalidate>
        <div class="modal-section">
          <h4 class="section-title">
            Symptoms
            <span class="sec-hint">Tap as many as you're feeling — tap again to unselect</span>
            <span class="multi-count" data-lsw-count="symptom" hidden>0 selected</span>
          </h4>
          <div class="chip-pick wrap multi" data-lsw-multi="symptom" data-min="1">
            <button type="button" data-val="pelvic_pain">⚡ Pelvic pain</button>
            <button type="button" data-val="cramps">🔥 Cramps</button>
            <button type="button" data-val="endo_belly">🎈 Endo belly</button>
            <button type="button" data-val="back_pain">🦴 Lower back</button>
            <button type="button" data-val="pain">💢 Pain (other)</button>
            <button type="button" data-val="bloating">💧 Bloating</button>
            <button type="button" data-val="nausea">🤢 Nausea</button>
            <button type="button" data-val="fatigue">😴 Fatigue</button>
            <button type="button" data-val="headache">🧠 Headache</button>
            <button type="button" data-val="breast_tender">💗 Breast tender</button>
            <button type="button" data-val="hot_flash">🥵 Hot flash</button>
            <button type="button" data-val="dizziness">💫 Dizziness</button>
            <button type="button" data-val="spotting">🩸 Spotting</button>
            <button type="button" data-val="painful_urination">🚽 Painful peeing</button>
            <button type="button" data-val="painful_bowel">💩 Painful BM</button>
            <button type="button" data-val="painful_sex">💔 Painful sex</button>
            <button type="button" data-val="mood_happy">😊 Happy</button>
            <button type="button" data-val="mood_sad">😢 Sad</button>
            <button type="button" data-val="mood_angry">😠 Angry</button>
            <button type="button" data-val="mood_anxious">😰 Anxious</button>
            <button type="button" data-val="mood_irritable">😤 Irritable</button>
            <button type="button" data-val="mood_numb">😶 Numb</button>
            <button type="button" data-val="sleep">🌙 Sleep issue</button>
            <button type="button" data-val="appetite">🍽 Appetite</button>
            <button type="button" data-val="other">＋ Other</button>
          </div>
        </div>

        <div class="modal-section" data-lsw-pain-section hidden>
          <h4 class="section-title">
            Pain feels like
            <span class="sec-hint">Pick any that fit — optional</span>
          </h4>
          <div class="chip-pick wrap multi" data-lsw-multi="painType">
            <button type="button" data-val="sharp">🗡 Sharp</button>
            <button type="button" data-val="dull">🌫 Dull</button>
            <button type="button" data-val="deep">🕳 Deep</button>
            <button type="button" data-val="burning">🔥 Burning</button>
            <button type="button" data-val="aching">💢 Aching</button>
            <button type="button" data-val="throbbing">💓 Throbbing</button>
            <button type="button" data-val="cramping">⚡ Cramping</button>
            <button type="button" data-val="stabbing">🩻 Stabbing</button>
            <button type="button" data-val="shooting">⚡ Shooting</button>
            <button type="button" data-val="pressure">🧊 Pressure</button>
            <button type="button" data-val="twisting">🌀 Twisting</button>
            <button type="button" data-val="pulling">🪢 Pulling</button>
            <button type="button" data-val="pinching">🤏 Pinching</button>
          </div>
        </div>

        <div class="modal-section">
          <h4 class="section-title">Severity</h4>
          <div class="seg-slider pain" data-lsw-scale="severity">
            <button type="button" data-val="1"><span class="seg-label">1</span><span class="seg-sublabel">Barely</span></button>
            <button type="button" data-val="2"><span class="seg-label">2</span><span class="seg-sublabel">Mild</span></button>
            <button type="button" data-val="3"><span class="seg-label">3</span><span class="seg-sublabel">Moderate</span></button>
            <button type="button" data-val="4"><span class="seg-label">4</span><span class="seg-sublabel">Strong</span></button>
            <button type="button" data-val="5"><span class="seg-label">5</span><span class="seg-sublabel">Severe</span></button>
          </div>
        </div>

        <div class="modal-section">
          <h4 class="section-title">Where? <span class="sec-hint">optional · tap any</span></h4>
          <div class="chip-pick wrap multi" data-lsw-multi="location">
            <button type="button" data-val="Lower abdomen">Lower abdomen</button>
            <button type="button" data-val="Pelvis">Pelvis</button>
            <button type="button" data-val="Ovaries">Ovaries</button>
            <button type="button" data-val="Uterus">Uterus</button>
            <button type="button" data-val="Lower back">Lower back</button>
            <button type="button" data-val="Legs">Legs</button>
            <button type="button" data-val="Rectum">Rectum</button>
            <button type="button" data-val="Bladder">Bladder</button>
            <button type="button" data-val="Other">Other</button>
          </div>
        </div>

        <div class="modal-section">
          <h4 class="section-title">Possible trigger <span class="sec-hint">optional · tap any</span></h4>
          <div class="chip-pick wrap multi" data-lsw-multi="triggers">
            <button type="button" data-val="food">🍔 Food</button>
            <button type="button" data-val="stress">😰 Stress</button>
            <button type="button" data-val="poor_sleep">😴 Poor sleep</button>
            <button type="button" data-val="exercise">🏃 Exercise</button>
            <button type="button" data-val="period">🩸 Period</button>
            <button type="button" data-val="ovulation">🌕 Ovulation</button>
            <button type="button" data-val="weather">🌧 Weather</button>
            <button type="button" data-val="travel">✈️ Travel</button>
            <button type="button" data-val="hormones">⚖️ Hormones</button>
          </div>
        </div>

        <div class="modal-section">
          <h4 class="section-title">What helped <span class="sec-hint">optional · tap any</span></h4>
          <div class="chip-pick wrap multi" data-lsw-multi="relief">
            <button type="button" data-val="heat">🔥 Heat</button>
            <button type="button" data-val="rest">🛏 Rest</button>
            <button type="button" data-val="medication">💊 Medication</button>
            <button type="button" data-val="hydration">💧 Hydration</button>
            <button type="button" data-val="stretch">🧘 Stretching</button>
            <button type="button" data-val="walk">🚶 Walking</button>
            <button type="button" data-val="bath">🛁 Bath</button>
            <button type="button" data-val="distraction">🎧 Distraction</button>
            <button type="button" data-val="none">— Nothing yet</button>
          </div>
        </div>

        <div class="modal-section">
          <label class="field"><span>Notes</span>
            <input type="text" id="lsw-notes" maxlength="500" placeholder="What you were doing, how it feels…" />
          </label>
        </div>

        <button type="submit" class="btn btn-primary full" id="lsw-submit">Log symptoms <em class="xp-badge">+5 XP each</em></button>
        <p class="form-status" id="lsw-status" role="status"></p>
      </form>
    </div>
  </div>`;

  const SIDE_CARD_HTML = `
    <div class="lsw-side-card" id="lsw-side-card">
      <div class="lsw-side-head"><span>📅</span> Quick log</div>
      <p>Caught a flare? Log it before it slips your mind.</p>
      <button type="button" class="lsw-side-btn" id="lsw-side-btn">
        <span>＋</span> Log Symptom
      </button>
    </div>`;

  // initialised + init must be declared BEFORE the readyState-triggered
  // init() call below. When the script runs with defer (which it does
  // on every authed page) document.readyState is already "interactive",
  // so init() fires immediately — if `initialised` were still in TDZ
  // here, the whole widget would silently ReferenceError out.
  let initialised = false;
  function init() {
    if (initialised) return;
    initialised = true;
    document.body.insertAdjacentHTML("beforeend", FAB_HTML);
    document.body.insertAdjacentHTML("beforeend", MODAL_HTML);
    // Inject the visible "Log Symptom" pill into the sidebar nav so it's
    // not only available via the floating FAB. Sits right under the side
    // navigation, same shape + colour as the dashboard's existing one.
    const sideNav = document.querySelector(".dash-sidebar .side-nav");
    if (sideNav && !document.getElementById("lsw-side-card")) {
      sideNav.insertAdjacentHTML("afterend", SIDE_CARD_HTML);
      document.getElementById("lsw-side-btn")?.addEventListener("click", () => openModal());
    }
    wire();
  }

  function wire() {
    const fab = document.getElementById("lsw-fab");
    const modal = document.getElementById("modal-symptom");
    const form  = document.getElementById("lsw-form");
    const status = document.getElementById("lsw-status");
    if (!fab || !modal || !form) return;

    fab.addEventListener("click", () => openModal());
    modal.querySelectorAll("[data-lsw-close]").forEach((el) =>
      el.addEventListener("click", () => closeModal())
    );
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.classList.contains("open")) closeModal();
    });

    // Multi-select chips. Toggle .on + maintain CSV in dataset.value.
    modal.querySelectorAll("[data-lsw-multi]").forEach((group) => {
      group.dataset.value = "";
      group.querySelectorAll("button[data-val]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          const set = new Set((group.dataset.value || "").split(",").filter(Boolean));
          const v = btn.dataset.val;
          if (set.has(v)) set.delete(v); else set.add(v);
          group.dataset.value = [...set].join(",");
          btn.classList.toggle("on", set.has(v));
          btn.setAttribute("aria-pressed", set.has(v) ? "true" : "false");
          updateMultiCount(group, set.size);
          if (group.dataset.lswMulti === "symptom") togglePainSection(set);
        });
      });
    });

    // Single-pick severity scale.
    modal.querySelectorAll("[data-lsw-scale]").forEach((group) => {
      group.querySelectorAll("button[data-val]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          group.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
          group.dataset.value = btn.dataset.val;
        });
      });
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = gather();
      if (!body) return;
      status.textContent = "Saving…"; status.className = "form-status";
      const submit = document.getElementById("lsw-submit");
      submit.disabled = true;
      try {
        const r = await fetch("/api/me/symptoms", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, date: todayLocal() }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `Couldn't save (${r.status})`);
        toast(`Logged · +${data.pointsAwarded || 0} XP`);
        closeModal();
        resetForm();
        // If we're on a page that maintains its own state of recent logs,
        // give it a chance to refresh (best-effort signal).
        document.dispatchEvent(new CustomEvent("lsw:logged", { detail: data }));
      } catch (err) {
        status.textContent = err.message || "Couldn't save."; status.className = "form-status err";
      } finally {
        submit.disabled = false;
      }
    });
  }

  function openModal() {
    const modal = document.getElementById("modal-symptom");
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    // Focus the first chip for keyboard users.
    setTimeout(() => modal.querySelector("[data-lsw-multi='symptom'] button")?.focus({ preventScroll: true }), 60);
  }
  function closeModal() {
    const modal = document.getElementById("modal-symptom");
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    document.getElementById("lsw-status").textContent = "";
  }

  function gather() {
    const modal = document.getElementById("modal-symptom");
    const symptoms = csvArr(modal.querySelector("[data-lsw-multi='symptom']")?.dataset.value);
    const status = document.getElementById("lsw-status");
    if (!symptoms.length) {
      status.textContent = "Pick at least one symptom."; status.className = "form-status err";
      return null;
    }
    const sev = modal.querySelector("[data-lsw-scale='severity']")?.dataset.value;
    if (!sev) {
      status.textContent = "Set severity 1-5."; status.className = "form-status err";
      return null;
    }
    return {
      symptoms,
      severity:  +sev,
      painTypes: csvArr(modal.querySelector("[data-lsw-multi='painType']")?.dataset.value),
      locations: csvArr(modal.querySelector("[data-lsw-multi='location']")?.dataset.value),
      triggers:  csvArr(modal.querySelector("[data-lsw-multi='triggers']")?.dataset.value),
      relief:    csvArr(modal.querySelector("[data-lsw-multi='relief']")?.dataset.value),
      notes:     document.getElementById("lsw-notes").value || null,
    };
  }
  function resetForm() {
    const modal = document.getElementById("modal-symptom");
    modal.querySelectorAll("[data-lsw-multi]").forEach((g) => {
      g.dataset.value = "";
      g.querySelectorAll("button.on").forEach((b) => { b.classList.remove("on"); b.setAttribute("aria-pressed", "false"); });
      updateMultiCount(g, 0);
    });
    modal.querySelectorAll("[data-lsw-scale]").forEach((g) => {
      g.dataset.value = "";
      g.querySelectorAll("button.on").forEach((b) => b.classList.remove("on"));
    });
    document.getElementById("lsw-notes").value = "";
    document.querySelector("[data-lsw-pain-section]").hidden = true;
  }
  function csvArr(v) { return v ? String(v).split(",").filter(Boolean) : []; }
  function updateMultiCount(group, n) {
    const key = group.dataset.lswMulti;
    const badge = group.parentElement?.querySelector(`[data-lsw-count='${key}']`);
    if (!badge) return;
    if (n > 0) { badge.textContent = `${n} selected`; badge.hidden = false; }
    else { badge.hidden = true; }
  }
  // Show the pain-type section if any of the picked symptoms are pain-y.
  const PAIN_SYMPTOMS = new Set([
    "pain","pelvic_pain","back_pain","cramps","headache","endo_belly",
    "breast_tender","painful_urination","painful_bowel","painful_sex",
  ]);
  function togglePainSection(set) {
    const pane = document.querySelector("[data-lsw-pain-section]");
    if (!pane) return;
    pane.hidden = ![...set].some((s) => PAIN_SYMPTOMS.has(s));
  }

  function todayLocal() {
    const d = new Date();
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().slice(0, 10);
  }

  function toast(text) {
    let stack = document.getElementById("toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.id = "toast-stack";
      stack.className = "toast-stack";
      stack.setAttribute("aria-live", "polite");
      document.body.appendChild(stack);
    }
    const t = document.createElement("div");
    t.className = "toast toast-ok";
    t.textContent = text;
    stack.appendChild(t);
    requestAnimationFrame(() => t.classList.add("in"));
    setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 250); }, 2400);
  }

  // Bootstrap last — every function + variable is now defined, so the
  // immediate readyState check can safely call init().
  document.addEventListener("DOMContentLoaded", init, { once: true });
  if (document.readyState !== "loading") init();
})();
