// /documents — private file storage backed by Cloudflare R2.
console.info("EndoMe documents build v1");

(() => {
  const KIND_ICO = {
    ultrasound: "🩻", scan: "🧠", report: "📋", lab: "🩸",
    letter: "✉️", prescription: "💊", image: "🖼️", other: "📄",
  };
  const KIND_LABEL = {
    ultrasound: "Ultrasound", scan: "MRI / CT scan", report: "Specialist report",
    lab: "Lab results", letter: "Doctor's letter", prescription: "Prescription",
    image: "Image", other: "Other",
  };
  const MAX_BYTES = 20 * 1024 * 1024;

  let pendingFile = null; // File picked, waiting for metadata
  let storageReady = true;
  const metaModal = document.getElementById("meta-modal");

  (async () => {
    try {
      const me = await fetchJson("/api/me/today");
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = me?.user?.displayName || me?.user?.username || "there";
      });
    } catch {}
    await load();
    document.getElementById("page-loader")?.classList.add("is-hidden");
  })();

  async function load() {
    try {
      const data = await fetchJson("/api/me/documents");
      storageReady = data.storageReady !== false;
      document.getElementById("storage-warn").hidden = storageReady;
      renderDocs(data.documents || []);
    } catch (err) {
      document.getElementById("doc-list").innerHTML =
        `<li class="empty-state">${escapeHtml(err.message || "Couldn't load.")}</li>`;
    }
  }

  function renderDocs(docs) {
    const el = document.getElementById("doc-list");
    if (!docs.length) {
      el.innerHTML = `<li class="empty-state">No documents yet. Drop one above to get started.</li>`;
      return;
    }
    el.innerHTML = docs.map(docCard).join("");
  }

  function docCard(d) {
    const isImage = (d.contentType || "").startsWith("image/");
    const sizeKb  = d.sizeBytes ? Math.max(1, Math.round(d.sizeBytes / 1024)) : 0;
    const fileUrl = `/api/me/documents/${d.id}/file`;
    return `<li class="doc-card">
      <a class="doc-thumb" href="${fileUrl}" target="_blank" rel="noopener" aria-label="Open ${escapeHtml(d.filename)}">
        ${isImage
          ? `<img src="${fileUrl}" alt="" loading="lazy" />`
          : `<span class="doc-thumb-icon">${KIND_ICO[d.kind] || "📄"}</span>`}
      </a>
      <div class="doc-body">
        <strong title="${escapeHtml(d.filename)}">${escapeHtml(d.filename)}</strong>
        <span class="doc-meta">${escapeHtml(KIND_LABEL[d.kind] || "Other")} · ${sizeKb} KB · ${relTime(d.uploadedAt)}</span>
        ${d.notes ? `<p class="doc-notes">${escapeHtml(d.notes)}</p>` : ""}
      </div>
      <div class="doc-actions">
        <a class="btn-soft small" href="${fileUrl}" target="_blank" rel="noopener">View</a>
        <a class="btn-soft small" href="${fileUrl}" download="${escapeHtml(d.filename)}">Download</a>
        <button class="btn-soft small danger" data-delete="${d.id}">Delete</button>
      </div>
    </li>`;
  }

  // --- Upload zone -----------------------------------------------------
  const zone  = document.getElementById("upload-zone");
  const input = document.getElementById("upload-input");
  document.getElementById("upload-pick").addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const files = [...input.files || []];
    input.value = "";
    if (files.length) startUpload(files[0]); // one at a time keeps the meta UX clean
  });
  ["dragenter", "dragover"].forEach((evt) =>
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.add("is-drop"); }));
  ["dragleave", "drop"].forEach((evt) =>
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.remove("is-drop"); }));
  zone.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) startUpload(f);
  });

  function startUpload(file) {
    if (file.size > MAX_BYTES) { toast("File too big — max 20 MB.", "err"); return; }
    pendingFile = file;
    document.getElementById("meta-filename").textContent = `${file.name} · ${Math.round(file.size / 1024)} KB`;
    document.getElementById("meta-form").reset();
    document.getElementById("meta-status").textContent = "";
    metaModal.classList.add("open"); metaModal.setAttribute("aria-hidden", "false");
  }

  document.querySelectorAll("[data-close-modal]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      metaModal.classList.remove("open"); metaModal.setAttribute("aria-hidden", "true");
    })
  );

  document.getElementById("meta-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!pendingFile) return;
    const form = e.target;
    const status = document.getElementById("meta-status");
    const statusBar = document.getElementById("upload-status");
    status.textContent = "Uploading…"; status.className = "form-status";
    statusBar.hidden = false; statusBar.textContent = `Uploading ${pendingFile.name}…`;
    try {
      await fetch("/api/me/documents", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": pendingFile.type || "application/octet-stream",
          "x-filename": pendingFile.name,
          "x-kind":     form.kind.value,
          "x-notes":    form.notes.value || "",
        },
        body: pendingFile,
      }).then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `Upload failed (${r.status})`);
        return data;
      });
      toast(`Uploaded ${pendingFile.name}`, "ok");
      pendingFile = null;
      metaModal.classList.remove("open"); metaModal.setAttribute("aria-hidden", "true");
      statusBar.hidden = true;
      await load();
    } catch (err) {
      status.textContent = err.message || "Couldn't upload.";
      status.className = "form-status err";
      statusBar.hidden = true;
    }
  });

  // --- Delete ----------------------------------------------------------
  document.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-delete]");
    if (!del) return;
    if (!confirm("Delete this document? This can't be undone.")) return;
    try {
      const res = await fetch(`/api/me/documents/${del.dataset.delete}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error("Couldn't delete");
      toast("Deleted", "ok");
      await load();
    } catch (err) { toast(err.message || "Couldn't delete", "err"); }
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
    return String(s ?? "").replace(/[<>&"']/g, (c) => ({
      "<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&#39;",
    })[c]);
  }
  function relTime(unixSec) {
    if (!unixSec) return "just now";
    const diff = Math.floor(Date.now() / 1000) - unixSec;
    if (diff < 60)    return "just now";
    if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
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
    setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 250); }, 2400);
  }
})();
