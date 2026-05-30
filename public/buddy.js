// /buddy — health-focused chatbot.
console.info("EndoMe buddy build v1");

(() => {
  let conversations = [];
  let activeId = null;
  let busy = false;
  let myAvatar = { url: null, emoji: null };
  let pet = { name: "Buddy", type: null };

  // Compact pet face SVGs (same art as onboarding) keyed by pet type — used
  // as the companion's avatar so Buddy looks like the user's own EndoPet.
  const PET_FACES = {
    luna:  `<svg viewBox="0 0 140 140"><path d="M40 60 L26 30 L48 46 Z" fill="#ff8aab"/><path d="M100 60 L114 30 L92 46 Z" fill="#ff8aab"/><ellipse cx="70" cy="92" rx="34" ry="26" fill="#ff9bb3"/><circle cx="70" cy="72" r="32" fill="#ffb6c8"/><circle cx="59" cy="74" r="4.5" fill="#2c1320"/><circle cx="81" cy="74" r="4.5" fill="#2c1320"/><path d="M67 86 q3 3 6 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>`,
    poppy: `<svg viewBox="0 0 140 140"><ellipse cx="44" cy="80" rx="14" ry="20" fill="#e8a86a"/><ellipse cx="96" cy="80" rx="14" ry="20" fill="#e8a86a"/><circle cx="70" cy="72" r="32" fill="#f5c184"/><circle cx="59" cy="72" r="4.5" fill="#2c1320"/><circle cx="81" cy="72" r="4.5" fill="#2c1320"/><ellipse cx="70" cy="84" rx="3.5" ry="2.5" fill="#2c1320"/><path d="M66 90 q4 4 8 0" stroke="#2c1320" stroke-width="1.6" fill="none"/></svg>`,
    mochi: `<svg viewBox="0 0 140 140"><ellipse cx="52" cy="34" rx="9" ry="22" fill="#dcd0f0"/><ellipse cx="88" cy="34" rx="9" ry="22" fill="#dcd0f0"/><circle cx="70" cy="72" r="30" fill="#f0e6fb"/><circle cx="60" cy="74" r="4.5" fill="#2c1320"/><circle cx="80" cy="74" r="4.5" fill="#2c1320"/><path d="M68 84 l2 2 l2 -2 z" fill="#ff7a99"/></svg>`,
    sunny: `<svg viewBox="0 0 140 140"><path d="M40 38 L52 60 L34 56 Z" fill="#e8762a"/><path d="M100 38 L88 60 L106 56 Z" fill="#e8762a"/><circle cx="70" cy="72" r="32" fill="#f08b3a"/><path d="M70 60 Q50 72 56 92 Q70 86 70 86 Q70 86 84 92 Q90 72 70 60 Z" fill="#fff"/><circle cx="60" cy="72" r="4.5" fill="#2c1320"/><circle cx="80" cy="72" r="4.5" fill="#2c1320"/></svg>`,
    coco:  `<svg viewBox="0 0 140 140"><circle cx="34" cy="58" r="16" fill="#9d8fc7"/><circle cx="106" cy="58" r="16" fill="#9d8fc7"/><circle cx="70" cy="68" r="30" fill="#b5a7d8"/><circle cx="60" cy="68" r="4.5" fill="#2c1320"/><circle cx="80" cy="68" r="4.5" fill="#2c1320"/><ellipse cx="70" cy="82" rx="9" ry="7" fill="#2c1320"/></svg>`,
    kiki:  `<svg viewBox="0 0 140 140"><ellipse cx="56" cy="34" rx="6" ry="20" fill="#d9a872"/><ellipse cx="84" cy="34" rx="6" ry="20" fill="#d9a872"/><ellipse cx="70" cy="70" rx="28" ry="26" fill="#e8b985"/><circle cx="60" cy="68" r="4.5" fill="#2c1320"/><circle cx="80" cy="68" r="4.5" fill="#2c1320"/><ellipse cx="70" cy="80" rx="3.5" ry="2.5" fill="#2c1320"/></svg>`,
  };
  const petFace = () => PET_FACES[pet.type] || "💬";

  (async () => {
    try {
      const me = await fetchJson("/api/me/today");
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = me?.user?.displayName || me?.user?.username || "there";
      });
      myAvatar = { url: me?.user?.avatarUrl || null, emoji: me?.user?.avatar || null };
      if (me?.pet?.name) pet = { name: me.pet.name, type: me.pet.type || null };
      applyPetIdentity();
    } catch {}
    await loadConversations();
    // Open the most recent if any, else stay on the welcome screen.
    if (conversations.length) openConversation(conversations[0].id);
    else showWelcome();
    document.getElementById("page-loader")?.classList.add("is-hidden");
  })();

  async function loadConversations() {
    try {
      const data = await fetchJson("/api/me/buddy/conversations");
      conversations = data.conversations || [];
      paintHistory();
    } catch (err) {
      document.getElementById("buddy-history-list").innerHTML =
        `<li class="empty-state small">${escapeHtml(err.message || "Couldn't load.")}</li>`;
    }
  }
  function paintHistory() {
    const list = document.getElementById("buddy-history-list");
    if (!conversations.length) {
      list.innerHTML = `<li class="empty-state small">No chats yet — say hi below.</li>`;
      return;
    }
    list.innerHTML = conversations.map((c) => `<li class="buddy-history-item ${c.id === activeId ? "is-active" : ""}" data-conv="${c.id}">
      <span class="ttl">${escapeHtml(c.title || "New chat")}</span>
      <span class="meta">
        <span>${c.messageCount || 0} msg${c.messageCount === 1 ? "" : "s"}</span>
        <button type="button" class="del" data-del-conv="${c.id}" aria-label="Delete chat">×</button>
      </span>
    </li>`).join("");
    list.querySelectorAll("[data-conv]").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-del-conv]")) return;
        openConversation(+row.dataset.conv);
      });
    });
    list.querySelectorAll("[data-del-conv]").forEach((b) => {
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        const convId = +b.dataset.delConv;
        const title = b.closest(".buddy-history-item")?.querySelector(".ttl")?.textContent || "this chat";
        confirmModal({
          title: "Delete chat?",
          body: `"${title}" and all its messages will be permanently removed. This can't be undone.`,
          confirmText: "Delete",
          danger: true,
          onConfirm: async () => {
            try {
              await fetchJson(`/api/me/buddy/conversations/${convId}`, { method: "DELETE" });
              if (activeId === convId) activeId = null;
              await loadConversations();
              if (!activeId) showWelcome();
              toast("Chat deleted", "ok");
            } catch (err) { toast(err.message || "Couldn't delete", "err"); }
          },
        });
      });
    });
  }

  async function openConversation(id) {
    activeId = id;
    paintHistory();
    const chat = document.getElementById("buddy-chat");
    chat.innerHTML = `<p class="empty-state small">Loading…</p>`;
    try {
      const data = await fetchJson(`/api/me/buddy/conversations/${id}`);
      renderMessages(data.messages || []);
    } catch (err) {
      chat.innerHTML = `<p class="empty-state">${escapeHtml(err.message || "Couldn't load.")}</p>`;
    }
  }
  function showWelcome() {
    document.getElementById("buddy-chat").innerHTML = `
      <div class="buddy-welcome">
        <span class="buddy-welcome-emoji buddy-pet-face lg">${petFace()}</span>
        <h1>Hi, I'm ${escapeHtml(pet.name)}.</h1>
        <p>I'm right here with you on your endo journey. Ask me about your symptoms, what your data is showing, what might help a flare, or anything about EndoMe.</p>
        <div class="buddy-suggestions">
          <button type="button" data-suggest="What does my symptom data show this month?">🔍 What does my data show?</button>
          <button type="button" data-suggest="What can I try for a pain flare right now?">🌡 Help with a flare</button>
          <button type="button" data-suggest="What might be driving my symptoms based on my data?">🧩 What's driving my symptoms?</button>
          <button type="button" data-suggest="What's one thing I could try this week to feel better?">✨ One thing to try this week</button>
        </div>
      </div>`;
    wireSuggestions();
  }
  function wireSuggestions() {
    document.querySelectorAll("[data-suggest]").forEach((b) => {
      b.addEventListener("click", () => {
        document.getElementById("buddy-input").value = b.dataset.suggest;
        refreshSendBtn();
        document.getElementById("buddy-input").focus();
      });
    });
  }
  function renderMessages(messages) {
    const chat = document.getElementById("buddy-chat");
    if (!messages.length) {
      chat.innerHTML = `<p class="empty-state">No messages yet — say something below.</p>`;
      return;
    }
    chat.innerHTML = messages.map(msgBubble).join("");
    chat.scrollTop = chat.scrollHeight;
  }
  function userAvatarHtml() {
    if (myAvatar.url) return `<img src="${escapeHtml(myAvatar.url)}" alt="" />`;
    if (myAvatar.emoji) return escapeHtml(myAvatar.emoji);
    return "🌸";
  }
  function msgBubble(m) {
    const avatar = m.role === "user" ? userAvatarHtml()
      : `<span class="buddy-pet-face">${petFace()}</span>`;
    return `<div class="buddy-msg ${m.role}">
      <div class="avatar${m.role === "assistant" ? " pet" : ""}">${avatar}</div>
      <div class="bubble">${renderLite(m.content)}</div>
    </div>`;
  }

  // Apply the pet's name + face to the page chrome (history header, welcome).
  function applyPetIdentity() {
    document.querySelectorAll("[data-buddy-name]").forEach((el) => { el.textContent = pet.name; });
    const histH2 = document.querySelector(".buddy-history-head h2");
    if (histH2) histH2.innerHTML = `<span class="buddy-pet-face sm">${petFace()}</span> ${escapeHtml(pet.name)}`;
  }
  // Lightweight markdown-ish renderer for assistant bubbles: bold, italic,
  // line breaks, and links. Plain text otherwise.
  function renderLite(text) {
    return escapeHtml(text)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\n/g, "<br>");
  }

  function appendMessage(role, content) {
    const chat = document.getElementById("buddy-chat");
    if (chat.querySelector(".buddy-welcome")) chat.innerHTML = "";
    chat.insertAdjacentHTML("beforeend", msgBubble({ role, content }));
    chat.scrollTop = chat.scrollHeight;
  }
  function showTyping() {
    const chat = document.getElementById("buddy-chat");
    chat.insertAdjacentHTML("beforeend", `<div class="buddy-msg assistant" id="buddy-typing-row">
      <div class="avatar pet"><span class="buddy-pet-face">${petFace()}</span></div>
      <div class="bubble"><div class="buddy-typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span> ${escapeHtml(pet.name)} is thinking…</div></div>
    </div>`);
    chat.scrollTop = chat.scrollHeight;
  }
  function hideTyping() { document.getElementById("buddy-typing-row")?.remove(); }

  // --- Input + send ---------------------------------------------------
  const input = document.getElementById("buddy-input");
  const sendBtn = document.getElementById("buddy-send");
  function refreshSendBtn() {
    sendBtn.disabled = busy || !input.value.trim();
  }
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(160, input.scrollHeight) + "px";
    refreshSendBtn();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); document.getElementById("buddy-form").requestSubmit(); }
  });
  document.getElementById("buddy-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true; refreshSendBtn();
    // Lazily create a conversation if there isn't one yet.
    if (!activeId) {
      try {
        const r = await fetchJson("/api/me/buddy/conversations", { method: "POST" });
        activeId = r.id;
      } catch (err) { toast(err.message || "Couldn't start a chat", "err"); busy = false; refreshSendBtn(); return; }
    }
    appendMessage("user", text);
    input.value = ""; input.style.height = "auto";
    showTyping();
    try {
      const data = await fetchJson(`/api/me/buddy/conversations/${activeId}/messages`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      hideTyping();
      appendMessage("assistant", data.reply || data.error || "(no reply)");
      await loadConversations();
    } catch (err) {
      hideTyping();
      appendMessage("assistant", "⚠ " + (err.message || "Couldn't send"));
    } finally {
      busy = false; refreshSendBtn();
    }
  });
  wireSuggestions();
  refreshSendBtn();

  // --- New chat --------------------------------------------------------
  document.getElementById("btn-new-chat").addEventListener("click", async () => {
    try {
      const r = await fetchJson("/api/me/buddy/conversations", { method: "POST" });
      activeId = r.id;
      await loadConversations();
      showWelcome();
      input.focus();
      closeHistoryDrawer();
    } catch (err) { toast(err.message || "Couldn't start", "err"); }
  });

  // --- Mobile / tablet history drawer toggle --------------------------
  // On screens narrower than 1080px the history column is hidden by
  // default. The chat-area header (rendered via CSS ::before) is
  // clickable and opens the history as a full-screen drawer. Clicking a
  // chat (or X anywhere) closes it. Reuses the existing markup — no DOM
  // changes needed.
  const historyEl = document.querySelector(".buddy-history");
  const mainEl = document.querySelector(".buddy-main");
  function openHistoryDrawer()  { historyEl?.classList.add("is-open"); document.body.style.overflow = "hidden"; }
  function closeHistoryDrawer() { historyEl?.classList.remove("is-open"); document.body.style.overflow = ""; }
  mainEl?.addEventListener("click", (e) => {
    // Only fire when tapping the CSS pseudo "💬 Chats" header strip,
    // which sits at y < ~40 within main.
    const r = mainEl.getBoundingClientRect();
    if (e.clientY - r.top < 44 && !e.target.closest(".buddy-chat,.buddy-input-row,form,button")) {
      openHistoryDrawer();
    }
  });
  // Tapping any chat tile (delegated handler) closes the drawer too.
  document.getElementById("buddy-history-list")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-conv]") && !e.target.closest("[data-del-conv]")) {
      setTimeout(closeHistoryDrawer, 50);
    }
  });
  // Esc closes the drawer.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && historyEl?.classList.contains("is-open")) closeHistoryDrawer();
  });

  // --- Confirmation modal (replaces native confirm) -------------------
  function confirmModal({ title, body, confirmText = "Confirm", cancelText = "Cancel", danger = false, onConfirm }) {
    let modal = document.getElementById("buddy-confirm-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "buddy-confirm-modal";
      modal.className = "buddy-confirm";
      modal.innerHTML = `
        <div class="buddy-confirm-backdrop" data-bc-cancel></div>
        <div class="buddy-confirm-card" role="dialog" aria-modal="true">
          <h3 id="bc-title"></h3>
          <p id="bc-body"></p>
          <div class="buddy-confirm-actions">
            <button type="button" class="btn-soft" id="bc-cancel"></button>
            <button type="button" class="btn" id="bc-confirm"></button>
          </div>
        </div>`;
      document.body.appendChild(modal);
    }
    modal.querySelector("#bc-title").textContent = title;
    modal.querySelector("#bc-body").textContent = body;
    const cancelBtn = modal.querySelector("#bc-cancel");
    const confirmBtn = modal.querySelector("#bc-confirm");
    cancelBtn.textContent = cancelText;
    confirmBtn.textContent = confirmText;
    confirmBtn.className = "btn " + (danger ? "btn-danger" : "btn-primary");
    const close = () => { modal.classList.remove("open"); };
    cancelBtn.onclick = close;
    modal.querySelector("[data-bc-cancel]").onclick = close;
    confirmBtn.onclick = async () => { close(); await onConfirm?.(); };
    modal.classList.add("open");
    confirmBtn.focus();
  }

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
