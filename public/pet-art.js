/* Shared pet art used by the dashboard, messages, and anywhere else
   the user's EndoPet needs to be rendered. Exposes window.PET_SVGS so
   pages don't have to import. */

window.PET_SVGS = {
  luna: `<svg class="pet-svg" viewBox="0 0 160 160" width="100%" height="100%">
    <ellipse cx="80" cy="138" rx="50" ry="8" fill="rgba(0,0,0,.06)"/>
    <path d="M44 60 L30 26 L52 50 Z" fill="var(--pet-mid)"/>
    <path d="M116 60 L130 26 L108 50 Z" fill="var(--pet-mid)"/>
    <path d="M48 56 L40 38 L56 50 Z" fill="var(--pet-light)"/>
    <path d="M112 56 L120 38 L104 50 Z" fill="var(--pet-light)"/>
    <ellipse cx="80" cy="106" rx="38" ry="30" fill="var(--pet-mid)"/>
    <circle cx="80" cy="80" r="36" fill="var(--pet-light)"/>
    <ellipse cx="66" cy="82" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="94" cy="82" rx="5" ry="6" fill="#2c1320"/>
    <circle cx="68" cy="80" r="1.6" fill="#fff"/><circle cx="96" cy="80" r="1.6" fill="#fff"/>
    <path d="M80 92 l-2 3 h4 z" fill="#ff5d8f"/>
    <path d="M76 96 q4 4 8 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    <ellipse cx="60" cy="93" rx="6" ry="3" fill="#ff5d8f" opacity=".35"/>
    <ellipse cx="100" cy="93" rx="6" ry="3" fill="#ff5d8f" opacity=".35"/>
  </svg>`,
  poppy: `<svg class="pet-svg" viewBox="0 0 160 160" width="100%" height="100%">
    <ellipse cx="80" cy="138" rx="50" ry="8" fill="rgba(0,0,0,.06)"/>
    <ellipse cx="50" cy="88" rx="16" ry="22" fill="var(--pet-mid)"/>
    <ellipse cx="110" cy="88" rx="16" ry="22" fill="var(--pet-mid)"/>
    <ellipse cx="80" cy="100" rx="40" ry="32" fill="var(--pet-light)"/>
    <circle cx="80" cy="78" r="34" fill="var(--pet-light)"/>
    <circle cx="80" cy="66" r="14" fill="var(--pet-mid)"/>
    <ellipse cx="68" cy="80" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="92" cy="80" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="80" cy="92" rx="3.5" ry="2.5" fill="#2c1320"/>
    <path d="M76 98 q4 4 8 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  </svg>`,
  mochi: `<svg class="pet-svg" viewBox="0 0 160 160" width="100%" height="100%">
    <ellipse cx="80" cy="138" rx="50" ry="8" fill="rgba(0,0,0,.06)"/>
    <ellipse cx="58" cy="40" rx="10" ry="26" fill="var(--pet-mid)"/>
    <ellipse cx="102" cy="40" rx="10" ry="26" fill="var(--pet-mid)"/>
    <ellipse cx="58" cy="42" rx="4" ry="16" fill="#ffb6c8"/>
    <ellipse cx="102" cy="42" rx="4" ry="16" fill="#ffb6c8"/>
    <ellipse cx="80" cy="106" rx="40" ry="32" fill="var(--pet-mid)"/>
    <circle cx="80" cy="82" r="32" fill="var(--pet-light)"/>
    <ellipse cx="68" cy="84" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="92" cy="84" rx="5" ry="6" fill="#2c1320"/>
    <path d="M78 94 l2 2 l2 -2 z" fill="#ff7a99"/>
    <path d="M76 100 q4 3 8 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  </svg>`,
  sunny: `<svg class="pet-svg" viewBox="0 0 160 160" width="100%" height="100%">
    <ellipse cx="80" cy="138" rx="50" ry="8" fill="rgba(0,0,0,.06)"/>
    <path d="M44 44 L56 70 L36 64 Z" fill="var(--pet-mid)"/>
    <path d="M116 44 L104 70 L124 64 Z" fill="var(--pet-mid)"/>
    <ellipse cx="80" cy="108" rx="38" ry="28" fill="var(--pet-mid)"/>
    <ellipse cx="80" cy="112" rx="22" ry="18" fill="#fff"/>
    <circle cx="80" cy="82" r="34" fill="var(--pet-light)"/>
    <path d="M80 70 Q60 84 64 102 Q80 96 80 96 Q80 96 96 102 Q100 84 80 70 Z" fill="#fff"/>
    <ellipse cx="68" cy="82" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="92" cy="82" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="80" cy="94" rx="3.5" ry="2.5" fill="#2c1320"/>
    <path d="M76 100 q4 4 8 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  </svg>`,
  coco: `<svg class="pet-svg" viewBox="0 0 160 160" width="100%" height="100%">
    <ellipse cx="80" cy="138" rx="50" ry="8" fill="rgba(0,0,0,.06)"/>
    <ellipse cx="80" cy="110" rx="40" ry="30" fill="var(--pet-mid)"/>
    <circle cx="40" cy="64" r="18" fill="var(--pet-mid)"/>
    <circle cx="120" cy="64" r="18" fill="var(--pet-mid)"/>
    <circle cx="40" cy="64" r="10" fill="#f4cce3"/>
    <circle cx="120" cy="64" r="10" fill="#f4cce3"/>
    <circle cx="80" cy="78" r="34" fill="var(--pet-light)"/>
    <ellipse cx="68" cy="78" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="92" cy="78" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="80" cy="94" rx="10" ry="8" fill="#2c1320"/>
    <path d="M70 106 q10 4 20 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  </svg>`,
  kiki: `<svg class="pet-svg" viewBox="0 0 160 160" width="100%" height="100%">
    <ellipse cx="80" cy="138" rx="50" ry="8" fill="rgba(0,0,0,.06)"/>
    <ellipse cx="62" cy="40" rx="7" ry="22" fill="var(--pet-mid)"/>
    <ellipse cx="98" cy="40" rx="7" ry="22" fill="var(--pet-mid)"/>
    <ellipse cx="80" cy="110" rx="40" ry="30" fill="var(--pet-mid)"/>
    <ellipse cx="80" cy="80" rx="30" ry="28" fill="var(--pet-light)"/>
    <ellipse cx="70" cy="78" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="90" cy="78" rx="5" ry="6" fill="#2c1320"/>
    <ellipse cx="80" cy="90" rx="3.5" ry="2.5" fill="#2c1320"/>
    <path d="M76 96 q4 4 8 0" stroke="#2c1320" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  </svg>`,
};


/* Render the pet art into a target container. opts:
   - container: DOM element to fill
   - type:      pet type key (luna/poppy/...). Falls back to luna.
   - colorSeed: hue rotation offset (degrees) applied to the pet's
                CSS-driven --pet-mid / --pet-light colours.
   - mood:      string set on data-mood for any mood-specific styles. */
window.renderPetSvgInto = function (container, opts) {
  if (!container) return;
  const type = opts?.type && window.PET_SVGS[opts.type] ? opts.type : "luna";
  container.innerHTML = window.PET_SVGS[type];
  container.dataset.pet = type;
  if (opts?.mood) container.dataset.mood = opts.mood;
  container.style.setProperty("--color-shift", `${opts?.colorSeed || 0}deg`);
};
