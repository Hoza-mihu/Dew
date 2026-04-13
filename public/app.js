import { authReady } from "./firebase-config.js";

const API = window.location.origin;

/** Attach Firebase ID token so the server can link Desk Bot / plant fleet to your account. */
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

const palette = { pothos: '#65d9a5', 'snake-plant': '#ffb86b', 'spider-plant': '#6bc2ff', 'peace-lily': '#ff8ab6', monstera: '#8b7fd9' };
let plants = [];
let plantFleetExpanded = false;
let plantFleetSummary = null;
const PLANT_FLEET_PREVIEW = 5;
let sensorChart = null;
let botsPlantChartInstance = null;
let plantFleetPollTimer = null;
const PLANT_FLEET_POLL_MS = 20000;
/** Dashboard activity list (from GET /api/users/:uid/activity-feed). */
let activityFeed = [];

/** Fleet optimal ranges (aligned with server `PLANT_OPTIMAL_*`). */
const DEFAULT_OPTIMAL = {
  temp: { min: 18, max: 30 },
  humidity: { min: 40, max: 70 },
  moisture: { min: 30, max: 60 },
  lux: { min: 200, max: 1500 },
};
let chartRange = '24h';
let lastWeatherForTips = null;
const telemetryCache = new Map();
const TELEMETRY_TTL_MS = 20000;
const ONLINE_MS = 5 * 60 * 1000;

/** Today's area averages from Open-Meteo (saved map location), not sensors. Set by loadDashboardWeather. */
let areaTodayAverages = null;

const WEATHER_CACHE_MS = 15 * 60 * 1000;
let weatherCache = { data: null, at: 0, locKey: null };
let weatherApiKey = '';
let weatherConfigFetched = false;

function wmoCondition(code) {
  if (code === 0) return 'Clear';
  if (code >= 1 && code <= 3) return ['Mainly clear', 'Partly cloudy', 'Overcast'][code - 1];
  if (code >= 45 && code <= 48) return 'Foggy';
  if (code >= 51 && code <= 67) return 'Rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Rain showers';
  if (code >= 85 && code <= 86) return 'Snow showers';
  if (code >= 95 && code <= 99) return 'Thunderstorm';
  return 'Unknown';
}

/** Map OpenWeather main to display condition and animation key. */
function openWeatherToCondition(main) {
  const m = (main || '').toLowerCase();
  if (m === 'clear') return { condition: 'Clear', animation: 'sunny' };
  if (m === 'clouds') return { condition: 'Clouds', animation: 'cloudy' };
  if (m === 'rain' || m === 'drizzle') return { condition: main, animation: 'rainy' };
  if (m === 'snow') return { condition: 'Snow', animation: 'snowy' };
  if (m === 'thunderstorm') return { condition: 'Thunderstorm', animation: 'thunderstorm' };
  if (m === 'mist' || m === 'fog' || m === 'haze') return { condition: main, animation: 'cloudy' };
  return { condition: main || 'Unknown', animation: 'cloudy' };
}

async function fetchUserLocation() {
  const uid = window.__dewUid;
  if (!uid) return null;
  const res = await authFetch(API + '/api/users/' + encodeURIComponent(uid) + '/location');
  if (!res.ok) return null;
  return res.json();
}

async function fetchWeatherConfig() {
  const res = await fetch(API + '/api/config/weather');
  if (!res.ok) return;
  const json = await res.json();
  weatherApiKey = (json.openWeatherApiKey || '').trim();
}

async function fetchWeatherOpenWeather(lat, lon) {
  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${encodeURIComponent(weatherApiKey)}&units=metric`;
  const res = await fetch(url);
  if (res.status === 401) throw new Error('OPENWEATHER_UNAUTHORIZED');
  if (!res.ok) throw new Error('Weather unavailable');
  const json = await res.json();
  if (json.cod && json.cod !== 200) throw new Error('Weather unavailable');
  const main = json.weather && json.weather[0] ? json.weather[0].main : '';
  const { condition, animation } = openWeatherToCondition(main);
  const m = json.main || {};
  const wind = json.wind && json.wind.speed != null ? Math.round(json.wind.speed * 3.6) : null;
  return {
    temp: m.temp,
    humidity: m.humidity,
    condition,
    animation,
    wind,
  };
}

async function fetchWeatherOpenMeteo(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Weather unavailable');
  const json = await res.json();
  const c = json.current;
  if (!c) throw new Error('Invalid weather data');
  const condition = wmoCondition(c.weather_code);
  let animation = 'cloudy';
  if (c.weather_code === 0) animation = 'sunny';
  else if (c.weather_code >= 95) animation = 'thunderstorm';
  else if (c.weather_code >= 71 && c.weather_code <= 77 || c.weather_code >= 85 && c.weather_code <= 86) animation = 'snowy';
  else if (c.weather_code >= 51 && c.weather_code <= 67 || c.weather_code >= 80 && c.weather_code <= 82) animation = 'rainy';
  else if (c.weather_code >= 1 && c.weather_code <= 3) animation = 'cloudy';
  return {
    temp: c.temperature_2m,
    humidity: c.relative_humidity_2m,
    condition,
    animation,
    wind: c.wind_speed_10m != null ? Math.round(c.wind_speed_10m) : null,
  };
}

async function fetchWeatherFromApi(lat, lon) {
  if (weatherApiKey) return fetchWeatherOpenWeather(lat, lon);
  return fetchWeatherOpenMeteo(lat, lon);
}

var WEATHER_ICONS = { sunny: 'ri-sun-line', cloudy: 'ri-cloud-line', rainy: 'ri-rainy-line', snowy: 'ri-snowflake-line', thunderstorm: 'ri-thunderstorms-line', windy: 'ri-windy-line' };

function populateHeroParticles(animation, windKmh, isMobile) {
  const rainCount = isMobile ? 22 : 40;
  const snowCount = isMobile ? 18 : 30;
  const sunCount = isMobile ? 8 : 16;
  const windCount = isMobile ? 12 : 24;

  const rainContainer = document.getElementById('weatherHeroRainContainer');
  const snowContainer = document.getElementById('weatherHeroSnowContainer');
  const sunContainer = document.getElementById('weatherHeroSunParticles');
  const stormRainContainer = document.getElementById('weatherHeroStormRainContainer');
  const windContainer = document.getElementById('weatherHeroWindParticles');

  if (animation === 'rainy' && rainContainer && rainContainer.children.length === 0) {
    for (let i = 0; i < rainCount; i++) {
      const d = document.createElement('div');
      d.className = 'hero-rain-drop';
      d.style.left = Math.random() * 100 + '%';
      d.style.animationDelay = (Math.random() * 0.5) + 's';
      d.style.animationDuration = (0.6 + Math.random() * 0.4) + 's';
      rainContainer.appendChild(d);
    }
  }
  if (animation === 'thunderstorm' && stormRainContainer && stormRainContainer.children.length === 0) {
    for (let i = 0; i < rainCount; i++) {
      const d = document.createElement('div');
      d.className = 'hero-rain-drop';
      d.style.left = Math.random() * 100 + '%';
      d.style.animationDelay = (Math.random() * 0.5) + 's';
      d.style.animationDuration = (0.5 + Math.random() * 0.3) + 's';
      stormRainContainer.appendChild(d);
    }
  }
  if (animation === 'snowy' && snowContainer && snowContainer.children.length === 0) {
    for (let i = 0; i < snowCount; i++) {
      const s = document.createElement('div');
      s.className = 'hero-snowflake';
      s.style.left = Math.random() * 100 + '%';
      s.style.animationDelay = (Math.random() * 2) + 's';
      s.style.animationDuration = (2.5 + Math.random() * 1.5) + 's';
      if (i % 3 === 0) s.classList.add('hero-snowflake--small');
      else if (i % 3 === 1) s.classList.add('hero-snowflake--large');
      snowContainer.appendChild(s);
    }
  }
  if (animation === 'sunny' && sunContainer && sunContainer.children.length === 0) {
    for (let i = 0; i < sunCount; i++) {
      const p = document.createElement('div');
      p.className = 'hero-sun-particle';
      p.style.left = Math.random() * 100 + '%';
      p.style.top = Math.random() * 100 + '%';
      p.style.animationDelay = (Math.random() * 3) + 's';
      p.style.animationDuration = (4 + Math.random() * 3) + 's';
      sunContainer.appendChild(p);
    }
  }
  if (windContainer && windKmh != null && windKmh >= 25 && windContainer.children.length === 0) {
    for (let i = 0; i < windCount; i++) {
      const w = document.createElement('div');
      w.className = 'hero-wind-particle';
      w.style.left = Math.random() * 100 + '%';
      w.style.top = Math.random() * 100 + '%';
      w.style.animationDelay = (Math.random() * 2) + 's';
      w.style.animationDuration = (2 + Math.random() * 2) + 's';
      windContainer.appendChild(w);
    }
  }
}

function renderWeatherHero(loc, weather) {
  const hero = document.getElementById('dashboardWeatherHero');
  const wrap = document.getElementById('dashboardWeatherWrap');
  const empty = document.getElementById('dashboardWeatherEmpty');
  if (!hero || !empty) return;
  if (!loc || !weather) {
    hero.style.display = 'none';
    if (wrap) wrap.style.display = 'none';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  if (wrap) wrap.style.display = 'none';
  hero.style.display = 'block';

  const anim = weather.animation || 'sunny';
  hero.setAttribute('data-weather', anim);
  const temp = weather.temp != null ? Number(weather.temp) : null;
  const tempLevel = temp < 0 ? 'cold' : (temp > 30 ? 'hot' : 'moderate');
  hero.setAttribute('data-temp', tempLevel);
  const isWindy = weather.wind != null && weather.wind >= 25;
  hero.setAttribute('data-windy', isWindy ? 'true' : 'false');

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
  populateHeroParticles(anim, weather.wind, isMobile);

  const iconEl = document.getElementById('weatherHeroIconI');
  if (iconEl) {
    iconEl.className = WEATHER_ICONS[anim] || WEATHER_ICONS.cloudy;
  }

  const locationLabel = [loc.city, loc.state, loc.country].filter(Boolean).join(', ') || 'Your location';
  const locEl = document.getElementById('weatherHeroLocation');
  const tempEl = document.getElementById('weatherHeroTemp');
  const condEl = document.getElementById('weatherHeroCondition');
  const humEl = document.getElementById('weatherHeroHumidity');
  const windEl = document.getElementById('weatherHeroWind');
  if (locEl) locEl.textContent = locationLabel;
  if (tempEl) tempEl.textContent = Math.round(weather.temp) + '°C';
  if (condEl) condEl.textContent = weather.condition;
  if (humEl) humEl.textContent = (weather.humidity != null ? weather.humidity + '%' : '—');
  if (windEl) windEl.textContent = (weather.wind != null ? weather.wind + ' km/h' : '—');

  reportWeatherForAlerts(weather);
  applyWeatherPlantTips(loc, weather, typeof plants !== 'undefined' ? plants : []);
}

function reportWeatherForAlerts(weather) {
  const uid = window.__dewUid;
  if (!uid || !weather) return;
  const API = window.location.origin;
  fetch(API + '/api/users/' + encodeURIComponent(uid) + '/weather-alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      temp: weather.temp,
      condition: weather.condition,
      humidity: weather.humidity,
      wind: weather.wind,
    }),
  })
    .then((r) => r.json())
    .then((data) => {
      if (data.created > 0 && typeof window.updateAlertsBadge === 'function') window.updateAlertsBadge();
    })
    .catch(() => {});
}

function renderWeatherCard(loc, weather) {
  const wrap = document.getElementById('dashboardWeatherWrap');
  const locEl = document.getElementById('dashboardWeatherLocation');
  const tempEl = document.getElementById('dashboardWeatherTemp');
  const condEl = document.getElementById('dashboardWeatherCondition');
  const humEl = document.getElementById('dashboardWeatherHumidity');
  const windEl = document.getElementById('dashboardWeatherWind');
  if (!wrap) return;
  if (!loc || !weather) return;
  const locationLabel = [loc.city, loc.state, loc.country].filter(Boolean).join(', ') || 'Your location';
  if (locEl) locEl.textContent = locationLabel;
  if (tempEl) tempEl.textContent = Math.round(weather.temp) + '°C';
  if (condEl) condEl.textContent = weather.condition;
  if (humEl) humEl.textContent = (weather.humidity != null ? weather.humidity + '%' : '—');
  if (windEl) windEl.textContent = (weather.wind != null ? weather.wind + ' km/h' : '—');
  applyWeatherPlantTips(loc, weather, typeof plants !== 'undefined' ? plants : []);
}

async function loadDashboardWeather() {
  const hero = document.getElementById('dashboardWeatherHero');
  const wrap = document.getElementById('dashboardWeatherWrap');
  const empty = document.getElementById('dashboardWeatherEmpty');
  if (!hero || !empty) return;

  const uid = window.__dewUid;
  if (!uid) {
    areaTodayAverages = null;
    hero.style.display = 'none';
    if (wrap) wrap.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  // Server-side weather endpoint handles caching + open-meteo calls.
  try {
    const res = await authFetch(`${API}/api/weather?user_id=${encodeURIComponent(uid)}`);
    if (!res.ok) throw new Error('Weather request failed');

    const data = await res.json();
    if (!data.ok || !data.location || !data.weather) {
      areaTodayAverages = null;
      hero.style.display = 'none';
      if (wrap) wrap.style.display = 'none';
      empty.style.display = 'block';
      maybeShowWeatherLocationPrompt();
      renderMetrics(typeof plants !== 'undefined' ? plants : []);
      return;
    }
    const loc = data.location;
    const weather = data.weather;
    areaTodayAverages = data.areaToday || null;
    empty.style.display = 'none';
    hero.style.display = 'block';
    if (wrap) wrap.style.display = 'block';
    renderWeatherHero(loc, weather);
    maybeHideWeatherLocationPrompt();
    renderMetrics(typeof plants !== 'undefined' ? plants : []);
    if (typeof plants !== 'undefined' && plants.length) {
      renderDailySummary(plants).catch(() => {});
    }
  } catch (e) {
    console.warn('Dashboard weather failed:', e.message);
    areaTodayAverages = null;
    hero.style.display = 'none';
    if (wrap) wrap.style.display = 'none';
    empty.style.display = 'block';
    maybeShowWeatherLocationPrompt();
    renderMetrics(typeof plants !== 'undefined' ? plants : []);
  }
}

window.refreshDashboardWeather = loadDashboardWeather;

// ============================================================
// Weather location prompt (first visit + "Change location")
// ============================================================
const WEATHER_LOCATION_PROMPT_STORAGE_KEY = "dewWeatherLocationPrompted";

function initWeatherLocationPromptUI() {
  const modal = document.getElementById("weatherLocationPromptModal");
  const closeBtn = document.getElementById("weatherLocationPromptCloseBtn");
  const searchBtn = document.getElementById("weatherLocationPromptBtnSearch");
  const detectBtn = document.getElementById("weatherLocationPromptBtnDetect");
  const statusEl = document.getElementById("weatherLocationPromptStatus");
  const changeBtn = document.getElementById("dashboardWeatherChangeLocationBtn");
  if (!modal || !detectBtn || !searchBtn) return;

  function setStatus(msg, type = "error") {
    if (!statusEl) return;
    statusEl.style.display = msg ? "block" : "none";
    statusEl.textContent = msg || "";
    statusEl.className =
      "location-message" +
      (type === "error"
        ? " location-message--error"
        : type === "success"
          ? " location-message--success"
          : "");
    statusEl.dataset.type = type;
  }

  function disableModalButtons(disabled) {
    detectBtn.disabled = !!disabled;
    searchBtn.disabled = !!disabled;
    if (closeBtn) closeBtn.disabled = !!disabled;
  }

  function showModal() {
    // `.modal` is flex by default in CSS, so use flex when opening.
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
    disableModalButtons(false);
    setStatus("");
    try {
      document.body.style.overflow = "hidden";
    } catch (_) {}
  }

  function hideModal() {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
    try {
      document.body.style.overflow = "";
    } catch (_) {}
  }

  if (closeBtn) closeBtn.addEventListener("click", hideModal);

  changeBtn?.addEventListener("click", () => {
    // Always open on explicit change requests.
    showModal();
  });

  searchBtn.addEventListener("click", () => {
    hideModal();
    // Settings view contains the manual location search UI.
    const settingsNav = document.querySelector('.nav-item[data-view="settings"]');
    if (settingsNav) settingsNav.click();
  });

  function nominatimPickCity(a) {
    if (!a || typeof a !== "object") return "";
    return (
      a.city ||
      a.town ||
      a.village ||
      a.municipality ||
      a.city_district ||
      a.suburb ||
      a.neighbourhood ||
      a.quarter ||
      a.hamlet ||
      a.residential ||
      a.county ||
      ""
    );
  }

  async function reverseGeocode(lat, lon) {
    const ua = "dew-weather-system/1.0";
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&format=json&addressdetails=1&zoom=18`;
    const res = await fetch(url, { headers: { "User-Agent": ua } });
    if (!res.ok) throw new Error("Reverse geocode failed");
    const json = await res.json();
    const a = json?.address || {};
    return {
      city: nominatimPickCity(a),
      state: a.state || a.state_district || "",
      country: a.country || "",
    };
  }

  detectBtn.addEventListener("click", async () => {
    const uid = window.__dewUid;
    if (!uid) return;

    if (typeof window.isSecureContext !== "undefined" && !window.isSecureContext) {
      const h = window.location.hostname || "";
      if (h !== "localhost" && h !== "127.0.0.1") {
        setStatus("On phones, precise location needs HTTPS. Open the site with https:// or set your city in Settings.", "error");
        return;
      }
    }

    disableModalButtons(true);
    setStatus("Requesting your location…", "info");

    if (!navigator.geolocation) {
      setStatus("Geolocation is not supported by this browser.", "error");
      disableModalButtons(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const lat = pos.coords.latitude;
          const lon = pos.coords.longitude;
          setStatus("Finding your exact location…", "info");
          const addr = await reverseGeocode(lat, lon);
          const payload = {
            city: addr.city,
            state: addr.state,
            country: addr.country,
            latitude: lat,
            longitude: lon,
          };
          const putRes = await authFetch(`${API}/api/users/${encodeURIComponent(uid)}/location`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!putRes.ok) throw new Error("Failed to save location");
          hideModal();
          disableModalButtons(false);
          // Refresh after saving.
          if (typeof window.refreshDashboardWeather === "function") window.refreshDashboardWeather();
        } catch (e) {
          setStatus(e?.message || "Could not detect/save location. Try again.", "error");
          disableModalButtons(false);
        }
      },
      (err) => {
        let msg = "Could not access your location. Try again.";
        if (err && err.code === 1) msg = "Location permission denied. You can still search manually.";
        else if (err && err.code === 3) msg = "Location timed out. Try again with GPS on or set manually.";
        setStatus(msg, "error");
        disableModalButtons(false);
      },
      { enableHighAccuracy: true, timeout: 25000, maximumAge: 0 }
    );
  });

  // Expose show/hide for loadDashboardWeather calls.
  window.__showWeatherLocationPrompt = () => showModal();
  window.__hideWeatherLocationPrompt = () => hideModal();
}

function maybeShowWeatherLocationPrompt() {
  try {
    const prompted = window.localStorage?.getItem(WEATHER_LOCATION_PROMPT_STORAGE_KEY) === "1";
    if (prompted) return;
    window.localStorage?.setItem(WEATHER_LOCATION_PROMPT_STORAGE_KEY, "1");
  } catch (_) {}
  if (window.__showWeatherLocationPrompt) window.__showWeatherLocationPrompt();
}

function maybeHideWeatherLocationPrompt() {
  if (window.__hideWeatherLocationPrompt) window.__hideWeatherLocationPrompt();
}

// Bind prompt UI once the module loads (DOM is already present for this script).
initWeatherLocationPromptUI();

/** Record plant usage for the current user (updates profile "Plants" count). */
function recordPlantUsage(plantIds) {
  const uid = window.__dewUid;
  if (!uid || !Array.isArray(plantIds) || plantIds.length === 0) return;
  authFetch(API + '/api/users/' + encodeURIComponent(uid) + '/usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plantIds }),
  }).catch(() => {});
}

function createPetals() {
  const layer = document.getElementById('petalLayer');
  const count = window.innerWidth < 600 ? 12 : 22;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'petal';
    p.style.left = Math.random() * 100 + 'vw';
    p.style.animationDelay = -(Math.random() * 16) + 's';
    p.style.width = (10 + Math.random() * 10) + 'px';
    p.style.height = (14 + Math.random() * 14) + 'px';
    layer.appendChild(p);
  }
}

function plantOptimal(p) {
  return p && p.optimal ? p.optimal : DEFAULT_OPTIMAL;
}

/** @returns {'optimal'|'warn'|'bad'} */
function valueInRangeStatus(val, min, max) {
  if (val == null || min == null || max == null) return 'warn';
  const span = Math.max(1e-6, max - min);
  const margin = span * 0.12;
  if (val >= min && val <= max) return 'optimal';
  if (val >= min - margin && val <= max + margin) return 'warn';
  return 'bad';
}

/**
 * Card quality class + short hint for dashboard metric tiles.
 * Green = inside optimal, yellow = just outside (soft margin), red = far outside.
 */
function metricConditionQuality(val, min, max) {
  if (val == null || min == null || max == null) {
    return { status: 'warn', qClass: 'metric-card--q-warn', hint: 'Waiting for data…' };
  }
  const st = valueInRangeStatus(val, min, max);
  const span = Math.max(1e-6, max - min);
  const margin = span * 0.12;
  let hint = 'Optimal conditions ✓';
  if (st === 'optimal') {
    return { status: st, qClass: 'metric-card--q-optimal', hint };
  }
  if (val < min) {
    const gap = min - val;
    if (gap > margin) hint = 'Too low — action needed';
    else hint = 'Slightly low — monitor ⚠';
  } else {
    const gap = val - max;
    if (gap > margin) hint = 'Too high — check environment';
    else hint = 'Slightly high — monitor ⚠';
  }
  const qClass = st === 'warn' ? 'metric-card--q-warn' : 'metric-card--q-bad';
  return { status: st, qClass, hint };
}

/** Garden health index 0–100 → quality buckets for card tint + hint. */
function gardenHealthQuality(healthPct) {
  if (healthPct >= 82) return { qClass: 'metric-card--q-optimal', hint: 'Optimal conditions ✓' };
  if (healthPct >= 58) return { qClass: 'metric-card--q-warn', hint: 'Good — watch moisture on a few plants ⚠' };
  return { qClass: 'metric-card--q-bad', hint: 'Several plants need care' };
}

function fleetAvgRange(plants, key) {
  if (!plants.length) return { min: null, max: null };
  let minSum = 0;
  let maxSum = 0;
  let n = 0;
  plants.forEach((p) => {
    const o = plantOptimal(p)[key];
    if (o && o.min != null && o.max != null) {
      minSum += o.min;
      maxSum += o.max;
      n += 1;
    }
  });
  if (!n) return { min: null, max: null };
  return { min: minSum / n, max: maxSum / n };
}

function metricBarRow(label, valueStr, unit, range, rawVal, min, max, rightTag = 'Fleet avg', hintOverride = null) {
  const q = metricConditionQuality(rawVal, min, max);
  const hint = hintOverride != null && String(hintOverride).trim() !== '' ? hintOverride : q.hint;
  const qClass = hintOverride != null && rawVal == null ? 'metric-card--q-warn' : q.qClass;
  let pct = 50;
  if (rawVal != null && min != null && max != null) {
    const lo = min - (max - min) * 0.5;
    const hi = max + (max - min) * 0.5;
    pct = Math.max(0, Math.min(100, ((Number(rawVal) - lo) / Math.max(1e-6, hi - lo)) * 100));
  }
  const zoneLeft = min != null && max != null ? 35 : 25;
  const zoneW = min != null && max != null ? 30 : 50;
  return `
    <div class="metric-card ${qClass} metric-card--condition">
      <div class="metric-label"><span>${label}</span><span class="right">${rightTag}</span></div>
      <div class="metric-value"><span class="metric-value-num">${valueStr}</span><span class="metric-unit">${unit}</span></div>
      <div class="metric-optimal">Optimal ${range}</div>
      <div class="metric-bar-wrap" aria-hidden="true">
        <div class="metric-bar-track"></div>
        <div class="metric-bar-zone" style="left:${zoneLeft}%;width:${zoneW}%"></div>
        <div class="metric-bar-fill" style="width:${pct}%"></div>
        <div class="metric-bar-dot" style="left:${pct}%"></div>
      </div>
      <div class="metric-condition-hint">${escapeHtml(hint)}</div>
      <div class="metric-tag">DEW Warden</div>
    </div>`;
}

/** Plants linked via live Plant Bot telemetry (sensors). */
function telemetryPlantsList(plants) {
  return (plants || []).filter((p) => String(p.usage?.last_source || '') === 'telemetry');
}

/**
 * Top row tiles: saved-area weather (not live sensors). Garden health: Plant Bot telemetry only.
 * Garden health: **average index from Plant Bot (telemetry) plants only**.
 */
function renderMetrics(plants) {
  const row = document.getElementById('metricsRow');
  if (!row) return;
  const o = DEFAULT_OPTIMAL;
  const a = areaTodayAverages;
  const tp = telemetryPlantsList(plants);

  const tempRange = `${o.temp.min}–${o.temp.max} °C`;
  const humRange = `${o.humidity.min}–${o.humidity.max} %`;
  const luxRange = `${o.lux.min}–${o.lux.max} lx`;
  const moistRangeDefault = `${o.moisture.min}–${o.moisture.max} %`;

  const avgTemp = a && a.avgTempC != null ? Number(a.avgTempC) : null;
  const avgHum = a && a.avgHumidityPct != null ? Number(a.avgHumidityPct) : null;
  const avgLux = a && a.avgLuxApprox != null ? Number(a.avgLuxApprox) : null;

  const hintNoArea =
    window.__dewUid && !a ? 'Add a location in Settings to load area weather for this row.' : null;

  const cards = [
    metricBarRow(
      'Avg temp',
      avgTemp != null ? avgTemp.toFixed(1) : '—',
      '°C',
      tempRange,
      avgTemp,
      o.temp.min,
      o.temp.max,
      'Area · today',
      avgTemp == null ? hintNoArea : null
    ),
    metricBarRow(
      'Air humidity',
      avgHum != null ? String(Math.round(avgHum)) : '—',
      '%',
      humRange,
      avgHum,
      o.humidity.min,
      o.humidity.max,
      'Area · today',
      avgHum == null ? hintNoArea : null
    ),
    metricBarRow(
      'Avg light',
      avgLux != null ? String(Math.round(avgLux)) : '—',
      'lx',
      luxRange,
      avgLux,
      o.lux.min,
      o.lux.max,
      'Area · today',
      avgLux == null ? hintNoArea : null
    ),
  ];

  const mr = fleetAvgRange(tp, 'moisture');
  const mrMin = mr.min != null ? mr.min : o.moisture.min;
  const mrMax = mr.max != null ? mr.max : o.moisture.max;
  const moistRangeFleet =
    mr.min != null && mr.max != null ? `${Math.round(mr.min)}–${Math.round(mr.max)} %` : moistRangeDefault;

  const nt = tp.length;
  if (nt === 0) {
    cards.push(`
    <div class="metric-card metric-card--q-bad metric-card--condition metric-card--garden-health">
      <div class="metric-label"><span>Garden health</span><span class="right">Plant Bots</span></div>
      <div class="metric-value"><span class="metric-value-num">—</span><span class="metric-unit">%</span></div>
      <div class="metric-optimal">Optimal ${moistRangeDefault} soil moisture (sensor plants)</div>
      <div class="metric-bar-wrap" aria-hidden="true">
        <div class="metric-bar-track"></div>
        <div class="metric-bar-zone" style="left:35%;width:30%"></div>
        <div class="metric-bar-fill" style="width:50%"></div>
        <div class="metric-bar-dot" style="left:50%"></div>
      </div>
      <div class="metric-condition-hint">No Plant Bot sensors linked — open <strong>Bots</strong> to connect</div>
      <div class="metric-delta negative"><i class="ri-robot-2-line"></i> Link a device to score garden health</div>
      <div class="metric-tag">DEW Warden</div>
    </div>`);
  } else {
    const avgMoist = Math.round(tp.reduce((s, p) => s + Number(p.moisture || 0), 0) / nt);
    const lowMoisture = tp.filter((p) => p.moisture < 45).length;
    const health = Math.round(100 - (lowMoisture / nt) * 22);
    const sm = valueInRangeStatus(avgMoist, mrMin, mrMax);
    const gq = gardenHealthQuality(health);
    const hp = Math.max(0, Math.min(100, health));
    const moistHint = sm === 'optimal' ? 'Soil moisture on target' : sm === 'warn' ? 'Soil moisture borderline' : 'Soil moisture needs attention';
    cards.push(`
    <div class="metric-card ${gq.qClass} metric-card--condition metric-card--garden-health">
      <div class="metric-label"><span>Garden health</span><span class="right">Plant Bots</span></div>
      <div class="metric-value"><span class="metric-value-num">${health}</span><span class="metric-unit">%</span></div>
      <div class="metric-optimal">Optimal ${moistRangeFleet} soil moisture (${nt} sensor plant${nt === 1 ? '' : 's'})</div>
      <div class="metric-bar-wrap" aria-hidden="true">
        <div class="metric-bar-track"></div>
        <div class="metric-bar-zone" style="left:35%;width:30%"></div>
        <div class="metric-bar-fill" style="width:${hp}%"></div>
        <div class="metric-bar-dot" style="left:${hp}%"></div>
      </div>
      <div class="metric-condition-hint">${escapeHtml(gq.hint)} · ${escapeHtml(moistHint)}</div>
      <div class="metric-delta ${sm === 'optimal' ? '' : 'negative'}"><i class="ri-plant-line"></i>${nt} sensor plant${nt === 1 ? '' : 's'} · ${avgMoist}% avg moisture</div>
      <div class="metric-tag">DEW Warden</div>
    </div>`);
  }

  let hint = '';
  if (window.__dewUid && !a) {
    hint =
      '<p class="dashboard-data-hint"><strong>Add a location</strong> in Settings to show weather in the row above. <strong>Garden health</strong> uses your Plant Bot plants only. The other tiles use forecast-style weather, not readings from your devices.</p>';
  } else if (window.__dewUid && a) {
    hint =
      '<p class="dashboard-data-hint"><strong>Weather row:</strong> today’s snapshot for your saved area (temp, humidity, estimated light from sunlight). <strong>Garden health</strong> includes Plant Bot plants only. These values are area weather—not live sensor readings from your home.</p>';
  }
  row.innerHTML = cards.join('') + hint;
}

/** Fleet health for a single plant (Good / Warning / Critical). */
function plantHealthLevel(p) {
  const o = plantOptimal(p);
  let worst = 'good';
  const bump = (to) => {
    if (to === 'critical') worst = 'critical';
    else if (to === 'warning' && worst === 'good') worst = 'warning';
  };
  const m = Number(p.moisture);
  const t = Number(p.temp);
  const lx = Number(p.lux);
  if (!Number.isNaN(m) && o.moisture) {
    if (m < o.moisture.min || m > o.moisture.max) bump('warning');
  }
  if (!Number.isNaN(t) && o.temp) {
    if (t > o.temp.max || t < o.temp.min) bump(t > o.temp.max ? 'critical' : 'warning');
  }
  if (!Number.isNaN(lx) && o.lux) {
    if (lx < o.lux.min || lx > o.lux.max) bump('warning');
  }
  return worst;
}

function insightTrendLabel(level) {
  if (level === 'critical') return '↓ Review sensors soon';
  if (level === 'warning') return '→ Watch trends';
  return '↑ Stable';
}

function computeSmartInsight(plants) {
  const lines = [];
  let level = 'good';
  const bump = (to) => {
    if (to === 'critical') level = 'critical';
    else if (to === 'warning' && level === 'good') level = 'warning';
  };
  plants.forEach((p) => {
    const o = plantOptimal(p);
    const m = Number(p.moisture);
    const t = Number(p.temp);
    const lx = Number(p.lux);
    if (!Number.isNaN(m) && o.moisture) {
      if (m < o.moisture.min) {
        lines.push(`💧 ${p.name || p.id}: soil moisture low (${Math.round(m)}%. Target ${o.moisture.min}–${o.moisture.max}%).`);
        bump('warning');
      } else if (m > o.moisture.max) {
        lines.push(`💧 ${p.name || p.id}: soil very wet — ease watering.`);
        bump('warning');
      }
    }
    if (!Number.isNaN(t) && o.temp) {
      if (t > o.temp.max) {
        lines.push(`🌡 ${p.name || p.id}: temperature above comfort (${t.toFixed(1)}°C).`);
        bump('critical');
      } else if (t < o.temp.min) {
        lines.push(`🌡 ${p.name || p.id}: cooler than ideal (${t.toFixed(1)}°C).`);
        bump('warning');
      }
    }
    if (!Number.isNaN(lx) && o.lux) {
      if (lx < o.lux.min) {
        lines.push(`☀ ${p.name || p.id}: light below ideal (${Math.round(lx)} lx). Consider a brighter spot.`);
        bump('warning');
      } else if (lx > o.lux.max) {
        lines.push(`☀ ${p.name || p.id}: very bright (${Math.round(lx)} lx) — watch for leaf stress.`);
        bump('warning');
      }
    }
  });
  if (!lines.length) {
    lines.push('🌱 All monitored plants are within typical ranges. Keep observing sensor trends.');
  }
  return { level, lines };
}

/** Simple “water in ~N hours” hints from soil deficit (heuristic). */
function computeWaterRecommendations(plants) {
  const out = [];
  plants.forEach((p) => {
    const o = plantOptimal(p);
    const m = Number(p.moisture);
    if (Number.isNaN(m) || !o.moisture || m >= o.moisture.min) return;
    const deficit = o.moisture.min - m;
    const hours = Math.min(48, Math.max(2, Math.round(4 + deficit / 4)));
    out.push(`💧 ${p.name || p.id}: consider watering within ~${hours}h (soil under target).`);
  });
  return out;
}

function renderSmartInsight(plants) {
  const el = document.getElementById('smartInsightBody');
  if (!el) return;
  if (!plants.length) {
    el.innerHTML = '<p class="dew-muted">Add plants to your fleet to see smart insights.</p>';
    return;
  }
  const { level, lines } = computeSmartInsight(plants);
  const cls =
    level === 'critical' ? 'dew-insight-status--crit' : level === 'warning' ? 'dew-insight-status--warn' : 'dew-insight-status--good';
  const label =
    level === 'critical' ? 'Critical — needs attention' : level === 'warning' ? 'Warning — review' : 'Good';
  const icon = level === 'critical' ? 'ri-alarm-warning-fill' : level === 'warning' ? 'ri-alarm-warning-line' : 'ri-leaf-fill';
  const trend = insightTrendLabel(level);
  const trendIcon = level === 'critical' ? 'ri-arrow-down-line' : level === 'warning' ? 'ri-arrow-right-line' : 'ri-arrow-up-line';
  el.innerHTML = `
    <div class="dew-insight-top">
      <div class="dew-insight-status ${cls}"><i class="${icon}"></i> ${label}</div>
      <span class="dew-insight-trend"><i class="${trendIcon}"></i> ${trend}</span>
    </div>
    <ul class="dew-insight-lines">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`;
}

async function renderDailySummary(plants) {
  const el = document.getElementById('dailySummaryBody');
  if (!el) return;
  if (!plants.length) {
    el.innerHTML = '<p class="dew-muted">No plants linked yet.</p>';
    return;
  }
  const { level, lines } = computeSmartInsight(plants);
  const alertSnips = (activityFeed || [])
    .filter((a) => a.kind === 'alert' || a.source === 'weather' || a.source === 'sensor')
    .slice(0, 2);

  let avgT = null;
  let avgM = null;
  const tps = plants.map((p) => p.temp).filter((v) => v != null && !Number.isNaN(Number(v)));
  const mps = plants.map((p) => p.moisture).filter((v) => v != null && !Number.isNaN(Number(v)));
  if (tps.length) avgT = tps.reduce((a, b) => a + Number(b), 0) / tps.length;
  if (mps.length) avgM = mps.reduce((a, b) => a + Number(b), 0) / mps.length;

  let avgH = null;
  if (lastWeatherForTips && lastWeatherForTips.weather && lastWeatherForTips.weather.humidity != null) {
    avgH = Number(lastWeatherForTips.weather.humidity);
  } else if (areaTodayAverages && areaTodayAverages.avgHumidityPct != null) {
    avgH = Number(areaTodayAverages.avgHumidityPct);
  }

  let telAvgM = null;
  let telAvgT = null;
  try {
    const ids = plants.slice(0, 4).map((p) => p.id);
    const results = await Promise.all(ids.map((id) => fetchTelemetryCached(id, chartRange)));
    let sumM = 0;
    let cM = 0;
    let sumT = 0;
    let cT = 0;
    results.forEach((arr) => {
      arr.forEach((r) => {
        if (r.moisture != null) {
          sumM += Number(r.moisture);
          cM += 1;
        }
        if (r.temp != null) {
          sumT += Number(r.temp);
          cT += 1;
        }
      });
    });
    if (cM) telAvgM = sumM / cM;
    if (cT) telAvgT = sumT / cT;
  } catch (_) {}

  const para =
    level === 'good'
      ? 'Your plants look healthy today with stable readings across the fleet.'
      : level === 'warning'
        ? 'Some readings are outside the comfort zone — check alerts and trends below.'
        : 'Critical conditions detected on one or more plants — review immediately.';

  const recs = computeWaterRecommendations(plants);
  const recBlock =
    recs.length > 0
      ? `<p class="dew-daily-rec">Recommendations</p><ul class="dew-insight-lines">${recs
          .slice(0, 2)
          .map((r) => `<li>${escapeHtml(r)}</li>`)
          .join('')}</ul>`
      : '';

  const alertBlock =
    alertSnips.length > 0
      ? `<p class="dew-daily-rec">Key alerts</p><ul class="dew-daily-alert-snips">${alertSnips
          .map(
            (a) =>
              `<li><i class="${escapeHtml(a.icon || 'ri-notification-3-line')}"></i>` +
              `<span>${escapeHtml(a.title || '')}</span></li>`
          )
          .join('')}</ul>`
      : '';

  const mDisplay = telAvgM != null ? telAvgM.toFixed(1) : avgM != null ? avgM.toFixed(1) : '—';
  const tDisplay = telAvgT != null ? telAvgT.toFixed(1) : avgT != null ? avgT.toFixed(1) : '—';
  const hDisplay = avgH != null ? String(Math.round(avgH)) : '—';

  el.innerHTML = `
    <p class="dew-daily-lead">${escapeHtml(para)}</p>
    <p class="dew-muted dew-daily-secondary">${lines.length ? escapeHtml(lines[0]) : ''}</p>
    <div class="dew-daily-metrics">
      <div class="dew-daily-metric"><span class="dew-daily-metric-label">🌡 Avg temp</span><strong>${tDisplay}${tDisplay !== '—' ? '°C' : ''}</strong><span class="dew-daily-metric-hint">fleet · ${chartRangeLabel(chartRange)}</span></div>
      <div class="dew-daily-metric"><span class="dew-daily-metric-label">💧 Avg moisture</span><strong>${mDisplay}${mDisplay !== '—' ? '%' : ''}</strong><span class="dew-daily-metric-hint">sensors</span></div>
      <div class="dew-daily-metric"><span class="dew-daily-metric-label">💨 Humidity</span><strong>${hDisplay}${hDisplay !== '—' ? '%' : ''}</strong><span class="dew-daily-metric-hint">area weather</span></div>
    </div>
    ${alertBlock}
    ${recBlock}`;
}

function alertSeverityClass(a) {
  if (a.kind === 'telemetry' || String(a.source || '') === 'telemetry') return 'dew-alert-item--info';
  const sev = String(a.severity || '').toLowerCase();
  if (sev.includes('crit') || sev === 'high' || sev === 'severe') return 'dew-alert-item--crit';
  if (sev.includes('warn') || sev === 'medium') return 'dew-alert-item--warn';
  if (a.source === 'weather') return 'dew-alert-item--warn';
  return 'dew-alert-item--info';
}

function alertStatusLabel(a) {
  if (a.kind === 'telemetry') return 'Logged';
  const st = String(a.status || '').toLowerCase();
  if (st === 'resolved' || a.read) return 'Resolved';
  return 'Active';
}

function renderAlertsPreview() {
  const ul = document.getElementById('alertsPreviewList');
  if (!ul) return;
  const sorted = [...(activityFeed || [])].sort((a, b) => {
    const ta = new Date(a.at || 0).getTime();
    const tb = new Date(b.at || 0).getTime();
    return tb - ta;
  });
  const alerts = sorted.filter((a) => a && (a.title || a.desc));
  if (!alerts.length) {
    ul.innerHTML = '<li class="dew-alerts-empty dew-muted">No alerts yet. Weather, sensor, and device activity will appear here.</li>';
    return;
  }
  ul.innerHTML = alerts.slice(0, 14).map((a) => {
    const t = escapeHtml(a.title || 'Alert');
    const d = escapeHtml((a.desc || '').slice(0, 96));
    const time = a.at ? formatRelativeTime(a.at) : escapeHtml(a.time || '');
    const sev = alertSeverityClass(a);
    const badge = escapeHtml(alertStatusLabel(a));
    const ic = escapeHtml(a.icon || 'ri-notification-3-line');
    return `<li class="dew-alerts-preview-item dew-alert-item ${sev}" data-nav-alerts="1" role="button" tabindex="0">
      <i class="${ic}"></i>
      <div class="dew-alert-item-body">
        <div class="dew-alert-item-title-row"><strong>${t}</strong><span class="dew-alert-badge">${badge}</span></div>
        <span class="dew-alert-item-desc">${d}</span>
        <span class="dew-alert-item-time">${escapeHtml(time)}</span>
      </div>
    </li>`;
  });
  ul.querySelectorAll('[data-nav-alerts]').forEach((node) => {
    const go = () => document.querySelector('.nav-item[data-view="alerts"]')?.click();
    node.addEventListener('click', go);
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') go();
    });
  });
}

async function renderUsageStats(plants) {
  const el = document.getElementById('usageStatsBody');
  if (!el) return;
  updateUsageRangeLabel();
  if (!plants.length) {
    el.innerHTML = '<p class="dew-muted">No fleet data.</p>';
    return;
  }
  const ids = plants.slice(0, 6).map((p) => p.id);
  const range = chartRange;
  let total = 0;
  let sumM = 0;
  let countM = 0;
  let sumT = 0;
  let countT = 0;
  let firstHalf = [];
  let secondHalf = [];
  try {
    const results = await Promise.all(ids.map((id) => fetchTelemetryCached(id, range)));
    results.forEach((arr) => {
      total += arr.length;
      arr.forEach((r) => {
        if (r.moisture != null) {
          sumM += Number(r.moisture);
          countM += 1;
        }
        if (r.temp != null) {
          sumT += Number(r.temp);
          countT += 1;
        }
      });
    });
    const merged = results.flat().sort((a, b) => new Date(a.at) - new Date(b.at));
    const mid = Math.floor(merged.length / 2);
    firstHalf = merged.slice(0, mid);
    secondHalf = merged.slice(mid);
  } catch (_) {}
  const avgM = countM ? (sumM / countM).toFixed(1) : '—';
  const avgT = countT ? (sumT / countT).toFixed(1) : '—';
  const mFirst =
    firstHalf.length && firstHalf.some((r) => r.moisture != null)
      ? firstHalf
          .filter((r) => r.moisture != null)
          .reduce((s, r) => s + Number(r.moisture), 0) /
        firstHalf.filter((r) => r.moisture != null).length
      : null;
  const mSecond =
    secondHalf.length && secondHalf.some((r) => r.moisture != null)
      ? secondHalf
          .filter((r) => r.moisture != null)
          .reduce((s, r) => s + Number(r.moisture), 0) /
        secondHalf.filter((r) => r.moisture != null).length
      : null;
  let trend = '';
  if (mFirst != null && mSecond != null) {
    const up = mSecond > mFirst + 1;
    const down = mSecond < mFirst - 1;
    const spanHint = range === '24h' ? 'today' : 'this range';
    trend = up
      ? `<span class="dew-trend dew-trend--up">↑ vs earlier in ${spanHint}</span>`
      : down
        ? `<span class="dew-trend dew-trend--down">↓ vs earlier in ${spanHint}</span>`
        : '<span class="dew-trend">→ steady</span>';
  }
  const tFirst =
    firstHalf.length && firstHalf.some((r) => r.temp != null)
      ? firstHalf.filter((r) => r.temp != null).reduce((s, r) => s + Number(r.temp), 0) /
        firstHalf.filter((r) => r.temp != null).length
      : null;
  const tSecond =
    secondHalf.length && secondHalf.some((r) => r.temp != null)
      ? secondHalf.filter((r) => r.temp != null).reduce((s, r) => s + Number(r.temp), 0) /
        secondHalf.filter((r) => r.temp != null).length
      : null;
  let trendT = '';
  if (tFirst != null && tSecond != null) {
    const up = tSecond > tFirst + 0.5;
    const down = tSecond < tFirst - 0.5;
    trendT = up ? '<span class="dew-trend dew-trend--up">↑</span>' : down ? '<span class="dew-trend dew-trend--down">↓</span>' : '<span class="dew-trend">→</span>';
  }
  let hum = '—';
  if (lastWeatherForTips && lastWeatherForTips.weather && lastWeatherForTips.weather.humidity != null) {
    hum = String(Math.round(Number(lastWeatherForTips.weather.humidity)));
  } else if (areaTodayAverages && areaTodayAverages.avgHumidityPct != null) {
    hum = String(Math.round(Number(areaTodayAverages.avgHumidityPct)));
  }
  const rlab = chartRangeLabel(range);
  const moistPct = avgM !== '—' ? Math.min(100, Math.max(0, Number(avgM))) : 0;
  const tempPct = avgT !== '—' ? Math.min(100, Math.max(0, ((Number(avgT) - 10) / 30) * 100)) : 0;
  el.innerHTML = `
    <div class="dew-activity-grid">
      <div class="dew-stat-pill dew-stat-pill--wide"><span>Readings <span class="dew-stat-range">(${rlab})</span></span><strong class="dew-count-up">${total}</strong></div>
      <div class="dew-stat-pill dew-stat-pill--wide"><span>Avg moisture</span><strong>${avgM}${avgM !== '—' ? '%' : ''}</strong>${trend}</div>
      <div class="dew-stat-pill dew-stat-pill--wide"><span>Avg temp</span><strong>${avgT}${avgT !== '—' ? '°C' : ''}</strong>${trendT}</div>
      <div class="dew-stat-pill dew-stat-pill--wide"><span>Area humidity</span><strong>${hum}${hum !== '—' ? '%' : ''}</strong><span class="dew-trend dew-trend--dim">outdoor</span></div>
    </div>
    <div class="dew-activity-bars" aria-hidden="true">
      <div class="dew-mini-bar"><span>Moisture</span><div class="dew-mini-bar-track"><div class="dew-mini-bar-fill dew-mini-bar-fill--moist" style="width:${moistPct}%"></div></div></div>
      <div class="dew-mini-bar"><span>Temp</span><div class="dew-mini-bar-track"><div class="dew-mini-bar-fill dew-mini-bar-fill--temp" style="width:${tempPct}%"></div></div></div>
    </div>`;
}

function updateLiveChip(plants) {
  const label = document.getElementById('lastSyncLabel');
  let lastMs = 0;
  plants.forEach((p) => {
    const t = p.updatedAt ? new Date(p.updatedAt).getTime() : 0;
    if (t > lastMs) lastMs = t;
  });
  if (label) label.textContent = lastMs ? formatRelativeTime(new Date(lastMs).toISOString()) : '—';
  const online = lastMs && Date.now() - lastMs < ONLINE_MS;
  const chip = document.getElementById('dashboardLiveChip');
  const dot = document.getElementById('dashboardLiveDot');
  if (chip) chip.classList.toggle('offline', !online);
  if (dot && !online) dot.classList.remove('chip-dot--pulse');
  else if (dot && online) dot.classList.add('chip-dot--pulse');
}

function applyWeatherPlantTips(loc, weather, plants) {
  const tipH = document.getElementById('weatherHeroTip');
  const tipC = document.getElementById('dashboardWeatherTip');
  if (!weather) {
    if (tipH) tipH.textContent = '';
    if (tipC) tipC.textContent = '';
    return;
  }
  lastWeatherForTips = { loc, weather, plants };
  const hum = weather.humidity != null ? Number(weather.humidity) : null;
  const cond = String(weather.condition || '').toLowerCase();
  const anim = weather.animation || 'cloudy';
  let msg = '';
  if (anim === 'sunny' || cond.includes('clear'))
    msg += ' Good day for bright indirect light — watch soil drying in warm sun.';
  else if (anim === 'rainy' || cond.includes('rain'))
    msg += ' Humid air — reduce watering and ensure drainage.';
  else if (hum != null && hum > 75) msg += ' High humidity — soil stays wet longer; check moisture before watering.';
  else if (hum != null && hum < 35) msg += ' Dry air — some plants may need misting or a pebble tray.';
  else msg += ' Stable outdoor conditions — align indoor watering with your sensor readings.';

  const insight = computeSmartInsight(plants || []);
  if (insight.level !== 'good' && insight.lines[0]) {
    msg += ` ${insight.lines[0]}`;
  }
  if (tipH) tipH.textContent = msg.trim();
  if (tipC) tipC.textContent = msg.trim();
}

async function refreshDashboardPanels(plants) {
  renderSmartInsight(plants);
  await renderDailySummary(plants);
  renderAlertsPreview();
  updateLiveChip(plants);
  renderUsageStats(plants).catch(() => {});
  if (lastWeatherForTips && lastWeatherForTips.weather) {
    applyWeatherPlantTips(lastWeatherForTips.loc, lastWeatherForTips.weather, plants);
  }
}

function chartRangeLabel(range) {
  if (range === '7d') return '7d';
  if (range === '30d') return '30d';
  if (range === 'all') return 'all time';
  return '24h';
}

function updateUsageRangeLabel() {
  const el = document.getElementById('usageStatsRangeLabel');
  if (el) el.textContent = '(' + chartRangeLabel(chartRange) + ')';
}

function chartRangeToHoursParam(range) {
  if (range === 'all') return 'all';
  if (range === '7d') return '168';
  if (range === '30d') return '720';
  return '24';
}

async function fetchTelemetryCached(plantId, range) {
  const q = chartRangeToHoursParam(range);
  const key = `${plantId}:${q}`;
  const now = Date.now();
  const hit = telemetryCache.get(key);
  if (hit && now - hit.at < TELEMETRY_TTL_MS) return hit.data;
  const url =
    q === 'all'
      ? `${API}/api/plants/${encodeURIComponent(plantId)}/telemetry?hours=all`
      : `${API}/api/plants/${encodeURIComponent(plantId)}/telemetry?hours=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  const arr = Array.isArray(data) ? data : [];
  telemetryCache.set(key, { at: now, data: arr });
  return arr;
}

function dataKeyForMetric(metricKey) {
  if (metricKey === 'temperature') return 'temp';
  if (metricKey === 'light') return 'lux';
  return 'moisture';
}

function formatBucketLabel(ts, range) {
  const d = new Date(ts);
  if (range === '24h') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (range === '7d') return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function mergeBucketedSeries(plants, metricKey, range, readingsLists) {
  const mKey = dataKeyForMetric(metricKey);
  const bucketCount = range === '24h' ? 12 : range === '7d' ? 14 : range === '30d' ? 18 : 24;
  let minT = Infinity;
  let maxT = -Infinity;
  readingsLists.forEach((arr) => {
    arr.forEach((r) => {
      const t = new Date(r.at).getTime();
      if (!Number.isNaN(t)) {
        minT = Math.min(minT, t);
        maxT = Math.max(maxT, t);
      }
    });
  });
  if (minT === Infinity) return { labels: [], series: [], empty: true, bucketMidMs: [] };
  if (maxT - minT < 120000) maxT = minT + 3600000;
  const span = maxT - minT;
  const labels = [];
  const bucketMidMs = [];
  const series = plants.map(() => Array(bucketCount).fill(null));
  for (let b = 0; b < bucketCount; b++) {
    const t0 = minT + (span * b) / bucketCount;
    const t1 = minT + (span * (b + 1)) / bucketCount;
    const mid = (t0 + t1) / 2;
    bucketMidMs.push(mid);
    labels.push(formatBucketLabel(mid, range));
    readingsLists.forEach((arr, pi) => {
      const inB = arr.filter((r) => {
        const t = new Date(r.at).getTime();
        return t >= t0 && t < t1;
      });
      const vals = inB.map((r) => r[mKey]).filter((v) => v != null && !Number.isNaN(Number(v)));
      if (vals.length) series[pi][b] = vals.reduce((a, x) => a + Number(x), 0) / vals.length;
    });
  }
  series.forEach((row) => {
    let last = null;
    for (let i = 0; i < row.length; i++) {
      if (row[i] != null) last = row[i];
      else row[i] = last;
    }
  });
  return { labels, series, empty: false, bucketMidMs };
}

function syntheticFromPlants(plants, metricKey) {
  const key = dataKeyForMetric(metricKey);
  const labels = ['6am', '8am', '10am', '12pm', '2pm', '4pm', 'Now'];
  return (plants || []).slice(0, 4).map((p, i) => {
    const v = p[key] != null ? Number(p[key]) : key === 'lux' ? 800 : 50;
    const data = Array.from({ length: 7 }, (_, j) =>
      Math.max(0, v - 5 + j * 2 + (Math.random() * 4 - 2))
    );
    return {
      label: (p.name || p.id).split(' ')[0],
      data,
      borderColor: palette[p.id] || Object.values(palette)[i],
      backgroundColor: (palette[p.id] || Object.values(palette)[i]) + '33',
      _minMaxIdx: (() => {
        let minI = 0;
        let maxI = 0;
        let minV = Infinity;
        let maxV = -Infinity;
        data.forEach((val, idx) => {
          if (val < minV) {
            minV = val;
            minI = idx;
          }
          if (val > maxV) {
            maxV = val;
            maxI = idx;
          }
        });
        return { minIdx: minI, maxIdx: maxI };
      })(),
    };
  });
}

function minMaxIndices(arr) {
  let minI = -1;
  let maxI = -1;
  let minV = Infinity;
  let maxV = -Infinity;
  arr.forEach((v, i) => {
    if (v == null || Number.isNaN(Number(v))) return;
    const n = Number(v);
    if (n < minV) {
      minV = n;
      minI = i;
    }
    if (n > maxV) {
      maxV = n;
      maxI = i;
    }
  });
  return { minIdx: minI, maxIdx: maxI };
}

async function buildChart(plants, metricKey = 'moisture', chartOpts = {}) {
  const canvasId = chartOpts.canvasId || 'sensorChart';
  const rangeOverride = chartOpts.rangeOverride;
  const isBotsCanvas = canvasId === 'botsPlantChartCanvas';
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (isBotsCanvas) {
    if (botsPlantChartInstance) botsPlantChartInstance.destroy();
  } else if (sensorChart) sensorChart.destroy();

  const range = rangeOverride != null ? rangeOverride : chartRange;
  const maxPlants = chartOpts.maxPlants != null ? chartOpts.maxPlants : 4;
  const plantList = (plants || []).slice(0, maxPlants);
  let labels = [];
  let datasets = [];
  /** Mid-timestamp per bucket for rich tooltips (real data only). */
  let bucketMidMs = [];

  if (plantList.length) {
    const readingsLists = await Promise.all(plantList.map((p) => fetchTelemetryCached(p.id, range)));
    const hasAny = readingsLists.some((a) => a.length);
    if (hasAny) {
      const merged = mergeBucketedSeries(plantList, metricKey, range, readingsLists);
      labels = merged.labels;
      bucketMidMs = merged.bucketMidMs || [];
      const series = merged.series;
      datasets = plantList.map((p, i) => {
        const data = series[i] || [];
        const mm = minMaxIndices(data);
        const pr = data.map((_, j) => (j === mm.minIdx || j === mm.maxIdx ? 5 : 0));
        return {
          label: (p.name || p.id).split(' ')[0],
          data,
          borderColor: palette[p.id] || Object.values(palette)[i],
          backgroundColor: (palette[p.id] || Object.values(palette)[i]) + '33',
          tension: 0.35,
          fill: true,
          borderWidth: 2,
          pointRadius: pr,
          pointHoverRadius: 6,
        };
      });
    }
  }

  if (!labels.length || !datasets.length) {
    const demoPlants =
      plants && plants.length
        ? plants
        : [{ id: 'pothos', name: 'Sample', moisture: 55, temp: 22, lux: 900 }];
    const syn = syntheticFromPlants(demoPlants, metricKey);
    labels = ['6am', '8am', '10am', '12pm', '2pm', '4pm', 'Now'];
    datasets = syn.map((ds) => {
      const mm = ds._minMaxIdx || { minIdx: 0, maxIdx: 0 };
      const pr = (ds.data || []).map((_, j) => (j === mm.minIdx || j === mm.maxIdx ? 5 : 0));
      const { _minMaxIdx, ...rest } = ds;
      return {
        ...rest,
        tension: 0.45,
        fill: true,
        borderWidth: 2,
        pointRadius: pr,
        pointHoverRadius: 6,
      };
    });
  }

  const yLabel =
    metricKey === 'temperature' ? '°C' : metricKey === 'light' ? 'lux' : '%';

  const isNarrow =
    typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches;
  const tickFont = isNarrow ? 9 : 11;
  const legendSize = isNarrow ? 9 : 11;
  if (isNarrow) {
    datasets = datasets.map((ds) => ({
      ...ds,
      borderWidth: 2.6,
      pointHoverRadius: Math.max(7, Number(ds.pointHoverRadius || 0)),
    }));
  }

  const fmtTooltipTitle = (dataIndex) => {
    if (bucketMidMs.length && bucketMidMs[dataIndex] != null) {
      return new Date(bucketMidMs[dataIndex]).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
    return labels[dataIndex] != null ? String(labels[dataIndex]) : '';
  };

  const chartBuilt = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      animation: { duration: 900, easing: 'easeOutQuart' },
      animations: {
        colors: { type: 'color', duration: 650 },
      },
      transitions: {
        active: { animation: { duration: 450 } },
      },
      maintainAspectRatio: false,
      layout: {
        padding: {
          top: isNarrow ? 4 : 6,
          right: isNarrow ? 2 : 4,
          bottom: isNarrow ? 2 : 4,
          left: isNarrow ? 0 : 2,
        },
      },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: { boxWidth: isNarrow ? 8 : 10, color: '#8fa99f', font: { size: legendSize } },
        },
        tooltip: {
          callbacks: {
            label(ctx) {
              const v = ctx.parsed.y;
              const vStr =
                metricKey === 'light' && v != null ? Number(v).toLocaleString() : v != null ? Number(v).toFixed(1) : '—';
              return `${ctx.dataset.label}: ${vStr} ${yLabel}`;
            },
            title(items) {
              const i = items[0]?.dataIndex;
              return fmtTooltipTitle(i);
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: '#8fa99f',
            font: { size: tickFont },
            maxRotation: isNarrow ? 40 : 0,
            minRotation: isNarrow ? 25 : 0,
            autoSkip: true,
            maxTicksLimit: isNarrow ? 6 : 12,
          },
          grid: { color: 'rgba(126, 242, 191, 0.12)' },
          title: { display: !isNarrow, text: 'Time', color: '#6d887a', font: { size: 10 } },
        },
        y: {
          position: 'left',
          grace: '6%',
          ticks: {
            color: '#8fa99f',
            font: { size: tickFont, lineHeight: 1.1 },
            padding: isNarrow ? 4 : 8,
            crossAlign: 'center',
            mirror: false,
            maxTicksLimit: isNarrow ? 6 : 12,
          },
          grid: { color: 'rgba(126, 242, 191, 0.12)' },
          border: { display: false },
          title: { display: true, text: yLabel, color: '#6d887a', font: { size: isNarrow ? 9 : 10 } },
        },
      },
    },
  });
  if (isBotsCanvas) botsPlantChartInstance = chartBuilt;
  else sensorChart = chartBuilt;
}

let chartResizeObserver = null;
/** Keep Chart.js in sync when the chart container width changes (rotation, split view, drawer). */
function initChartResizeHandling() {
  if (typeof ResizeObserver === 'undefined' || chartResizeObserver) return;
  const onResize = () => {
    try {
      sensorChart?.resize();
      botsPlantChartInstance?.resize();
    } catch (_) {}
  };
  chartResizeObserver = new ResizeObserver(onResize);
  const w1 = document.getElementById('sensorChartWrap');
  const w2 = document.getElementById('plantBotChartWrap');
  if (w1) chartResizeObserver.observe(w1);
  if (w2) chartResizeObserver.observe(w2);
  window.addEventListener('orientationchange', onResize, { passive: true });
}

/** Used by Bots → Plant Bot page (lazy-loaded module). */
async function dewBuildBotsPlantChart({ plants: plantList, metricKey, range }) {
  await buildChart(plantList || [], metricKey || 'moisture', {
    canvasId: 'botsPlantChartCanvas',
    rangeOverride: range || '24h',
    maxPlants: 1,
  });
}

async function buildChartAsync(plants, metricKey) {
  const key = metricKey || chartMetricFromActiveTab();
  const wrap = document.getElementById('sensorChartWrap');
  const skel = document.getElementById('chartSkeleton');
  if (wrap) wrap.classList.add('chart-wrapper--loading');
  if (skel) skel.style.display = 'block';
  try {
    await buildChart(plants, key);
  } finally {
    if (wrap) wrap.classList.remove('chart-wrapper--loading');
    if (skel) skel.style.display = 'none';
    const card = document.querySelector('.dew-chart-card');
    if (card) {
      card.classList.remove('chart-flash');
      void card.offsetWidth;
      card.classList.add('chart-flash');
    }
  }
}

function initChartRangeTabs() {
  const row = document.getElementById('chartRangeTabs');
  if (!row || row.dataset.wired) return;
  row.dataset.wired = '1';
  row.querySelectorAll('.chart-range-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      row.querySelectorAll('.chart-range-tab').forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      chartRange = btn.getAttribute('data-range') || '24h';
      updateUsageRangeLabel();
      buildChartAsync(plants, chartMetricFromActiveTab());
      renderUsageStats(plants).catch(() => {});
    });
  });
}

function initAlertsPreviewMore() {
  const btn = document.getElementById('btnAlertsPreviewMore');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    document.querySelector('.nav-item[data-view="alerts"]')?.click();
  });
}

function wireSensorTabs() {
  document.querySelectorAll('#sensorTabs .tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('#sensorTabs .tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      buildChartAsync(plants, tab.dataset.metric);
    };
  });
}

function getPlantImageUrl(p) {
  if (!p || !p.image) return null;
  return '/images/plants/' + encodeURIComponent(p.image);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatRelativeTime(iso) {
  if (!iso) return '—';
  try {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '—';
    const diff = Date.now() - t;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
  } catch (_) {
    return '—';
  }
}

function sourceBadge(usage) {
  const src = String(usage?.last_source || '').toLowerCase();
  if (src === 'telemetry') return '<span class="fleet-source-badge fleet-source-badge--live">sensor</span>';
  if (src) return '<span class="fleet-source-badge">' + src.replace(/-/g, ' ') + '</span>';
  return '';
}

function renderPlantFleetSummary() {
  const el = document.getElementById('plantFleetSummary');
  const btn = document.getElementById('btnPlantFleetViewAll');
  if (!el) return;
  let s = plantFleetSummary;
  if (!s && plants.length) {
    s = {
      total: plants.length,
      telemetryLinked: plants.filter((p) => String(p.usage?.last_source || '') === 'telemetry').length,
      needsAttention: plants.filter((p) => /low|dry|drying/i.test(String(p.status || ''))).length,
      avgMoisture: Math.round(plants.reduce((a, p) => a + (Number(p.moisture) || 0), 0) / plants.length),
    };
  }
  if (!plants.length) {
    el.textContent = window.__dewUid
      ? 'No plants here yet. Connect your Plant Bot using the steps below, or save Desk Bot while you’re signed in — then your plants and their overall condition will show up here.'
      : 'Sign in to see plants linked to your account.';
    if (btn) btn.style.display = 'none';
    return;
  }
  if (btn) btn.style.display = plants.length > PLANT_FLEET_PREVIEW ? '' : 'none';
  if (!s) {
    el.textContent = '';
    return;
  }
  const parts = [
    `${s.total} plant${s.total === 1 ? '' : 's'}`,
    s.telemetryLinked != null ? `${s.telemetryLinked} reporting via sensor` : null,
    s.avgMoisture != null ? `avg moisture ${s.avgMoisture}%` : null,
    s.needsAttention ? `${s.needsAttention} need attention` : 'all clear',
  ].filter(Boolean);
  el.textContent = 'Overall: ' + parts.join(' · ') + '.';
}

function renderPlantTable(plants) {
  const tbody = document.getElementById('plantTableBody');
  const list = plantFleetExpanded || plants.length <= PLANT_FLEET_PREVIEW
    ? plants
    : plants.slice(0, PLANT_FLEET_PREVIEW);
  const btn = document.getElementById('btnPlantFleetViewAll');
  if (btn) {
    const more = plants.length > PLANT_FLEET_PREVIEW;
    btn.style.display = more || plantFleetExpanded ? '' : 'none';
    btn.textContent = plantFleetExpanded ? 'Show less' : 'View all';
    btn.setAttribute('aria-expanded', plantFleetExpanded ? 'true' : 'false');
  }
  if (!plants.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="plant-fleet-empty">No plants here yet. Open <strong>How to connect your plant sensor</strong> above, paste your key into your bot once, or save <strong>Desk Bot</strong> below while you’re signed in.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(p => {
    const imgUrl = getPlantImageUrl(p);
    const thumb = imgUrl
      ? `<img class="plant-avatar-img" src="${imgUrl}" alt="${(p.name || p.id)}" loading="lazy" />`
      : `<span class="plant-avatar">${(p.name || '?')[0]}</span>`;
    const last = p.usage?.last_used_at ? formatRelativeTime(p.usage.last_used_at) : formatRelativeTime(p.updatedAt);
    const badge = sourceBadge(p.usage);
    const syncLine = p.updatedAt ? `<span class="fleet-sync">${formatRelativeTime(p.updatedAt)} reading</span>` : '';
    const hl = plantHealthLevel(p);
    const healthClass = hl === 'critical' ? 'plant-health plant-health--bad' : hl === 'warning' ? 'plant-health plant-health--warn' : 'plant-health plant-health--good';
    const healthLabel = hl === 'critical' ? 'Critical' : hl === 'warning' ? 'Warning' : 'Healthy';
    return `
    <tr class="plant-row" data-id="${p.id}">
      <td>
        <div class="plant-name">
          <div class="plant-avatar-wrap">${thumb}</div>
          <div>
            <div style="font-size:12px;font-weight:600;">${p.name || p.id}</div>
            <div style="font-size:10px;color:#9cb5aa;">${p.species || '—'}</div>
          </div>
        </div>
      </td>
      <td><span class="${healthClass}">${healthLabel}</span></td>
      <td><span class="status-pill ${/low|dry/i.test(p.status || '') ? 'bad' : ''}"><span style="width:7px;height:7px;border-radius:999px;background:${/low|dry/i.test(p.status || '') ? '#ff6d7d' : '#47d58f'};"></span>${p.status || '—'}</span></td>
      <td><div class="bar-track"><div class="bar-fill ${(p.moisture || 0) < 45 ? 'low' : ''}" style="width:${Math.min(100, p.moisture || 0)}%;"></div></div></td>
      <td>${(p.temp != null ? p.temp : '—').toString().replace(/^([\d.]+)$/, '$1°C')}</td>
      <td>${p.lux != null ? Number(p.lux).toLocaleString() : '—'}</td>
      <td class="plant-fleet-activity">
        <div class="fleet-activity-main">${last} ${badge}</div>
        ${syncLine ? `<div class="fleet-activity-sub">${syncLine}</div>` : ''}
      </td>
      <td><button type="button" class="btn btn-ghost btn-sm btn-plant-view" data-plant-id="${escapeHtml(p.id)}">View</button></td>
    </tr>
  `;
  }).join('');
}

function initPlantFleetChartLink() {
  const tbody = document.getElementById('plantTableBody');
  if (!tbody || tbody.dataset.chartLinkWired) return;
  tbody.dataset.chartLinkWired = '1';
  tbody.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-plant-view');
    if (!btn) return;
    e.preventDefault();
    document.getElementById('sensorChartWrap')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

/** Derive weather type from plant sensor data (temp °C, moisture %, lux) for dashboard animation. */
function getWeatherFromPlant(plant) {
  if (!plant) return 'sunny';
  const temp = Number(plant.temp);
  const moisture = Number(plant.moisture);
  const lux = Number(plant.lux) || 0;
  if (temp < 14) return 'snowy';
  if (lux < 250) return 'clear-night';
  if (moisture >= 68 && lux < 1400) return 'rainy';
  if (lux >= 1800 && temp >= 19) return 'sunny';
  if (lux >= 800 && lux < 1800) return 'cloudy';
  return 'sunny';
}

function populateWeatherParticles(weather) {
  const rainContainer = document.getElementById('weatherRainContainer');
  const snowContainer = document.getElementById('weatherSnowContainer');
  const starsContainer = document.getElementById('weatherStarsContainer');
  if (weather === 'rainy' && rainContainer && rainContainer.children.length === 0) {
    rainContainer.innerHTML = '';
    for (let i = 0; i < 24; i++) {
      const d = document.createElement('div');
      d.className = 'rain-drop';
      d.style.left = Math.random() * 100 + '%';
      d.style.animationDelay = (Math.random() * 0.5) + 's';
      d.style.animationDuration = (0.6 + Math.random() * 0.5) + 's';
      rainContainer.appendChild(d);
    }
  }
  if (weather === 'snowy' && snowContainer && snowContainer.children.length === 0) {
    snowContainer.innerHTML = '';
    for (let i = 0; i < 18; i++) {
      const s = document.createElement('div');
      s.className = 'snowflake';
      s.style.left = Math.random() * 100 + '%';
      s.style.top = -(Math.random() * 20) + 'px';
      s.style.animationDelay = (Math.random() * 2) + 's';
      s.style.animationDuration = (2.2 + Math.random() * 1.5) + 's';
      snowContainer.appendChild(s);
    }
  }
  if (weather === 'clear-night' && starsContainer && starsContainer.children.length === 0) {
    starsContainer.innerHTML = '';
    const positions = [[15, 12], [45, 8], [80, 14], [25, 22], [60, 18], [10, 28], [70, 10], [35, 6], [90, 20], [55, 24], [20, 16], [75, 12]];
    positions.forEach(([left, top], i) => {
      const star = document.createElement('div');
      star.className = 'weather-star';
      star.style.left = left + '%';
      star.style.top = top + '%';
      star.style.animationDelay = (i * 0.2) + 's';
      starsContainer.appendChild(star);
    });
  }
}

function updateDeskbotWeather(plants, focusPlantId) {
  // Weather strip removed from Desk Bot preview; plant data still drives theme/sync elsewhere.
}

function applyDeskbotTheme(theme, el) {
  const preview = document.getElementById('deskbotPreview');
  if (!preview) return;
  preview.dataset.deskTheme = theme || 'mint';
  preview.style.background = '';
}

function updateDeskbotHero(plants, config) {
  const text = document.getElementById('deskbotLivePillText');
  const pill = document.getElementById('deskbotLivePill');
  const dot = document.getElementById('deskbotLiveDot');
  const sync = document.getElementById('deskbotSyncLine');
  let lastMs = 0;
  (plants || []).forEach((p) => {
    const t = p.updatedAt ? new Date(p.updatedAt).getTime() : 0;
    if (t > lastMs) lastMs = t;
  });
  const cfgMs = config?.updatedAt ? new Date(config.updatedAt).getTime() : 0;
  const best = Math.max(lastMs, cfgMs);
  const online = lastMs && Date.now() - lastMs < ONLINE_MS;
  if (text) text.textContent = online ? '🟢 Active' : '🔴 Offline';
  if (pill) pill.classList.toggle('deskbot-live-pill--on', online);
  if (dot) dot.classList.toggle('deskbot-live-dot--pulse', online);
  if (sync) {
    sync.textContent = best
      ? `Updated ${formatRelativeTime(new Date(best).toISOString())} · ${online ? 'sensors live' : 'sensors idle'}`
      : 'No sync yet — connect a Plant Bot.';
  }
}

/** Apply server deskbot config to the preview card (weather, theme) and hero status — no configure UI. */
function syncDeskbotFromConfig(plants, config) {
  if (!plants || !plants.length) {
    updateDeskbotWeather([], null);
    updateDeskbotHero([], config);
    return;
  }
  const focusId = config && config.plantId ? config.plantId : (plants[0] && plants[0].id);
  updateDeskbotWeather(plants, focusId);
  if (config) applyDeskbotTheme(config.theme || 'mint');
  updateDeskbotHero(plants, config);
}

/** Click / keyboard: short “delight” animation on the Desk Bot preview (respects reduced motion). */
function wireDeskbotPreviewInteractions() {
  const preview = document.getElementById('deskbotPreview');
  const eyes = document.getElementById('deskbotEyes');
  const hint = document.getElementById('deskbotPreviewHint');
  if (!preview || preview.dataset.interactiveWired === '1') return;
  preview.dataset.interactiveWired = '1';

  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const trigger = () => {
    if (reduceMotion()) {
      preview.classList.add('deskbot-preview-card--delight');
      setTimeout(() => preview.classList.remove('deskbot-preview-card--delight'), 180);
      return;
    }
    preview.classList.remove('deskbot-preview-card--delight');
    void preview.offsetWidth;
    preview.classList.add('deskbot-preview-card--delight');
    if (eyes) {
      eyes.classList.remove('deskbot-eyes--delight');
      void eyes.offsetWidth;
      eyes.classList.add('deskbot-eyes--delight');
      setTimeout(() => eyes.classList.remove('deskbot-eyes--delight'), 850);
    }
    setTimeout(() => preview.classList.remove('deskbot-preview-card--delight'), 850);
    if (hint && !hint.dataset.dimmed) {
      hint.dataset.dimmed = '1';
      hint.style.opacity = '0.45';
    }
  };

  preview.addEventListener('click', (e) => {
    if (e.button !== 0) return;
    trigger();
  });
  preview.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      trigger();
    }
  });
}

function chartMetricFromActiveTab() {
  const tab = document.querySelector('#sensorTabs .tab.active');
  return (tab && tab.dataset && tab.dataset.metric) || 'moisture';
}

/** Poll plant fleet while signed in so ESP32 / Plant Bot telemetry updates appear without manual refresh. */
async function refreshPlantFleetFromServer() {
  const uid = window.__dewUid;
  if (!uid) return;
  try {
    const fleetRes = await authFetch(API + '/api/users/' + encodeURIComponent(uid) + '/plant-fleet');
    if (!fleetRes.ok) return;
    const data = await fleetRes.json();
    const fleetPlants = Array.isArray(data.plants) ? data.plants : [];
    plants = fleetPlants;
    plantFleetSummary = data.summary || null;
    const po = document.getElementById('plantsOnline');
    const npc = document.getElementById('navPlantsCount');
    const ndc = document.getElementById('navBotsCount');
    if (po) po.textContent = plants.length;
    if (npc) npc.textContent = plants.length;
    if (ndc) ndc.textContent = plants.length;
    renderMetrics(plants);
    await refreshDashboardPanels(plants);
    renderPlantFleetSummary();
    renderPlantTable(plants);
    await buildChartAsync(plants, chartMetricFromActiveTab());
    const ar = await authFetch(API + '/api/users/' + encodeURIComponent(uid) + '/activity-feed');
    if (ar.ok) {
      activityFeed = await ar.json();
      renderAlertsPreview();
    }
    syncDeskbotFromConfig(plants, window.__lastDeskbotConfig || {});
  } catch (_) {}
}

function stopPlantFleetPolling() {
  if (plantFleetPollTimer) {
    clearInterval(plantFleetPollTimer);
    plantFleetPollTimer = null;
  }
}

function startPlantFleetPolling() {
  stopPlantFleetPolling();
  if (!window.__dewUid) return;
  plantFleetPollTimer = setInterval(() => refreshPlantFleetFromServer(), PLANT_FLEET_POLL_MS);
}

const DEW_INGEST_SESSION_KEY = 'dew_last_ingest_token';

/** Create/load per-user ingest token automatically (no manual Firebase uid copy). */
async function ensurePlantIngestToken() {
  const uid = window.__dewUid;
  const wrap = document.getElementById('plantFleetDeviceSetup');
  const codeEl = document.getElementById('plantFleetIngestTokenValue');
  const statusEl = document.getElementById('plantFleetIngestStatus');
  if (!uid || !wrap) return;
  wrap.hidden = false;
  if (codeEl) codeEl.textContent = 'Loading…';
  try {
    const gr = await authFetch(API + '/api/users/' + encodeURIComponent(uid) + '/ingest-token');
    const gj = await gr.json().catch(() => ({}));
    if (!gr.ok) {
      if (codeEl) codeEl.textContent = '—';
      if (statusEl) {
        statusEl.textContent =
          gr.status === 503
            ? 'Sign-in isn’t available on the server right now. Try again later or ask your host to turn on secure sign-in.'
            : 'We couldn’t load your key. Make sure you’re signed in, then refresh the page.';
      }
      return;
    }
    if (gj.exists) {
      if (statusEl) {
        statusEl.textContent =
          'Your key is active. Tap Copy if you need to paste it into your Plant Bot again, or Regenerate for a new key.';
      }
      let show = '••••••••••••••••••••••••••••••••••••••••••••••••••';
      try {
        const cached = sessionStorage.getItem(DEW_INGEST_SESSION_KEY);
        if (cached) show = cached;
      } catch (_) {}
      if (codeEl) codeEl.textContent = show;
    } else {
      const pr = await authFetch(API + '/api/users/' + encodeURIComponent(uid) + '/ingest-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const pj = await pr.json().catch(() => ({}));
      if (pr.ok && pj.token) {
        if (codeEl) codeEl.textContent = pj.token;
        if (statusEl) {
          statusEl.textContent =
            'Your key is ready below. Copy it now and keep it somewhere safe — after you leave or refresh, we only show dots here.';
        }
        try {
          sessionStorage.setItem(DEW_INGEST_SESSION_KEY, pj.token);
        } catch (_) {}
      } else {
        if (codeEl) codeEl.textContent = '—';
        if (statusEl) statusEl.textContent = 'We couldn’t create a key. Refresh the page or try signing in again.';
      }
    }
  } catch (_) {
    if (codeEl) codeEl.textContent = '—';
  }
}

function wirePlantFleetIngestActions() {
  const copyBtn = document.getElementById('btnCopyPlantFleetIngest');
  const regenBtn = document.getElementById('btnRegeneratePlantFleetIngest');
  if (!copyBtn || copyBtn.dataset.wired) return;
  copyBtn.dataset.wired = '1';
  if (regenBtn) regenBtn.dataset.wired = '1';
  copyBtn.addEventListener('click', async () => {
    const codeEl = document.getElementById('plantFleetIngestTokenValue');
    const text = (codeEl && codeEl.textContent) || '';
    let toCopy = text;
    if (/^•+$/.test(text.trim()) || text.includes('•')) {
      try {
        toCopy = sessionStorage.getItem(DEW_INGEST_SESSION_KEY) || '';
      } catch (_) {}
    }
    if (!toCopy || toCopy.includes('•')) {
      alert('Tap Regenerate to show a new key you can copy, or copy right after a new key appears.');
      return;
    }
    try {
      await navigator.clipboard.writeText(toCopy);
      const t = copyBtn.textContent;
      copyBtn.textContent = 'Copied';
      setTimeout(() => {
        copyBtn.textContent = t;
      }, 2000);
    } catch (_) {}
  });

  if (regenBtn) regenBtn.addEventListener('click', async () => {
    const uid = window.__dewUid;
    const codeEl = document.getElementById('plantFleetIngestTokenValue');
    const statusEl = document.getElementById('plantFleetIngestStatus');
    if (!uid) return;
    try {
      const pr = await authFetch(API + '/api/users/' + encodeURIComponent(uid) + '/ingest-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerate: true }),
      });
      const pj = await pr.json().catch(() => ({}));
      if (pr.ok && pj.token) {
        if (codeEl) codeEl.textContent = pj.token;
        if (statusEl) statusEl.textContent = 'You have a new key — paste it into your bot and keep it somewhere safe.';
        try {
          sessionStorage.setItem(DEW_INGEST_SESSION_KEY, pj.token);
        } catch (_) {}
      }
    } catch (_) {}
  });
}

async function load() {
  try {
    plantFleetExpanded = false;
    const uid = window.__dewUid;
    let fleetRes = null;
    if (uid) {
      fleetRes = await authFetch(API + '/api/users/' + encodeURIComponent(uid) + '/plant-fleet').catch(() => null);
    }
    let fleetPlants = [];
    let summary = null;
    if (fleetRes && fleetRes.ok) {
      const data = await fleetRes.json();
      fleetPlants = Array.isArray(data.plants) ? data.plants : [];
      summary = data.summary || null;
    } else if (uid && (!fleetRes || !fleetRes.ok)) {
      // Backend unavailable: fall back to demo plants so dashboard still works.
      const plantsRes = await fetch(API + '/api/plants');
      fleetPlants = await plantsRes.json();
      summary = null;
    }
    // Logged-out: show full demo list. Logged-in with empty fleet: stay empty until usage/telemetry exists.
    if (!fleetPlants.length && !uid) {
      const plantsRes = await fetch(API + '/api/plants');
      fleetPlants = await plantsRes.json();
      summary = null;
    }

    plants = fleetPlants;
    plantFleetSummary = summary;

    const [activityRes, configRes] = await Promise.all([
      uid
        ? authFetch(API + '/api/users/' + encodeURIComponent(uid) + '/activity-feed')
        : fetch(API + '/api/activity'),
      fetch(API + '/api/deskbot-config'),
    ]);
    activityFeed = activityRes.ok ? await activityRes.json() : [];
    const deskbotConfig = await configRes.json();

    document.getElementById('plantsOnline').textContent = plants.length;
    document.getElementById('navPlantsCount').textContent = plants.length;
    document.getElementById('navBotsCount').textContent = plants.length;

    renderMetrics(plants);
    await refreshDashboardPanels(plants);
    renderPlantFleetSummary();
    renderPlantTable(plants);
    await buildChartAsync(plants, 'moisture');
    wireSensorTabs();
    initChartRangeTabs();
    initAlertsPreviewMore();
    window.__lastDeskbotConfig = deskbotConfig;
    syncDeskbotFromConfig(plants, deskbotConfig);
    wireDeskbotPreviewInteractions();
    initPlantFleetChartLink();
    loadDashboardWeather();

    setTimeout(() => recordPlantUsage(plants.map(p => p.id)), 200);
    ensurePlantIngestToken();
    wirePlantFleetIngestActions();
  } catch (e) {
    console.error(e);
    document.getElementById('metricsRow').innerHTML = '<div class="metric-card" style="grid-column:1/-1">Failed to load API. Is the server running? Run: npm start</div>';
  }
}

document.getElementById('btnRefresh').addEventListener('click', () => {
  document.getElementById('lastSyncLabel').textContent = 'Syncing…';
  load().then(() => { document.getElementById('lastSyncLabel').textContent = 'Just now'; });
});

createPetals();

document.getElementById('btnPlantFleetViewAll')?.addEventListener('click', () => {
  plantFleetExpanded = !plantFleetExpanded;
  renderPlantFleetSummary();
  renderPlantTable(plants);
});

// Run dashboard load (and weather) after auth has set __dewUid so location fetch works
function startApp() {
  load().then(() => {
    initChartResizeHandling();
    startPlantFleetPolling();
  });
}
window.__dew = {
  buildBotsPlantChart: dewBuildBotsPlantChart,
  getPlants: () => plants,
  reloadDashboard: load,
};

if (window.__dewAuthReady && window.__dewUid) {
  startApp();
} else {
  window.addEventListener("dewAuthReady", startApp, { once: true });
}
