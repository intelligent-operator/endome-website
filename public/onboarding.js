(() => {
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let step = 1;
  let selectedPet = "luna";

  // Bind display name from /api/me/today (no full state needed here).
  fetch("/api/me/today", { credentials: "same-origin" })
    .then((r) => (r.status === 401 ? (location.href = "/login") : r.json()))
    .then((data) => {
      if (!data || !data.user) return;
      $$("[data-bind='displayName']").forEach((el) => {
        el.textContent = data.user.displayName || data.user.username || "friend";
      });
    })
    .catch(() => {})
    .finally(() => {
      document.getElementById("page-loader")?.classList.add("is-hidden");
    });

  // --- Step nav ----------------------------------------------------------
  function showStep(n) {
    step = n;
    $$(".ob-step").forEach((s) => (s.hidden = +s.dataset.step !== n));
    $$(".ob-dot").forEach((d) => d.classList.toggle("on", +d.dataset.dot <= n));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // --- Pet picker --------------------------------------------------------
  $$(".ob-pet").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".ob-pet").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      selectedPet = btn.dataset.val;
      const nameInput = $("pet-name");
      if (nameInput && !nameInput.value) nameInput.placeholder = btn.querySelector(".ob-pet-name").textContent;
    });
  });

  // --- Next/Prev ---------------------------------------------------------
  document.addEventListener("click", async (e) => {
    if (e.target.closest("[data-prev]")) {
      e.preventDefault();
      showStep(Math.max(1, step - 1));
      return;
    }
    if (e.target.closest("[data-next]")) {
      e.preventDefault();
      if (step === 2) {
        // Persist pet selection before advancing.
        const cont = $("pet-continue");
        cont.disabled = true;
        cont.textContent = "Saving…";
        try {
          const name = ($("pet-name").value || "").trim();
          const res = await fetch("/api/me/pet", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: selectedPet, name: name || undefined }),
            credentials: "same-origin",
          });
          if (!res.ok) throw new Error("save failed");
          showStep(3);
        } catch {
          alert("Could not save your pet. Try again.");
        } finally {
          cont.disabled = false;
          cont.textContent = "Continue →";
        }
        return;
      }
      showStep(Math.min(3, step + 1));
    }
  });

  // --- "Order EndoMe DNA" -> Stripe Checkout ------------------------------
  const buy = $("buy-endomap");
  if (buy) {
    buy.addEventListener("click", async (e) => {
      e.preventDefault();
      buy.disabled = true;
      const original = buy.textContent;
      buy.textContent = "Opening Stripe…";
      try {
        const res = await fetch("/api/me/checkout/dna", {
          method: "POST",
          credentials: "same-origin",
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.url) {
          location.href = data.url;
          return;
        }
        toast(data.error || "Couldn't start checkout right now.");
      } catch {
        toast("Network error. Try again.");
      } finally {
        buy.disabled = false;
        buy.textContent = original;
      }
    });
  }

  function toast(text) {
    const stack = $("ob-toast-stack");
    if (!stack) return;
    const t = document.createElement("div");
    t.className = "toast toast-ok";
    t.textContent = text;
    stack.appendChild(t);
    requestAnimationFrame(() => t.classList.add("in"));
    setTimeout(() => {
      t.classList.remove("in");
      setTimeout(() => t.remove(), 250);
    }, 2500);
  }
})();
