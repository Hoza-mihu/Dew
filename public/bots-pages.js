/**
 * Bots hub + Plant Bot / Desk Bot detail pages (lazy-loaded from profile.js).
 * Uses window.__dew from app.js for chart + plant list.
 */
import { authReady } from "./firebase-config.js";

const API = window.location.origin;
const ONLINE_MS = 5 * 60 * 1000;

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
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function getWeatherFromPlant(plant) {
  if (!plant) return "sunny";
  const temp = Number(plant.temp);
  const moisture = Number(plant.moisture);
  const lux = Number(plant.lux) || 0;
  if (temp < 14) return "snowy";
  if (lux < 250) return "clear-night";
  if (moisture >= 68 && lux < 1400) return "rainy";
  if (lux >= 1800 && temp >= 19) return "sunny";
  if (lux >= 800 && lux < 1800) return "cloudy";
  return "sunny";
}

function sensorStatus(kind, val) {
  if (val == null || Number.isNaN(Number(val))) return { label: "No data", tone: "unknown" };
  const v = Number(val);
  if (kind === "moisture") {
    if (v < 32) return { label: "Low", tone: "low" };
    if (v > 78) return { label: "High", tone: "high" };
    return { label: "Good", tone: "optimal" };
  }
  if (kind === "temperature") {
    if (v < 16) return { label: "Cool", tone: "low" };
    if (v > 29) return { label: "Warm", tone: "high" };
    return { label: "Comfortable", tone: "optimal" };
  }
  if (kind === "light") {
    if (v < 400) return { label: "Dim", tone: "low" };
    if (v > 3500) return { label: "Bright", tone: "high" };
    return { label: "Nice", tone: "optimal" };
  }
  if (kind === "humidity") {
    if (v < 35) return { label: "Dry", tone: "low" };
    if (v > 75) return { label: "Humid", tone: "high" };
    return { label: "Balanced", tone: "optimal" };
  }
  return { label: "—", tone: "unknown" };
}

/** Friendly “AI insight” copy — plain language, no jargon. */
function plantInsight(p) {
  if (!p) {
    return {
      title: "Connect a plant to begin",
      body: "Choose a plant above and we’ll describe how things look in simple words.",
    };
  }
  const hasAnyTelemetry = p.moisture != null || p.lux != null || p.temp != null || p.humidity != null;
  if (!hasAnyTelemetry) {
    return {
      title: "Waiting for Plant Bot data",
      body: "Your selection is saved. When your Plant Bot starts syncing, we’ll show the live readings here.",
    };
  }
  const m = Number(p.moisture);
  const lux = Number(p.lux) || 0;
  let title = "Your plant is thriving 🌱";
  const bits = [];
  if (!Number.isNaN(m)) {
    if (m < 35) {
      title = "A drink would help soon";
      bits.push("Soil is on the dry side — a light watering when you’re ready keeps things happy.");
    } else if (m > 80) {
      title = "Ease up on watering";
      bits.push("Soil is quite wet — give it time to dry a bit before the next pour.");
    } else {
      bits.push("Moisture feels right where it should be.");
    }
  }
  if (lux && lux < 350) bits.push("Light is a little low — a brighter spot could perk things up.");
  else if (lux && lux > 3200) bits.push("Light is quite strong — watch leaves if it stays intense.");
  let body = bits.join(" ");
  if (!body.trim()) body = "Everything looks steady. No action needed right now.";
  return { title, body };
}

let plantBotState = { plants: [], selectedId: null, metric: "moisture", range: "24h" };
let deskPageWired = false;

async function fetchFleetPlants() {
  let uid = window.__dewUid;
  if (!uid) {
    try {
      const auth = await authReady;
      uid = auth.currentUser?.uid || null;
    } catch (_) {}
  }
  if (!uid) return [];
  const res = await authFetch(`${API}/api/users/${encodeURIComponent(uid)}/plant-fleet`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.plants) ? data.plants : [];
}

async function fetchPlantCatalog() {
  try {
    const res = await fetch(`${API}/api/plants/catalog`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

function fleetOnline(plants) {
  let lastMs = 0;
  (plants || []).forEach((p) => {
    const t = p.updatedAt ? new Date(p.updatedAt).getTime() : 0;
    if (t > lastMs) lastMs = t;
  });
  const online = lastMs && Date.now() - lastMs < ONLINE_MS;
  return { lastMs, online, bestIso: lastMs ? new Date(lastMs).toISOString() : null };
}

function renderSensorGrid(plant) {
  const grid = document.getElementById("plantBotSensorGrid");
  if (!grid) return;
  if (!plant) {
    grid.innerHTML = `<p class="bots-muted">No plant selected.</p>`;
    return;
  }
  const t = plant.temp != null ? `${Number(plant.temp).toFixed(1)}°C` : "—";
  const h = plant.humidity != null ? `${Math.round(Number(plant.humidity))}%` : "—";
  const mo = plant.moisture != null ? `${Math.round(Number(plant.moisture))}%` : "—";
  const lx = plant.lux != null ? `${Math.round(Number(plant.lux)).toLocaleString()} lux` : "—";
  const rows = [
    { icon: "🌡", name: "Temperature", val: t, kind: "temperature", raw: plant.temp },
    { icon: "💧", name: "Humidity", val: h, kind: "humidity", raw: plant.humidity },
    { icon: "🌱", name: "Soil moisture", val: mo, kind: "moisture", raw: plant.moisture },
    { icon: "☀", name: "Light", val: lx, kind: "light", raw: plant.lux },
  ];
  grid.innerHTML = rows
    .map((r) => {
      const st = sensorStatus(r.kind, r.raw);
      return `<div class="bots-metric-tile bots-sensor-cell--${st.tone}" title="${escapeHtml(r.name)}">
        <span class="bots-metric-value">${escapeHtml(r.val)}</span>
        <span class="bots-metric-label">${r.name}</span>
        <span class="bots-metric-hint">${st.label}</span>
      </div>`;
    })
    .join("");
}

async function refreshPlantBotPage() {
  const fleetPlants = await fetchFleetPlants();
  const catalogPlants = await fetchPlantCatalog();
  plantBotState.plants = fleetPlants;

  // On first load, restore what the user previously selected for this Plant Bot.
  if (!plantBotState.selectedId) {
    try {
      const res = await authFetch(`${API}/api/plantbot-choice`);
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data && data.plantId) plantBotState.selectedId = String(data.plantId);
      }
    } catch (_) {}
  }

  const sel = document.getElementById("plantBotPlantSelect");
  if (sel) {
    const keep = plantBotState.selectedId && (catalogPlants.some((p) => p.id === plantBotState.selectedId) || fleetPlants.some((p) => p.id === plantBotState.selectedId));
    if (!keep) {
      const preferred = fleetPlants[0]?.id || catalogPlants[0]?.id || null;
      plantBotState.selectedId = preferred;
    }

    sel.innerHTML = catalogPlants.length
      ? catalogPlants.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`).join("")
      : `<option value="">No plants available</option>`;

    if (plantBotState.selectedId) sel.value = plantBotState.selectedId;
  }

  const p =
    fleetPlants.find((x) => x.id === plantBotState.selectedId) ||
    catalogPlants.find((x) => x.id === plantBotState.selectedId) ||
    null;
  let online = false;
  let syncLabel = "—";
  if (p?.updatedAt) {
    const t = new Date(p.updatedAt).getTime();
    if (!Number.isNaN(t)) {
      syncLabel = formatRelativeTime(p.updatedAt);
      online = Date.now() - t < ONLINE_MS;
    }
  }
  const ov = document.getElementById("plantBotOverviewStatus");
  const os = document.getElementById("plantBotOverviewSync");
  const on = document.getElementById("plantBotOverviewName");
  const od = document.getElementById("plantBotOverviewDevice");
  const liveText = document.getElementById("plantBotLiveText");
  const liveDot = document.getElementById("plantBotLiveDot");
  if (ov) {
    ov.textContent = online ? "Active" : "Offline";
    ov.classList.toggle("bots-status-on", !!online);
    ov.classList.toggle("bots-status-off", !online);
  }
  if (os) os.textContent = syncLabel;
  if (on) on.textContent = p ? p.name || p.id : "—";
  if (od) od.textContent = p ? `esp32-${(p.id || "plant").slice(0, 8)}` : "—";
  if (liveText) liveText.textContent = online ? "Active · Syncing live" : "Offline · Waiting for data";
  if (liveDot) liveDot.classList.toggle("is-live", !!online);

  renderSensorGrid(p);
  const insight = plantInsight(p);
  const it = document.getElementById("plantBotInsightTitle");
  const ib = document.getElementById("plantBotInsightBody");
  if (it) it.textContent = insight.title;
  if (ib) ib.textContent = insight.body;

  const dew = window.__dew;
  if (dew && dew.buildBotsPlantChart && p) {
    await dew.buildBotsPlantChart({
      plants: [p],
      metricKey: plantBotState.metric,
      range: plantBotState.range,
    });
  } else if (dew && dew.buildBotsPlantChart) {
    await dew.buildBotsPlantChart({ plants: [], metricKey: plantBotState.metric, range: plantBotState.range });
  }
}

function wirePlantBotPageOnce() {
  const sel = document.getElementById("plantBotPlantSelect");
  if (sel && sel.dataset.botsWired !== "1") {
    sel.dataset.botsWired = "1";
    sel.addEventListener("change", async () => {
      plantBotState.selectedId = sel.value;
      if (plantBotState.selectedId) {
        try {
          await authFetch(`${API}/api/plantbot-choice`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ plantId: plantBotState.selectedId }),
          });
        } catch (_) {
          // If saving fails, still refresh so the user sees the latest state.
        }
      }
      refreshPlantBotPage();
    });
  }
  document.getElementById("plantBotMetricTabs")?.querySelectorAll(".tab").forEach((tab) => {
    if (tab.dataset.botsWired === "1") return;
    tab.dataset.botsWired = "1";
    tab.addEventListener("click", () => {
      document.getElementById("plantBotMetricTabs").querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      plantBotState.metric = tab.getAttribute("data-metric") || "moisture";
      refreshPlantBotPage();
    });
  });
  document.getElementById("plantBotRangeTabs")?.querySelectorAll(".tab").forEach((tab) => {
    if (tab.dataset.botsWired === "1") return;
    tab.dataset.botsWired = "1";
    tab.addEventListener("click", () => {
      document.getElementById("plantBotRangeTabs").querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      plantBotState.range = tab.getAttribute("data-range") || "24h";
      refreshPlantBotPage();
    });
  });
  const refBtn = document.getElementById("btnRefreshPlantBotPage");
  if (refBtn && refBtn.dataset.botsWired !== "1") {
    refBtn.dataset.botsWired = "1";
    refBtn.addEventListener("click", () => {
      window.__dew?.reloadDashboard?.().finally(() => refreshPlantBotPage());
    });
  }
}

export function initPlantBotPage() {
  wirePlantBotPageOnce();
  refreshPlantBotPage();
}

function applyDeskPreviewTheme(theme) {
  const el = document.getElementById("deskBotPagePreview");
  if (!el) return;
  if (theme === "mint") el.style.background = "radial-gradient(circle at 10% 0%, #fff 0, #ddfff3 45%, #bff5ff 100%)";
  else if (theme === "sakura") el.style.background = "radial-gradient(circle at 10% 0%, #fff0f7 0, #ffd6f1 40%, #ffc0da 100%)";
  else if (theme === "midnight") el.style.background = "radial-gradient(circle at 10% 0%, #131933 0, #28305b 45%, #3ac6ff 100%)";
}

function deskPreviewFromState(plant, cfg, show) {
  const lineEl = document.getElementById("deskBotPreviewLine");
  const badges = document.getElementById("deskBotPreviewBadges");
  const prev = document.getElementById("deskBotPagePreview");
  if (lineEl) lineEl.textContent = cfg.line || "Your status line appears here.";
  const bits = [];
  if (show.moisture && plant?.moisture != null) bits.push(`Moisture ${Math.round(plant.moisture)}%`);
  if (show.temp && plant?.temp != null) bits.push(`${Number(plant.temp).toFixed(1)}°C`);
  if (show.humidity && plant?.humidity != null) bits.push(`${Math.round(plant.humidity)}% humidity`);
  if (show.light && plant?.lux != null) bits.push(`${Math.round(plant.lux)} lux`);
  if (show.weather) bits.push(`${getWeatherFromPlant(plant)} conditions`);
  if (show.health && plant?.status) bits.push(plant.status);
  if (badges) badges.innerHTML = bits.map((b) => `<span class="bots-preview-badge">${escapeHtml(b)}</span>`).join("");
  if (prev && plant) {
    prev.setAttribute("data-weather", getWeatherFromPlant(plant));
  }
}

export function initDeskBotPage() {
  fetchFleetPlants().then(async (plants) => {
    const sel = document.getElementById("deskBotPlantSelect");
    if (sel) {
      sel.innerHTML = plants.length
        ? plants.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`).join("")
        : `<option value="">No plants yet</option>`;
    }
    let cfg = {};
    try {
      const res = await fetch(`${API}/api/deskbot-config`);
      cfg = await res.json();
    } catch (_) {}
    if (sel && cfg.plantId) sel.value = cfg.plantId;
    const line = document.getElementById("deskBotLineInput");
    if (line) line.value = cfg.line || "";

    const mood = cfg.mood || "happy";
    document.querySelectorAll("#deskBotMoodRow .bots-seg-btn").forEach((b) => {
      const on = b.getAttribute("data-mood") === mood;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });

    const theme = cfg.theme || "mint";
    document.querySelectorAll("#deskBotThemeRow .bots-theme-swatch").forEach((s) => {
      s.classList.toggle("active", s.getAttribute("data-theme") === theme);
    });
    applyDeskPreviewTheme(theme);

    const show = { moisture: false, temp: false, light: false, humidity: false, weather: false, health: false, ...cfg.show };
    document.querySelectorAll("#deskBotShowToggles .bots-display-chip").forEach((btn) => {
      const k = btn.getAttribute("data-show");
      if (k != null && show[k] != null) {
        const on = !!show[k];
        btn.setAttribute("aria-pressed", on ? "true" : "false");
        btn.classList.toggle("active", on);
      }
    });

    const plant = plants.find((p) => p.id === (sel?.value || cfg.plantId)) || plants[0];
    deskPreviewFromState(plant, cfg, show);

    const { online, bestIso } = fleetOnline(plants);
    const cfgMs = cfg.updatedAt ? new Date(cfg.updatedAt).getTime() : 0;
    const best = Math.max(fleetOnline(plants).lastMs, cfgMs);
    const oSt = document.getElementById("deskBotOverviewStatus");
    const oSy = document.getElementById("deskBotOverviewSync");
    if (oSt) {
      oSt.textContent = online ? "Active" : "Offline";
      oSt.classList.toggle("bots-status-on", online);
      oSt.classList.toggle("bots-status-off", !online);
    }
    if (oSy) oSy.textContent = best ? formatRelativeTime(new Date(best).toISOString()) : "—";
    const deskLiveText = document.getElementById("deskBotLiveText");
    const deskLiveDot = document.getElementById("deskBotLiveDot");
    if (deskLiveText) deskLiveText.textContent = online ? "Active · In sync" : "Offline · Waiting for link";
    if (deskLiveDot) deskLiveDot.classList.toggle("is-live", online);

    function readForm() {
      const s = sel?.value;
      const pl = plants.find((x) => x.id === s) || plants[0];
      const sh = {};
      document.querySelectorAll("#deskBotShowToggles .bots-display-chip").forEach((btn) => {
        const k = btn.getAttribute("data-show");
        if (k) sh[k] = btn.getAttribute("aria-pressed") === "true";
      });
      const th = document.querySelector("#deskBotThemeRow .bots-theme-swatch.active")?.getAttribute("data-theme") || "mint";
      const md = document.querySelector("#deskBotMoodRow .bots-seg-btn.active")?.getAttribute("data-mood") || "happy";
      return {
        plantId: s,
        line: line?.value || "",
        theme: th,
        mood: md,
        show: sh,
        plant: pl,
      };
    }

    if (!deskPageWired) {
      deskPageWired = true;
      document.querySelectorAll("#deskBotMoodRow .bots-seg-btn").forEach((b) => {
        b.addEventListener("click", () => {
          document.querySelectorAll("#deskBotMoodRow .bots-seg-btn").forEach((x) => {
            x.classList.remove("active");
            x.setAttribute("aria-selected", "false");
          });
          b.classList.add("active");
          b.setAttribute("aria-selected", "true");
          const st = readForm();
          deskPreviewFromState(st.plant, { ...cfg, line: st.line, theme: st.theme, mood: st.mood, show: st.show }, st.show);
        });
      });
      document.querySelectorAll("#deskBotThemeRow .bots-theme-swatch").forEach((sw) => {
        sw.addEventListener("click", () => {
          document.querySelectorAll("#deskBotThemeRow .bots-theme-swatch").forEach((x) => x.classList.remove("active"));
          sw.classList.add("active");
          const th = sw.getAttribute("data-theme") || "mint";
          applyDeskPreviewTheme(th);
          const st = readForm();
          deskPreviewFromState(st.plant, { ...cfg, line: st.line, theme: th, show: st.show }, st.show);
        });
      });
      sel?.addEventListener("change", () => {
        const st = readForm();
        deskPreviewFromState(st.plant, { ...cfg, line: st.line, theme: st.theme, show: st.show }, st.show);
      });
      line?.addEventListener("input", () => {
        const st = readForm();
        deskPreviewFromState(st.plant, { ...cfg, line: line.value, theme: st.theme, show: st.show }, st.show);
      });
      document.querySelectorAll("#deskBotShowToggles .bots-display-chip").forEach((btn) => {
        btn.addEventListener("click", () => {
          const pressed = btn.getAttribute("aria-pressed") === "true";
          btn.setAttribute("aria-pressed", pressed ? "false" : "true");
          btn.classList.toggle("active", !pressed);
          const st = readForm();
          deskPreviewFromState(st.plant, { ...cfg, line: st.line, theme: st.theme, show: st.show }, st.show);
        });
      });
      document.getElementById("btnSaveDeskBotPage")?.addEventListener("click", async () => {
        const st = readForm();
        const status = document.getElementById("deskBotSaveStatus");
        try {
          const res = await authFetch(`${API}/api/deskbot-config`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              plantId: st.plantId,
              line: st.line,
              theme: st.theme,
              mood: st.mood,
              show: st.show,
            }),
          });
          if (!res.ok) throw new Error("Save failed");
          cfg = await res.json();
          window.__lastDeskbotConfig = cfg;
          if (status) status.textContent = "Saved to Desk Bot ✓";
          setTimeout(() => {
            if (status) status.textContent = "";
          }, 2500);
        } catch (e) {
          if (status) status.textContent = e.message || "Could not save";
        }
      });
    }
  });
}

/** Single entry: unified Bots page (Plant + Desk sections). */
export function initBotsPage() {
  initPlantBotPage();
  initDeskBotPage();
}
