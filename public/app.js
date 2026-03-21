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
let plantFleetPollTimer = null;
const PLANT_FLEET_POLL_MS = 20000;

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
  const res = await fetch(API + '/api/users/' + encodeURIComponent(uid) + '/location');
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
}

async function loadDashboardWeather() {
  const hero = document.getElementById('dashboardWeatherHero');
  const wrap = document.getElementById('dashboardWeatherWrap');
  const empty = document.getElementById('dashboardWeatherEmpty');
  if (!hero || !empty) return;

  const uid = window.__dewUid;
  if (!uid) {
    hero.style.display = 'none';
    if (wrap) wrap.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  // Server-side weather endpoint handles caching + open-meteo calls.
  try {
    const res = await fetch(`${API}/api/weather?user_id=${encodeURIComponent(uid)}`);
    if (res.status === 404) {
      hero.style.display = 'none';
      if (wrap) wrap.style.display = 'none';
      empty.style.display = 'block';
      maybeShowWeatherLocationPrompt();
      return;
    }
    if (!res.ok) throw new Error('Weather request failed');

    const data = await res.json();
    const loc = data.location;
    const weather = data.weather;
    empty.style.display = 'none';
    hero.style.display = 'block';
    if (wrap) wrap.style.display = 'block';
    renderWeatherHero(loc, weather);
    maybeHideWeatherLocationPrompt();
  } catch (e) {
    console.warn('Dashboard weather failed:', e.message);
    hero.style.display = 'none';
    if (wrap) wrap.style.display = 'none';
    empty.style.display = 'block';
    maybeShowWeatherLocationPrompt();
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

  async function reverseGeocode(lat, lon) {
    // Nominatim reverse geocoding for city/country labels.
    const ua = "dew-weather-system/1.0";
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&format=json&addressdetails=1&zoom=10`;
    const res = await fetch(url, { headers: { "User-Agent": ua } });
    if (!res.ok) throw new Error("Reverse geocode failed");
    const json = await res.json();
    const a = json?.address || {};
    const city =
      a.city ||
      a.town ||
      a.village ||
      a.hamlet ||
      a.municipality ||
      "";
    const state = a.state || "";
    const country = a.country || "";
    return { city, state, country };
  }

  detectBtn.addEventListener("click", async () => {
    const uid = window.__dewUid;
    if (!uid) return;

    disableModalButtons(true);
    setStatus("Requesting device location…", "info");

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
        const msg =
          err && err.code === 1
            ? "Location permission denied. You can still search manually."
            : "Could not access your location. Try again.";
        setStatus(msg, "error");
        disableModalButtons(false);
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 }
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

function renderMetrics(plants) {
  const n = plants.length;
  const avgTemp = n ? (plants.reduce((s, p) => s + p.temp, 0) / n).toFixed(1) : '—';
  const avgLux = n ? Math.round(plants.reduce((s, p) => s + p.lux, 0) / n) : '—';
  const withHum = plants.filter((p) => p.humidity != null);
  const avgHum = withHum.length
    ? Math.round(withHum.reduce((s, p) => s + Number(p.humidity), 0) / withHum.length)
    : null;
  const lowMoisture = plants.filter(p => p.moisture < 45).length;
  const health = n ? Math.round(100 - (lowMoisture / n) * 22) : 0;
  const metrics = [
    { label: 'Avg Temp', value: avgTemp, unit: '°C', delta: 'fleet', positive: true },
    { label: 'Humidity', value: avgHum != null ? String(avgHum) : '—', unit: '%', delta: avgHum != null ? 'sensor avg' : 'room', positive: true },
    { label: 'Lux (Light)', value: String(avgLux), unit: 'lx', delta: 'Optimal range', positive: true },
    { label: 'Garden Health', value: String(health), unit: '%', delta: 'AI index', positive: health >= 70 },
  ];
  const row = document.getElementById('metricsRow');
  row.innerHTML = metrics.map(m => `
    <div class="metric-card">
      <div class="metric-label"><span>${m.label}</span><span class="right">Today</span></div>
      <div class="metric-value"><span>${m.value}</span><span class="metric-unit">${m.unit}</span></div>
      <div class="metric-delta ${m.positive ? '' : 'negative'}"><i class="ri-arrow-${m.positive ? 'up' : 'down'}-s-line"></i>${m.delta}</div>
      <div class="metric-tag">DEW Warden</div>
    </div>
  `).join('');
}

function getPlantImageUrl(p) {
  if (!p || !p.image) return null;
  return '/images/plants/' + encodeURIComponent(p.image);
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
      ? 'No plants linked to your account yet. When your ESP32 sends telemetry (or you use Desk Bot), they will appear here with overall conditions.'
      : 'Sign in to see plants linked to your sensors.';
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
    tbody.innerHTML = `<tr><td colspan="6" class="plant-fleet-empty">No plants linked yet. Use <strong>Option A</strong>: include <code>"uid"</code> (copy from the box above) in your Plant Bot POST to <code>/api/telemetry</code>. Or save Desk Bot while signed in.</td></tr>`;
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
      <td><span class="status-pill ${/low|dry/i.test(p.status || '') ? 'bad' : ''}"><span style="width:7px;height:7px;border-radius:999px;background:${/low|dry/i.test(p.status || '') ? '#ff6d7d' : '#47d58f'};"></span>${p.status || '—'}</span></td>
      <td><div class="bar-track"><div class="bar-fill ${(p.moisture || 0) < 45 ? 'low' : ''}" style="width:${Math.min(100, p.moisture || 0)}%;"></div></div></td>
      <td>${(p.temp != null ? p.temp : '—').toString().replace(/^([\d.]+)$/, '$1°C')}</td>
      <td>${p.lux != null ? Number(p.lux).toLocaleString() : '—'}</td>
      <td class="plant-fleet-activity">
        <div class="fleet-activity-main">${last} ${badge}</div>
        ${syncLine ? `<div class="fleet-activity-sub">${syncLine}</div>` : ''}
      </td>
    </tr>
  `;
  }).join('');
}

function renderActivity(list) {
  const ul = document.getElementById('activityList');
  ul.innerHTML = (list || []).map(a => `
    <li class="activity-item">
      <div class="activity-icon"><i class="${a.icon || 'ri-circle-line'}"></i></div>
      <div class="activity-text"><strong>${a.title || '—'}</strong><span>${a.desc || ''}</span></div>
      <div class="activity-time">${a.time || ''}</div>
    </li>
  `).join('');
}

function buildChart(plants, metricKey = 'moisture') {
  const ctx = document.getElementById('sensorChart').getContext('2d');
  if (sensorChart) sensorChart.destroy();
  const key = metricKey === 'temperature' ? 'temp' : metricKey;
  const labels = ['6am', '8am', '10am', '12pm', '2pm', '4pm', 'Now'];
  const datasets = (plants || []).slice(0, 4).map((p, i) => {
    const v = p[key] != null ? p[key] : 50;
    const spread = () => Array.from({ length: 7 }, (_, j) => Math.max(0, v - 5 + (j * 2) + (Math.random() * 4 - 2)));
    return {
      label: (p.name || p.id).split(' ')[0],
      data: spread(),
      borderColor: palette[p.id] || Object.values(palette)[i],
      backgroundColor: (palette[p.id] || Object.values(palette)[i]) + '33',
      tension: 0.45,
      fill: true,
      borderWidth: 2,
      pointRadius: 0,
    };
  });
  sensorChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: true, labels: { boxWidth: 10, color: '#8fa99f', font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: '#8fa99f', font: { size: 11 } }, grid: { color: 'rgba(126, 242, 191, 0.12)' } },
        y: { ticks: { color: '#8fa99f', font: { size: 11 } }, grid: { color: 'rgba(126, 242, 191, 0.12)' } },
      },
    },
  });
}

function wireSensorTabs(plants) {
  document.querySelectorAll('#sensorTabs .tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('#sensorTabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      buildChart(plants, tab.dataset.metric);
    };
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
  const preview = document.getElementById('deskbotPreview');
  if (!preview) return;
  const plant = (plants || []).find(p => p.id === focusPlantId) || (plants || [])[0];
  const weather = getWeatherFromPlant(plant);
  preview.setAttribute('data-weather', weather);
  populateWeatherParticles(weather);
}

function applyDeskbotTheme(theme, el) {
  const preview = document.getElementById('deskbotPreview');
  if (!preview) return;
  if (theme === 'mint') preview.style.background = 'radial-gradient(circle at 10% 0%, #fff 0, #ddfff3 45%, #bff5ff 100%)';
  else if (theme === 'sakura') preview.style.background = 'radial-gradient(circle at 10% 0%, #fff0f7 0, #ffd6f1 40%, #ffc0da 100%)';
  else if (theme === 'midnight') preview.style.background = 'radial-gradient(circle at 10% 0%, #131933 0, #28305b 45%, #3ac6ff 100%)';
  const meta = document.getElementById('deskbotMeta');
  if (meta) meta.textContent = theme === 'mint' ? 'Anime theme · Soft mint glow' : theme === 'sakura' ? 'Sakura bloom · Pink aura' : 'Midnight nebula · Cyan pulse';
}

function initDeskbot(plants, config) {
  const focusSelect = document.getElementById('deskbotFocus');
  const lineInput = document.getElementById('deskbotLineInput');
  const lineEl = document.getElementById('deskbotLine');
  const statusEl = document.getElementById('deskbotStatus');
  const themeSwatches = document.getElementById('themeSwatches');
  if (!focusSelect) return;
  if (!plants || !plants.length) {
    focusSelect.innerHTML = '<option value="">No plants in fleet yet</option>';
    if (lineEl) lineEl.textContent = '—';
    if (lineInput) lineInput.value = '';
    updateDeskbotWeather([], null);
    return;
  }
  focusSelect.innerHTML = (plants || []).map(p => `<option value="${p.id}" ${(config && config.plantId === p.id) ? 'selected' : ''}>${p.name || p.id}</option>`).join('');
  updateDeskbotWeather(plants, config && config.plantId ? config.plantId : (plants && plants[0] && plants[0].id));
  if (config) {
    lineEl.textContent = config.line || '—';
    lineInput.value = config.line || '';
    themeSwatches.querySelectorAll('.theme-swatch').forEach(s => { s.classList.toggle('active', s.dataset.theme === (config.theme || 'mint')); });
    applyDeskbotTheme(config.theme || 'mint');
  }
  const markDirty = () => { statusEl.textContent = 'Unsaved changes'; };
  focusSelect.addEventListener('change', () => {
    const p = plants.find(x => x.id === focusSelect.value);
    if (p) {
      lineEl.textContent = `${(p.name || p.id).split(' ')[0]}: ${p.moisture}% · ${p.status}`;
      lineInput.value = lineEl.textContent;
      updateDeskbotWeather(plants, focusSelect.value);
      markDirty();
    }
  });
  lineInput.addEventListener('input', () => { lineEl.textContent = lineInput.value || 'Awaiting status…'; markDirty(); });
  themeSwatches.addEventListener('click', e => {
    const s = e.target.closest('.theme-swatch');
    if (!s) return;
    themeSwatches.querySelectorAll('.theme-swatch').forEach(x => x.classList.remove('active'));
    s.classList.add('active');
    applyDeskbotTheme(s.dataset.theme);
    markDirty();
  });
  document.getElementById('btnSaveDeskbot').addEventListener('click', async () => {
    const theme = themeSwatches.querySelector('.theme-swatch.active');
    const body = {
      plantId: focusSelect.value,
      line: lineInput.value || lineEl.textContent,
      theme: theme ? theme.dataset.theme : 'mint',
      show: {
        moisture: document.getElementById('toggleMoisture').checked,
        temp: document.getElementById('toggleTemp').checked,
        light: document.getElementById('toggleLight').checked,
      },
    };
    try {
      const res = await authFetch(API + '/api/deskbot-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) {
        statusEl.textContent = 'Pushed to Desk Bot ✓';
        setTimeout(() => { statusEl.textContent = 'Synced'; }, 2500);
        if (body.plantId && window.__dewUid) recordPlantUsage([body.plantId]);
      }
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
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
    const ndc = document.getElementById('navDevicesCount');
    if (po) po.textContent = plants.length;
    if (npc) npc.textContent = plants.length;
    if (ndc) ndc.textContent = plants.length;
    renderMetrics(plants);
    renderPlantFleetSummary();
    renderPlantTable(plants);
    buildChart(plants, chartMetricFromActiveTab());
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

/** Show copyable Firebase uid for Plant Bot POST /api/telemetry (Option A: JSON body `uid`). */
function updatePlantFleetUidDisplay() {
  const wrap = document.getElementById('plantFleetUidSetup');
  const el = document.getElementById('plantFleetUidValue');
  const uid = window.__dewUid;
  if (el) el.textContent = uid || '—';
  if (wrap) wrap.hidden = !uid;
}

function wirePlantFleetUidCopy() {
  const btn = document.getElementById('btnCopyPlantFleetUid');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', async () => {
    const uid = window.__dewUid;
    if (!uid) return;
    try {
      await navigator.clipboard.writeText(uid);
      const t = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => {
        btn.textContent = t;
      }, 2000);
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
      fetch(API + '/api/activity'),
      fetch(API + '/api/deskbot-config'),
    ]);
    const activity = await activityRes.json();
    const deskbotConfig = await configRes.json();

    document.getElementById('plantsOnline').textContent = plants.length;
    document.getElementById('navPlantsCount').textContent = plants.length;
    document.getElementById('navDevicesCount').textContent = plants.length;

    renderMetrics(plants);
    renderPlantFleetSummary();
    renderPlantTable(plants);
    renderActivity(activity);
    buildChart(plants, 'moisture');
    wireSensorTabs(plants);
    initDeskbot(plants, deskbotConfig);
    loadDashboardWeather();

    setTimeout(() => recordPlantUsage(plants.map(p => p.id)), 200);
    updatePlantFleetUidDisplay();
    wirePlantFleetUidCopy();
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
  load().then(() => startPlantFleetPolling());
}
if (window.__dewAuthReady && window.__dewUid) {
  startApp();
} else {
  window.addEventListener("dewAuthReady", startApp, { once: true });
}
