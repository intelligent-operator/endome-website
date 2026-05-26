// /security — change password + account deletion.
console.info("EndoMe security build v1");

(() => {
  (async () => {
    try {
      const me = await fetchJson("/api/me/today");
      document.querySelectorAll("[data-bind='displayName']").forEach((el) => {
        el.textContent = me?.user?.displayName || me?.user?.username || "there";
      });
    } catch {}
    document.getElementById("page-loader")?.classList.add("is-hidden");
  })();

  // --- Change password -------------------------------------------------
  document.getElementById("password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const status = document.getElementById("pw-status");
    const cur = form.currentPassword.value;
    const nw  = form.newPassword.value;
    const cf  = form.confirm.value;
    if (nw !== cf) { status.textContent = "New passwords don't match."; status.className = "form-status err"; return; }
    status.textContent = "Saving…"; status.className = "form-status";
    try {
      await fetchJson("/api/me/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: cur, newPassword: nw }),
      });
      form.reset();
      status.textContent = "Password updated ✨";
      status.className = "form-status ok";
      toast("Password updated", "ok");
    } catch (err) {
      status.textContent = err.message || "Couldn't update password.";
      status.className = "form-status err";
    }
  });

  // --- Delete account --------------------------------------------------
  const dm = document.getElementById("delete-modal");
  document.getElementById("btn-delete-account").addEventListener("click", () => {
    dm.classList.add("open"); dm.setAttribute("aria-hidden", "false");
  });
  document.querySelectorAll("[data-close-modal]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      dm.classList.remove("open"); dm.setAttribute("aria-hidden", "true");
    })
  );
  document.getElementById("delete-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const status = document.getElementById("delete-status");
    status.textContent = "Deleting…"; status.className = "form-status";
    try {
      await fetchJson("/api/me/account", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: form.confirm.value, password: form.password.value }),
      });
      toast("Account deleted. Goodbye 💖", "ok");
      setTimeout(() => location.href = "/", 1200);
    } catch (err) {
      status.textContent = err.message || "Couldn't delete.";
      status.className = "form-status err";
    }
  });

  async function fetchJson(url, init = {}) {
    const res = await fetch(url, { credentials: "same-origin", ...init });
    if (res.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
    let payload = {};
    try { payload = await res.json(); } catch {}
    if (!res.ok) throw new Error(payload.error || `Request failed (${res.status})`);
    return payload;
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
