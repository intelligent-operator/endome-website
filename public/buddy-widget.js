// Buddy popup widget — self-injects an Intercom-style chat bubble + panel
// on whatever authed page includes it. Reuses /api/me/buddy/* endpoints.
//
// Include with:  <link rel="stylesheet" href="/buddy-widget.css">
//                <script src="/buddy-widget.js" defer></script>
//
// On /buddy itself we skip the widget (the full page is the chat).
(() => {
  if (location.pathname.startsWith("/buddy")) return;

  // ---- DOM injection -----------------------------------------------------
  const launcher = document.createElement("button");
  launcher.className = "bw-launcher";
  launcher.type = "button";
  launcher.setAttribute("aria-label", "Talk to your companion");
  launcher.innerHTML = `<span class="bw-launch-face">💬</span><span class="bw-launch-label">Talk to Buddy</span>`;

  const panel = document.createElement("section");
  panel.className = "bw-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Buddy chat");
  panel.innerHTML = `
    <header class="bw-head">
      <button type="button" class="bw-head-icon" data-bw-history title="Chat history" aria-label="Chat history">☰</button>
      <div class="bw-head-avatar">💬</div>
      <div class="bw-head-title">
        <strong>Buddy</strong>
        <span><span class="bw-dot"></span> Health companion · online</span>
      </div>
      <div class="bw-head-actions">
        <button type="button" class="bw-head-icon" data-bw-new title="New chat" aria-label="New chat">+</button>
        <a href="/buddy" title="Open full chat" aria-label="Open full chat">↗</a>
        <button type="button" class="bw-head-icon" data-bw-close title="Close" aria-label="Close">×</button>
      </div>
    </header>
    <div class="bw-stage">
      <!-- Slide-in history drawer (collapsed by default) -->
      <aside class="bw-drawer" id="bw-drawer" hidden>
        <div class="bw-drawer-head">
          <strong>Your chats</strong>
          <button type="button" class="bw-head-icon dark" data-bw-history title="Close history">×</button>
        </div>
        <ul class="bw-drawer-list" id="bw-drawer-list"></ul>
      </aside>
      <div class="bw-body" id="bw-body">
        <div class="bw-welcome">
          <h3>👋 Say hi to your companion.</h3>
          <p>Ask anything about your symptoms, your data, or how you're feeling.</p>
        </div>
      </div>
    </div>
    <form class="bw-input-row" id="bw-form">
      <textarea id="bw-input" rows="1" placeholder="Ask Buddy…" maxlength="4000"></textarea>
      <button type="submit" id="bw-send" disabled>Send</button>
    </form>
    <p class="bw-foot">Focused on your endo journey + the EndoMe app. <a href="/buddy">See full chat →</a></p>`;

  // If the host page already has a .fab-buddy link (we shipped that on
  // /dashboard before this widget existed), drop it — the launcher replaces it.
  document.querySelectorAll(".fab-buddy").forEach((el) => el.remove());

  // Backdrop dims the page behind the popup on mobile (bottom-sheet style)
  // and on tablet (modal). Tapping it closes. Pointer-events:none above
  // tablet width so desktop keeps working as an Intercom-style floater.
  const backdrop = document.createElement("div");
  backdrop.className = "bw-backdrop";
  backdrop.hidden = true;

  document.addEventListener("DOMContentLoaded", () => {
    document.body.appendChild(launcher);
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    wire();
    backdrop.addEventListener("click", closePanel);
    fetchIdentity();
  }, { once: true });

  async function fetchIdentity() {
    if (identityLoaded) return;
    identityLoaded = true;
    try {
      const r = await fetch("/api/me/today", { credentials: "same-origin" });
      if (r.ok) {
        const me = await r.json();
        myAvatar = { url: me?.user?.avatarUrl || null, emoji: me?.user?.avatar || null };
        if (me?.pet?.name) pet = { name: me.pet.name, type: me.pet.type || null };
        applyPetIdentity();
      }
    } catch {}
  }

  // ---- State -------------------------------------------------------------
  let activeConvId = null;
  let busy = false;
  let opened = false;
  let loadedOnce = false;
  let identityLoaded = false;
  let myAvatar = { url: null, emoji: null };
  let pet = { name: "Buddy", type: null };

  const PET_FACES = {
    luna:  `<svg viewBox="0 0 140 140"><path d="M40 60 L26 30 L48 46 Z" fill="#ff8aab"/><path d="M100 60 L114 30 L92 46 Z" fill="#ff8aab"/><ellipse cx="70" cy="92" rx="34" ry="26" fill="#ff9bb3"/><circle cx="70" cy="72" r="32" fill="#ffb6c8"/><circle cx="59" cy="74" r="4.5" fill="#2c1320"/><circle cx="81" cy="74" r="4.5" fill="#2c1320"/><path d="M67 86 q3 3 6 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>`,
    poppy: `<svg viewBox="0 0 140 140"><ellipse cx="44" cy="80" rx="14" ry="20" fill="#e8a86a"/><ellipse cx="96" cy="80" rx="14" ry="20" fill="#e8a86a"/><circle cx="70" cy="72" r="32" fill="#f5c184"/><circle cx="59" cy="72" r="4.5" fill="#2c1320"/><circle cx="81" cy="72" r="4.5" fill="#2c1320"/><ellipse cx="70" cy="84" rx="3.5" ry="2.5" fill="#2c1320"/><path d="M66 90 q4 4 8 0" stroke="#2c1320" stroke-width="1.6" fill="none"/></svg>`,
    mochi: `<svg viewBox="0 0 140 140"><ellipse cx="52" cy="34" rx="9" ry="22" fill="#dcd0f0"/><ellipse cx="88" cy="34" rx="9" ry="22" fill="#dcd0f0"/><circle cx="70" cy="72" r="30" fill="#f0e6fb"/><circle cx="60" cy="74" r="4.5" fill="#2c1320"/><circle cx="80" cy="74" r="4.5" fill="#2c1320"/><path d="M68 84 l2 2 l2 -2 z" fill="#ff7a99"/></svg>`,
    sunny: `<svg viewBox="0 0 140 140"><path d="M40 38 L52 60 L34 56 Z" fill="#e8762a"/><path d="M100 38 L88 60 L106 56 Z" fill="#e8762a"/><circle cx="70" cy="72" r="32" fill="#f08b3a"/><path d="M70 60 Q50 72 56 92 Q70 86 70 86 Q70 86 84 92 Q90 72 70 60 Z" fill="#fff"/><circle cx="60" cy="72" r="4.5" fill="#2c1320"/><circle cx="80" cy="72" r="4.5" fill="#2c1320"/></svg>`,
    coco:  `<svg viewBox="0 0 140 140"><circle cx="34" cy="58" r="16" fill="#9d8fc7"/><circle cx="106" cy="58" r="16" fill="#9d8fc7"/><circle cx="70" cy="68" r="30" fill="#b5a7d8"/><circle cx="60" cy="68" r="4.5" fill="#2c1320"/><circle cx="80" cy="68" r="4.5" fill="#2c1320"/><ellipse cx="70" cy="82" rx="9" ry="7" fill="#2c1320"/></svg>`,
    kiki:  `<svg viewBox="0 0 140 140"><ellipse cx="56" cy="34" rx="6" ry="20" fill="#d9a872"/><ellipse cx="84" cy="34" rx="6" ry="20" fill="#d9a872"/><ellipse cx="70" cy="70" rx="28" ry="26" fill="#e8b985"/><circle cx="60" cy="68" r="4.5" fill="#2c1320"/><circle cx="80" cy="68" r="4.5" fill="#2c1320"/><ellipse cx="70" cy="80" rx="3.5" ry="2.5" fill="#2c1320"/></svg>`,
  };
  const petFace = () => PET_FACES[pet.type] || "💬";

  function wire() {
    launcher.addEventListener("click", () => {
      // On tablet + mobile send the user to the dedicated /buddy page
      // (better UX than a popup with the keyboard taking over the screen).
      // Desktop keeps the in-place Intercom-style popup.
      if (matchMedia("(max-width: 820px)").matches) {
        location.href = "/messages?c=buddy";
        return;
      }
      openPanel();
    });
    panel.querySelectorAll("[data-bw-close]").forEach((b) => b.addEventListener("click", closePanel));
    panel.querySelectorAll("[data-bw-history]").forEach((b) => b.addEventListener("click", toggleDrawer));
    panel.querySelector("[data-bw-new]").addEventListener("click", startNewChat);
    const input = panel.querySelector("#bw-input");
    const send  = panel.querySelector("#bw-send");
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(96, input.scrollHeight) + "px";
      send.disabled = busy || !input.value.trim();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        panel.querySelector("#bw-form").requestSubmit();
      }
    });
    panel.querySelector("#bw-form").addEventListener("submit", onSend);
    // Esc closes when focused inside the panel.
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); closePanel(); }
    });
  }

  async function openPanel() {
    if (opened) return;
    opened = true;
    launcher.hidden = true;
    backdrop.hidden = false;
    panel.hidden = false;
    // Always ensure the history drawer is closed on (re)open so the user
    // lands on the conversation, not an empty drawer.
    const drawer = panel.querySelector("#bw-drawer");
    if (drawer) drawer.hidden = true;
    document.body.classList.add("bw-open");
    // Do NOT auto-focus the input on touch screens — that pops the OS
    // keyboard instantly and shoves the panel out of view. Let the user
    // tap when they're ready. Desktop keeps autofocus for keyboard users.
    const isTouch = matchMedia("(max-width: 820px)").matches || ("ontouchstart" in window);
    if (!isTouch) panel.querySelector("#bw-input").focus({ preventScroll: true });
    // Start watching the visual viewport so the panel rides above the
    // on-screen keyboard instead of disappearing behind it.
    enableKeyboardTracking();
    if (!loadedOnce) {
      loadedOnce = true;
      await fetchIdentity();
      await loadMostRecent();
    }
  }
  function closePanel() {
    opened = false;
    panel.hidden = true;
    backdrop.hidden = true;
    launcher.hidden = false;
    document.body.classList.remove("bw-open");
    panel.querySelector("#bw-drawer").hidden = true;
    panel.style.bottom = "";  // reset any keyboard offset
    disableKeyboardTracking();
  }

  // ---- iOS keyboard tracking --------------------------------------------
  // On iOS Safari the on-screen keyboard does NOT resize the layout
  // viewport — it just overlays the bottom. Without compensation the
  // bottom-sheet's input row ends up behind the keyboard and users can't
  // see what they're typing. We listen to visualViewport changes and
  // push the sheet up by the obscured pixel count.
  let vvHandler = null;
  function enableKeyboardTracking() {
    if (vvHandler || !window.visualViewport) return;
    vvHandler = () => {
      if (!matchMedia("(max-width: 820px)").matches) { panel.style.bottom = ""; return; }
      const vv = window.visualViewport;
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      panel.style.bottom = offset + "px";
    };
    window.visualViewport.addEventListener("resize", vvHandler);
    window.visualViewport.addEventListener("scroll", vvHandler);
    vvHandler();
  }
  function disableKeyboardTracking() {
    if (!vvHandler || !window.visualViewport) return;
    window.visualViewport.removeEventListener("resize", vvHandler);
    window.visualViewport.removeEventListener("scroll", vvHandler);
    vvHandler = null;
  }

  // ---- History drawer ----------------------------------------------------
  function toggleDrawer() {
    const drawer = panel.querySelector("#bw-drawer");
    const show = drawer.hidden;
    drawer.hidden = !show;
    if (show) loadDrawer();
  }
  async function loadDrawer() {
    const list = panel.querySelector("#bw-drawer-list");
    list.innerHTML = `<li class="bw-drawer-empty">Loading…</li>`;
    let convs = [];
    try {
      const r = await fetch("/api/me/buddy/conversations", { credentials: "same-origin" });
      if (r.ok) { const data = await r.json(); convs = data.conversations || []; }
    } catch {}
    if (!convs.length) { list.innerHTML = `<li class="bw-drawer-empty">No chats yet.</li>`; return; }
    list.innerHTML = convs.map((c) => `
      <li class="bw-drawer-item ${c.id === activeConvId ? "active" : ""}" data-conv="${c.id}">
        <span class="t">${esc(c.title || "New chat")}</span>
        <button type="button" class="bw-drawer-del" data-del="${c.id}" aria-label="Delete chat">×</button>
      </li>`).join("");
    list.querySelectorAll("[data-conv]").forEach((li) => {
      li.addEventListener("click", (e) => {
        if (e.target.closest("[data-del]")) return;
        openConv(+li.dataset.conv);
      });
    });
    list.querySelectorAll("[data-del]").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        confirmDelete(+b.dataset.del, b.closest(".bw-drawer-item")?.querySelector(".t")?.textContent || "this chat");
      });
    });
  }
  async function openConv(id) {
    activeConvId = id;
    panel.querySelector("#bw-drawer").hidden = true;
    const body = panel.querySelector("#bw-body");
    body.innerHTML = `<p class="bw-welcome"><em style="color:#7a5f6c">Loading…</em></p>`;
    try {
      const r = await fetch(`/api/me/buddy/conversations/${id}`, { credentials: "same-origin" });
      if (!r.ok) throw new Error();
      const data = await r.json();
      renderMessages(data.messages || []);
    } catch { renderWelcome(); }
  }
  async function startNewChat() {
    panel.querySelector("#bw-drawer").hidden = true;
    activeConvId = null;
    renderWelcome();
    panel.querySelector("#bw-input").focus();
  }
  function confirmDelete(id, title) {
    bwConfirm({
      title: "Delete chat?",
      body: `"${title}" and all its messages will be permanently removed.`,
      confirmText: "Delete",
      danger: true,
      onConfirm: async () => {
        try {
          await fetch(`/api/me/buddy/conversations/${id}`, { method: "DELETE", credentials: "same-origin" });
          if (activeConvId === id) { activeConvId = null; renderWelcome(); }
          loadDrawer();
        } catch {}
      },
    });
  }

  // Pull the user's most recent conversation; if none, show the welcome.
  async function loadMostRecent() {
    const body = panel.querySelector("#bw-body");
    body.innerHTML = `<p class="bw-welcome"><em style="color:#7a5f6c">Loading…</em></p>`;
    let convs = [];
    try {
      const r = await fetch("/api/me/buddy/conversations", { credentials: "same-origin" });
      if (r.ok) { const data = await r.json(); convs = data.conversations || []; }
    } catch {}
    if (!convs.length) { renderWelcome(); return; }
    activeConvId = convs[0].id;
    try {
      const r = await fetch(`/api/me/buddy/conversations/${activeConvId}`, { credentials: "same-origin" });
      if (!r.ok) throw new Error();
      const data = await r.json();
      renderMessages(data.messages || []);
    } catch {
      renderWelcome();
    }
  }

  function renderWelcome() {
    const body = panel.querySelector("#bw-body");
    body.innerHTML = `
      <div class="bw-welcome">
        <div class="bw-welcome-face">${petFace()}</div>
        <h3>👋 Hi, I'm ${esc(pet.name)}.</h3>
        <p>I'm right here with you. Ask about your symptoms, what your data shows, or what might help a flare.</p>
        <div class="bw-welcome-chips">
          <button type="button" data-bw-suggest="What does my symptom data show this month?">🔍 What does my data show?</button>
          <button type="button" data-bw-suggest="What can I try for a pain flare right now?">🌡 Help with a flare</button>
          <button type="button" data-bw-suggest="What's one thing I could try this week to feel better?">✨ One thing to try this week</button>
        </div>
      </div>`;
    body.querySelectorAll("[data-bw-suggest]").forEach((b) => {
      b.addEventListener("click", () => {
        const input = panel.querySelector("#bw-input");
        input.value = b.dataset.bwSuggest;
        panel.querySelector("#bw-send").disabled = false;
        input.focus();
      });
    });
  }
  function renderMessages(messages) {
    const body = panel.querySelector("#bw-body");
    if (!messages.length) { renderWelcome(); return; }
    body.innerHTML = messages.map(bubble).join("");
    body.scrollTop = body.scrollHeight;
  }
  function userAv() {
    if (myAvatar.url) return `<img src="${esc(myAvatar.url)}" alt="" />`;
    if (myAvatar.emoji) return esc(myAvatar.emoji);
    return "🌸";
  }
  function bubble(m) {
    const av = m.role === "user" ? userAv() : `<span class="bw-pet-face">${petFace()}</span>`;
    return `<div class="bw-msg ${m.role}">
      <div class="av${m.role === "assistant" ? " pet" : ""}">${av}</div>
      <div class="bb">${renderLite(m.content)}</div>
    </div>`;
  }
  // Apply pet name + face to the widget header AND the launcher button.
  function applyPetIdentity() {
    const t = panel.querySelector(".bw-head-title strong");
    if (t) t.textContent = pet.name;
    const a = panel.querySelector(".bw-head-avatar");
    if (a) a.innerHTML = pet.type ? `<span class="bw-pet-face">${petFace()}</span>` : "💬";
    const label = launcher.querySelector(".bw-launch-label");
    if (label) label.textContent = `Talk to ${pet.name}`;
    const face = launcher.querySelector(".bw-launch-face");
    if (face) face.innerHTML = pet.type ? `<span class="bw-pet-face">${petFace()}</span>` : "💬";
  }
  function appendBubble(role, content) {
    const body = panel.querySelector("#bw-body");
    if (body.querySelector(".bw-welcome")) body.innerHTML = "";
    body.insertAdjacentHTML("beforeend", bubble({ role, content }));
    body.scrollTop = body.scrollHeight;
  }
  function showTyping() {
    const body = panel.querySelector("#bw-body");
    body.insertAdjacentHTML("beforeend", `<div class="bw-msg assistant" id="bw-typing">
      <div class="av pet"><span class="bw-pet-face">${petFace()}</span></div>
      <div class="bb"><div class="bw-typing"><span class="d"></span><span class="d"></span><span class="d"></span></div></div>
    </div>`);
    body.scrollTop = body.scrollHeight;
  }
  function hideTyping() { panel.querySelector("#bw-typing")?.remove(); }

  function renderLite(text) {
    return esc(text)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\n/g, "<br>");
  }
  function esc(s) {
    return String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&#39;" })[c]);
  }

  // Styled confirm modal (shares .buddy-confirm styles from buddy.css, which
  // is loaded on /buddy; for other pages we inject minimal fallback styles).
  function bwConfirm({ title, body, confirmText = "Confirm", danger = false, onConfirm }) {
    let m = document.getElementById("bw-confirm");
    if (!m) {
      m = document.createElement("div");
      m.id = "bw-confirm";
      m.className = "buddy-confirm";
      m.innerHTML = `
        <div class="buddy-confirm-backdrop" data-bwc-cancel></div>
        <div class="buddy-confirm-card" role="dialog" aria-modal="true">
          <h3 id="bwc-title"></h3>
          <p id="bwc-body"></p>
          <div class="buddy-confirm-actions">
            <button type="button" class="btn-soft" id="bwc-cancel">Cancel</button>
            <button type="button" class="btn" id="bwc-confirm"></button>
          </div>
        </div>`;
      document.body.appendChild(m);
    }
    m.querySelector("#bwc-title").textContent = title;
    m.querySelector("#bwc-body").textContent = body;
    const cancel = m.querySelector("#bwc-cancel");
    const ok = m.querySelector("#bwc-confirm");
    ok.textContent = confirmText;
    ok.className = "btn " + (danger ? "btn-danger" : "btn-primary");
    const close = () => m.classList.remove("open");
    cancel.onclick = close;
    m.querySelector("[data-bwc-cancel]").onclick = close;
    ok.onclick = async () => { close(); await onConfirm?.(); };
    m.classList.add("open");
  }

  async function onSend(e) {
    e.preventDefault();
    const input = panel.querySelector("#bw-input");
    const send  = panel.querySelector("#bw-send");
    const text  = input.value.trim();
    if (!text || busy) return;
    busy = true; send.disabled = true;

    if (!activeConvId) {
      try {
        const r = await fetch("/api/me/buddy/conversations", { method: "POST", credentials: "same-origin" });
        if (!r.ok) throw new Error("create failed");
        const data = await r.json();
        activeConvId = data.id;
      } catch {
        busy = false; send.disabled = false;
        appendBubble("assistant", "⚠ Couldn't start a chat. Try again.");
        return;
      }
    }
    appendBubble("user", text);
    input.value = ""; input.style.height = "auto";
    showTyping();
    try {
      const r = await fetch(`/api/me/buddy/conversations/${activeConvId}/messages`, {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      const data = await r.json().catch(() => ({}));
      hideTyping();
      appendBubble("assistant", data.reply || data.error || "(no reply)");
    } catch {
      hideTyping();
      appendBubble("assistant", "⚠ Network hiccup. Try again.");
    } finally {
      busy = false;
      send.disabled = !panel.querySelector("#bw-input").value.trim();
    }
  }
})();
