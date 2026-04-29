import { authReady } from "./firebase-config.js";

const API = (import.meta.env && import.meta.env.VITE_API_BASE_URL) ? import.meta.env.VITE_API_BASE_URL : window.location.origin;

async function authFetch(url, options = {}) {
  try {
    const auth = await authReady;
    const user = auth.currentUser;
    const headers = new Headers(options.headers || {});
    if (user) {
      const token = await user.getIdToken();
      headers.set("Authorization", `Bearer ${token}`);
    }
    return fetch(url, { ...options, headers });
  } catch (_) {
    return fetch(url, options);
  }
}

async function dewReadErrorMessage(res, fallback) {
  try {
    const j = await res.json();
    if (j && typeof j.error === "string" && j.error.trim()) return j.error.trim();
  } catch (_) {}
  if (res.status === 401 || res.status === 403) return "Please sign in again, then retry.";
  return fallback || "Something went wrong.";
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function copyText(text) {
  const t = String(text || "");
  if (!t) return false;
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch (_) {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return !!ok;
  }
}

function toast(msg, type = "success") {
  try {
    window.__dewShowToast?.(msg, type);
  } catch (_) {}
  // Fallback: minimal
  if (!window.__dewShowToast) console.log(`[${type}]`, msg);
}

function fmtIso(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

let wired = false;

async function refreshLists() {
  const devList = document.getElementById("iotDevicesList");
  const devEmpty = document.getElementById("iotDevicesEmpty");
  const tbList = document.getElementById("iotTearboardsList");
  const tbEmpty = document.getElementById("iotTearboardsEmpty");

  if (devList) devList.innerHTML = "";
  if (tbList) tbList.innerHTML = "";
  if (devEmpty) devEmpty.style.display = "none";
  if (tbEmpty) tbEmpty.style.display = "none";

  const [devRes, tbRes] = await Promise.all([
    authFetch(`${API}/api/iot/devices`),
    authFetch(`${API}/api/iot/tearboards`),
  ]);

  const devJson = devRes.ok ? await devRes.json().catch(() => ({})) : {};
  const tbJson = tbRes.ok ? await tbRes.json().catch(() => ({})) : {};
  const devices = Array.isArray(devJson.devices) ? devJson.devices : [];
  const tearboards = Array.isArray(tbJson.tearboards) ? tbJson.tearboards : [];

  if (devEmpty) devEmpty.style.display = devices.length ? "none" : "block";
  if (tbEmpty) tbEmpty.style.display = tearboards.length ? "none" : "block";

  if (devList) {
    devList.innerHTML = devices
      .map(
        (d) => `<div class="card" style="margin-bottom: 10px">
          <div class="card-body" style="display:flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap">
            <div style="min-width: 260px">
              <div style="font-weight: 700">${escapeHtml(d.device_name || d.device_id)}</div>
              <div class="bots-muted" style="margin-top: 2px">
                <code>${escapeHtml(d.device_id)}</code> · last seen ${escapeHtml(fmtIso(d.last_seen_at))}
              </div>
            </div>
            <div style="display:flex; gap: 10px; flex-wrap: wrap; align-items: center">
              <button type="button" class="btn btn-ghost btn-sm" data-action="rotate-device-token" data-device-id="${escapeHtml(d.device_id)}">
                <i class="ri-refresh-line"></i> Rotate token
              </button>
              <button type="button" class="btn btn-ghost btn-sm" data-action="prefill-device" data-device-id="${escapeHtml(d.device_id)}">
                <i class="ri-edit-2-line"></i> Use in mapping
              </button>
            </div>
          </div>
        </div>`
      )
      .join("");
  }

  if (tbList) {
    tbList.innerHTML = tearboards
      .map(
        (t) => `<div class="card" style="margin-bottom: 10px">
          <div class="card-body" style="display:flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap">
            <div style="min-width: 260px">
              <div style="font-weight: 700">${escapeHtml(t.name || t.tearboard_id)}</div>
              <div class="bots-muted" style="margin-top: 2px">
                <code>${escapeHtml(t.tearboard_id)}</code> · created ${escapeHtml(fmtIso(t.created_at))}
              </div>
            </div>
            <div style="display:flex; gap: 10px; flex-wrap: wrap; align-items: center">
              <button type="button" class="btn btn-ghost btn-sm" data-action="prefill-tearboard" data-tearboard-id="${escapeHtml(t.tearboard_id)}">
                <i class="ri-edit-2-line"></i> Use in mapping
              </button>
            </div>
          </div>
        </div>`
      )
      .join("");
  }
}

async function createDevice() {
  const idEl = document.getElementById("iotDeviceId");
  const nameEl = document.getElementById("iotDeviceName");
  const device_id = String(idEl?.value || "").trim();
  const device_name = String(nameEl?.value || "").trim();

  const res = await authFetch(`${API}/api/iot/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id, device_name }),
  });
  if (!res.ok) {
    toast(await dewReadErrorMessage(res, "Could not create device."), "error");
    return;
  }
  const json = await res.json().catch(() => ({}));
  const tok = json.device_token || "";
  if (tok) {
    await copyText(tok);
    toast("Device created. Token copied to clipboard.", "success");
  } else {
    toast("Device created.", "success");
  }
  if (idEl) idEl.value = json.device_id || device_id;
  if (nameEl) nameEl.value = "";
  await refreshLists();
}

async function rotateDeviceToken(deviceId) {
  const did = String(deviceId || "").trim();
  if (!did) return;
  const res = await authFetch(`${API}/api/iot/devices/${encodeURIComponent(did)}/rotate-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    toast(await dewReadErrorMessage(res, "Could not rotate token."), "error");
    return;
  }
  const json = await res.json().catch(() => ({}));
  if (json.device_token) {
    await copyText(json.device_token);
    toast("New device token copied to clipboard.", "success");
  } else {
    toast("Token rotated.", "success");
  }
}

async function createTearboard() {
  const nameEl = document.getElementById("iotTearboardName");
  const deviceEl = document.getElementById("iotTearboardDeviceId");
  const name = String(nameEl?.value || "").trim();
  const device_id = String(deviceEl?.value || "").trim();

  const res = await authFetch(`${API}/api/iot/tearboards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, device_id }),
  });
  if (!res.ok) {
    toast(await dewReadErrorMessage(res, "Could not create tearboard."), "error");
    return;
  }
  const json = await res.json().catch(() => ({}));
  const tok = json.tearboard_token || "";
  if (tok) {
    await copyText(tok);
    toast("Tearboard created. Token copied to clipboard.", "success");
    const test = document.getElementById("iotTestTbToken");
    if (test && !String(test.value || "").trim()) test.value = tok;
  } else {
    toast("Tearboard created.", "success");
  }
  if (nameEl) nameEl.value = "";
  if (deviceEl) deviceEl.value = "";
  await refreshLists();
}

async function mapDevice() {
  const tbEl = document.getElementById("iotMapTearboardId");
  const devEl = document.getElementById("iotMapDeviceId");
  const tearboard_id = String(tbEl?.value || "").trim();
  const device_id = String(devEl?.value || "").trim();
  if (!tearboard_id || !device_id) {
    toast("Enter tearboard_id and device_id.", "info");
    return;
  }

  const res = await authFetch(`${API}/api/iot/tearboards/${encodeURIComponent(tearboard_id)}/map-device`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id }),
  });
  if (!res.ok) {
    toast(await dewReadErrorMessage(res, "Could not map device."), "error");
    return;
  }
  toast("Mapped device to tearboard.", "success");
}

async function testTearboardRead() {
  const tokEl = document.getElementById("iotTestTbToken");
  const out = document.getElementById("iotTestOut");
  const tok = String(tokEl?.value || "").trim();
  if (!tok) {
    toast("Paste a tb_... tearboard token first.", "info");
    return;
  }
  if (out) out.textContent = "Loading…";
  const res = await fetch(`${API}/api/tearboard/get-device-data?limit=10`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const json = await res.json().catch(() => ({}));
  if (out) out.textContent = JSON.stringify(json, null, 2);
  if (!res.ok) toast(json.error || "Fetch failed.", "error");
  else toast("Fetched tearboard data.", "success");
}

function wireOnce() {
  if (wired) return;
  wired = true;

  // Expose toast hook so this module can reuse the app toast when present.
  if (!window.__dewShowToast && typeof window.showToast === "function") {
    window.__dewShowToast = window.showToast;
  }

  document.getElementById("btnIotRefresh")?.addEventListener("click", refreshLists);
  document.getElementById("btnIotCreateDevice")?.addEventListener("click", createDevice);
  document.getElementById("btnIotCreateTearboard")?.addEventListener("click", createTearboard);
  document.getElementById("btnIotMapDevice")?.addEventListener("click", mapDevice);
  document.getElementById("btnIotTestTbRead")?.addEventListener("click", testTearboardRead);

  document.getElementById("iotDevicesList")?.addEventListener("click", async (e) => {
    const btn = e.target?.closest("button[data-action]");
    if (!btn) return;
    const act = btn.getAttribute("data-action");
    if (act === "rotate-device-token") {
      await rotateDeviceToken(btn.getAttribute("data-device-id"));
    } else if (act === "prefill-device") {
      const devEl = document.getElementById("iotMapDeviceId");
      if (devEl) devEl.value = btn.getAttribute("data-device-id") || "";
      toast("Device id filled into mapping.", "success");
    }
  });

  document.getElementById("iotTearboardsList")?.addEventListener("click", async (e) => {
    const btn = e.target?.closest("button[data-action]");
    if (!btn) return;
    const act = btn.getAttribute("data-action");
    if (act === "prefill-tearboard") {
      const tbEl = document.getElementById("iotMapTearboardId");
      if (tbEl) tbEl.value = btn.getAttribute("data-tearboard-id") || "";
      toast("Tearboard id filled into mapping.", "success");
    }
  });
}

export async function initIotSetupPage() {
  wireOnce();
  await refreshLists();
}

