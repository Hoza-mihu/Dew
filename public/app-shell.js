/**
 * Responsive shell: mobile/tablet nav drawer, backdrop, escape to close.
 * Drawer layout matches CSS: narrow viewports OR touch devices at "desktop" widths
 * (e.g. Chrome/Safari "Desktop site" — wide innerWidth but primary touch).
 *
 * Chrome Android: debounced toggle + pointer events reduce double-fires; delegated
 * sidebar pointerup closes drawer before click; pageshow fixes stuck overflow (bfcache).
 */

/**
 * @returns {boolean} True when off-canvas drawer + hamburger should be used (see styles.css).
 */
export function isDrawerMode() {
  const w =
    typeof window !== "undefined"
      ? window.innerWidth || document.documentElement?.clientWidth || 0
      : 0;
  if (w <= 1024) return true;
  try {
    const hasTouch = (navigator.maxTouchPoints || 0) > 0;
    return (
      (window.matchMedia("(hover: none)").matches ||
        window.matchMedia("(any-hover: none)").matches ||
        hasTouch) &&
      (window.matchMedia("(pointer: coarse)").matches ||
        window.matchMedia("(any-pointer: coarse)").matches ||
        hasTouch) &&
      w < 1600
    );
  } catch {
    return false;
  }
}

function syncDrawerModeClass() {
  document.body.classList.toggle("drawer-mode", isDrawerMode());
}

function openDrawer() {
  document.body.classList.add("nav-drawer-open");
  const btn = document.getElementById("navMenuToggle");
  if (btn) {
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-label", "Close navigation menu");
  }
  const bd = document.getElementById("sidebarBackdrop");
  if (bd) bd.setAttribute("aria-hidden", "false");
  document.documentElement.style.overflow = "hidden";
  document.body.style.overflow = "hidden";
}

export function closeDrawer() {
  document.body.classList.remove("nav-drawer-open");
  const btn = document.getElementById("navMenuToggle");
  if (btn) {
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "Open navigation menu");
  }
  const bd = document.getElementById("sidebarBackdrop");
  if (bd) bd.setAttribute("aria-hidden", "true");
  document.documentElement.style.overflow = "";
  document.body.style.overflow = "";
}

function isLogoModalOpen() {
  const modal = document.getElementById("dewLogoModal");
  if (!modal) return false;
  return modal.style.display !== "none";
}

function calcLogoLightboxVars(fromEl, toEl) {
  if (!fromEl || !toEl) return { dx: 0, dy: 0, scale: 0.9 };
  try {
    const fr = fromEl.getBoundingClientRect();
    const tr = toEl.getBoundingClientRect();
    const fromCx = fr.left + fr.width / 2;
    const fromCy = fr.top + fr.height / 2;
    const toCx = tr.left + tr.width / 2;
    const toCy = tr.top + tr.height / 2;
    const dx = fromCx - toCx;
    const dy = fromCy - toCy;
    const scale = Math.max(0.18, Math.min(0.92, Math.min(fr.width / Math.max(1, tr.width), fr.height / Math.max(1, tr.height))));
    return { dx, dy, scale };
  } catch (_) {
    return { dx: 0, dy: 0, scale: 0.9 };
  }
}

function openLogoModal() {
  const modal = document.getElementById("dewLogoModal");
  const content = document.querySelector("#dewLogoModal .dew-logo-lightbox-content");
  const img = document.getElementById("dewLogoModalImg");
  const btn = document.getElementById("dewLogoBtn");
  if (!modal) return;
  if (document.body.classList.contains("nav-drawer-open")) closeDrawer();
  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");
  document.documentElement.style.overflow = "hidden";
  document.body.style.overflow = "hidden";

  // Start closed (for animation), then open next frame.
  modal.classList.remove("dew-logo-lightbox--open");
  if (content && btn) {
    // Ensure we measure the target at (almost) final layout.
    const { dx, dy, scale } = calcLogoLightboxVars(btn, content);
    content.style.setProperty("--dew-logo-dx", `${dx}px`);
    content.style.setProperty("--dew-logo-dy", `${dy}px`);
    content.style.setProperty("--dew-logo-scale", String(scale));
  }
  // Prevent a flash of transform after the open class is applied.
  requestAnimationFrame(() => {
    modal.classList.add("dew-logo-lightbox--open");
    // Force-load to avoid pop-in.
    try { img?.decode?.(); } catch (_) {}
  });
}

function closeLogoModal() {
  const modal = document.getElementById("dewLogoModal");
  if (!modal) return;
  modal.classList.remove("dew-logo-lightbox--open");
  // Wait for transition before hiding so it feels like Insta/Facebook.
  window.setTimeout(() => {
    // If re-opened quickly, don't hide.
    if (modal.classList.contains("dew-logo-lightbox--open")) return;
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
    // If drawer isn't open, release scroll locks.
    if (!document.body.classList.contains("nav-drawer-open")) {
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
    }
  }, 210);
}

function wireLogoModal() {
  const btn = document.getElementById("dewLogoBtn");
  const backdrop = document.getElementById("dewLogoModalBackdrop");
  const closeBtn = document.getElementById("dewLogoModalClose");
  if (!btn) return;

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    openLogoModal();
    closeBtn?.focus?.();
  });
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openLogoModal();
      closeBtn?.focus?.();
    }
  });

  backdrop?.addEventListener("click", closeLogoModal);
  closeBtn?.addEventListener("click", closeLogoModal);
}

const TOGGLE_DEBOUNCE_MS = 380;
let lastToggleTime = 0;

function toggleDrawer() {
  if (document.body.classList.contains("nav-drawer-open")) closeDrawer();
  else openDrawer();
}

function toggleDrawerDebounced() {
  const now = Date.now();
  if (now - lastToggleTime < TOGGLE_DEBOUNCE_MS) return;
  lastToggleTime = now;
  toggleDrawer();
}

/** Chrome: touch can fire both pointerup and click — only toggle once per gesture */
let toggleTouchConsumed = false;

function wireMenuToggle(toggle) {
  if (!toggle) return;

  toggle.addEventListener(
    "pointerup",
    (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.pointerType === "touch" || e.pointerType === "pen") {
        e.preventDefault();
        toggleTouchConsumed = true;
        toggleDrawerDebounced();
        window.setTimeout(() => {
          toggleTouchConsumed = false;
        }, 450);
      }
    },
    { passive: false }
  );

  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    if (toggleTouchConsumed) return;
    toggleDrawerDebounced();
  });
}

function backdropClose() {
  closeDrawer();
}

function wireBackdrop(backdrop) {
  if (!backdrop) return;
  backdrop.addEventListener("click", backdropClose);
  backdrop.addEventListener("pointerup", (e) => {
    if (e.pointerType === "touch" && e.target === backdrop) backdropClose();
  });
  /* Chrome: sometimes no click after touchend on fixed overlay */
  backdrop.addEventListener(
    "touchend",
    (e) => {
      if (e.target === backdrop) {
        e.preventDefault();
        backdropClose();
      }
    },
    { passive: false }
  );
}

function syncDrawerToViewport() {
  if (!isDrawerMode() && document.body.classList.contains("nav-drawer-open")) {
    closeDrawer();
  }
}

/** bfcache / tab restore: avoid body overflow stuck "hidden" when drawer wasn't open */
function recoverScrollLocksFromCache() {
  if (!document.body.classList.contains("nav-drawer-open")) {
    document.documentElement.style.overflow = "";
    document.body.style.overflow = "";
  }
}

function wire() {
  const toggle = document.getElementById("navMenuToggle");
  const backdrop = document.getElementById("sidebarBackdrop");

  wireMenuToggle(toggle);
  wireBackdrop(backdrop);
  wireLogoModal();

  document.querySelectorAll(".sidebar .nav-item[data-view]").forEach((el) => {
    el.addEventListener("click", () => {
      if (isDrawerMode()) closeDrawer();
    });
  });

  document.getElementById("btnSignOut")?.addEventListener("click", () => {
    if (isDrawerMode()) closeDrawer();
  });
  document.getElementById("btnExitDemo")?.addEventListener("click", () => {
    if (isDrawerMode()) closeDrawer();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (isLogoModalOpen()) {
      closeLogoModal();
      document.getElementById("dewLogoBtn")?.focus?.();
      return;
    }
    if (document.body.classList.contains("nav-drawer-open")) {
      closeDrawer();
      toggle?.focus();
    }
  });

  window.addEventListener("resize", syncDrawerToViewport, { passive: true });
  window.addEventListener("resize", syncDrawerModeClass, { passive: true });
  window.addEventListener("orientationchange", () => {
    setTimeout(syncDrawerModeClass, 220);
    setTimeout(syncDrawerToViewport, 320);
  });
  window.addEventListener("pageshow", (e) => {
    recoverScrollLocksFromCache();
    syncDrawerModeClass();
    if (e.persisted) syncDrawerToViewport();
  });
  try {
    window.visualViewport?.addEventListener("resize", syncDrawerToViewport, { passive: true });
    window.visualViewport?.addEventListener("resize", syncDrawerModeClass, { passive: true });
  } catch (_) {}

  syncDrawerModeClass();
  syncDrawerToViewport();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wire);
} else {
  wire();
}
