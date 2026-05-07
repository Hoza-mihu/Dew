import { authReady } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  GithubAuthProvider,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";

authReady.then(async (auth) => {
  // Complete Google/GitHub sign-in if user just returned from redirect
  try {
    const result = await getRedirectResult(auth);
    if (result?.user) {
      window.location.href = "/dashboard";
      return;
    }
    if (result?.error) {
      const errorEl = document.getElementById("loginError");
      if (errorEl) {
        errorEl.textContent = result.error.message || "Sign-in failed.";
        errorEl.classList.add("show");
      }
    }
  } catch (_) { /* no redirect pending */ }

  onAuthStateChanged(auth, (user) => {
    if (user) window.location.href = "/dashboard";
  });
}).catch((err) => {
  const errorEl = document.getElementById("loginError");
  if (errorEl) {
    errorEl.textContent = err.message || "Firebase config failed. Check .env and server.";
    errorEl.classList.add("show");
  }
});

const form = document.getElementById("loginForm");
const emailEl = document.getElementById("email");
const passwordEl = document.getElementById("password");
const errorEl = document.getElementById("loginError");
const successEl = document.getElementById("loginSuccess");
const btnSubmit = document.getElementById("btnSubmit");
const loginFormBlock = document.getElementById("loginFormBlock");
const forgotBlock = document.getElementById("forgotBlock");
const forgotLink = document.getElementById("forgotLink");
const forgotBack = document.getElementById("forgotBack");
const forgotForm = document.getElementById("forgotForm");
const forgotEmailEl = document.getElementById("forgotEmail");
const btnForgotSubmit = document.getElementById("btnForgotSubmit");

function showError(msg) {
  successEl.classList.remove("show");
  successEl.textContent = "";
  errorEl.textContent = msg;
  errorEl.classList.add("show");
}
function hideError() {
  errorEl.textContent = "";
  errorEl.classList.remove("show");
}
function showSuccess(msg) {
  errorEl.classList.remove("show");
  errorEl.textContent = "";
  successEl.textContent = msg;
  successEl.classList.add("show");
}

// Friendly messages for Firebase errors (including API key)
function getAuthErrorMessage(err) {
  if (!err || !err.code) return "Something went wrong. Please try again.";
  const code = (err.code || "").toLowerCase();
  if (code.includes("api-key") || code.includes("api_key") || code.includes("invalid-api-key"))
    return "Authentication isn’t configured correctly. If you’re the developer: check your Firebase API key in the Console and ensure HTTP referrer restrictions allow this site (e.g. localhost).";
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found")
    return "Invalid email or password.";
  if (code === "auth/invalid-email") return "Please enter a valid email address.";
  if (code === "auth/too-many-requests") return "Too many attempts. Try again later.";
  if (code === "auth/network-request-failed") return "Network error. Check your connection and try again.";
  if (code === "auth/popup-blocked") return "Sign-in popup was blocked. Allow popups for this site and try again.";
  if (code === "auth/account-exists-with-different-credential") return "An account already exists with the same email but a different sign-in method. Try signing in with that method instead.";
  return err.message || "Something went wrong. Please try again.";
}

// Remember me: save/restore email and password for next visit
const rememberMeEl = document.getElementById("rememberMe");
const DEW_REMEMBER = "dew_remember_me";
const DEW_EMAIL = "dew_remember_email";
const DEW_PASSWORD = "dew_remember_password";

function initRememberMe() {
  const remembered = localStorage.getItem(DEW_REMEMBER) === "1";
  const savedEmail = localStorage.getItem(DEW_EMAIL);
  const savedPassword = localStorage.getItem(DEW_PASSWORD);
  if (remembered && savedEmail) {
    emailEl.value = savedEmail;
    passwordEl.value = savedPassword || "";
    rememberMeEl.checked = true;
  } else {
    emailEl.value = "";
    passwordEl.value = "";
    rememberMeEl.checked = false;
  }
}
initRememberMe();

// Forgot password
forgotLink?.addEventListener("click", (e) => {
  e.preventDefault();
  hideError();
  loginFormBlock.style.display = "none";
  forgotBlock.classList.add("show");
  forgotEmailEl.value = emailEl.value.trim();
  setTimeout(() => forgotEmailEl.focus(), 100);
});

forgotBack?.addEventListener("click", (e) => {
  e.preventDefault();
  loginFormBlock.style.display = "block";
  forgotBlock.classList.remove("show");
  hideError();
  successEl.classList.remove("show");
});

// Reset form – clear fields and hide password
document.getElementById("resetForm")?.addEventListener("click", (e) => {
  e.preventDefault();
  hideError();
  successEl.classList.remove("show");
  emailEl.value = "";
  passwordEl.value = "";
  passwordEl.type = "password";
  const icon = document.getElementById("togglePwdIcon");
  if (icon) icon.className = "ri-eye-line";
  const toggleBtn = document.querySelector("#loginForm .toggle-pwd");
  if (toggleBtn) {
    toggleBtn.setAttribute("title", "Show password");
    toggleBtn.setAttribute("aria-label", "Show password");
  }
  rememberMeEl.checked = false;
  localStorage.removeItem(DEW_REMEMBER);
  localStorage.removeItem(DEW_EMAIL);
  localStorage.removeItem(DEW_PASSWORD);
});

forgotForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();
  successEl.classList.remove("show");
  const email = forgotEmailEl.value.trim();
  if (!email) {
    showError("Please enter your email address.");
    return;
  }
  btnForgotSubmit.disabled = true;
  try {
    const auth = await authReady;
    await sendPasswordResetEmail(auth, email);
    showSuccess("Check your email for a link to reset your password.");
    forgotEmailEl.value = "";
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      showError("No account found with this email.");
    } else {
      showError(getAuthErrorMessage(err));
    }
  } finally {
    btnForgotSubmit.disabled = false;
  }
});

function isValidEmail(str) {
  if (!str || typeof str !== "string") return false;
  const trimmed = str.trim();
  if (!trimmed) return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(trimmed);
}

// Sign in
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();
  const email = emailEl.value.trim();
  const password = passwordEl.value;
  if (!email || !password) {
    showError("Please enter email and password.");
    return;
  }
  if (!isValidEmail(email)) {
    showError("Please enter a valid email address.");
    emailEl.focus();
    return;
  }
  btnSubmit.disabled = true;
  form.classList.add("login-loading");
  try {
    const auth = await authReady;
    const remember = rememberMeEl?.checked ?? false;
    await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
    if (remember) {
      localStorage.setItem(DEW_REMEMBER, "1");
      localStorage.setItem(DEW_EMAIL, email);
      localStorage.setItem(DEW_PASSWORD, password);
    } else {
      localStorage.removeItem(DEW_REMEMBER);
      localStorage.removeItem(DEW_EMAIL);
      localStorage.removeItem(DEW_PASSWORD);
    }
    await signInWithEmailAndPassword(auth, email, password);
    window.location.href = "/dashboard";
  } catch (err) {
    showError(getAuthErrorMessage(err));
  } finally {
    btnSubmit.disabled = false;
    form.classList.remove("login-loading");
  }
});

// Google sign-in
const btnGoogle = document.getElementById("btnGoogle");
const btnGitHub = document.getElementById("btnGitHub");

async function signInWithProvider(providerName, provider) {
  hideError();
  const btn = providerName === "Google" ? btnGoogle : btnGitHub;
  if (!btn) return;
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  btn.innerHTML = providerName === "Google" ? '<i class="ri-google-fill"></i> Signing in with Google…' : '<i class="ri-github-fill"></i> Signing in with GitHub…';
  try {
    const auth = await authReady;
    const remember = rememberMeEl?.checked ?? false;
    await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
    try {
      await signInWithPopup(auth, provider);
      window.location.href = "/dashboard";
    } catch (popupErr) {
      if (popupErr.code === "auth/popup-blocked") {
        await signInWithRedirect(auth, provider);
        return;
      }
      throw popupErr;
    }
  } catch (err) {
    if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") {
      // User closed popup – no message
    } else {
      showError(getAuthErrorMessage(err));
    }
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.innerHTML = originalLabel;
  }
}

btnGoogle?.addEventListener("click", () => signInWithProvider("Google", new GoogleAuthProvider()));
btnGitHub?.addEventListener("click", () => signInWithProvider("GitHub", new GithubAuthProvider()));

document.getElementById("btnTryDemo")?.addEventListener("click", () => {
  try {
    sessionStorage.setItem("dewDemoMode", "1");
  } catch (_) {}
  // Root path is routed to landing.html on Vercel; ensure demo opens the dashboard shell.
  window.location.href = "/dashboard?mode=demo";
});

// Petals
function createPetals() {
  const layer = document.getElementById("petalLayer");
  if (!layer) return;
  const count = window.innerWidth < 600 ? 12 : 22;
  for (let i = 0; i < count; i++) {
    const p = document.createElement("div");
    p.className = "petal";
    p.style.left = Math.random() * 100 + "vw";
    p.style.animationDelay = -(Math.random() * 16) + "s";
    p.style.width = 10 + Math.random() * 10 + "px";
    p.style.height = 14 + Math.random() * 14 + "px";
    layer.appendChild(p);
  }
}
createPetals();
