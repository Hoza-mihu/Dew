// Protect dashboard: redirect to login if not signed in; wire Sign Out.
import { authReady } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";

authReady.then((auth) => {
  onAuthStateChanged(auth, (user) => {
    window.__dewUid = user ? user.uid : null;
    if (!user) {
      window.location.href = "/login.html";
      return;
    }
    window.__dewAuthReady = true;
    window.dispatchEvent(new CustomEvent("dewAuthReady", { detail: { uid: user.uid } }));
  });

  document.getElementById("btnSignOut")?.addEventListener("click", () => {
    signOut(auth).then(() => {
      window.location.href = "/login.html";
    });
  });
}).catch(() => {
  window.location.href = "/login.html";
});
