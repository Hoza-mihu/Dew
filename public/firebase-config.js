// DEW Eco Warden – Firebase config from API (/api/config/firebase) or Vite env (VITE_*)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";

let app = null;
let auth = null;

/** Used only when Demo Mode is on and /api/config/firebase is unavailable (offline / no server). */
const DEMO_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDemoDew000000000000000000000000",
  authDomain: "dew-demo-local.firebaseapp.com",
  projectId: "dew-demo-local",
  storageBucket: "dew-demo-local.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abcdef1234567890abcdef",
};

/** Prefer API (npm start / dev:api). If proxy fails (502) or API returns 503, use VITE_FIREBASE_* from .env. */
function firebaseConfigFromViteEnv() {
  const v = import.meta.env;
  const cfg = {
    apiKey: v.VITE_FIREBASE_API_KEY,
    authDomain: v.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: v.VITE_FIREBASE_PROJECT_ID,
    storageBucket: v.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: v.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: v.VITE_FIREBASE_APP_ID,
    measurementId: v.VITE_FIREBASE_MEASUREMENT_ID,
  };
  const required = ["apiKey", "authDomain", "projectId", "storageBucket", "messagingSenderId", "appId"];
  const missing = required.filter((k) => !cfg[k]);
  if (missing.length) return null;
  if (!cfg.measurementId) delete cfg.measurementId;
  return cfg;
}

async function loadFirebaseConfig() {
  try {
    const res = await fetch("/api/config/firebase");
    if (res.ok) return await res.json();
  } catch {
    /* ECONNREFUSED / 502 from proxy when API is not running */
  }
  const fromVite = firebaseConfigFromViteEnv();
  if (fromVite) return fromVite;
  throw new Error(
    "Firebase config unavailable. Run the API (e.g. npm run dev:api) with FIREBASE_* in .env, " +
      "or set VITE_FIREBASE_* in .env for Vite-only dev (see .env.example)."
  );
}

const authReady = (async () => {
  const demo =
    typeof sessionStorage !== "undefined" && sessionStorage.getItem("dewDemoMode") === "1";
  let firebaseConfig;
  try {
    firebaseConfig = await loadFirebaseConfig();
  } catch (e) {
    if (demo) {
      firebaseConfig = DEMO_FIREBASE_CONFIG;
    } else {
      throw e;
    }
  }
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  return auth;
})();

export { authReady, app, auth };

/** Use auth after awaiting authReady, e.g. const auth = await authReady; */
export function getAuthInstance() {
  return auth;
}
