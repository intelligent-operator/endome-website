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
