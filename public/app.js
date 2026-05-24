// Auth-aware nav: swap "Sign In / Get Started" for "Dashboard" if signed in.
// One small fetch on page load; doesn't block render.
(async () => {
  try {
    const res = await fetch("/api/me/today", { credentials: "same-origin" });
    if (!res.ok) return;
    document.querySelectorAll(".nav-when-out").forEach((el) => (el.hidden = true));
    document.querySelectorAll(".nav-when-in").forEach((el) => (el.hidden = false));
  } catch { /* offline / failure → leave defaults */ }
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

// "Request a DNA Test" CTAs -> Stripe Checkout
document.querySelectorAll("[data-checkout]").forEach((el) => {
  el.addEventListener("click", async (e) => {
    e.preventDefault();
    const original = el.textContent;
    el.setAttribute("aria-busy", "true");
    try {
      const res = await fetch("/api/checkout", { method: "POST" });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        el.textContent = "Unavailable — try again";
        setTimeout(() => (el.textContent = original), 2500);
      }
    } catch {
      el.textContent = "Network error";
      setTimeout(() => (el.textContent = original), 2500);
    } finally {
      el.removeAttribute("aria-busy");
    }
  });
});

// Friendly post-checkout banner
const params = new URLSearchParams(location.search);
if (params.get("checkout") === "success") {
  alert("Thanks for your order — check your email for next steps.");
} else if (params.get("checkout") === "cancelled") {
  alert("Checkout cancelled. You can try again whenever you're ready.");
}

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
