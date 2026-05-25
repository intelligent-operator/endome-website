// Auth-aware nav: flip <body class="is-signed-in"> when we have a session.
// CSS does the show/hide so there's no flicker from JS toggling hidden attrs.
(async () => {
  try {
    const res = await fetch("/api/me/today", { credentials: "same-origin" });
    if (res.ok) document.body.classList.add("is-signed-in");
  } catch { /* offline / failure → leave defaults (signed-out) */ }
})();

// Newsletter signup -> /api/subscribe
const newsletterForm = document.getElementById("newsletter-form");
if (newsletterForm) {
  const status = document.getElementById("newsletter-status");
  newsletterForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = newsletterForm.email.value.trim();
    if (!email) return;
    status.textContent = "Subscribing…";
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error("subscribe failed");
      newsletterForm.reset();
      status.textContent = "Thanks — check your inbox.";
    } catch {
      status.textContent = "Something went wrong. Try again.";
    }
  });
}

// (DNA / Tests CTAs are now plain links — logged-out users land on
// /register, logged-in users on /tests where the per-test Stripe
// Checkout flow takes over.)

// (Post-checkout success/cancel banner now lives on /tests.)

// EndoPet selection (visual only)
document.querySelectorAll(".pet-card").forEach((card) => {
  card.addEventListener("click", () => {
    document.querySelectorAll(".pet-card").forEach((c) => {
      c.classList.remove("selected");
      const fav = c.querySelector(".pet-fav");
      if (fav) {
        fav.classList.add("heart");
        fav.innerHTML =
          '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 21s-7-4.5-7-10a4 4 0 017-2.6A4 4 0 0119 11c0 5.5-7 10-7 10z" stroke="#ff5d8f" stroke-width="2" fill="none"/></svg>';
      }
    });
    card.classList.add("selected");
    const fav = card.querySelector(".pet-fav");
    if (fav) {
      fav.classList.remove("heart");
      fav.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12l4 4L19 6" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
  });
});
