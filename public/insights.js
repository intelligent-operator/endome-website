// Public Research Dashboard preview status.
// Reads total donations + roadmap, pulls the milestone keyed "dashboard"
// from the response, and lights up the status banner accordingly.
console.info("EndoMe insights build v1");

(async () => {
  const pill = document.getElementById("status-pill");
  const fill = document.getElementById("status-bar-fill");
  const text = document.getElementById("status-text");
  if (!pill || !fill || !text) return;

  try {
    const data = await fetch("/api/donations/totals").then((r) => r.json());
    const dashboard = (data.milestones || []).find((m) => m.key === "dashboard");
    if (!dashboard) {
      pill.textContent = "Status unknown";
      text.textContent = "Couldn't read the roadmap right now.";
      return;
    }
    const raised = data.totalCents || 0;
    const target = dashboard.cumulativeCents;
    const pct = Math.max(0, Math.min(100, (raised / target) * 100));
    fill.style.width = pct.toFixed(1) + "%";

    if (raised >= target) {
      pill.textContent = "✓ Unlocked";
      pill.classList.add("is-live");
      text.innerHTML = `Live. Last engine refresh ran <strong>recently</strong>.`;
    } else {
      pill.textContent = "Preview · Locked";
      pill.classList.add("is-locked");
      const remaining = target - raised;
      text.innerHTML = `Goes live at <strong>${fmt(target)}</strong> cumulative. ${pct.toFixed(0)}% there. <strong>${fmt(remaining)}</strong> to go.`;
    }
  } catch {
    pill.textContent = "Status unknown";
    text.textContent = "Couldn't reach the server.";
  }

  function fmt(cents) {
    const d = (cents || 0) / 100;
    if (d >= 1000) return "$" + Math.round(d / 1000) + "k";
    return "$" + Math.round(d).toLocaleString();
  }
})();
