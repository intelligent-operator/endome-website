// Account dropdown — wires the top-right "Hi, <name>" tile to a dropdown
// menu. Included on every signed-in page. Idempotent; safe to load twice.
(() => {
  const toggle = document.getElementById("account-toggle");
  const dd     = document.getElementById("account-dropdown");
  if (!toggle || !dd || toggle.dataset.wired === "1") return;
  toggle.dataset.wired = "1";

  function open()  { dd.hidden = false; toggle.setAttribute("aria-expanded", "true"); }
  function close() { dd.hidden = true;  toggle.setAttribute("aria-expanded", "false"); }

  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (dd.hidden) open(); else close();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".account-menu")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !dd.hidden) close();
  });
})();
