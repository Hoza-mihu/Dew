// DEW Eco Warden – Firebase config from .env (via /api/config/firebase), then auth
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";

let app = null;
let auth = null;

const authReady = (async () => {
  const res = await fetch("/api/config/firebase");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || "Firebase config unavailable. Check .env (see .env.example).");
  }
  const firebaseConfig = await res.json();
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  return auth;
})();

export { authReady, app, auth };

/** Use auth after awaiting authReady, e.g. const auth = await authReady; */
export function getAuthInstance() {
  return auth;
}
