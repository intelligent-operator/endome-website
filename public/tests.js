(() => {
  // ---- post-checkout return banner --------------------------------------
  const qs = new URLSearchParams(location.search);
  const checkout = qs.get("checkout");
  const justBoughtTest = qs.get("test");
  if (checkout) {
    const name = testName(justBoughtTest);
    if (checkout === "success") {
      // Webhook usually fires within a couple of seconds — refresh state
      // shortly after the page paints so the card flips to "ordered".
      setTimeout(refreshTests, 2500);
      toast(`${name} ordered — confirmation email on its way 🌸`);
    } else if (checkout === "cancelled") {
      toast("Order cancelled — no charge was made", "err");
    }
    history.replaceState({}, "", "/tests");
  }

  // ---- initial load -----------------------------------------------------
  fetch("/api/me/today", { credentials: "same-origin" })
    .then((r) => (r.status === 401 ? (location.href = "/login") : r.json()))
    .then((data) => {
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = data?.user?.displayName || data?.user?.username || "there";
      });
      paint(data?.tests || {});
    })
    .catch(() => {})
    .finally(() => {
      document.getElementById("page-loader")?.classList.add("is-hidden");
    });

  async function refreshTests() {
    try {
      const data = await fetch("/api/me/today", { credentials: "same-origin" }).then((r) => r.json());
      paint(data?.tests || {});
    } catch {}
  }

  function paint(tests) {
    for (const [testId, state] of Object.entries(tests)) {
      const card = document.querySelector(`.test-card[data-test="${testId}"]`);
      if (!card) continue;
      const btn = card.querySelector(".test-action");
      if (!btn) continue;

      // Clean prior states
      card.classList.remove("is-pending", "is-complete");

      if (state.resultsAt) {
        card.classList.add("is-complete");
        btn.outerHTML = `<span class="test-done">✓ Results received</span>`;
      } else if (state.orderedAt) {
        card.classList.add("is-pending");
        btn.dataset.action = "upload";
        btn.textContent = "Upload results";
      } else {
        btn.dataset.action = "order";
        btn.textContent = `Request ${testName(testId)}`;
      }
    }
  }

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".test-action");
    if (!btn) return;
    e.preventDefault();

    const testId  = btn.dataset.test;
    const action  = btn.dataset.action;
    const original = btn.textContent;
    btn.disabled = true;

    try {
      if (action === "order") {
        // Real Stripe Checkout — browser navigates to Stripe-hosted page.
        btn.textContent = "Opening Stripe…";
        const res = await fetch(`/api/me/checkout/${testId}`, {
          method: "POST",
          credentials: "same-origin",
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.url) {
          location.href = data.url;
          return; // leaving the page
        }
        toast(data.error || "Couldn't start checkout", "err");
      } else if (action === "upload") {
        btn.textContent = "Saving…";
        const res = await fetch(`/api/me/results/${testId}`, {
          method: "POST",
          credentials: "same-origin",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast(data.error || "Couldn't save", "err");
        } else {
          toast(`${testName(testId)} results recorded`);
          await refreshTests();
          return;
        }
      }
    } catch {
      toast("Network error", "err");
    } finally {
      // Only re-enable if the click didn't navigate away.
      btn.disabled = false;
      btn.textContent = original;
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
