(() => {
  const form = document.getElementById("register-form");
  const status = document.getElementById("register-status");
  const button = document.getElementById("register-submit");
  if (!form || !status || !button) return;

  function setStatus(text, ok = false) {
    status.textContent = text;
    status.className = "form-status" + (ok ? " ok" : text ? " err" : "");
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setStatus("");

    const displayName = form.displayName.value.trim();
    const email = form.email.value.trim().toLowerCase();
    const password = form.password.value;
    const terms = form.terms.checked;

    if (!displayName) return setStatus("Please tell us what to call you.");
    if (!email.includes("@") || !email.includes(".")) return setStatus("Please enter a valid email.");
    if (password.length < 10) return setStatus("Password must be at least 10 characters.");
    if (!terms) return setStatus("Please confirm the disclaimer to continue.");
    if (displayName.length > 60 || email.length > 200 || password.length > 500) {
      return setStatus("Input too long.");
    }

    button.disabled = true;
    setStatus("Creating your account…", true);

    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ displayName, email, password }),
        credentials: "same-origin",
        redirect: "manual",
      });
      let data = {};
      try { data = await res.json(); } catch {}

      if (res.ok && data.ok) {
        setStatus("Welcome to EndoMe — redirecting…", true);
        window.location.replace(data.redirect || "/dashboard");
        return;
      }
      setStatus(data.error || "Could not create account. Try again.");
    } catch {
      setStatus("Network error. Try again.");
    } finally {
      button.disabled = false;
    }
  });
})();
