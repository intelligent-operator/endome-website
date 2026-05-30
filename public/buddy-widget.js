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
  launcher.setAttribute("aria-label", "Open Buddy chat");
  launcher.innerHTML = `<span>💬</span><span>Buddy</span>`;

  const panel = document.createElement("section");
  panel.className = "bw-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Buddy chat");
  panel.innerHTML = `
    <header class="bw-head">
      <div class="bw-head-avatar">💬</div>
      <div class="bw-head-title">
        <strong>Buddy</strong>
        <span><span class="bw-dot"></span> Health companion · online</span>
      </div>
      <div class="bw-head-actions">
        <a href="/buddy" title="Open full chat" aria-label="Open full chat">↗</a>
        <button type="button" data-bw-close title="Close" aria-label="Close">×</button>
      </div>
    </header>
    <div class="bw-body" id="bw-body"></div>
    <form class="bw-input-row" id="bw-form">
      <textarea id="bw-input" rows="1" placeholder="Ask Buddy…" maxlength="4000"></textarea>
      <button type="submit" id="bw-send" disabled>Send</button>
    </form>
    <p class="bw-foot">Focused on your endo journey + the EndoMe app. <a href="/buddy">See full chat →</a></p>`;

  // If the host page already has a .fab-buddy link (we shipped that on
  // /dashboard before this widget existed), drop it — the launcher replaces it.
  document.querySelectorAll(".fab-buddy").forEach((el) => el.remove());

  document.addEventListener("DOMContentLoaded", () => {
    document.body.appendChild(launcher);
    document.body.appendChild(panel);
    wire();
  }, { once: true });

  // ---- State -------------------------------------------------------------
  let activeConvId = null;
  let busy = false;
  let opened = false;
  let loadedOnce = false;

  function wire() {
    launcher.addEventListener("click", openPanel);
    panel.querySelector("[data-bw-close]").addEventListener("click", closePanel);
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
    panel.hidden = false;
    panel.querySelector("#bw-input").focus();
    if (!loadedOnce) {
      loadedOnce = true;
      await loadMostRecent();
    }
  }
  function closePanel() {
    opened = false;
    panel.hidden = true;
    launcher.hidden = false;
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
        <h3>👋 Hi, I'm Buddy.</h3>
        <p>Quick questions about your symptoms, the app, or endo? Ask away.</p>
        <div class="bw-welcome-chips">
          <button type="button" data-bw-suggest="What does my symptom data show this month?">🔍 What does my data show?</button>
          <button type="button" data-bw-suggest="How do I track a flare in the app?">📝 How do I log a flare?</button>
          <button type="button" data-bw-suggest="What questions should I bring to my next gyno appointment?">🩺 Prep for my next appointment</button>
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
  function bubble(m) {
    const av = m.role === "user" ? "🌸" : "💬";
    return `<div class="bw-msg ${m.role}">
      <div class="av">${av}</div>
      <div class="bb">${renderLite(m.content)}</div>
    </div>`;
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
      <div class="av">💬</div>
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
