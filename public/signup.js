import { authReady } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  GithubAuthProvider,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";

authReady.then(async (auth) => {
  try {
    const result = await getRedirectResult(auth);
    if (result?.user) {
      window.location.href = "/dashboard";
      return;
    }
    if (result?.error) {
      const errorEl = document.getElementById("signupError");
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
  const errorEl = document.getElementById("signupError");
  if (errorEl) {
    errorEl.textContent = err.message || "Firebase config failed. Check .env and server.";
    errorEl.classList.add("show");
  }
});

const form = document.getElementById("signupForm");
const emailEl = document.getElementById("email");
const passwordEl = document.getElementById("password");
const confirmEl = document.getElementById("confirmPassword");
const errorEl = document.getElementById("signupError");
const btnSubmit = document.getElementById("btnSubmit");
const pwdRuleEl = document.getElementById("pwdRule");
const matchRuleEl = document.getElementById("matchRule");

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.add("show");
}
function hideError() {
  errorEl.textContent = "";
  errorEl.classList.remove("show");
}

function getAuthErrorMessage(err) {
  if (!err || !err.code) return "Something went wrong. Please try again.";
  const code = (err.code || "").toLowerCase();
  if (code.includes("api-key") || code.includes("api_key") || code.includes("invalid-api-key"))
    return "Authentication isn’t configured correctly. If you’re the developer: check your Firebase API key in the Console and ensure HTTP referrer restrictions allow this site (e.g. localhost).";
  if (err.code === "auth/email-already-in-use")
    return "This email is already in use. Sign in or use another email.";
  if (err.code === "auth/invalid-email") return "Please enter a valid email address.";
  if (err.code === "auth/weak-password") return "Password is too weak. Use at least 6 characters.";
  if (err.code === "auth/network-request-failed") return "Network error. Check your connection and try again.";
  if (err.code === "auth/popup-blocked") return "Sign-in popup was blocked. Allow popups for this site and try again.";
  if (err.code === "auth/account-exists-with-different-credential") return "An account already exists with this email. Sign in with your existing method instead.";
  return err.message || "Something went wrong. Please try again.";
}

// Inline validation hints
function updatePwdRule() {
  if (!pwdRuleEl || !passwordEl) return;
  const len = (passwordEl.value || "").length;
  pwdRuleEl.textContent = len < 6 ? "At least 6 characters" : "✓ Length OK";
  pwdRuleEl.classList.toggle("invalid", len > 0 && len < 6);
  pwdRuleEl.classList.toggle("valid", len >= 6);
}
function updateMatchRule() {
  if (!matchRuleEl || !passwordEl || !confirmEl) return;
  const p = passwordEl.value;
  const c = confirmEl.value;
  if (c.length === 0) {
    matchRuleEl.textContent = "Passwords must match";
    matchRuleEl.classList.remove("valid", "invalid");
    return;
  }
  matchRuleEl.textContent = p === c ? "✓ Passwords match" : "Passwords don’t match";
  matchRuleEl.classList.toggle("invalid", p !== c);
  matchRuleEl.classList.toggle("valid", p === c);
}
passwordEl?.addEventListener("input", () => {
  updatePwdRule();
  updateMatchRule();
});
confirmEl?.addEventListener("input", updateMatchRule);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();
  const email = emailEl.value.trim();
  const password = passwordEl.value;
  const confirm = confirmEl.value;
  if (!email || !password) {
    showError("Please fill in email and password.");
    return;
  }
  if (password.length < 6) {
    showError("Password must be at least 6 characters.");
    return;
  }
  if (password !== confirm) {
    showError("Passwords do not match.");
    return;
  }
  btnSubmit.disabled = true;
  form.classList.add("login-loading");
  try {
    const auth = await authReady;
    await createUserWithEmailAndPassword(auth, email, password);
    window.location.href = "/dashboard";
  } catch (err) {
    showError(getAuthErrorMessage(err));
  } finally {
    btnSubmit.disabled = false;
    form.classList.remove("login-loading");
  }
});

// Reset form – clear fields and hide passwords
document.getElementById("resetForm")?.addEventListener("click", (e) => {
  e.preventDefault();
  hideError();
  emailEl.value = "";
  passwordEl.value = "";
  confirmEl.value = "";
  passwordEl.type = "password";
  confirmEl.type = "password";
  const formEl = document.getElementById("signupForm");
  formEl?.querySelectorAll(".toggle-pwd i").forEach((icon) => {
    icon.className = "ri-eye-line";
  });
  formEl?.querySelectorAll(".toggle-pwd").forEach((btn) => {
    btn.setAttribute("title", "Show password");
    btn.setAttribute("aria-label", "Show password");
  });
  updatePwdRule();
  updateMatchRule();
});

// Google / GitHub sign-up (same as login – Firebase creates account on first use)
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
      // no message
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
