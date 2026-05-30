// /buddy — health-focused chatbot.
console.info("EndoMe buddy build v1");

(() => {
  let conversations = [];
  let activeId = null;
  let busy = false;

  (async () => {
    try {
      const me = await fetchJson("/api/me/today");
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = me?.user?.displayName || me?.user?.username || "there";
      });
    } catch {}
    await loadConversations();
    // Open the most recent if any, else stay on the welcome screen.
    if (conversations.length) openConversation(conversations[0].id);
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
        if (!confirm("Delete this chat?")) return;
        try {
          await fetchJson(`/api/me/buddy/conversations/${b.dataset.delConv}`, { method: "DELETE" });
          if (activeId === +b.dataset.delConv) activeId = null;
          await loadConversations();
          if (!activeId) showWelcome();
        } catch (err) { toast(err.message || "Couldn't delete", "err"); }
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
        <span class="buddy-welcome-emoji">💬</span>
        <h1>Hi, I'm Buddy.</h1>
        <p>I'm here for your endo journey + the EndoMe app — nothing else. Ask about your symptoms, what an insight is telling you, how to log a flare, what stage 2 means, anything health-related.</p>
        <div class="buddy-suggestions">
          <button type="button" data-suggest="What does my symptom data show this month?">🔍 What does my data show?</button>
          <button type="button" data-suggest="How do I track a flare in the app?">📝 How do I log a flare?</button>
          <button type="button" data-suggest="What questions should I bring to my next gyno appointment?">🩺 Prep for my next appointment</button>
          <button type="button" data-suggest="What is endometriosis, in plain language?">🌸 What is endometriosis?</button>
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
  function msgBubble(m) {
    const avatar = m.role === "user" ? "🌸" : "💬";
    return `<div class="buddy-msg ${m.role}">
      <div class="avatar">${avatar}</div>
      <div class="bubble">${renderLite(m.content)}</div>
    </div>`;
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
      <div class="avatar">💬</div>
      <div class="bubble"><div class="buddy-typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span> Buddy is thinking…</div></div>
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
    } catch (err) { toast(err.message || "Couldn't start", "err"); }
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
