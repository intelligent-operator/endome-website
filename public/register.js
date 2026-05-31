(() => {
  const $ = (id) => document.getElementById(id);
  const form = $("register-form");
  const status = $("register-status");
  const button = $("register-submit");
  const pwInput = $("reg-password");
  const pwHint = $("pw-strength");
  if (!form || !status || !button) return;

  function setStatus(text, ok = false) {
    status.textContent = text;
    status.className = "form-status" + (ok ? " ok" : text ? " err" : "");
  }

  // Live password strength hint
  function scorePassword(p) {
    if (!p) return { label: "Use a long passphrase you don't reuse elsewhere.", level: 0 };
    let score = 0;
    if (p.length >= 10) score++;
    if (p.length >= 14) score++;
    if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++;
    if (/\d/.test(p)) score++;
    if (/[^A-Za-z0-9]/.test(p)) score++;
    if (p.length < 10) return { label: `${p.length}/10 characters minimum.`, level: 0 };
    if (score <= 2) return { label: "OK — longer is better.", level: 1 };
    if (score === 3) return { label: "Good password.", level: 2 };
    return { label: "Strong password.", level: 3 };
  }
  if (pwInput) {
    pwInput.addEventListener("input", () => {
      const { label, level } = scorePassword(pwInput.value);
      pwHint.textContent = label;
      pwHint.className = "field-hint strength-" + level;
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setStatus("");

    const displayName = form.displayName.value.trim();
    const aliasRaw = (form.alias?.value || "").trim().replace(/^@+/, "");
    const email = form.email.value.trim().toLowerCase();
    const password = form.password.value;

    if (!displayName) return setStatus("Please tell us what to call you.");
    if (aliasRaw && !/^[A-Za-z0-9_.-]{2,30}$/.test(aliasRaw)) {
      return setStatus("@handle: letters, numbers, underscore, hyphen, dot only (2-30 chars).");
    }
    if (!email.includes("@") || !email.includes(".")) {
      return setStatus("Please enter a valid email.");
    }
    if (password.length < 10) {
      return setStatus("Password must be at least 10 characters.");
    }
    if (displayName.length > 60 || email.length > 200 || password.length > 500) {
      return setStatus("Input too long.");
    }

    button.disabled = true;
    setStatus("Creating your account…", true);

    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ displayName, email, password, alias: aliasRaw || null }),
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
