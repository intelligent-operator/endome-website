// Newsletter signup -> /api/subscribe
const form = document.getElementById("newsletter-form");
if (form) {
  const status = document.getElementById("newsletter-status");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    if (!email) return;
    status.textContent = "Subscribing…";
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error("subscribe failed");
      form.reset();
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

// --- Login modal ---------------------------------------------------------
const loginModal = document.getElementById("login-modal");
function openLogin() {
  loginModal.classList.add("open");
  loginModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  setTimeout(() => loginModal.querySelector('input[name="email"]')?.focus(), 50);
}
function closeLogin() {
  loginModal.classList.remove("open");
  loginModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}
document.querySelectorAll("[data-open-login]").forEach((el) =>
  el.addEventListener("click", (e) => { e.preventDefault(); openLogin(); })
);
document.querySelectorAll("[data-close-login]").forEach((el) =>
  el.addEventListener("click", (e) => { e.preventDefault(); closeLogin(); })
);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && loginModal.classList.contains("open")) closeLogin();
});

const loginForm = document.getElementById("login-form");
if (loginForm) {
  const status = document.getElementById("login-status");
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = loginForm.email.value.trim();
    const password = loginForm.password.value;
    if (!email || !password) return;
    status.textContent = "Signing in…";
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        status.textContent = "Welcome back — redirecting…";
        if (data.redirect) location.href = data.redirect;
      } else {
        status.textContent = data.error || "Customer portal coming soon.";
      }
    } catch {
      status.textContent = "Network error. Try again.";
    }
  });
}

// --- EndoPet selection (visual only; persisted on signup) ---------------
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
