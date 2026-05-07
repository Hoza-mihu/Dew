// Protect dashboard: redirect to login if not signed in; wire Sign Out.
import { authReady } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";

function isDemoMode() {
  try {
    return sessionStorage.getItem("dewDemoMode") === "1";
  } catch {
    return false;
  }
}

function exitDemoToLogin() {
  try {
    sessionStorage.removeItem("dewDemoMode");
    sessionStorage.removeItem("dewDemoSeed");
  } catch (_) {}
  window.__dewDemoMode = false;
  window.isDemoMode = false;
  window.location.href = "/";
}

function wireSignOut(auth) {
  document.getElementById("btnExitDemo")?.addEventListener("click", () => {
    exitDemoToLogin();
  });

  document.getElementById("btnSignOut")?.addEventListener("click", () => {
    if (isDemoMode()) {
      exitDemoToLogin();
      return;
    }
    signOut(auth).then(() => {
      window.location.href = "/";
    });
  });
}

function dispatchDemoAuth() {
  const uid = window.__dewDemoUser?.uid || "demo-warden-001";
  window.__dewUid = uid;
  window.__dewAuthReady = true;
  window.dispatchEvent(new CustomEvent("dewAuthReady", { detail: { uid, demo: true } }));
}

authReady
  .then((auth) => {
    const demo = isDemoMode();

    if (demo) {
      window.__dewDemoMode = true;
      window.isDemoMode = true;
      dispatchDemoAuth();
    }

    onAuthStateChanged(auth, (user) => {
      if (user) {
        if (demo) {
          try {
            sessionStorage.removeItem("dewDemoMode");
          } catch (_) {}
          window.__dewDemoMode = false;
          window.isDemoMode = false;
          document.getElementById("btnExitDemo")?.setAttribute("hidden", "");
        }
        window.__dewUid = user.uid;
        window.__dewAuthReady = true;
        window.dispatchEvent(new CustomEvent("dewAuthReady", { detail: { uid: user.uid } }));
        return;
      }
      if (!demo) {
        window.location.href = "/login.html";
      }
    });

    wireSignOut(auth);
  })
  .catch(() => {
    if (isDemoMode()) {
      window.__dewDemoMode = true;
      window.isDemoMode = true;
      dispatchDemoAuth();
      wireSignOut(null);
      return;
    }
    window.location.href = "/login.html";
  });
