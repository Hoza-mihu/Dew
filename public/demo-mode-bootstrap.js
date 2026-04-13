/**
 * Must load before auth-guard / firebase-config so fetch is patched early.
 */
import { installDemoFetch, seedDemoSession, invalidateDemoFleetCache } from "./demo-mock-api.js";

const qs = new URLSearchParams(window.location.search || "");
if (qs.get("mode") === "demo") {
  try {
    sessionStorage.setItem("dewDemoMode", "1");
  } catch (_) {}
  try {
    const path = window.location.pathname || "/";
    history.replaceState({}, "", path);
  } catch (_) {}
}

if (sessionStorage.getItem("dewDemoMode") === "1") {
  window.__dewDemoMode = true;
  window.isDemoMode = true;
  seedDemoSession();
  // Load full generated catalog first so Demo "Plants" and "My Plants" match production catalog.
  const { loadDemoPlantCatalog } = await import("./demo-mock-api.js");
  await loadDemoPlantCatalog();
  installDemoFetch();
}

function syncExitDemoNavVisibility() {
  const btn = document.getElementById("btnExitDemo");
  if (!btn) return;
  btn.hidden = sessionStorage.getItem("dewDemoMode") !== "1";
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", syncExitDemoNavVisibility);
} else {
  syncExitDemoNavVisibility();
}

/** Optional: gentle “live” refresh so charts and numbers drift slightly (simulated IoT). */
window.addEventListener(
  "dewAuthReady",
  () => {
    if (sessionStorage.getItem("dewDemoMode") !== "1") return;
    setInterval(() => {
      invalidateDemoFleetCache();
      try {
        window.__dew?.reloadDashboard?.();
      } catch (_) {}
    }, 22000);
  },
  { once: true }
);
