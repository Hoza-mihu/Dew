/**
 * Sync Data dashboard — sensor cards, sparklines, sync to Supabase via POST /api/sensors/sync
 */
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

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatRelativeTime(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  return `${Math.floor(sec / 86400)} d ago`;
}

function clamp(n, a, b) {
  return Math.min(b, Math.max(a, n));
}

/** Sparkline SVG path (line only). */
function buildSparkline(values, w = 120, h = 36) {
  const nums = values.map((v) => Number(v)).filter((v) => !Number.isNaN(v));
  const pad = 2;
  if (nums.length === 1) {
    const y = h / 2;
    return { d: `M ${pad} ${y} L ${w - pad} ${y}`, fill: "none" };
  }
  if (nums.length < 2) return { d: "", fill: "none" };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;
  const step = innerW / (nums.length - 1);
  const pts = nums.map((v, i) => {
    const x = pad + i * step;
    const y = pad + innerH - ((v - min) / span) * innerH;
    return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  });
  return { d: pts.join(" "), fill: "none" };
}

function trendFromSeries(series) {
  if (!series || series.length < 2) return { arrow: "—", pct: 0, label: "No trend yet" };
  const a = Number(series[0]);
  const b = Number(series[series.length - 1]);
  if (Number.isNaN(a) || Number.isNaN(b)) return { arrow: "—", pct: 0, label: "No trend yet" };
  const delta = b - a;
  const base = Math.abs(a) > 0.001 ? Math.abs(a) : 1;
  const pct = (delta / base) * 100;
  const arrow = delta > 0.5 ? "↑" : delta < -0.5 ? "↓" : "→";
  const sign = pct >= 0 ? "+" : "";
  return { arrow, pct, label: `${arrow} ${sign}${pct.toFixed(1)}%` };
}

/** Map value to 0–100% on optimal bar (center of band = green). */
function optimalMarkerPct(value, optimal) {
  if (value == null || !optimal) return 50;
  const { min, max } = optimal;
  const span = max - min || 1;
  const low = min - span * 0.35;
  const high = max + span * 0.35;
  return clamp(((Number(value) - low) / (high - low)) * 100, 0, 100);
}

function insightLine(plant, optimal) {
  if (!plant) return "";
  const parts = [];
  const t = Number(plant.temp);
  const m = Number(plant.moisture);
  const lux = Number(plant.lux) || 0;
  if (!Number.isNaN(t) && optimal?.temp) {
    if (t > optimal.temp.max) parts.push("Temperature is slightly above the comfort band.");
    else if (t < optimal.temp.min) parts.push("Temperature is a bit cool for this plant.");
  }
  if (!Number.isNaN(m) && optimal?.moisture) {
    if (m < optimal.moisture.min) parts.push("Soil moisture is low — consider watering soon.");
    else if (m > optimal.moisture.max) parts.push("Soil is quite wet — hold off on watering.");
  }
  if (lux && optimal?.lux) {
    if (lux < optimal.lux.min) parts.push("Light is on the low side — move closer to a window if you can.");
    else if (lux > optimal.lux.max * 1.8) parts.push("Light is very strong — watch for leaf stress.");
  }
  if (parts.length === 0) return "All key readings look within a comfortable range.";
  return parts.join(" ");
}

const SENSOR_DEFS = [
  { id: "temperature", label: "Temperature", icon: "ri-temp-hot-line", key: "temp", unit: "°C", format: (v) => `${Number(v).toFixed(1)}°C` },
  { id: "humidity", label: "Humidity", icon: "ri-water-percent-line", key: "humidity", unit: "%", format: (v) => `${Math.round(Number(v))}%` },
  { id: "moisture", label: "Soil moisture", icon: "ri-drop-line", key: "moisture", unit: "%", format: (v) => `${Math.round(Number(v))}%` },
  { id: "light", label: "Light (lux)", icon: "ri-sun-line", key: "lux", unit: "lux", format: (v) => `${Math.round(Number(v)).toLocaleString()} lux` },
];

let state = {
  range: "24h",
  plantId: null,
  visible: new Set(SENSOR_DEFS.map((s) => s.id)),
  wired: false,
};

/** Last fetch (avoid full reload when only toggling sensor filters). */
let syncCache = { plant: null, readings: null };

async function fetchFleet(uid) {
  const res = await authFetch(`${API}/api/users/${encodeURIComponent(uid)}/plant-fleet`);
  if (!res.ok) return { plants: [], summary: {} };
  const data = await res.json();
  return { plants: data.plants || [], summary: data.summary || {} };
}

async function fetchTelemetry(plantId, range) {
  let q = "hours=24";
  if (range === "7d") q = "hours=168";
  else if (range === "30d") q = "hours=720";
  else if (range === "all") q = "hours=all";
  const res = await fetch(`${API}/api/plants/${encodeURIComponent(plantId)}/telemetry?${q}`);
  if (!res.ok) return [];
  return res.json();
}

function seriesForKey(readings, key) {
  return (readings || []).map((r) => r[key]).filter((v) => v != null && !Number.isNaN(Number(v)));
}

function optimalForKey(optimal, id) {
  if (!optimal) return null;
  if (id === "temperature") return optimal.temp;
  if (id === "humidity") return optimal.humidity;
  if (id === "moisture") return optimal.moisture;
  if (id === "light") return optimal.lux;
  return null;
}

function renderSkeleton(grid) {
  grid.classList.add("sync-data-grid--loading");
  grid.innerHTML = Array(4)
    .fill(0)
    .map(
      () => `<article class="sync-sensor-card sync-sensor-card--skeleton">
      <div class="sync-skeleton-line sync-skeleton-line--lg"></div>
      <div class="sync-skeleton-line"></div>
      <div class="sync-skeleton-spark"></div>
    </article>`
    )
    .join("");
}

function renderEmpty(emptyEl, grid, insights, show) {
  grid.innerHTML = "";
  grid.classList.remove("sync-data-grid--loading");
  if (insights) insights.innerHTML = "";
  if (!show) return;
  emptyEl.style.display = "flex";
}

function renderCards({ grid, emptyEl, insightsEl, plant, readings, alertEl }) {
  emptyEl.style.display = "none";
  grid.classList.remove("sync-data-grid--loading");
  const optimal = plant.optimal || {};
  const updated = plant.updatedAt ? formatRelativeTime(plant.updatedAt) : "—";
      const online = plant.updatedAt && Date.now() - new Date(plant.updatedAt).getTime() < 5 * 60 * 1000;

  const cardsHtml = SENSOR_DEFS.filter((def) => state.visible.has(def.id))
    .map((def) => {
      const raw = plant[def.key];
      const has = raw != null && !Number.isNaN(Number(raw));
      const series = seriesForKey(readings, def.key);
      const spark = buildSparkline(series);
      const tr = trendFromSeries(series);
      const opt = optimalForKey(optimal, def.id);
      const display = has ? def.format(raw) : "—";
      const marker = has && opt ? optimalMarkerPct(raw, opt) : 50;
      const optLabel =
        opt && opt.min != null && opt.max != null
          ? `Optimal: ${def.id === "temperature" ? opt.min + "–" + opt.max + "°C" : opt.min + "–" + opt.max + (def.id === "light" ? " lux" : "%")}`
          : "Ideal ranges follow your plant profile";
      const active = has && online;

      return `<article class="sync-sensor-card" data-sensor="${def.id}">
        <header class="sync-sensor-card__head">
          <span class="sync-sensor-card__icon" aria-hidden="true"><i class="${def.icon}"></i></span>
          <div class="sync-sensor-card__titles">
            <h3 class="sync-sensor-card__name">${escapeHtml(def.label)}</h3>
            <span class="sync-sensor-card__status ${active ? "is-on" : "is-off"}">
              ${active ? "Active" : "Disconnected"}
            </span>
          </div>
        </header>
        <div class="sync-sensor-card__value-row">
          <span class="sync-sensor-card__value">${escapeHtml(display)}</span>
          <span class="sync-sensor-card__trend" title="Change across selected period">${escapeHtml(tr.label)}</span>
        </div>
        <div class="sync-sensor-card__meta">Updated ${escapeHtml(updated)}</div>
        <div class="sync-sensor-card__spark" aria-hidden="true">
          <svg viewBox="0 0 120 36" preserveAspectRatio="none">${spark.d ? `<path d="${escapeHtml(spark.d)}" fill="none" class="sync-spark-path" vector-effect="non-scaling-stroke" />` : ""}</svg>
        </div>
        <div class="sync-sensor-card__opt">
          <span class="sync-sensor-card__opt-label">${escapeHtml(optLabel)}</span>
          <div class="sync-opt-bar" role="presentation">
            <div class="sync-opt-bar__gradient"></div>
            <div class="sync-opt-bar__marker" style="left:${marker}%"></div>
          </div>
        </div>
      </article>`;
    })
    .join("");

  grid.innerHTML = cardsHtml || `<p class="sync-data-muted">No sensors selected — use the toggles above.</p>`;

  if (insightsEl) {
    insightsEl.innerHTML = `<div class="sync-data-insights-inner">
      <i class="ri-lightbulb-line" aria-hidden="true"></i>
      <p>${escapeHtml(insightLine(plant, optimal))}</p>
    </div>`;
  }

  if (alertEl) alertEl.style.display = "none";
}

async function loadAndRender() {
  const grid = document.getElementById("syncDataGrid");
  const emptyEl = document.getElementById("syncDataEmpty");
  const insightsEl = document.getElementById("syncDataInsights");
  const alertEl = document.getElementById("syncDataAlert");
  const lastEl = document.getElementById("syncDataLastSynced");
  if (!grid || !emptyEl) return;

  const auth = await authReady;
  const uid = auth.currentUser?.uid;
  if (!uid) {
    emptyEl.style.display = "flex";
    grid.innerHTML = "";
    return;
  }

  renderSkeleton(grid);
  const { plants } = await fetchFleet(uid);
  if (!plants.length) {
    renderEmpty(emptyEl, grid, insightsEl, true);
    if (lastEl) lastEl.textContent = "Last synced: —";
    return;
  }

  if (!state.plantId || !plants.find((p) => p.id === state.plantId)) {
    state.plantId = plants[0].id;
  }
  const plant = plants.find((p) => p.id === state.plantId) || plants[0];
  const sel = document.getElementById("syncPlantSelect");
  if (sel) {
    sel.innerHTML = plants.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`).join("");
    sel.value = state.plantId;
  }

  const readings = await fetchTelemetry(plant.id, state.range);
  syncCache = { plant, readings };
  renderCards({ grid, emptyEl, insightsEl, plant, readings, alertEl });

  try {
    const lr = await authFetch(`${API}/api/sensors/last-sync`);
    if (lr.ok) {
      const j = await lr.json();
      if (lastEl && j.lastSync) lastEl.textContent = `Last synced: ${formatRelativeTime(j.lastSync)}`;
      else if (lastEl) lastEl.textContent = "Last synced: — (Supabase optional)";
    }
  } catch (_) {
    if (lastEl) lastEl.textContent = "Last synced: —";
  }
}

function wireOnce() {
  if (state.wired) return;
  state.wired = true;

  document.getElementById("syncRangeTabs")?.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.getElementById("syncRangeTabs").querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      state.range = tab.getAttribute("data-range") || "24h";
      loadAndRender();
    });
  });

  document.getElementById("syncPlantSelect")?.addEventListener("change", (e) => {
    state.plantId = e.target.value;
    loadAndRender();
  });

  document.getElementById("syncSensorFilters")?.querySelectorAll(".sync-filter-chip[data-sensor]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-sensor");
      if (!id) return;
      if (state.visible.has(id)) state.visible.delete(id);
      else state.visible.add(id);
      btn.classList.toggle("active", state.visible.has(id));
      btn.setAttribute("aria-pressed", state.visible.has(id) ? "true" : "false");
      const grid = document.getElementById("syncDataGrid");
      const emptyEl = document.getElementById("syncDataEmpty");
      const insightsEl = document.getElementById("syncDataInsights");
      const alertEl = document.getElementById("syncDataAlert");
      if (syncCache.plant && grid && emptyEl) {
        renderCards({ grid, emptyEl, insightsEl, plant: syncCache.plant, readings: syncCache.readings, alertEl });
      } else loadAndRender();
    });
  });

  const btn = document.getElementById("btnSyncNow");
  btn?.addEventListener("click", async () => {
    const alertEl = document.getElementById("syncDataAlert");
    const lastEl = document.getElementById("syncDataLastSynced");
    btn.disabled = true;
    btn.classList.add("is-syncing");
    if (alertEl) {
      alertEl.style.display = "none";
      alertEl.textContent = "";
    }
    try {
      const res = await authFetch(`${API}/api/sensors/sync`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "Sync failed");
      if (j.warning && alertEl) {
        alertEl.className = "sync-data-alert sync-data-alert--warn";
        alertEl.textContent = j.warning;
        alertEl.style.display = "flex";
      }
      if (lastEl && j.syncedAt) lastEl.textContent = `Last synced: ${formatRelativeTime(j.syncedAt)}`;
      await loadAndRender();
    } catch (e) {
      if (alertEl) {
        alertEl.className = "sync-data-alert sync-data-alert--err";
        alertEl.innerHTML = `${escapeHtml(e.message || "Could not sync")} <button type="button" class="btn btn-ghost btn-sm" id="syncRetryBtn">Retry</button>`;
        alertEl.style.display = "flex";
        document.getElementById("syncRetryBtn")?.addEventListener("click", () => btn.click(), { once: true });
      }
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-syncing");
    }
  });

  document.getElementById("syncDataConnectCta")?.addEventListener("click", () => {
    document.querySelector('.nav-item[data-view="bots"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

export function initSyncDataPage() {
  wireOnce();
  loadAndRender();
}
