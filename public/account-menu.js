// Account dropdown — wires the top-right "Hi, <name>" tile to a dropdown
// menu. Included on every signed-in page. Idempotent; safe to load twice.
// Also wires the mobile nav drawer: the hamburger button is injected at
// runtime so every existing dashboard page picks it up without touching
// its markup, and clicking it slides the left sidebar in from the side.
(() => {
  const toggle = document.getElementById("account-toggle");
  const dd     = document.getElementById("account-dropdown");
  if (toggle && dd && toggle.dataset.wired !== "1") {
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
  }

  // -- Topbar avatar swap ---------------------------------------------------
  // If the user has uploaded a profile photo, replace the default SVG inside
  // the topbar avatar tile site-wide. Cheap fetch on page load; the JSON
  // response is small and most dashboard pages already hit /api/me/today.
  (async () => {
    try {
      const res = await fetch("/api/me/today", { credentials: "same-origin" });
      if (!res.ok) return;
      const data = await res.json();
      const url = data?.user?.avatarUrl;
      if (!url) return;
      document.querySelectorAll(".dash-topbar .avatar").forEach((el) => {
        if (el.dataset.avatarPainted === "1") return;
        el.dataset.avatarPainted = "1";
        el.innerHTML = `<img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`;
      });
    } catch {}
  })();

  // -- Mobile nav drawer ----------------------------------------------------
  // The left sidebar is sticky on desktop and slides in from the left on
  // mobile + iPad. We inject the trigger button next to the logo so every
  // page benefits without bespoke edits.
  function setupMobileNav() {
    const topbar = document.querySelector(".dash-topbar-inner");
    const sidebar = document.querySelector(".dash-sidebar");
    if (!topbar || !sidebar || topbar.dataset.mobileWired === "1") return;
    topbar.dataset.mobileWired = "1";

    // Inject hamburger button as the first child of the topbar.
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dash-burger";
    btn.setAttribute("aria-label", "Open menu");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = `
      <span class="dash-burger-lines">
        <span></span><span></span><span></span>
      </span>`;
    topbar.insertBefore(btn, topbar.firstChild);

    // Overlay that dims the page while the drawer is open.
    const overlay = document.createElement("div");
    overlay.className = "dash-drawer-overlay";
    overlay.hidden = true;
    document.body.appendChild(overlay);

    sidebar.classList.add("dash-drawer");

    function openDrawer() {
      sidebar.classList.add("is-open");
      overlay.hidden = false;
      btn.classList.add("is-open");
      btn.setAttribute("aria-expanded", "true");
      document.body.classList.add("drawer-open");
    }
    function closeDrawer() {
      sidebar.classList.remove("is-open");
      overlay.hidden = true;
      btn.classList.remove("is-open");
      btn.setAttribute("aria-expanded", "false");
      document.body.classList.remove("drawer-open");
    }

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      if (sidebar.classList.contains("is-open")) closeDrawer(); else openDrawer();
    });
    overlay.addEventListener("click", closeDrawer);
    // Tap any nav link inside the drawer → close before navigating so the
    // next page loads without the drawer still on screen.
    sidebar.querySelectorAll(".side-nav a").forEach((a) => {
      a.addEventListener("click", () => closeDrawer());
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && sidebar.classList.contains("is-open")) closeDrawer();
    });
    // Auto-close if the viewport grows back to desktop width.
    window.addEventListener("resize", () => {
      if (window.innerWidth > 1080 && sidebar.classList.contains("is-open")) closeDrawer();
    });
  }
  setupMobileNav();

  // -- Small dashboard footer ------------------------------------------------
  // Injected once per page so we don't have to touch every dashboard HTML.
  // Skipped on the public site (no .dash-body) so it doesn't show on the
  // marketing pages.
  (function injectFooter() {
    if (!document.body.classList.contains("dash-body")) return;
    if (document.querySelector(".dash-footer")) return;
    const year = new Date().getFullYear();
    const footer = document.createElement("footer");
    footer.className = "dash-footer";
    footer.innerHTML = `
      <div class="dash-footer-inner">
        <a class="dash-footer-brand" href="/dashboard">
          <img src="/logo-final.png" alt="" />
          EndoMe
        </a>
        <nav class="dash-footer-links" aria-label="Footer">
          <a href="/profile">Profile</a>
          <a href="/security">Security</a>
          <a href="/community">Community</a>
          <a href="/research">Donate</a>
          <a href="/api/logout">Sign out</a>
        </nav>
        <span class="dash-footer-copy">© ${year} EndoMe · Built with 💖 for the endo community</span>
      </div>`;
    document.body.appendChild(footer);
  })();
})();
