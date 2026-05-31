/* /messages — unified inbox.
   Buddy (the pet chatbot) is pinned at the top and uses the existing
   /api/me/buddy/conversations API under the hood — to the user it's
   just another conversation in the list. Friend DMs use the new
   /api/me/messages/dm endpoints. */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

let conversations = [];
let activeKey = null;       // "buddy" | userId
let activeKind = null;      // "buddy" | "friend"
let buddyConvId = null;     // active buddy conversation id (chat thread)
let petName = "Your Buddy";

function escapeHtml(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
function relTime(epochSec){
  if (!epochSec) return "";
  const diff = Math.floor(Date.now() / 1000) - epochSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m";
  if (diff < 86400) return Math.floor(diff / 3600) + "h";
  if (diff < 7 * 86400) return Math.floor(diff / 86400) + "d";
  return new Date(epochSec * 1000).toLocaleDateString();
}
function initials(name){
  if (!name) return "?";
  const parts = String(name).trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join("").toUpperCase();
}
async function api(path, opts = {}){
  const r = await fetch(path, { credentials: "same-origin", ...opts });
  const text = await r.text();
  let body = {}; try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  if (!r.ok) throw new Error(body.error || r.statusText || "Request failed");
  return body;
}
function toast(msg, tone = "ok"){
  const stack = $("#toast-stack"); if (!stack) return alert(msg);
  const t = document.createElement("div");
  t.className = `toast toast-${tone}`; t.textContent = msg;
  stack.appendChild(t);
  setTimeout(() => t.classList.add("toast-out"), 2200);
  setTimeout(() => t.remove(), 2700);
}

// --- Conversation list ---------------------------------------------------
async function loadConversations(){
  try {
    const data = await api("/api/me/messages/conversations");
    conversations = data.conversations || [];
    const buddy = conversations.find((c) => c.type === "buddy");
    if (buddy?.displayName) petName = buddy.displayName;
    paintList();
  } catch (err) {
    $("#msg-list").innerHTML = `<li class="msg-empty">Couldn't load: ${escapeHtml(err.message)}</li>`;
  }
  // Friend requests live next to the list.
  try {
    const fr = await api("/api/me/friends");
    paintFriendRequests(fr.incoming || []);
  } catch {}
}

function paintList(){
  const ul = $("#msg-list");
  const q = $("#msg-search-input").value.trim().toLowerCase();
  const filtered = conversations.filter((c) =>
    !q || c.displayName?.toLowerCase().includes(q) || c.username?.toLowerCase().includes(q)
  );
  if (!filtered.length) {
    ul.innerHTML = `<li class="msg-empty">No conversations yet. Tap ＋ to find a friend.</li>`;
    return;
  }
  // Group into Buddy (pinned), Active chats (friends with messages),
  // and Friends (accepted but never messaged yet) so the user can see
  // who's available to chat at a glance.
  const buddyRow  = filtered.find((c) => c.type === "buddy");
  const activeFriends = filtered.filter((c) => c.type === "friend" && c.lastAt);
  const idleFriends   = filtered.filter((c) => c.type === "friend" && !c.lastAt);
  const out = [];
  if (buddyRow) out.push(convRowHtml(buddyRow));
  if (activeFriends.length) {
    out.push(`<li class="msg-section-head">Chats</li>`);
    out.push(...activeFriends.map(convRowHtml));
  }
  if (idleFriends.length) {
    out.push(`<li class="msg-section-head">Friends <span class="msg-section-count">${idleFriends.length}</span></li>`);
    out.push(...idleFriends.map(convRowHtml));
  }
  if (!activeFriends.length && !idleFriends.length) {
    out.push(`<li class="msg-empty msg-empty-sub">No friends yet. Tap ＋ to find someone by their @handle.</li>`);
  }
  ul.innerHTML = out.join("");
}

// Cache the user's pet so the conversation-list Buddy row can show its
// actual SVG (luna/poppy/...) instead of a generic 🌸. Loaded once at
// page boot — refreshed cheaply only when the pet changes (rare).
let _petCache = null;
async function loadPet() {
  try {
    const r = await api("/api/me/pet");
    _petCache = r?.pet || r || null;
  } catch { _petCache = null; }
}
function buddyAvatarHtml(opts = {}) {
  const size = opts.size || 42;
  if (!_petCache || !window.PET_SVGS || !window.PET_SVGS[_petCache.type]) {
    return `<div class="ml-avatar ml-avatar-buddy" style="width:${size}px;height:${size}px;font-size:${Math.round(size*0.45)}px">🌸</div>`;
  }
  const wrap = document.createElement("div");
  wrap.className = "ml-avatar ml-avatar-pet";
  wrap.style.width = size + "px"; wrap.style.height = size + "px";
  window.renderPetSvgInto(wrap, {
    type: _petCache.type, mood: _petCache.mood, colorSeed: _petCache.colorSeed,
  });
  return wrap.outerHTML;
}

function convRowHtml(c){
  const key = c.type === "buddy" ? "buddy" : c.userId;
  const isActive = activeKey === key;
  const avatar = c.type === "buddy"
    ? buddyAvatarHtml({ size: 42 })
    : (c.avatarUrl
        ? `<div class="ml-avatar"><img src="${escapeHtml(c.avatarUrl)}" alt=""></div>`
        : c.avatar
          ? `<div class="ml-avatar" style="font-size:22px">${escapeHtml(c.avatar)}</div>`
          : `<div class="ml-avatar ml-avatar-text">${escapeHtml(initials(c.displayName))}</div>`);
  const preview = c.lastMessage
    ? `<span class="ml-preview ${c.unread ? "ml-unread" : ""}">${c.youSentLast ? "You: " : ""}${escapeHtml(c.lastMessage)}</span>`
    : `<span class="ml-preview ml-muted">${c.type === "buddy" ? "Tap to chat with your Buddy" : "Say hi 👋"}</span>`;
  const meta = c.lastAt
    ? `<span class="ml-time">${escapeHtml(relTime(c.lastAt))}</span>`
    : "";
  const badge = c.unread ? `<span class="ml-badge">${c.unread}</span>` : "";
  const pin = c.pinned ? `<span class="ml-pin" title="Pinned">📌</span>` : "";
  return `
    <li class="msg-row ${isActive ? "is-active" : ""}" data-key="${escapeHtml(key)}" data-kind="${c.type}" data-uid="${escapeHtml(c.userId || "")}">
      ${avatar}
      <div class="ml-body">
        <div class="ml-head"><strong>${escapeHtml(c.displayName)}</strong>${pin}<span class="ml-spacer"></span>${meta}</div>
        <div class="ml-foot">${preview}${badge}</div>
      </div>
    </li>`;
}

function paintFriendRequests(incoming){
  const section = $("#msg-requests");
  const list = $("#msg-requests-list");
  if (!incoming?.length) { section.hidden = true; return; }
  section.hidden = false;
  list.innerHTML = incoming.map((p) => `
    <li class="msg-req-row" data-uid="${escapeHtml(p.id)}">
      <div class="msg-req-name">
        <strong>${escapeHtml(p.displayName || p.alias || "Someone")}</strong>
        ${p.alias ? `<span>@${escapeHtml(p.alias)}</span>` : ""}
      </div>
      <div class="msg-req-actions">
        <button type="button" class="btn btn-primary btn-small" data-act="accept">Accept</button>
        <button type="button" class="btn btn-ghost btn-small" data-act="decline">Decline</button>
      </div>
    </li>`).join("");
}

// --- Thread (chat) -------------------------------------------------------
function clearThread(){
  $("#msg-thread-body").innerHTML = `
    <div class="msg-thread-empty">
      <span class="msg-thread-empty-icon">💬</span>
      <p>Pick a conversation to start.</p>
    </div>`;
  $("#msg-composer").hidden = true;
  $("#msg-thread-name").textContent = "—";
  $("#msg-thread-sub").textContent = "";
  $("#msg-thread-avatar").textContent = "💬";
  activeKey = null; activeKind = null; buddyConvId = null;
}

async function openConversation(key, kind, userId){
  activeKey = key; activeKind = kind;
  paintList(); // refresh active row highlight
  $("#msg-shell").classList.add("is-thread-open"); // mobile: switch view
  $("#msg-composer").hidden = false;
  if (kind === "buddy") {
    await openBuddyThread();
  } else {
    await openFriendThread(userId);
  }
  // Focus the composer on desktop. Skip on touch — keyboard would
  // otherwise pop and shove the chat off screen.
  if (!matchMedia("(max-width: 820px)").matches) {
    $("#msg-input").focus();
  }
}

async function openBuddyThread(){
  $("#msg-thread-name").textContent = petName;
  $("#msg-thread-sub").textContent = "Your EndoMe Buddy · always here";
  // Render the user's actual pet in the thread header + as the chip
  // next to every Buddy bubble. Falls back to 🌸 if the /api/me/pet
  // call hasn't returned yet.
  if (!_petCache) await loadPet();
  const headAvatar = $("#msg-thread-avatar");
  headAvatar.className = "msg-thread-avatar msg-thread-avatar-pet";
  if (_petCache && window.PET_SVGS?.[_petCache.type]) {
    window.renderPetSvgInto(headAvatar, {
      type: _petCache.type, mood: _petCache.mood, colorSeed: _petCache.colorSeed,
    });
  } else {
    headAvatar.innerHTML = "🌸";
  }
  _otherAvatarHtml = buddyAvatarHtml({ size: 30 });
  // Find-or-create the user's most-recent buddy conversation.
  try {
    const list = await api("/api/me/buddy/conversations");
    const conv = list.conversations?.[0];
    if (conv?.id) buddyConvId = conv.id;
    else {
      const c = await api("/api/me/buddy/conversations", { method: "POST" });
      buddyConvId = c.id;
    }
    const full = await api(`/api/me/buddy/conversations/${buddyConvId}`);
    paintMessages(
      // Server-side buddy_messages uses { content, createdAt } — DM rows
      // use { body, sentAt }. Normalise here so paintMessages doesn't
      // care which kind of thread it's painting.
      (full.messages || []).map((m) => ({
        fromMe: m.role === "user",
        body: m.content || "",
        sentAt: m.createdAt || 0,
        isBuddy: m.role === "assistant",
      })),
      petName
    );
  } catch (err) {
    paintError(err);
  }
}

async function openFriendThread(userId){
  try {
    const data = await api(`/api/me/messages/dm/${encodeURIComponent(userId)}`);
    const other = data.other;
    $("#msg-thread-name").textContent = other.displayName || other.alias || other.username;
    $("#msg-thread-sub").textContent = "@" + other.username;
    $("#msg-thread-avatar").className = "msg-thread-avatar";
    // Resolve the avatar in priority order: uploaded photo →
    // emoji avatar the user picked → initials fallback. The friend
    // chat was previously falling back to initials whenever the
    // server didn't return avatarUrl, even when the friend had
    // chosen an emoji avatar.
    if (other.avatarUrl) {
      $("#msg-thread-avatar").innerHTML = `<img src="${escapeHtml(other.avatarUrl)}" alt="">`;
      _otherAvatarHtml = `<div class="ml-avatar" style="width:30px;height:30px"><img src="${escapeHtml(other.avatarUrl)}" alt=""></div>`;
    } else if (other.avatar) {
      $("#msg-thread-avatar").textContent = other.avatar;
      _otherAvatarHtml = `<div class="ml-avatar" style="width:30px;height:30px;font-size:16px">${escapeHtml(other.avatar)}</div>`;
    } else {
      $("#msg-thread-avatar").textContent = initials(other.displayName);
      _otherAvatarHtml = `<div class="ml-avatar ml-avatar-text" style="width:30px;height:30px;font-size:11px">${escapeHtml(initials(other.displayName))}</div>`;
    }
    paintMessages(data.messages || [], other.displayName);
    // Re-render the conversation list so unread badge clears.
    loadConversations();
  } catch (err) {
    paintError(err);
  }
}

// Avatar for the OTHER side of the conversation (the small circle that
// sits next to their bubbles). We pull it from the active thread state
// so it's defined whether we're chatting with Buddy or a friend.
let _otherAvatarHtml = "";
function paintMessages(messages, otherName){
  const body = $("#msg-thread-body");
  if (!messages.length) {
    body.innerHTML = `
      <div class="msg-thread-empty">
        <span class="msg-thread-empty-icon">💬</span>
        <p>No messages yet — say hi to ${escapeHtml(otherName || "them")}.</p>
      </div>`;
    return;
  }
  // Group by day. Skip empty bubbles so a corrupt row doesn't render as
  // a phantom timestamp-only blob (which is what happened when the
  // buddy api was returning `content` and the client was reading
  // `body` — fixed, but the guard is cheap insurance).
  const filtered = messages.filter((m) => (m.body || "").length > 0);
  let lastDayKey = "";
  let lastFromMe = null;
  const html = filtered.map((m, idx) => {
    const d = new Date((m.sentAt || 0) * 1000);
    const dayKey = d.toDateString();
    let sep = "";
    if (dayKey !== lastDayKey) {
      sep = `<div class="msg-day-sep">${escapeHtml(d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }))}</div>`;
      lastDayKey = dayKey;
    }
    const cls = m.fromMe ? "msg-bubble msg-mine" : "msg-bubble " + (m.isBuddy ? "msg-buddy" : "msg-theirs");
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    // Only show the opponent avatar on the FIRST bubble in a run of
    // consecutive theirs-messages — iMessage / Messenger style.
    const showAvatar = !m.fromMe && (lastFromMe !== false || sep);
    lastFromMe = m.fromMe;
    const avatar = showAvatar ? `<div class="msg-row-avatar">${_otherAvatarHtml}</div>` : `<div class="msg-row-avatar msg-row-avatar-placeholder"></div>`;
    return `${sep}<div class="msg-bubble-row ${m.fromMe ? "row-mine" : "row-theirs"}">
      ${!m.fromMe ? avatar : ""}
      <div class="${cls}">${escapeHtml(m.body).replace(/\n/g, "<br>")}<span class="msg-time">${escapeHtml(time)}</span></div>
    </div>`;
  }).join("");
  body.innerHTML = `<div class="msg-thread-inner">${html}</div>`;
  body.scrollTop = body.scrollHeight;
}

function paintError(err){
  $("#msg-thread-body").innerHTML = `
    <div class="msg-thread-empty">
      <p>Couldn't load: ${escapeHtml(err.message || String(err))}</p>
    </div>`;
}

// --- Sending -------------------------------------------------------------
async function sendCurrent(text){
  if (!text.trim() || !activeKey) return;
  const body = text.trim();
  if (activeKind === "buddy") {
    if (!buddyConvId) return;
    // Optimistic: append the user's bubble while we wait.
    appendOwn(body);
    showTyping(true);
    try {
      await api(`/api/me/buddy/conversations/${buddyConvId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Buddy backend expects `content` (it's the AI-side field name);
        // friend DMs use `body`. Two different endpoints, two different
        // schemas — normalise on the client side.
        body: JSON.stringify({ content: body }),
      });
      const full = await api(`/api/me/buddy/conversations/${buddyConvId}`);
      paintMessages(
        (full.messages || []).map((m) => ({
          fromMe: m.role === "user",
          body: m.content || "",
          sentAt: m.createdAt || 0,
          isBuddy: m.role === "assistant",
        })),
        petName
      );
    } catch (err) {
      toast(`Couldn't send: ${err.message}`, "error");
    } finally {
      showTyping(false);
    }
  } else {
    appendOwn(body);
    try {
      await api(`/api/me/messages/dm/${encodeURIComponent(activeKey)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      loadConversations(); // refresh preview + sort
    } catch (err) {
      toast(`Couldn't send: ${err.message}`, "error");
    }
  }
}

function appendOwn(body){
  // Find or create the inner column so the bubble drops into the same
  // centred container as everything else.
  let inner = $("#msg-thread-body .msg-thread-inner");
  const empty = $("#msg-thread-body .msg-thread-empty");
  if (empty) empty.remove();
  if (!inner) {
    inner = document.createElement("div");
    inner.className = "msg-thread-inner";
    $("#msg-thread-body").appendChild(inner);
  }
  const wrap = document.createElement("div");
  wrap.className = "msg-bubble-row row-mine";
  wrap.innerHTML = `<div class="msg-bubble msg-mine">${escapeHtml(body).replace(/\n/g, "<br>")}<span class="msg-time">now</span></div>`;
  inner.appendChild(wrap);
  $("#msg-thread-body").scrollTop = $("#msg-thread-body").scrollHeight;
}

function showTyping(on){
  const id = "msg-typing-row";
  document.getElementById(id)?.remove();
  if (!on) return;
  let inner = $("#msg-thread-body .msg-thread-inner");
  if (!inner) {
    inner = document.createElement("div");
    inner.className = "msg-thread-inner";
    $("#msg-thread-body").appendChild(inner);
  }
  const row = document.createElement("div");
  row.id = id; row.className = "msg-bubble-row row-theirs";
  row.innerHTML = `<div class="msg-row-avatar">${_otherAvatarHtml}</div><div class="msg-bubble msg-buddy msg-typing"><span></span><span></span><span></span></div>`;
  inner.appendChild(row);
  $("#msg-thread-body").scrollTop = $("#msg-thread-body").scrollHeight;
}

// --- Friend search modal -------------------------------------------------
function openAddFriend(){
  const m = $("#modal-add-friend");
  m.classList.add("open");
  m.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  $("#friend-search").value = "";
  $("#friend-results").innerHTML = "";
  setTimeout(() => $("#friend-search").focus(), 80);
  m.querySelectorAll("[data-close-modal]").forEach((el) => {
    el.onclick = () => closeModal();
  });
}
function closeModal(){
  document.querySelectorAll(".modal.open").forEach((m) => {
    m.classList.remove("open");
    m.setAttribute("aria-hidden", "true");
  });
  document.body.classList.remove("modal-open");
}

let searchTimer = null;
async function runFriendSearch(){
  clearTimeout(searchTimer);
  const q = $("#friend-search").value.trim();
  if (q.length < 2) { $("#friend-results").innerHTML = `<li class="friend-empty">Type at least 2 characters.</li>`; return; }
  searchTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/me/friends/search?q=${encodeURIComponent(q)}`);
      const list = data.results || [];
      if (!list.length) { $("#friend-results").innerHTML = `<li class="friend-empty">No one found.</li>`; return; }
      $("#friend-results").innerHTML = list.map((u) => {
        let action = "";
        if (u.friendStatus === "friends") action = `<button class="btn btn-primary btn-small" data-act="chat" data-uid="${escapeHtml(u.id)}">💬 Chat</button>`;
        else if (u.friendStatus === "outgoing") action = `<span class="friend-pending">Request pending</span>`;
        else if (u.friendStatus === "incoming") action = `<button class="btn btn-primary btn-small" data-act="accept" data-uid="${escapeHtml(u.id)}">Accept</button>`;
        else action = `<button class="btn btn-primary btn-small" data-act="request" data-uid="${escapeHtml(u.id)}">Send request</button>`;
        return `<li class="friend-result">
          <div class="friend-avatar">${u.avatarUrl ? `<img src="${escapeHtml(u.avatarUrl)}" alt="">` : escapeHtml(initials(u.displayName || u.alias || "?"))}</div>
          <div class="friend-info">
            <strong>${escapeHtml(u.displayName || u.alias || "Someone")}</strong>
            ${u.alias ? `<span>@${escapeHtml(u.alias)}</span>` : `<span class="friend-noalias">no handle set</span>`}
          </div>
          ${action}
        </li>`;
      }).join("");
    } catch (err) {
      $("#friend-results").innerHTML = `<li class="friend-empty">${escapeHtml(err.message)}</li>`;
    }
  }, 200);
}

// --- Wire up -------------------------------------------------------------
$("#msg-list").addEventListener("click", (e) => {
  const row = e.target.closest(".msg-row");
  if (!row) return;
  const kind = row.dataset.kind;
  const key = row.dataset.key;
  const uid = row.dataset.uid;
  openConversation(key, kind, uid);
});

$("#msg-search-input").addEventListener("input", paintList);

$("#msg-new-btn").addEventListener("click", openAddFriend);

$("#msg-back-btn").addEventListener("click", () => {
  $("#msg-shell").classList.remove("is-thread-open");
  activeKey = null;
  paintList();
  clearThread();
});

// Friend-requests accept/decline
$("#msg-requests-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const row = btn.closest(".msg-req-row");
  const uid = row?.dataset.uid;
  if (!uid) return;
  btn.disabled = true;
  try {
    if (btn.dataset.act === "accept") {
      await api(`/api/me/friends/${encodeURIComponent(uid)}/accept`, { method: "POST" });
      toast("Friend request accepted");
    } else {
      await api(`/api/me/friends/${encodeURIComponent(uid)}/decline`, { method: "POST" });
      toast("Request declined");
    }
    loadConversations();
  } catch (err) { toast(err.message, "error"); btn.disabled = false; }
});

// Search modal actions
$("#friend-search").addEventListener("input", runFriendSearch);
$("#friend-results").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const uid = btn.dataset.uid;
  btn.disabled = true;
  try {
    if (btn.dataset.act === "request") {
      await api(`/api/me/friends/${encodeURIComponent(uid)}`, { method: "POST" });
      toast("Request sent");
      runFriendSearch();
    } else if (btn.dataset.act === "accept") {
      await api(`/api/me/friends/${encodeURIComponent(uid)}/accept`, { method: "POST" });
      toast("Friend added");
      loadConversations();
      closeModal();
      openConversation(uid, "friend", uid);
    } else if (btn.dataset.act === "chat") {
      closeModal();
      openConversation(uid, "friend", uid);
    }
  } catch (err) { toast(err.message, "error"); btn.disabled = false; }
});

// Composer
$("#msg-composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#msg-input");
  const text = input.value;
  input.value = "";
  autoResize(input);
  sendCurrent(text);
});
// Grow the composer textarea with content. Reset to "auto" first so
// scrollHeight reflects the true content height after deletions.
function autoResize(el){
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}
// Resize once at script load in case the textarea starts with content.
setTimeout(() => autoResize($("#msg-input")), 0);
$("#msg-input").addEventListener("input", (e) => autoResize(e.target));
$("#msg-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#msg-composer").dispatchEvent(new Event("submit"));
  }
});

// Escape closes any modal (defense-in-depth)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeModal();
    document.body.classList.remove("modal-open");
  }
});

// --- Polling: near-real-time updates without WebSockets ------------------
// Every 4s while the page is visible we re-fetch the conversation list +
// the currently-open thread (if it's a friend DM). When unread count goes
// up on a row that isn't currently open, ping a sound + favicon dot so
// the user knows even from another browser tab.
let _convPoll = null, _threadPoll = null;
let _lastUnreadTotal = 0;
let _newMsgPing = null;
function totalUnread(list) {
  return (list || []).reduce((s, c) => s + (c.unread || 0), 0);
}
function startPolling() {
  stopPolling();
  // Conversation list — keeps the sidebar previews + unread badges fresh.
  _convPoll = setInterval(async () => {
    if (document.hidden) return;
    try {
      const data = await api("/api/me/messages/conversations");
      const newList = data.conversations || [];
      const newUnread = totalUnread(newList);
      if (newUnread > _lastUnreadTotal && !document.hasFocus()) {
        // Tab unfocused + new unread → audible + favicon ping.
        pingNewMessage();
      }
      _lastUnreadTotal = newUnread;
      conversations = newList;
      paintList();
      // Reflect in the document title for tab-switchers.
      if (newUnread > 0) document.title = `(${newUnread}) Messages – EndoMe`;
      else document.title = `Messages – EndoMe`;
    } catch {}
  }, 4000);
  // Active thread — keeps the open conversation refreshed.
  _threadPoll = setInterval(async () => {
    if (document.hidden) return;
    if (!activeKey || activeKind !== "friend") return;
    try {
      const data = await api(`/api/me/messages/dm/${encodeURIComponent(activeKey)}`);
      // Only repaint if message count or last id changed — stops the
      // scroll position from jumping every poll.
      const sig = (data.messages || []).map((m) => `${m.id}:${m.body.length}`).join("|");
      if (sig !== _threadSig) {
        _threadSig = sig;
        const wasAtBottom = isThreadAtBottom();
        paintMessages(data.messages || [], data.other?.displayName || "");
        if (wasAtBottom) scrollThreadToBottom();
      }
    } catch {}
  }, 3000);
}
function stopPolling() {
  if (_convPoll) { clearInterval(_convPoll); _convPoll = null; }
  if (_threadPoll) { clearInterval(_threadPoll); _threadPoll = null; }
}
let _threadSig = "";
function isThreadAtBottom() {
  const el = $("#msg-thread-body");
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
function scrollThreadToBottom() {
  const el = $("#msg-thread-body");
  if (el) el.scrollTop = el.scrollHeight;
}
function pingNewMessage() {
  // A polite single chime — most browsers block autoplay so this is
  // best-effort. We construct an oscillator inline; no external file.
  try {
    if (!_newMsgPing) _newMsgPing = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _newMsgPing;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 720;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.4);
  } catch {}
}
// Pause polling when the tab loses focus, resume on return — saves
// battery on mobile.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else startPolling();
});

// Load + render the user's own profile chip at the top of the list pane
// (avatar + name + @handle, links to /profile).
async function loadMyProfile() {
  try {
    const data = await api("/api/me/profile");
    const p = data.profile || {};
    const card = $("#msg-me-card");
    const av = $("#msg-me-avatar");
    if (p.avatarUrl) av.innerHTML = `<img src="${escapeHtml(p.avatarUrl)}" alt="">`;
    else av.textContent = initials(p.name || p.displayName || p.alias || "?");
    $("#msg-me-name").textContent = p.displayName || p.alias || p.name || "Your profile";
    $("#msg-me-handle").textContent = p.alias ? "@" + p.alias : "Set your @handle in Profile →";
    card.title = "View your profile";
  } catch {}
}

// Bootstrap: read ?c=… so /buddy and other deep-links land on the right
// conversation.
window.addEventListener("DOMContentLoaded", async () => {
  loadMyProfile();
  // Load pet BEFORE the conversation list so the Buddy row's avatar
  // can render the actual pet SVG on first paint.
  await loadPet();
  await loadConversations();
  _lastUnreadTotal = totalUnread(conversations);
  const params = new URLSearchParams(location.search);
  const want = params.get("c");
  if (want === "buddy" || !want) {
    // Default to opening Buddy on desktop, leave mobile on the list.
    if (!matchMedia("(max-width: 820px)").matches) openConversation("buddy", "buddy");
  } else {
    openConversation(want, "friend", want);
  }
  $("#page-loader")?.classList.add("is-hidden");
  startPolling();
});
