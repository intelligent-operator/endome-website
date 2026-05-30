(() => {
  const $ = (id) => document.getElementById(id);
  const stepCreds = document.querySelector('[data-step="creds"]');
  const stepOtp   = document.querySelector('[data-step="otp"]');
  const credsForm   = $("creds-form");
  const credsStatus = $("creds-status");
  const credsSubmit = $("creds-submit");
  const credsTitle  = $("creds-title");
  const credsSub    = $("creds-sub");
  const toggleMode  = $("toggle-mode");
  const passwordField = $("password-field");

  const otpForm   = $("otp-form");
  const otpStatus = $("otp-status");
  const otpSubmit = $("otp-submit");
  const otpTarget = $("otp-target");
  const otpResend = $("otp-resend");
  const backCreds = $("back-to-creds");

  // Default to the email-code flow — friendlier and the more common path.
  // Returning users on a recognised device land here; the password toggle
  // is still available for first-time sign-in on a fresh browser, or for
  // anyone who prefers a password. We remember the user's last choice
  // in localStorage so it sticks across sessions.
  const SAVED_MODE = (() => {
    try { return localStorage.getItem("endome:loginMode"); } catch { return null; }
  })();
  let mode = SAVED_MODE === "password" ? "password" : "passwordless";
  let challenge = null;

  function setStatus(el, text, ok = false) {
    el.textContent = text;
    el.className = "form-status" + (ok ? " ok" : text ? " err" : "");
  }
  function showStep(name) {
    stepCreds.hidden = name !== "creds";
    stepOtp.hidden   = name !== "otp";
  }
  function setMode(m) {
    mode = m;
    const passInput = passwordField.querySelector("input");
    if (m === "passwordless") {
      passwordField.style.display = "none";
      passInput.required = false;
      credsSubmit.textContent = "Email me a code";
      credsTitle.textContent  = "Sign in with email";
      credsSub.textContent    = "We'll email you a 6-digit code — no password needed.";
      toggleMode.textContent  = "Use password instead";
    } else {
      passwordField.style.display = "";
      passInput.required = true;
      credsSubmit.textContent = "Continue";
      credsTitle.textContent  = "Welcome back";
      credsSub.textContent    = "Sign in with your password — we'll email you a code to confirm.";
      toggleMode.textContent  = "Email me a sign-in code instead";
    }
  }

  toggleMode.addEventListener("click", (e) => {
    e.preventDefault();
    const next = mode === "password" ? "passwordless" : "password";
    setMode(next);
    try { localStorage.setItem("endome:loginMode", next); } catch {}
    setStatus(credsStatus, "");
  });

  // Apply the saved/default mode on first paint.
  setMode(mode);

  // --- Step 1 submit -------------------------------------------------------
  credsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setStatus(credsStatus, "");
    const username = credsForm.username.value.trim();
    const password = credsForm.password.value;
    if (!username) return setStatus(credsStatus, "Enter your email or username.");
    if (mode === "password" && password.length < 8) {
      return setStatus(credsStatus, "Enter your password.");
    }
    if (username.length > 200) return setStatus(credsStatus, "Input too long.");

    credsSubmit.disabled = true;
    setStatus(credsStatus, mode === "passwordless" ? "Sending code…" : "Checking…", true);

    try {
      const endpoint = mode === "passwordless" ? "/api/login/code" : "/api/login";
      const body = mode === "passwordless"
        ? { email: username.toLowerCase() }
        : { username, password };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        credentials: "same-origin",
        redirect: "manual",
      });
      let data = {};
      try { data = await res.json(); } catch {}

      if (res.ok && data.needsOtp && data.challenge) {
        challenge = data.challenge;
        otpTarget.textContent = data.sentTo || "your inbox";
        showStep("otp");
        setStatus(otpStatus, "");
        setTimeout(() => otpForm.code.focus(), 80);
        return;
      }
      // Admin (env-var) login: straight to dashboard, no OTP.
      if (res.ok && data.ok && data.redirect) {
        setStatus(credsStatus, "Welcome — redirecting…", true);
        window.location.replace(data.redirect);
        return;
      }
      setStatus(credsStatus, data.error || "Could not sign in.");
    } catch {
      setStatus(credsStatus, "Network error. Try again.");
    } finally {
      credsSubmit.disabled = false;
    }
  });

  // --- Step 2 submit -------------------------------------------------------
  otpForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = otpForm.code.value.replace(/\D/g, "");
    if (!/^\d{6}$/.test(code)) return setStatus(otpStatus, "Enter the 6-digit code.");
    if (!challenge) return setStatus(otpStatus, "Session expired. Start over.");

    otpSubmit.disabled = true;
    setStatus(otpStatus, "Verifying…", true);

    try {
      const res = await fetch("/api/login/verify", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ challenge, code }),
        credentials: "same-origin",
        redirect: "manual",
      });
      let data = {};
      try { data = await res.json(); } catch {}
      if (res.ok && data.ok) {
        setStatus(otpStatus, "Welcome — redirecting…", true);
        window.location.replace(data.redirect || "/dashboard");
        return;
      }
      setStatus(otpStatus, data.error || "Invalid code.");
      otpForm.code.select();
    } catch {
      setStatus(otpStatus, "Network error. Try again.");
    } finally {
      otpSubmit.disabled = false;
    }
  });

  // Auto-submit when 6 digits are entered (and strip non-numerics on input).
  otpForm.code.addEventListener("input", (e) => {
    const cleaned = e.target.value.replace(/\D/g, "").slice(0, 6);
    if (cleaned !== e.target.value) e.target.value = cleaned;
    if (cleaned.length === 6) {
      otpForm.requestSubmit?.();
    }
  });

  // --- Resend / back -------------------------------------------------------
  otpResend.addEventListener("click", async (e) => {
    e.preventDefault();
    const email = credsForm.username.value.trim().toLowerCase();
    if (!email) {
      setStatus(otpStatus, "Go back and re-enter your email.");
      return;
    }
    setStatus(otpStatus, "Sending new code…", true);
    try {
      const res = await fetch("/api/login/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.challenge) {
        challenge = data.challenge;
        otpTarget.textContent = data.sentTo || otpTarget.textContent;
        setStatus(otpStatus, "New code sent.", true);
      } else {
        setStatus(otpStatus, data.error || "Could not send a new code.");
      }
    } catch {
      setStatus(otpStatus, "Network error. Try again.");
    }
  });

  backCreds.addEventListener("click", (e) => {
    e.preventDefault();
    challenge = null;
    otpForm.code.value = "";
    setStatus(otpStatus, "");
    showStep("creds");
  });
})();
