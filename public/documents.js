// /documents — private file storage backed by Cloudflare R2, plus an AI
// reviewer that pulls structured findings out of each upload.
console.info("EndoMe documents build v2");

(() => {
  // Order here drives the folder strip; matches server's ALLOWED_DOC_KINDS.
  const FOLDERS = [
    { id: "all",          icon: "📁", label: "All documents" },
    { id: "ultrasound",   icon: "🩻", label: "Ultrasounds" },
    { id: "scan",         icon: "🧠", label: "MRI / CT Scans" },
    { id: "lab",          icon: "🩸", label: "Blood Tests" },
    { id: "report",       icon: "📋", label: "Specialist Notes" },
    { id: "letter",       icon: "✉️", label: "Doctor's Letters" },
    { id: "prescription", icon: "💊", label: "Prescriptions" },
    { id: "image",        icon: "🖼️", label: "Other Images" },
    { id: "other",        icon: "📄", label: "Other" },
  ];
  const FOLDER_BY_ID = Object.fromEntries(FOLDERS.map((f) => [f.id, f]));
  const MAX_BYTES = 25 * 1024 * 1024;

  // Files queued for upload — we collect every File from a multi-select
  // (or a multi-file drop), let the user pick ONE folder + notes that
  // applies to the whole batch, then upload sequentially so each gets
  // its own row and its own AI review on the server.
  let pendingFiles = [];
  let storageReady = true;
  let docs = [];
  let activeFolder = "all";
  let viewerId = null;
  let viewerPoll = null;

  const metaModal   = document.getElementById("meta-modal");
  const viewerModal = document.getElementById("viewer-modal");

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
      docs = data.documents || [];
      renderUsage(data.limits);
      renderFolders();
      renderDocs();
      // If any doc is still being reviewed, poll for completion.
      if (docs.some((d) => d.ai?.status === "pending")) schedulePoll();
    } catch (err) {
      document.getElementById("doc-list").innerHTML =
        `<li class="empty-state">${escapeHtml(err.message || "Couldn't load.")}</li>`;
    }
  }

  function renderUsage(limits) {
    const wrap = document.getElementById("docs-usage");
    if (!wrap || !limits) return;
    const usedMb  = Math.round((limits.usedBytes || 0) / (1024 * 1024));
    const totalMb = Math.round((limits.totalBytes || 0) / (1024 * 1024));
    const usedBytes = limits.usedBytes || 0;
    const totalBytes = limits.totalBytes || 1;
    const pct = Math.min(100, (usedBytes / totalBytes) * 100);
    document.getElementById("docs-usage-text").textContent  = `${usedMb} / ${totalMb} MB`;
    document.getElementById("docs-usage-count").textContent = `${limits.usedCount || 0} / ${limits.maxCount || 100}`;
    const pctEl = document.getElementById("docs-usage-pct");
    if (pctEl) pctEl.textContent = Math.round(pct) + "%";
    // SVG circle r=42 → circumference = 2 * π * 42 ≈ 264
    const ring = document.getElementById("docs-usage-ring-fill");
    if (ring) {
      const C = 264;
      ring.style.strokeDasharray = String(C);
      ring.style.strokeDashoffset = String(C * (1 - pct / 100));
    }
    const ringWrap = document.querySelector(".docs-usage-ring");
    if (ringWrap) {
      ringWrap.classList.toggle("warn", pct > 80);
      ringWrap.classList.toggle("full", pct >= 100);
    }
    wrap.hidden = false;
  }

  function renderFolders() {
    const counts = new Map();
    for (const d of docs) counts.set(d.kind || "other", (counts.get(d.kind || "other") || 0) + 1);
    const wrap = document.getElementById("docs-folders");
    if (!wrap) return;
    wrap.innerHTML = FOLDERS.map((f) => {
      const n = f.id === "all" ? docs.length : (counts.get(f.id) || 0);
      const isActive = f.id === activeFolder;
      return `<button type="button" class="docs-folder ${isActive ? "on" : ""}" data-folder="${f.id}">
        <span class="docs-folder-ico">${f.icon}</span>
        <span class="docs-folder-label">${escapeHtml(f.label)}</span>
        <span class="docs-folder-count">${n}</span>
      </button>`;
    }).join("");
    wrap.querySelectorAll("[data-folder]").forEach((b) =>
      b.addEventListener("click", () => {
        activeFolder = b.dataset.folder;
        renderFolders();
        renderDocs();
      })
    );
  }

  function renderDocs() {
    const list = document.getElementById("doc-list");
    const title = document.getElementById("docs-list-title");
    const sub = document.getElementById("docs-list-sub");
    const folder = FOLDER_BY_ID[activeFolder] || FOLDER_BY_ID.all;
    const filtered = activeFolder === "all" ? docs : docs.filter((d) => (d.kind || "other") === activeFolder);
    if (title) title.textContent = folder.label;
    if (sub) sub.textContent = filtered.length ? `${filtered.length} document${filtered.length === 1 ? "" : "s"}` : "Private to your account";

    if (!filtered.length) {
      list.innerHTML = `<li class="empty-state">
        ${activeFolder === "all"
          ? `No documents yet. Drop an ultrasound, blood test, or specialist letter above and the AI will start a review.`
          : `Nothing in ${escapeHtml(folder.label)} yet.`}
      </li>`;
      return;
    }
    list.innerHTML = filtered.map(docCard).join("");
    list.querySelectorAll("[data-open-id]").forEach((card) =>
      card.addEventListener("click", () => openViewer(+card.dataset.openId))
    );
  }

  function docCard(d) {
    const isImage = (d.contentType || "").startsWith("image/");
    const sizeKb  = d.sizeBytes ? Math.max(1, Math.round(d.sizeBytes / 1024)) : 0;
    const sizeLabel = sizeKb > 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${sizeKb} KB`;
    const fileUrl = `/api/me/documents/${d.id}/file`;
    const folder = FOLDER_BY_ID[d.kind] || FOLDER_BY_ID.other;
    const aiState = d.ai?.status || "skipped";
    const aiBadge = {
      pending: `<span class="ai-pill pending">✨ Reviewing…</span>`,
      done:    `<span class="ai-pill done">✨ Reviewed</span>`,
      error:   `<span class="ai-pill err">✕ Review failed</span>`,
      skipped: `<span class="ai-pill skip">Not reviewed</span>`,
    }[aiState] || "";
    const aiSummary = d.ai?.summary
      ? `<p class="doc-ai-summary">${escapeHtml(d.ai.summary)}</p>`
      : (aiState === "pending"
          ? `<p class="doc-ai-summary muted">The AI is reading this now…</p>`
          : "");
    return `<li class="doc-card doc-card-clickable" data-open-id="${d.id}">
      <div class="doc-thumb">
        ${isImage
          ? `<img src="${fileUrl}" alt="" loading="lazy" />`
          : `<span class="doc-thumb-icon">${folder.icon}</span>`}
        <span class="doc-thumb-tag">${folder.icon} ${escapeHtml(folder.label)}</span>
      </div>
      <div class="doc-card-cta">›</div>
      <div class="doc-body">
        <div class="doc-head-row">
          <strong title="${escapeHtml(d.filename)}">${escapeHtml(d.filename)}</strong>
          ${aiBadge}
        </div>
        <span class="doc-meta">${sizeLabel} · ${relTime(d.uploadedAt)}</span>
        ${aiSummary}
        ${d.notes ? `<p class="doc-notes"><em>Your note:</em> ${escapeHtml(d.notes)}</p>` : ""}
      </div>
    </li>`;
  }

  // --- View toggle -----------------------------------------------------
  let viewMode = "grid";
  document.querySelectorAll(".docs-view-btn").forEach((b) =>
    b.addEventListener("click", () => {
      viewMode = b.dataset.view;
      document.querySelectorAll(".docs-view-btn").forEach((x) => x.classList.toggle("on", x === b));
      document.getElementById("doc-list").classList.toggle("view-list", viewMode === "list");
    })
  );

  // --- Upload zone -----------------------------------------------------
  const zone  = document.getElementById("upload-zone");
  const input = document.getElementById("upload-input");
  document.getElementById("upload-pick").addEventListener("click", () => input.click());
  document.getElementById("docs-hero-upload")?.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const files = [...input.files || []];
    input.value = "";
    if (files.length) startUpload(files);
  });
  ["dragenter", "dragover"].forEach((evt) =>
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.add("is-drop"); }));
  ["dragleave", "drop"].forEach((evt) =>
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.remove("is-drop"); }));
  zone.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) startUpload(files);
  });

  function guessKind(file) {
    const lc = (file.name || "").toLowerCase();
    return /ultraso|tvs|tvus/.test(lc) ? "ultrasound"
         : /\bmri\b|\bct\b|\bxray\b|scan/.test(lc) ? "scan"
         : /\bblood\b|\bcbc\b|\bfbe\b|\blab\b|hba1c|ferritin/.test(lc) ? "lab"
         : /\bprescrip|script|rx\b/.test(lc) ? "prescription"
         : /letter/.test(lc) ? "letter"
         : /report|notes/.test(lc) ? "report"
         : (file.type || "").startsWith("image/") ? "image"
         : "other";
  }

  function startUpload(files) {
    // Drop oversized files up front and warn for each one. Anything
    // valid joins the pending batch.
    const accepted = [];
    for (const f of files) {
      if (f.size > MAX_BYTES) {
        toast(`${f.name}: too big (max 25 MB)`, "err");
        continue;
      }
      accepted.push(f);
    }
    if (!accepted.length) return;
    pendingFiles = accepted;

    // Pick the most common kind across the batch as the default. Users
    // who mix types just override the dropdown once for all.
    const counts = {};
    for (const f of accepted) {
      const k = guessKind(f);
      counts[k] = (counts[k] || 0) + 1;
    }
    const guess = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "other";

    const single = accepted.length === 1;
    const totalKb = Math.round(accepted.reduce((s, f) => s + f.size, 0) / 1024);
    document.getElementById("meta-filename").innerHTML = single
      ? `${escapeHtml(accepted[0].name)} · ${Math.round(accepted[0].size / 1024)} KB`
      : `<strong>${accepted.length} files</strong> · ${totalKb} KB total<br/>
         <span class="meta-files-preview">${accepted.slice(0, 4).map((f) => escapeHtml(f.name)).join(" · ")}${accepted.length > 4 ? ` · +${accepted.length - 4} more` : ""}</span>`;

    const form = document.getElementById("meta-form");
    form.reset();
    form.kind.value = guess;
    document.getElementById("meta-status").textContent = "";
    metaModal.classList.add("open"); metaModal.setAttribute("aria-hidden", "false");
  }

  document.querySelectorAll("[data-close-modal]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      pendingFiles = [];
      metaModal.classList.remove("open"); metaModal.setAttribute("aria-hidden", "true");
    })
  );

  document.getElementById("meta-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!pendingFiles.length) return;
    const form = e.target;
    const status = document.getElementById("meta-status");
    const statusBar = document.getElementById("upload-status");
    const kind  = form.kind.value;
    const notes = form.notes.value || "";

    // Close the modal immediately so the user sees the progress bar at
    // the top of the page rather than a sticky modal.
    metaModal.classList.remove("open"); metaModal.setAttribute("aria-hidden", "true");
    statusBar.hidden = false;
    const total = pendingFiles.length;
    let firstNewId = null;
    let okCount = 0;
    const errors = [];

    // Upload sequentially. Each POST kicks off its own AI review on the
    // server (ctx.waitUntil) so they run in parallel after we respond,
    // even though we're posting in series here.
    for (let i = 0; i < pendingFiles.length; i++) {
      const file = pendingFiles[i];
      statusBar.textContent = total > 1
        ? `Uploading ${i + 1} of ${total} — ${file.name}…`
        : `Uploading ${file.name}…`;
      try {
        const r = await fetch("/api/me/documents", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": file.type || "application/octet-stream",
            "x-filename":   file.name,
            "x-kind":       kind,
            "x-notes":      notes,
          },
          body: file,
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `Upload failed (${r.status})`);
        if (d?.id && firstNewId == null) firstNewId = d.id;
        okCount += 1;
      } catch (err) {
        errors.push(`${file.name}: ${err.message || "upload failed"}`);
      }
    }

    pendingFiles = [];
    statusBar.hidden = true;
    if (okCount > 0) {
      toast(total === 1 ? "Uploaded — AI is reviewing now" : `Uploaded ${okCount}/${total} — AI is reviewing each one`);
    }
    if (errors.length) {
      // Surface the first error in the meta modal in case the user wants
      // to retry; show as a toast for the rest.
      status.textContent = errors[0]; status.className = "form-status err";
      for (let i = 1; i < errors.length; i++) toast(errors[i], "err");
    }
    await load();
    // Pop the viewer for the FIRST new doc so the user can watch the AI
    // populate it — only when single-file or when the user can sensibly
    // follow along (we don't pop one for each upload in a batch).
    if (firstNewId && total === 1) openViewer(firstNewId);
  });

  // --- Viewer modal ----------------------------------------------------
  document.querySelectorAll("[data-close-viewer]").forEach((el) =>
    el.addEventListener("click", () => closeViewer())
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !viewerModal.hidden && viewerModal.classList.contains("open")) closeViewer();
  });

  async function openViewer(id) {
    viewerId = id;
    viewerModal.classList.add("open"); viewerModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    document.getElementById("viewer-preview").innerHTML = `<p class="empty-state">Loading…</p>`;
    document.getElementById("viewer-title").textContent = "Loading…";
    document.getElementById("viewer-sub").textContent = "";
    document.getElementById("viewer-ai-status").textContent = "loading";
    document.getElementById("viewer-ai-summary").value = "";
    document.getElementById("viewer-ai-notes").value = "";
    document.getElementById("viewer-notes").value = "";
    await refreshViewer();
  }
  function closeViewer() {
    viewerModal.classList.remove("open"); viewerModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    viewerId = null;
    if (viewerPoll) { clearTimeout(viewerPoll); viewerPoll = null; }
    load();
  }
  async function refreshViewer() {
    if (!viewerId) return;
    let data;
    try {
      data = await fetchJson(`/api/me/documents/${viewerId}`);
    } catch (err) {
      document.getElementById("viewer-preview").innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
      return;
    }
    const d = data.document;
    if (!d) return;
    paintViewer(d);
    if (d.ai?.status === "pending") schedulePoll(true);
  }
  function schedulePoll(viewerOnly) {
    if (viewerPoll) clearTimeout(viewerPoll);
    viewerPoll = setTimeout(async () => {
      if (viewerOnly && viewerId) await refreshViewer();
      else await load();
    }, 4000);
  }

  function paintViewer(d) {
    const folder = FOLDER_BY_ID[d.kind] || FOLDER_BY_ID.other;
    const fileUrl = `/api/me/documents/${d.id}/file`;
    document.getElementById("viewer-title").textContent = d.filename;
    document.getElementById("viewer-sub").textContent =
      `${folder.icon} ${folder.label} · ${Math.max(1, Math.round((d.sizeBytes || 0) / 1024))} KB · ${relTime(d.uploadedAt)}`;
    document.getElementById("viewer-open").href     = fileUrl;
    document.getElementById("viewer-download").href = fileUrl;
    document.getElementById("viewer-download").setAttribute("download", d.filename);

    const preview = document.getElementById("viewer-preview");
    const ct = (d.contentType || "").toLowerCase();
    if (ct.startsWith("image/")) {
      preview.innerHTML = `<img class="doc-viewer-img" src="${fileUrl}" alt="${escapeHtml(d.filename)}" />`;
    } else if (ct === "application/pdf") {
      preview.innerHTML = `<iframe class="doc-viewer-pdf" src="${fileUrl}#toolbar=0" title="${escapeHtml(d.filename)}"></iframe>`;
    } else if (ct === "text/plain" || ct === "text/csv") {
      preview.innerHTML = `<iframe class="doc-viewer-pdf" src="${fileUrl}" title="${escapeHtml(d.filename)}"></iframe>`;
    } else {
      preview.innerHTML = `<div class="doc-viewer-fallback"><span>${folder.icon}</span><p>No preview available. <a href="${fileUrl}" target="_blank" rel="noopener">Open ↗</a></p></div>`;
    }

    document.getElementById("viewer-kind").value = d.kind || "other";
    document.getElementById("viewer-notes").value = d.notes || "";

    // AI block
    const status = d.ai?.status || "skipped";
    const statusLabel = {
      pending: "⏳ Reviewing… this usually takes ~30 seconds",
      done:    d.ai?.editedByUser ? "✓ Reviewed (you've edited the notes)" : "✓ Reviewed",
      error:   `✕ Review failed — ${d.ai?.error || "try re-running"}`,
      skipped: d.ai?.error || "Skipped",
    }[status];
    document.getElementById("viewer-ai-status").textContent = statusLabel;
    document.getElementById("viewer-ai-status").className = `ai-status ai-status-${status}`;
    document.getElementById("viewer-ai-summary").value = d.ai?.summary || "";
    document.getElementById("viewer-ai-notes").value   = d.ai?.notes   || "";
    document.getElementById("viewer-ai-summary").disabled = status === "pending";
    document.getElementById("viewer-ai-notes").disabled   = status === "pending";
    document.getElementById("viewer-ai-rerun").hidden = !(status === "done" || status === "error");
  }

  document.getElementById("viewer-save").addEventListener("click", async () => {
    if (!viewerId) return;
    const statusEl = document.getElementById("viewer-save-status");
    statusEl.textContent = "Saving…"; statusEl.className = "form-status";
    try {
      const body = {
        kind:      document.getElementById("viewer-kind").value,
        notes:     document.getElementById("viewer-notes").value,
        aiSummary: document.getElementById("viewer-ai-summary").value,
        aiNotes:   document.getElementById("viewer-ai-notes").value,
      };
      await fetchJson(`/api/me/documents/${viewerId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      statusEl.textContent = "Saved."; statusEl.className = "form-status ok";
      toast("Saved", "ok");
      await refreshViewer();
    } catch (err) {
      statusEl.textContent = err.message || "Couldn't save."; statusEl.className = "form-status err";
    }
  });

  document.getElementById("viewer-ai-rerun").addEventListener("click", async () => {
    if (!viewerId) return;
    if (!confirm("Re-run the AI review? Your edits to the AI notes will be replaced.")) return;
    const btn = document.getElementById("viewer-ai-rerun");
    btn.disabled = true;
    try {
      await fetchJson(`/api/me/documents/${viewerId}/rerun?force=1`, { method: "POST" });
      toast("Re-running AI review…", "ok");
      await refreshViewer();
    } catch (err) {
      toast(err.message || "Couldn't re-run", "err");
    } finally { btn.disabled = false; }
  });

  document.getElementById("viewer-delete").addEventListener("click", async () => {
    if (!viewerId) return;
    if (!confirm("Delete this document? This can't be undone.")) return;
    try {
      const res = await fetch(`/api/me/documents/${viewerId}`, {
        method: "DELETE", credentials: "same-origin",
      });
      if (!res.ok) throw new Error("Couldn't delete");
      toast("Deleted", "ok");
      closeViewer();
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
