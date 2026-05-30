/* /read-story?id=N — display a published community story. */

function escapeHtml(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
function paragraphs(body){
  return String(body || "").split(/\n\n+/).map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`).join("");
}

(async () => {
  const root = document.getElementById("story-root");
  const id = new URLSearchParams(location.search).get("id");
  if (!id) { root.innerHTML = `<p class="empty-state">No story specified.</p>`; return; }
  try {
    const r = await fetch(`/api/community/stories/${id}`, { credentials: "same-origin" });
    if (!r.ok) throw new Error(`Story not available`);
    const { story, chapters } = await r.json();
    document.title = `${story.title} – EndoMe`;
    root.innerHTML = `
      <article class="story-doc">
        <a class="back-link" href="/community?tab=stories">← Back to stories</a>
        ${story.coverImageUrl ? `<div class="story-cover"><img src="${escapeHtml(story.coverImageUrl)}" alt="" /></div>` : ""}
        <header class="story-head">
          <h1>${escapeHtml(story.title)}</h1>
          ${story.summary ? `<p class="story-summary">${escapeHtml(story.summary)}</p>` : ""}
          <div class="story-byline">
            <span class="story-author">${escapeHtml(story.author)}</span>
            ${story.publishedAt ? `<span class="story-date"> · ${new Date(story.publishedAt * 1000).toLocaleDateString(undefined, { day:"numeric", month:"long", year:"numeric" })}</span>` : ""}
          </div>
        </header>
        ${chapters.map((c, i) => `
          <section class="story-chapter">
            <span class="story-chapter-num">Chapter ${i + 1}</span>
            ${c.heading ? `<h2>${escapeHtml(c.heading)}</h2>` : ""}
            ${c.imageUrl ? `<figure class="story-chapter-img"><img src="${escapeHtml(c.imageUrl)}" alt="" /></figure>` : ""}
            <div class="story-chapter-body">${paragraphs(c.body)}</div>
          </section>`).join("")}
        <footer class="story-foot">
          <p><a href="/community?tab=stories">Read more stories →</a></p>
        </footer>
      </article>`;
  } catch (err) {
    root.innerHTML = `<p class="empty-state">Couldn't load this story. It may not be published yet.</p>`;
  }
})();
