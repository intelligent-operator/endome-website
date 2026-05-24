(() => {
  const form = document.getElementById("login-page-form");
  const status = document.getElementById("login-page-status");
  const button = document.getElementById("login-submit");
  if (!form || !status || !button) return;

  function setStatus(text, ok = false) {
    status.textContent = text;
    status.className = "form-status" + (ok ? " ok" : text ? " err" : "");
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setStatus("");

    const username = form.username.value.trim();
    const password = form.password.value;

    if (!username || !password) {
      setStatus("Please enter your username and password.");
      return;
    }
    if (username.length > 100 || password.length > 500) {
      setStatus("Input too long.");
      return;
    }

    button.disabled = true;
    setStatus("Signing in…", true);

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ username, password }),
        credentials: "same-origin",
        redirect: "manual",
      });

      let data = {};
      try { data = await res.json(); } catch {}

      if (res.ok && data.ok) {
        setStatus("Welcome — redirecting…", true);
        window.location.replace(data.redirect || "/dashboard");
        return;
      }
      if (res.status === 429) {
        setStatus(data.error || "Too many attempts. Try again shortly.");
      } else {
        setStatus(data.error || "Invalid credentials.");
      }
    } catch {
      setStatus("Network error. Try again.");
    } finally {
      button.disabled = false;
    }
  });
})();
