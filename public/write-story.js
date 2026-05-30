/* /write-story — author a multi-chapter community story with photos.
   Routes:
     /write-story?id=N   edit existing
     /write-story        create new (auto-creates a draft on first save)
*/
const $ = (sel, root = document) => root.querySelector(sel);

const urlParams = new URLSearchParams(location.search);
let storyId = urlParams.get("id") ? +urlParams.get("id") : null;
let story = null;
let chapters = [];

const STATUS_LABEL = {
  draft:     { label: "Draft",                       tone: "draft" },
  submitted: { label: "Submitted — awaiting review", tone: "submitted" },
  approved:  { label: "Approved",                    tone: "approved" },
  rejected:  { label: "Needs changes",               tone: "rejected" },
  published: { label: "Published ✨",                tone: "published" },
};

function escapeHtml(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
function toast(msg, tone = "ok") {
  const stack = $("#toast-stack"); if (!stack) return alert(msg);
  const t = document.createElement("div");
  t.className = `toast toast-${tone}`; t.textContent = msg;
  stack.appendChild(t);
  setTimeout(() => t.classList.add("toast-out"), 2200);
  setTimeout(() => t.remove(), 2700);
}

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: "same-origin", ...opts });
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

async function loadStory() {
  if (!storyId) { paintEmpty(); return; }
  try {
    const data = await api(`/api/me/stories/${storyId}`);
    story = data.story; chapters = data.chapters || [];
    paint();
  } catch (err) {
    toast(`Couldn't load: ${err.message}`, "error");
    storyId = null; paintEmpty();
  }
}

function paintEmpty() {
  $("#ws-title").textContent = "Write your story";
  $("#ws-status").hidden = true;
  $("#ws-recall-btn").hidden = true;
  $("#ws-chapters").innerHTML = `<li class="ws-empty">Save your title and cover first, then add chapters.</li>`;
}

function paint() {
  $("#ws-title").textContent = story.title || "Untitled story";
  $("#ws-title-input").value = story.title || "";
  $("#ws-summary-input").value = story.summary || "";

  // Status pill
  const slot = $("#ws-status");
  const meta = STATUS_LABEL[story.status] || { label: story.status, tone: "draft" };
  slot.hidden = false;
  slot.className = `ws-status ws-status-${meta.tone}`;
  slot.innerHTML = `
    <strong>${escapeHtml(meta.label)}</strong>
    ${story.reject_reason ? `<p class="ws-reject-reason">Reviewer feedback: <em>${escapeHtml(story.reject_reason)}</em></p>` : ""}
  `;

  // Cover
  const cover = $("#ws-cover-art");
  if (story.coverImageUrl) {
    cover.innerHTML = `<img src="${escapeHtml(story.coverImageUrl)}" alt="" />`;
  } else {
    cover.innerHTML = `<span class="ws-cover-placeholder">No cover image yet</span>`;
  }

  // Locked state when not draft/rejected
  const locked = story.status !== "draft" && story.status !== "rejected";
  for (const id of ["ws-title-input","ws-summary-input","ws-save-meta","ws-add-chapter","ws-cover-file","ws-delete-btn"]) {
    const el = $("#" + id); if (el) el.disabled = locked;
  }
  $("#ws-submit-btn").hidden = locked || !chapters.length;
  $("#ws-recall-btn").hidden = !locked || story.status === "published";

  // Chapters
  paintChapters(locked);
}

function paintChapters(locked) {
  const list = $("#ws-chapters");
  if (!chapters.length) {
    list.innerHTML = `<li class="ws-empty">No chapters yet. Tap "+ Add chapter" to start.</li>`;
    return;
  }
  list.innerHTML = chapters.map((c, i) => `
    <li class="ws-chapter" data-id="${c.id}">
      <header class="ws-chapter-head">
        <span class="ws-chapter-num">Chapter ${i + 1}</span>
        ${!locked ? `<div class="ws-chapter-actions">
          ${i > 0 ? `<button type="button" class="ws-icon-btn" data-move-up>↑</button>` : ""}
          ${i < chapters.length - 1 ? `<button type="button" class="ws-icon-btn" data-move-down>↓</button>` : ""}
          <button type="button" class="ws-icon-btn ws-danger" data-delete>✕</button>
        </div>` : ""}
      </header>
      <input type="text" class="ws-ch-heading" placeholder="Chapter heading…" value="${escapeHtml(c.heading || "")}" ${locked ? "disabled" : ""} maxlength="200" />
      <textarea class="ws-ch-body" rows="6" placeholder="Tell this part of the story…" ${locked ? "disabled" : ""} maxlength="8000">${escapeHtml(c.body || "")}</textarea>
      <div class="ws-ch-image-row">
        <div class="ws-ch-image">
          ${c.imageUrl ? `<img src="${escapeHtml(c.imageUrl)}" alt="" />` : `<span class="ws-cover-placeholder small">No photo</span>`}
        </div>
        ${!locked ? `<label class="btn btn-ghost btn-small">
          📷 Upload photo
          <input type="file" accept="image/*" data-ch-image hidden />
        </label>` : ""}
      </div>
      ${!locked ? `<button type="button" class="btn btn-ghost btn-small" data-save-chapter>💾 Save chapter</button>` : ""}
    </li>
  `).join("");
}

// --- Meta save (title, summary, creates draft if first save) -------------
async function saveMeta() {
  const title = $("#ws-title-input").value.trim();
  const summary = $("#ws-summary-input").value.trim();
  if (!title) { toast("Add a title first", "error"); return; }
  try {
    if (!storyId) {
      const res = await api("/api/me/stories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, summary }) });
      storyId = res.id;
      history.replaceState({}, "", `/write-story?id=${storyId}`);
    } else {
      await api(`/api/me/stories/${storyId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, summary }) });
    }
    toast("Saved");
    await loadStory();
  } catch (err) { toast(`Couldn't save: ${err.message}`, "error"); }
}

// --- Cover upload --------------------------------------------------------
async function uploadCover(file) {
  if (!storyId) { toast("Save the title first", "error"); return; }
  const fd = new FormData(); fd.append("file", file);
  try {
    await api(`/api/me/stories/${storyId}/cover`, { method: "POST", body: fd });
    toast("Cover saved");
    await loadStory();
  } catch (err) { toast(`Upload failed: ${err.message}`, "error"); }
}

// --- Chapter operations --------------------------------------------------
async function addChapter() {
  if (!storyId) { await saveMeta(); if (!storyId) return; }
  try {
    await api(`/api/me/stories/${storyId}/chapters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ heading: "", body: "" }),
    });
    await loadStory();
  } catch (err) { toast(`Couldn't add: ${err.message}`, "error"); }
}

async function saveChapter(chId, heading, body) {
  try {
    await api(`/api/me/stories/${storyId}/chapters/${chId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ heading, body }),
    });
    toast("Chapter saved");
  } catch (err) { toast(`Couldn't save: ${err.message}`, "error"); }
}

async function deleteChapter(chId) {
  if (!confirm("Delete this chapter?")) return;
  try {
    await api(`/api/me/stories/${storyId}/chapters/${chId}`, { method: "DELETE" });
    await loadStory();
  } catch (err) { toast(`Couldn't delete: ${err.message}`, "error"); }
}

async function moveChapter(chId, dir) {
  const idx = chapters.findIndex((c) => c.id === chId);
  if (idx < 0) return;
  const swapWith = chapters[idx + dir];
  if (!swapWith) return;
  try {
    await Promise.all([
      api(`/api/me/stories/${storyId}/chapters/${chId}`,       { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ position: swapWith.position }) }),
      api(`/api/me/stories/${storyId}/chapters/${swapWith.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ position: chapters[idx].position }) }),
    ]);
    await loadStory();
  } catch (err) { toast(`Couldn't reorder: ${err.message}`, "error"); }
}

async function uploadChapterImage(chId, file) {
  const fd = new FormData(); fd.append("file", file);
  try {
    await api(`/api/me/stories/${storyId}/chapters/${chId}/image`, { method: "POST", body: fd });
    toast("Photo saved");
    await loadStory();
  } catch (err) { toast(`Upload failed: ${err.message}`, "error"); }
}

// --- Submit / recall / delete -------------------------------------------
async function submitForReview() {
  if (!storyId) return;
  if (!confirm("Submit your story for review? You won't be able to edit until it's reviewed.")) return;
  try {
    await api(`/api/me/stories/${storyId}/submit`, { method: "POST" });
    toast("Submitted for review");
    await loadStory();
  } catch (err) { toast(`Couldn't submit: ${err.message}`, "error"); }
}

async function recallToDraft() {
  if (!storyId) return;
  if (!confirm("Recall to draft? You can edit again, but you'll need to resubmit.")) return;
  try {
    await api(`/api/me/stories/${storyId}/recall`, { method: "POST" });
    toast("Recalled to draft");
    await loadStory();
  } catch (err) { toast(`Couldn't recall: ${err.message}`, "error"); }
}

async function deleteStory() {
  if (!storyId) { location.href = "/community"; return; }
  if (!confirm("Delete this story permanently? This can't be undone.")) return;
  try {
    await api(`/api/me/stories/${storyId}`, { method: "DELETE" });
    toast("Story deleted");
    location.href = "/community";
  } catch (err) { toast(`Couldn't delete: ${err.message}`, "error"); }
}

// --- Wire up -------------------------------------------------------------
$("#ws-save-meta").addEventListener("click", saveMeta);
$("#ws-cover-file").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) uploadCover(f); });
$("#ws-add-chapter").addEventListener("click", addChapter);
$("#ws-submit-btn").addEventListener("click", submitForReview);
$("#ws-recall-btn").addEventListener("click", recallToDraft);
$("#ws-delete-btn").addEventListener("click", deleteStory);

document.addEventListener("click", (e) => {
  const li = e.target.closest?.(".ws-chapter");
  if (!li) return;
  const chId = +li.dataset.id;
  if (e.target.closest("[data-delete]")) deleteChapter(chId);
  else if (e.target.closest("[data-move-up]")) moveChapter(chId, -1);
  else if (e.target.closest("[data-move-down]")) moveChapter(chId, 1);
  else if (e.target.closest("[data-save-chapter]")) {
    const heading = li.querySelector(".ws-ch-heading").value;
    const body = li.querySelector(".ws-ch-body").value;
    saveChapter(chId, heading, body);
  }
});

document.addEventListener("change", (e) => {
  if (e.target.matches("[data-ch-image]")) {
    const li = e.target.closest(".ws-chapter");
    const chId = +li.dataset.id;
    const file = e.target.files?.[0];
    if (file) uploadChapterImage(chId, file);
  }
});

window.addEventListener("DOMContentLoaded", () => {
  loadStory().finally(() => $("#page-loader")?.classList.add("is-hidden"));
});
