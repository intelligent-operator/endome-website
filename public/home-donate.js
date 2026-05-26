// Homepage donation graph + instant donate.
// Lives on / (public homepage). Talks to the same /api/donations/* endpoints
// as /donate, but skips the modal — one-tap straight to Stripe Checkout.
console.info("EndoMe home-donate build v1");

(() => {
  const wrap = document.getElementById("dgraph-wrap");
  if (!wrap) return; // section not present (older homepage cache)

  const svg = document.getElementById("dgraph");
  const W = 800, H = 280, PAD_L = 50, PAD_R = 30, PAD_T = 20, PAD_B = 50;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const fmt = (cents) => {
    const d = (cents || 0) / 100;
    if (d >= 1000) return "$" + Math.round(d / 1000) + "k";
    return "$" + Math.round(d);
  };
  const fmtBig = (cents) => "$" + Math.round((cents || 0) / 100).toLocaleString();

  let selectedCents = 2500;

  (async () => {
    try {
      const data = await fetch("/api/donations/totals").then((r) => r.json());
      paint(data);
    } catch {
      document.getElementById("dgraph-next").textContent = "Couldn't load the roadmap right now.";
    }
  })();

  function paint(d) {
    document.getElementById("dgraph-raised").textContent = fmtBig(d.totalCents);
    const next = d.milestones[d.activeIndex >= 0 ? d.activeIndex : d.milestones.length - 1];
    const remaining = Math.max(0, next.cumulativeCents - d.totalCents);
    document.getElementById("dgraph-next").innerHTML = d.activeIndex < 0
      ? `<strong>All milestones unlocked.</strong> Keep going — more impact ahead.`
      : `<strong>${fmt(remaining)}</strong> from <strong>${next.emoji} ${escapeHtml(next.title)}</strong>`;

    drawGraph(d);
  }

  function drawGraph(d) {
    const ms = d.milestones;
    const total = d.totalGoalCents;
    const raised = d.totalCents;

    // X coordinate for a cumulative-cents value (0 → PAD_L, total → W - PAD_R)
    const xFor = (c) => PAD_L + (c / total) * innerW;
    // Y coordinate for a step index (top → first milestone hits high)
    const yFor = (i) => PAD_T + innerH - ((i + 1) / ms.length) * innerH;

    // Gridlines (horizontal at each milestone level)
    const grid = svg.querySelector(".dg-grid");
    grid.innerHTML = "";
    for (let i = 0; i < ms.length; i++) {
      const y = yFor(i);
      grid.insertAdjacentHTML("beforeend",
        `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="#ffeaf2" stroke-dasharray="2 4"/>`);
    }
    // Baseline
    grid.insertAdjacentHTML("beforeend",
      `<line x1="${PAD_L}" y1="${H - PAD_B}" x2="${W - PAD_R}" y2="${H - PAD_B}" stroke="#ffd6e0" stroke-width="1"/>`);

    // Target curve — connects (0, baseline) → each milestone (cumulative, yFor(i))
    let targetPath = `M ${PAD_L} ${H - PAD_B}`;
    for (let i = 0; i < ms.length; i++) {
      targetPath += ` L ${xFor(ms[i].cumulativeCents)} ${yFor(i)}`;
    }
    svg.querySelector("#dg-target").setAttribute("d", targetPath);

    // Build the raised path: same shape but truncated at `raised`.
    // Climbs along the milestone line up to the most-recently-passed milestone,
    // then partial climb toward the active one.
    const reached = ms.filter((m) => m.reached).length; // count fully reached
    let raisedPath = `M ${PAD_L} ${H - PAD_B}`;
    for (let i = 0; i < reached; i++) {
      raisedPath += ` L ${xFor(ms[i].cumulativeCents)} ${yFor(i)}`;
    }
    // Partial line into the active milestone
    if (reached < ms.length && raised > (reached > 0 ? ms[reached - 1].cumulativeCents : 0)) {
      const prevCum = reached > 0 ? ms[reached - 1].cumulativeCents : 0;
      const prevY   = reached > 0 ? yFor(reached - 1) : H - PAD_B;
      const nextCum = ms[reached].cumulativeCents;
      const nextY   = yFor(reached);
      const t = (raised - prevCum) / (nextCum - prevCum); // 0..1
      const xNow = xFor(raised);
      const yNow = prevY + (nextY - prevY) * t;
      raisedPath += ` L ${xNow} ${yNow}`;
    }
    svg.querySelector("#dg-stroke").setAttribute("d", raisedPath);

    // Area fill = raised path + close down to baseline
    const lastX = raised >= total ? xFor(total) : xFor(raised);
    const areaPath = raisedPath + ` L ${lastX} ${H - PAD_B} L ${PAD_L} ${H - PAD_B} Z`;
    svg.querySelector("#dg-area").setAttribute("d", areaPath);

    // Milestone markers
    const markers = document.getElementById("dg-markers");
    markers.innerHTML = "";
    ms.forEach((m, i) => {
      const cx = xFor(m.cumulativeCents);
      const cy = yFor(i);
      const reachedNow = m.reached;
      const active = i === d.activeIndex;
      const fill = reachedNow ? "#5cc77c" : active ? "#ff4e8a" : "#fff";
      const stroke = reachedNow ? "#5cc77c" : "#ff4e8a";
      const text = reachedNow ? "✓" : (i + 1);
      markers.insertAdjacentHTML("beforeend", `
        <g class="dg-marker ${reachedNow ? "is-reached" : ""} ${active ? "is-active" : ""}" data-i="${i}" tabindex="0" role="button" aria-label="${escapeHtml(m.title)}: ${fmt(m.targetCents)}">
          <circle cx="${cx}" cy="${cy}" r="14" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
          <text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="11" font-weight="800" fill="${reachedNow ? "#fff" : active ? "#fff" : "#ff4e8a"}" font-family="Poppins,sans-serif">${text}</text>
          <text x="${cx}" y="${H - PAD_B + 22}" text-anchor="middle" font-size="11" font-weight="700" fill="#7a5f6c" font-family="Poppins,sans-serif">${m.emoji}</text>
          <text x="${cx}" y="${H - PAD_B + 38}" text-anchor="middle" font-size="10" font-weight="700" fill="#3a2330" font-family="Poppins,sans-serif">${fmt(m.cumulativeCents)}</text>
        </g>`);
    });

    // Tooltip on hover/tap
    const tip = document.getElementById("dgraph-tooltip");
    markers.querySelectorAll(".dg-marker").forEach((g) => {
      const showTip = () => {
        const i = +g.dataset.i;
        const m = ms[i];
        const rect = svg.getBoundingClientRect();
        const wrapRect = wrap.getBoundingClientRect();
        const bbox = g.getBoundingClientRect();
        const left = (bbox.left + bbox.width / 2) - wrapRect.left;
        const top  = (bbox.top - 10) - wrapRect.top;
        tip.style.left = left + "px";
        tip.style.top  = top + "px";
        tip.innerHTML = `
          <strong>${escapeHtml(m.emoji)} ${escapeHtml(m.title)}</strong>
          <span class="tip-amount">${fmtBig(m.targetCents)} — total ${fmtBig(m.cumulativeCents)}</span>
          <p>${escapeHtml(m.summary)}</p>`;
        tip.hidden = false;
      };
      g.addEventListener("mouseenter", showTip);
      g.addEventListener("mousemove", showTip);
      g.addEventListener("mouseleave", () => { tip.hidden = true; });
      g.addEventListener("focus", showTip);
      g.addEventListener("blur",  () => { tip.hidden = true; });
      g.addEventListener("click", showTip);
    });
  }

  // --- Instant donate buttons ----------------------------------------
  document.querySelectorAll(".instant-amounts .amt-chip").forEach((c) => {
    c.addEventListener("click", () => {
      document.querySelectorAll(".instant-amounts .amt-chip").forEach((b) => b.classList.toggle("on", b === c));
      selectedCents = +c.dataset.amount;
      document.getElementById("amt-custom").value = "";
      updateLabel();
    });
  });
  document.getElementById("amt-custom").addEventListener("input", (e) => {
    const dollars = Number(e.target.value);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      selectedCents = 2500;
    } else {
      selectedCents = Math.round(dollars * 100);
      document.querySelectorAll(".instant-amounts .amt-chip").forEach((b) => b.classList.remove("on"));
    }
    updateLabel();
  });
  function updateLabel() {
    document.getElementById("instant-amount-label").textContent = fmt(selectedCents);
  }

  document.getElementById("instant-donate-go").addEventListener("click", async () => {
    const btn = document.getElementById("instant-donate-go");
    const status = document.getElementById("instant-donate-status");
    if (selectedCents < 200) {
      status.textContent = "Minimum donation is $2.";
      status.className = "form-status err";
      return;
    }
    btn.disabled = true;
    btn.textContent = "Redirecting…";
    status.textContent = "Taking you to Stripe…";
    status.className = "form-status";
    try {
      const res = await fetch("/api/donations/checkout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents: selectedCents }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || "Couldn't start checkout.");
      location.href = data.url;
    } catch (err) {
      status.textContent = err.message || "Couldn't start checkout.";
      status.className = "form-status err";
      btn.disabled = false;
      btn.innerHTML = `Donate <span id="instant-amount-label">${fmt(selectedCents)}</span> →`;
    }
  });

  function escapeHtml(s) {
    return String(s ?? "").replace(/[<>&"']/g, (c) => ({
      "<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&#39;",
    })[c]);
  }
})();
