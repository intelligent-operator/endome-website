// Homepage donation graph + instant donate.
// Red dotted target line, green raised line that climbs the target.
// Zoom toggle: "Next 3" (focused) or "All milestones".
// Smooth, snap-to-nearest tooltip + hover guideline.
console.info("EndoMe home-donate build v5");

(() => {
  const wrap = document.getElementById("dgraph-wrap");
  if (!wrap) return;

  const svg     = document.getElementById("dgraph");
  const tooltip = document.getElementById("dgraph-tooltip");
  const cursorLine = document.getElementById("dg-cursor");
  const cursorDot  = document.getElementById("dg-cursor-dot");

  // SVG coordinate space — preserveAspectRatio="none" lets it stretch.
  const W = 800, H = 320;
  const PAD_L = 60, PAD_R = 30, PAD_T = 28, PAD_B = 64;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const fmtShort = (cents) => {
    const d = (cents || 0) / 100;
    if (d >= 1_000_000) return "$" + (d / 1_000_000).toFixed(d % 1_000_000 ? 1 : 0) + "M";
    if (d >= 1000) return "$" + Math.round(d / 1000) + "k";
    return "$" + Math.round(d);
  };
  const fmtBig = (cents) => "$" + Math.round((cents || 0) / 100).toLocaleString();

  let selectedCents = 2500;
  let allMilestones = [];        // full roadmap from server
  let totalsData    = null;      // /api/donations/totals result
  let zoomMode      = "3";       // "3" → focus first 3, "all" → all

  // Boot
  (async () => {
    try {
      const data = await fetch("/api/donations/totals").then((r) => r.json());
      totalsData = data;
      allMilestones = data.milestones;
      paintHeader(data);
      drawGraph();
    } catch {
      document.getElementById("dgraph-next").textContent = "Couldn't load the roadmap right now.";
    }
  })();

  // --- Zoom toggle ----------------------------------------------------
  document.querySelectorAll(".dg-zoom-btn").forEach((b) => {
    b.addEventListener("click", () => {
      zoomMode = b.dataset.zoom;
      document.querySelectorAll(".dg-zoom-btn").forEach((x) => {
        const on = x === b;
        x.classList.toggle("on", on);
        x.setAttribute("aria-pressed", on ? "true" : "false");
      });
      drawGraph();
    });
  });

  // --- Header --------------------------------------------------------
  function paintHeader(d) {
    document.getElementById("dgraph-raised").textContent = fmtBig(d.totalCents);
    const next = d.milestones[d.activeIndex >= 0 ? d.activeIndex : d.milestones.length - 1];
    const remaining = Math.max(0, next.cumulativeCents - d.totalCents);
    document.getElementById("dgraph-next").innerHTML = d.activeIndex < 0
      ? `<strong>All milestones unlocked.</strong> Keep going.`
      : `<strong>${fmtShort(remaining)}</strong> from <strong>${escapeHtml(next.emoji)} ${escapeHtml(next.title)}</strong>`;
  }

  // --- Graph ---------------------------------------------------------
  function visibleMilestones() {
    if (zoomMode === "all") return allMilestones;
    return allMilestones.slice(0, 3);
  }

  function drawGraph() {
    if (!totalsData) return;
    const visible = visibleMilestones();
    if (!visible.length) return;

    // Y-axis max = top-visible milestone's cumulative cents (lots of headroom not needed).
    const yMax = visible[visible.length - 1].cumulativeCents;
    // X positions: pad evenly across innerW. Index 0 sits at x = PAD_L + step.
    const stepX = innerW / (visible.length + 1);
    const xFor  = (i) => PAD_L + stepX * (i + 1);
    const yFor  = (cents) => PAD_T + innerH - (Math.min(cents, yMax) / yMax) * innerH;
    const baseline = PAD_T + innerH;

    // ----- Y-axis tick labels -----
    const axis = document.getElementById("dg-axis-y");
    axis.innerHTML = "";
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (yMax / ticks) * i;
      const y = yFor(v);
      axis.insertAdjacentHTML("beforeend",
        `<text x="${PAD_L - 10}" y="${y + 4}" text-anchor="end" font-size="11" fill="#a08596" font-family="Poppins,sans-serif">${fmtShort(v)}</text>`);
    }
    // ----- Gridlines -----
    const grid = document.getElementById("dg-grid");
    grid.innerHTML = "";
    for (let i = 0; i <= ticks; i++) {
      const y = yFor((yMax / ticks) * i);
      grid.insertAdjacentHTML("beforeend",
        `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="#f6e4ea" stroke-width="1"/>`);
    }
    // Baseline X axis
    grid.insertAdjacentHTML("beforeend",
      `<line x1="${PAD_L}" y1="${baseline}" x2="${W - PAD_R}" y2="${baseline}" stroke="#ffd6e0" stroke-width="1"/>`);

    // ----- Red dotted TARGET line, from baseline up through each milestone -----
    let targetPts = [`${PAD_L},${baseline}`];
    visible.forEach((m, i) => targetPts.push(`${xFor(i)},${yFor(m.cumulativeCents)}`));
    const targetPath = "M " + targetPts.join(" L ");
    const target = document.getElementById("dg-target");
    target.setAttribute("d", targetPath);

    // ----- GREEN raised line, climbs the target until current raised total -----
    const raised = totalsData.totalCents;
    // Build a path that follows the same segments as the target but stops at `raised`.
    // For each segment (i → i+1), if raised >= ms[i+1].cumulativeCents, draw whole segment.
    // Else, draw partial segment and stop.
    let raisedPts  = [`${PAD_L},${baseline}`];
    let raisedXY   = null;          // where the green line currently ends
    let prevCum    = 0;
    let prevX      = PAD_L;
    let prevY      = baseline;
    let stopped    = false;
    for (let i = 0; i < visible.length; i++) {
      const m = visible[i];
      const nextX = xFor(i);
      const nextY = yFor(m.cumulativeCents);
      if (raised >= m.cumulativeCents) {
        raisedPts.push(`${nextX},${nextY}`);
        prevCum = m.cumulativeCents;
        prevX = nextX; prevY = nextY;
        raisedXY = { x: nextX, y: nextY };
      } else {
        const t = Math.max(0, (raised - prevCum) / (m.cumulativeCents - prevCum));
        const x = prevX + (nextX - prevX) * t;
        const y = prevY + (nextY - prevY) * t;
        raisedPts.push(`${x},${y}`);
        raisedXY = { x, y };
        stopped = true;
        break;
      }
    }
    // If we reached the last visible milestone without stopping, extend a flat
    // line to the right edge so it looks like the segment continues offstage.
    if (!stopped) {
      raisedPts.push(`${W - PAD_R},${prevY}`);
      raisedXY = { x: W - PAD_R, y: prevY };
    }
    const raisedPath = "M " + raisedPts.join(" L ");
    document.getElementById("dg-raised").setAttribute("d", raisedPath);

    // Filled area below the green line
    const areaPath = raisedPath +
      ` L ${raisedXY.x},${baseline}` +
      ` L ${PAD_L},${baseline} Z`;
    document.getElementById("dg-area").setAttribute("d", areaPath);

    // ----- Milestone markers -----
    const markers = document.getElementById("dg-markers");
    markers.innerHTML = "";
    visible.forEach((m, i) => {
      const cx = xFor(i);
      const cy = yFor(m.cumulativeCents);
      const reached = totalsData.totalCents >= m.cumulativeCents;
      const isActive = !reached && totalsData.totalCents >= (i === 0 ? 0 : visible[i - 1].cumulativeCents);
      const stroke = reached ? "#22c55e" : "#dc2626";
      const fill   = reached ? "#22c55e" : "#fff";
      const text   = reached ? "✓" : (i + 1);
      const textColor = reached ? "#fff" : "#dc2626";

      // Active pulse halo
      const halo = isActive
        ? `<circle class="dg-marker-halo" cx="${cx}" cy="${cy}" r="20" fill="none" stroke="#dc2626" stroke-width="2" opacity=".5"/>`
        : "";

      markers.insertAdjacentHTML("beforeend", `
        <g class="dg-marker ${reached ? "is-reached" : ""} ${isActive ? "is-active" : ""}" data-i="${i}" tabindex="0" role="button" aria-label="${escapeHtml(m.title)}: ${fmtShort(m.targetCents)}">
          ${halo}
          <circle class="dg-marker-circle" cx="${cx}" cy="${cy}" r="13" fill="${fill}" stroke="${stroke}" stroke-width="2.5"/>
          <text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="11" font-weight="800" fill="${textColor}" font-family="Poppins,sans-serif">${text}</text>
          <!-- Emoji + amount on a single baseline beneath the marker -->
          <text x="${cx}" y="${baseline + 28}" text-anchor="middle" font-family="Poppins,sans-serif">
            <tspan font-size="15">${m.emoji}</tspan>
            <tspan dx="6" font-size="11" font-weight="800" fill="#3a2330">${fmtShort(m.cumulativeCents)}</tspan>
          </text>
          <!-- Invisible bigger hit target for easier hovering on mobile + desktop -->
          <circle class="dg-marker-hit" cx="${cx}" cy="${cy}" r="26" fill="transparent"/>
        </g>`);
    });

    bindHover(visible, xFor, yFor, baseline);
  }

  // --- Snap-to-nearest hover ----------------------------------------
  // One delegated listener on the SVG. On mousemove we compute the SVG-coord
  // X of the pointer, find the nearest milestone, and snap the tooltip + a
  // vertical guideline + a dot to it. Zero flicker; tooltip never gets eaten
  // by hover-on-itself because the dom element lives outside the SVG.
  function bindHover(visible, xFor, yFor, baseline) {
    const rectFor = () => svg.getBoundingClientRect();
    let activeIdx = -1;
    let raf = null;

    const hide = () => {
      tooltip.hidden = true;
      cursorLine.setAttribute("hidden", "true");
      cursorDot.setAttribute("hidden", "true");
      svg.querySelectorAll(".dg-marker").forEach((m) => m.classList.remove("is-hover"));
      activeIdx = -1;
    };
    svg.onmouseleave = hide;
    wrap.querySelector(".dgraph-svg-wrap").addEventListener("mouseleave", hide);

    // Hover shows a clean amount-pill tooltip only — no description.
    // The full milestone detail opens in a click-triggered modal instead.
    const showAt = (idx) => {
      if (idx === activeIdx) return;
      activeIdx = idx;
      const m = visible[idx];
      const cx = xFor(idx);
      const cy = yFor(m.cumulativeCents);
      const r = rectFor();
      const scaleX = r.width  / W;
      const scaleY = r.height / H;
      const wrapRect = wrap.getBoundingClientRect();
      const left = (r.left + cx * scaleX) - wrapRect.left;
      const top  = (r.top  + cy * scaleY) - wrapRect.top;
      const reached = totalsData.totalCents >= m.cumulativeCents;
      const status = reached ? "Unlocked" : "Locked";
      tooltip.innerHTML = `
        <strong>${escapeHtml(m.emoji)} ${escapeHtml(m.title)}</strong>
        <span class="tip-amount">${fmtBig(m.cumulativeCents)} · ${escapeHtml(status)}</span>
        <span class="tip-hint">Click to read</span>`;
      tooltip.style.left = left + "px";
      tooltip.style.top  = top  + "px";
      tooltip.hidden = false;
      cursorLine.setAttribute("x1", cx);
      cursorLine.setAttribute("x2", cx);
      cursorLine.setAttribute("y1", PAD_T);
      cursorLine.setAttribute("y2", baseline);
      cursorLine.removeAttribute("hidden");
      cursorDot.setAttribute("cx", cx);
      cursorDot.setAttribute("cy", cy);
      cursorDot.removeAttribute("hidden");
      svg.querySelectorAll(".dg-marker").forEach((mk) =>
        mk.classList.toggle("is-hover", +mk.dataset.i === idx));
    };

    svg.onmousemove = (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const r = rectFor();
        const scaleX = r.width / W;
        // Pointer X in SVG space
        const sx = (e.clientX - r.left) / scaleX;
        // Find nearest milestone
        let best = 0, bestD = Infinity;
        for (let i = 0; i < visible.length; i++) {
          const d = Math.abs(xFor(i) - sx);
          if (d < bestD) { bestD = d; best = i; }
        }
        // Only show if pointer is within the plot region
        if (sx < PAD_L - 8 || sx > W - PAD_R + 8) { hide(); return; }
        showAt(best);
      });
    };

    // Click any milestone marker → open detail modal.
    svg.querySelectorAll(".dg-marker").forEach((g, i) => {
      const fire = (e) => { e.preventDefault(); openMilestoneModal(visible[i], i, totalsData.totalCents); };
      g.addEventListener("click", fire);
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fire(e); });
      g.addEventListener("focus", () => showAt(i));
      g.addEventListener("blur",  hide);
    });
  }

  // --- Milestone detail modal ---------------------------------------
  const msModal = document.getElementById("ms-modal");
  function openMilestoneModal(m, i, totalCents) {
    if (!msModal) return;
    const reached = totalCents >= m.cumulativeCents;
    document.getElementById("ms-modal-emoji").textContent = m.emoji;
    document.getElementById("ms-modal-step").textContent  = `Milestone ${i + 1}`;
    document.getElementById("ms-modal-title").textContent = m.title;
    document.getElementById("ms-modal-target").textContent     = fmtBig(m.targetCents);
    document.getElementById("ms-modal-cumulative").textContent = fmtBig(m.cumulativeCents);
    const statusEl = document.getElementById("ms-modal-status");
    statusEl.textContent = reached ? "Unlocked" : "Locked";
    statusEl.className   = reached ? "is-reached" : "is-locked";
    document.getElementById("ms-modal-summary").textContent = m.summary;
    msModal.classList.add("open"); msModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
  }
  function closeMilestoneModal() {
    msModal.classList.remove("open"); msModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }
  if (msModal) {
    msModal.addEventListener("click", (e) => { if (e.target.closest("[data-close-ms]")) closeMilestoneModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && msModal.classList.contains("open")) closeMilestoneModal(); });
    document.getElementById("ms-modal-cta")?.addEventListener("click", () => {
      closeMilestoneModal();
      // Homepage: scroll to the inline instant-donate strip.
      const instant = document.getElementById("instant-donate");
      if (instant) {
        instant.scrollIntoView({ behavior: "smooth", block: "center" });
        instant.classList.add("flash-attention");
        setTimeout(() => instant.classList.remove("flash-attention"), 1400);
        return;
      }
      // /donate page: trigger its own donate modal.
      document.getElementById("donate-cta")?.click();
    });
  }

  // --- Instant donate buttons (unchanged behaviour) -----------------
  document.querySelectorAll(".instant-amounts .amt-chip").forEach((c) => {
    c.addEventListener("click", () => {
      document.querySelectorAll(".instant-amounts .amt-chip").forEach((b) => b.classList.toggle("on", b === c));
      selectedCents = +c.dataset.amount;
      const cs = document.getElementById("amt-custom"); if (cs) cs.value = "";
      updateLabel();
    });
  });
  const customInput = document.getElementById("amt-custom");
  if (customInput) {
    customInput.addEventListener("input", (e) => {
      const dollars = Number(e.target.value);
      if (!Number.isFinite(dollars) || dollars <= 0) {
        selectedCents = 2500;
      } else {
        selectedCents = Math.round(dollars * 100);
        document.querySelectorAll(".instant-amounts .amt-chip").forEach((b) => b.classList.remove("on"));
      }
      updateLabel();
    });
  }
  function updateLabel() {
    const el = document.getElementById("instant-amount-label");
    if (el) el.textContent = fmtShort(selectedCents);
  }

  const goBtn = document.getElementById("instant-donate-go");
  if (goBtn) goBtn.addEventListener("click", async () => {
    const status = document.getElementById("instant-donate-status");
    if (selectedCents < 200) {
      status.textContent = "Minimum donation is $2.";
      status.className = "form-status err";
      return;
    }
    goBtn.disabled = true;
    goBtn.textContent = "Redirecting…";
    status.textContent = "Taking you to Stripe…";
    status.className = "form-status";
    try {
      const res = await fetch("/api/donations/checkout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents: selectedCents, returnTo: location.pathname }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || "Couldn't start checkout.");
      location.href = data.url;
    } catch (err) {
      status.textContent = err.message || "Couldn't start checkout.";
      status.className = "form-status err";
      goBtn.disabled = false;
      goBtn.innerHTML = `Donate <span id="instant-amount-label">${fmtShort(selectedCents)}</span> →`;
    }
  });

  function escapeHtml(s) {
    return String(s ?? "").replace(/[<>&"']/g, (c) => ({
      "<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&#39;",
    })[c]);
  }
})();
