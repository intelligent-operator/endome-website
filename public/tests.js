(() => {
  // Load profile + order state, then paint card states.
  fetch("/api/me/today", { credentials: "same-origin" })
    .then((r) => (r.status === 401 ? (location.href = "/login") : r.json()))
    .then((data) => {
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = data?.user?.displayName || data?.user?.username || "there";
      });
      paint(data?.tests || {});
    })
    .catch(() => {});

  function paint(tests) {
    for (const [testId, state] of Object.entries(tests)) {
      const card = document.querySelector(`.test-card[data-test="${testId}"]`);
      if (!card) continue;
      const btn = card.querySelector(".test-action");
      if (!btn) continue;

      if (state.resultsAt) {
        card.classList.add("is-complete");
        btn.outerHTML = `<span class="test-done">✓ Results received</span>`;
      } else if (state.orderedAt) {
        card.classList.add("is-pending");
        btn.dataset.action = "upload";
        btn.textContent = "Upload results";
      } else {
        btn.dataset.action = "order";
      }
    }
  }

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".test-action");
    if (!btn) return;
    e.preventDefault();
    const testId = btn.dataset.test;
    const isOrder = btn.dataset.action !== "upload";
    const endpoint = isOrder
      ? `/api/me/order/${testId}`
      : `/api/me/results/${testId}`;

    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "Saving…";

    try {
      const res = await fetch(endpoint, { method: "POST", credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error || "Couldn't save", "err");
        btn.disabled = false;
        btn.textContent = originalText;
        return;
      }
      if (isOrder) {
        toast(`${testName(testId)} requested 🌸 we'll be in touch`);
      } else {
        toast(`${testName(testId)} results recorded`);
      }
      // Refresh state
      const refresh = await fetch("/api/me/today", { credentials: "same-origin" }).then((r) => r.json());
      paint(refresh?.tests || {});
    } catch {
      toast("Network error", "err");
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  function testName(id) {
    return { dna: "EndoMe DNA", bloods: "EndoMe Bloods", map: "EndoMe Map" }[id] || "Test";
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
