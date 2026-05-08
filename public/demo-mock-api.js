/**
 * DEW Demo Mode — intercepts /api/* (except config) with believable mock data.
 * Pre-generated curves, stable per session via seeded PRNG.
 */

const DEMO_UID = "demo-warden-001";

const NAME_POOL = [
  "Luna Green",
  "Aarav Sharma",
  "Maya Fern",
  "Jordan Bloom",
  "Sage Rivers",
  "Noah Moss",
  "Priya Vine",
  "Alex Canopy",
];

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Smooth value along 0..1 with gentle drift */
function smoothWave(seed, i, n) {
  const rnd = mulberry32(seed + i * 9973);
  const t = i / Math.max(1, n - 1);
  return Math.sin(t * Math.PI * 2 * 1.7 + seed * 0.01) * 0.5 + Math.sin(t * Math.PI * 3.1) * 0.25 + (rnd() - 0.5) * 0.08;
}

function clamp(n, a, b) {
  return Math.min(b, Math.max(a, n));
}

const OPTIMAL_DEFAULT = {
  temp: { min: 18, max: 30 },
  humidity: { min: 40, max: 70 },
  moisture: { min: 30, max: 60 },
  lux: { min: 200, max: 1500 },
};

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function pickRangeForLightCategory(lightCategory) {
  const lc = String(lightCategory || "medium").toLowerCase();
  if (lc === "low") return { min: 150, max: 900 };
  if (lc === "bright") return { min: 700, max: 2400 };
  return { min: 350, max: 1600 };
}

function pickMoistureRangeForCategory(lightCategory) {
  // Heuristic: bright light tends to dry faster; low light stays moist longer.
  const lc = String(lightCategory || "medium").toLowerCase();
  if (lc === "bright") return { min: 22, max: 48 };
  if (lc === "low") return { min: 35, max: 62 };
  return { min: 28, max: 56 };
}

function buildOptimalForCatalog(cat) {
  const lux = pickRangeForLightCategory(cat?.lightCategory);
  const moisture = pickMoistureRangeForCategory(cat?.lightCategory);
  // Keep temp/humidity within common indoor plant comfort bands but slightly vary by difficulty.
  const diff = Math.max(1, Math.min(5, Number(cat?.difficulty || 2)));
  const tempMin = lerp(17, 20, (diff - 1) / 4);
  const tempMax = lerp(31, 27.5, (diff - 1) / 4);
  const humidityMin = lerp(35, 45, (diff - 1) / 4);
  const humidityMax = lerp(75, 65, (diff - 1) / 4);
  return {
    temp: { min: Math.round(tempMin), max: Math.round(tempMax) },
    humidity: { min: Math.round(humidityMin), max: Math.round(humidityMax) },
    moisture,
    lux,
  };
}

/**
 * Random demo “saved map” location + matching weather (new pick each full page load).
 * Shape matches server GET /api/weather payload.
 */
const DEMO_LOCATIONS = [
  { city: "Portland", state: "OR", country: "USA", latitude: 45.5152, longitude: -122.6784, temp: 12, humidity: 78, condition: "Rain", animation: "rainy", wind: 18, weather_code: 61 },
  { city: "Reykjavik", state: "", country: "Iceland", latitude: 64.1466, longitude: -21.9426, temp: 2, humidity: 71, condition: "Snow", animation: "snowy", wind: 24, weather_code: 71 },
  { city: "Singapore", state: "", country: "Singapore", latitude: 1.3521, longitude: 103.8198, temp: 30, humidity: 84, condition: "Thunderstorm", animation: "thunderstorm", wind: 12, weather_code: 95 },
  { city: "Nairobi", state: "", country: "Kenya", latitude: -1.2921, longitude: 36.8219, temp: 24, humidity: 58, condition: "Mainly clear", animation: "sunny", wind: 14, weather_code: 1 },
  { city: "Sydney", state: "NSW", country: "Australia", latitude: -33.8688, longitude: 151.2093, temp: 22, humidity: 62, condition: "Partly cloudy", animation: "cloudy", wind: 22, weather_code: 2 },
  { city: "Lima", state: "", country: "Peru", latitude: -12.0464, longitude: -77.0428, temp: 19, humidity: 76, condition: "Foggy", animation: "cloudy", wind: 9, weather_code: 45 },
  { city: "Mumbai", state: "MH", country: "India", latitude: 19.076, longitude: 72.8777, temp: 29, humidity: 79, condition: "Rain showers", animation: "rainy", wind: 15, weather_code: 82 },
  { city: "Oslo", state: "", country: "Norway", latitude: 59.9139, longitude: 10.7522, temp: -4, humidity: 68, condition: "Overcast", animation: "cloudy", wind: 20, weather_code: 3 },
  { city: "Cairo", state: "", country: "Egypt", latitude: 30.0444, longitude: 31.2357, temp: 26, humidity: 35, condition: "Clear", animation: "sunny", wind: 11, weather_code: 0 },
  { city: "Vancouver", state: "BC", country: "Canada", latitude: 49.2827, longitude: -123.1207, temp: 8, humidity: 81, condition: "Rain showers", animation: "rainy", wind: 19, weather_code: 80 },
  { city: "Auckland", state: "", country: "New Zealand", latitude: -36.8485, longitude: 174.7633, temp: 18, humidity: 73, condition: "Partly cloudy", animation: "cloudy", wind: 26, weather_code: 2 },
  { city: "Dubai", state: "", country: "UAE", latitude: 25.2048, longitude: 55.2708, temp: 34, humidity: 42, condition: "Clear", animation: "sunny", wind: 17, weather_code: 0 },
  { city: "São Paulo", state: "SP", country: "Brazil", latitude: -23.5505, longitude: -46.6333, temp: 25, humidity: 68, condition: "Rain", animation: "rainy", wind: 13, weather_code: 63 },
  { city: "Seoul", state: "", country: "South Korea", latitude: 37.5665, longitude: 126.978, temp: 4, humidity: 45, condition: "Mainly clear", animation: "cloudy", wind: 21, weather_code: 1 },
  { city: "Lagos", state: "", country: "Nigeria", latitude: 6.5244, longitude: 3.3792, temp: 31, humidity: 77, condition: "Thunderstorm", animation: "thunderstorm", wind: 10, weather_code: 95 },
  { city: "Barcelona", state: "CT", country: "Spain", latitude: 41.3851, longitude: 2.1734, temp: 16, humidity: 64, condition: "Sunny", animation: "sunny", wind: 14, weather_code: 0 },
  { city: "Anchorage", state: "AK", country: "USA", latitude: 61.2181, longitude: -149.9003, temp: -11, humidity: 72, condition: "Snow showers", animation: "snowy", wind: 8, weather_code: 86 },
  { city: "Tokyo", state: "", country: "Japan", latitude: 35.6762, longitude: 139.6503, temp: 11, humidity: 52, condition: "Partly cloudy", animation: "cloudy", wind: 16, weather_code: 2 },
  { city: "Mexico City", state: "CDMX", country: "Mexico", latitude: 19.4326, longitude: -99.1332, temp: 20, humidity: 48, condition: "Clear", animation: "sunny", wind: 7, weather_code: 0 },
  { city: "Helsinki", state: "", country: "Finland", latitude: 60.1699, longitude: 24.9384, temp: -2, humidity: 88, condition: "Snow", animation: "snowy", wind: 23, weather_code: 73 },
];

let _demoLocationSession = null;

// Plant Bot binding (demo-only). In real mode this is stored server-side per user.
let demoPlantbotChoicePlantId = null;

function getDemoLocationPick() {
  if (!_demoLocationSession) {
    _demoLocationSession = DEMO_LOCATIONS[Math.floor(Math.random() * DEMO_LOCATIONS.length)];
  }
  return _demoLocationSession;
}

function buildDemoWeatherApiPayload() {
  const L = getDemoLocationPick();
  const weather = {
    temp: L.temp,
    humidity: L.humidity,
    wind: L.wind,
    condition: L.condition,
    animation: L.animation,
    weather_code: L.weather_code != null ? L.weather_code : 2,
  };
  const location = {
    city: L.city,
    state: L.state || "",
    country: L.country,
    latitude: L.latitude,
    longitude: L.longitude,
    last_updated: new Date().toISOString(),
  };
  const avgT = Number(weather.temp);
  const avgH = Number(weather.humidity);
  const areaToday = {
    avgTempC: Number.isFinite(avgT) ? avgT + (Math.random() * 1.4 - 0.7) : null,
    avgHumidityPct: Number.isFinite(avgH) ? Math.min(100, Math.max(0, avgH + (Math.random() * 6 - 3))) : null,
    avgLuxApprox: Math.round(5000 + Math.random() * 9000),
  };
  return {
    ok: true,
    location,
    weather,
    forecast: [],
    areaToday,
  };
}

/**
 * Full catalog for demo = `public/demo-plant-catalog.json` (generated from server.js via
 * `node scripts/generate-demo-plant-catalog.mjs`). Fallback if fetch fails.
 */
const DEMO_PLANT_CATALOG_FALLBACK = [
  {
    id: "pothos",
    name: "Golden Pothos",
    species: "Epipremnum aureum",
    indoor: true,
    image: "pothos.jpg",
    lightCategory: "low",
    difficulty: 1,
    toxicity: "Toxic to pets (cats/dogs) if ingested.",
    summary: "A fast-growing trailing vine that tolerates low light.",
    care: { light: "", water: "", soil: "", temp: "", humidity: "", fertilizer: "" },
    facts: [],
    benefits: [],
    tips: [],
    ratings: { ease: 4.5, benefits: 4.2, cost: 4.0, popularity: 4.8 },
  },
  {
    id: "snake-plant",
    name: "Snake Plant",
    species: "Dracaena trifasciata",
    indoor: true,
    image: "snake plant.jpg",
    lightCategory: "low",
    difficulty: 1,
    toxicity: "Toxic to pets if ingested.",
    summary: "Tough, upright, low-light friendly.",
    care: { light: "", water: "", soil: "", temp: "", humidity: "", fertilizer: "" },
    facts: [],
    benefits: [],
    tips: [],
    ratings: { ease: 4.8, benefits: 4.0, cost: 4.5, popularity: 4.6 },
  },
  {
    id: "spider-plant",
    name: "Spider Plant",
    species: "Chlorophytum comosum",
    indoor: true,
    image: "spider plant.jpg",
    lightCategory: "medium",
    difficulty: 1,
    toxicity: "Generally considered non-toxic to pets.",
    summary: "Classic arching plant.",
    care: { light: "", water: "", soil: "", temp: "", humidity: "", fertilizer: "" },
    facts: [],
    benefits: [],
    tips: [],
    ratings: { ease: 4.6, benefits: 4.1, cost: 4.2, popularity: 4.7 },
  },
  {
    id: "peace-lily",
    name: "Peace Lily",
    species: "Spathiphyllum spp.",
    indoor: true,
    image: "peace lily.jpg",
    lightCategory: "low",
    difficulty: 2,
    toxicity: "Toxic to pets if ingested.",
    summary: "Elegant shade-tolerant bloomer.",
    care: { light: "", water: "", soil: "", temp: "", humidity: "", fertilizer: "" },
    facts: [],
    benefits: [],
    tips: [],
    ratings: { ease: 4.0, benefits: 4.3, cost: 3.8, popularity: 4.5 },
  },
  {
    id: "monstera",
    name: "Swiss Cheese Plant",
    species: "Monstera deliciosa",
    indoor: true,
    image: "swiss cheese plant.jpg",
    lightCategory: "bright",
    difficulty: 2,
    toxicity: "Toxic to pets and humans if ingested.",
    summary: "Large fenestrated leaves.",
    care: { light: "", water: "", soil: "", temp: "", humidity: "", fertilizer: "" },
    facts: [],
    benefits: [],
    tips: [],
    ratings: { ease: 3.8, benefits: 4.6, cost: 3.9, popularity: 4.9 },
  },
];

let _demoCatalog = null;
let catalogLoadPromise = Promise.resolve();

/** Load merged catalog + extras (same as production). Call before installDemoFetch in demo bootstrap. */
export function loadDemoPlantCatalog() {
  catalogLoadPromise = fetch("/demo-plant-catalog.json", { cache: "force-cache" })
    .then((r) => {
      if (!r.ok) throw new Error("demo-plant-catalog.json " + r.status);
      return r.json();
    })
    .then((data) => {
      if (!Array.isArray(data) || !data.length) throw new Error("empty catalog");
      _demoCatalog = data;
      _fleetCache = null;
    })
    .catch((err) => {
      console.warn("[demo] Using embedded catalog fallback:", err?.message || err);
      _demoCatalog = null;
      _fleetCache = null;
    });
  return catalogLoadPromise;
}

function getDemoCatalog() {
  if (_demoCatalog && _demoCatalog.length) return _demoCatalog;
  return DEMO_PLANT_CATALOG_FALLBACK;
}

function catalogById(plantId) {
  return getDemoCatalog().find((p) => p.id === plantId) || null;
}

const FLEET_ZONES = ["Living room", "Office", "Kitchen", "Bedroom", "Window", "Hall", "Studio"];

function fleetPlantFromCatalog(cat, index) {
  const wobble = mulberry32(hashStr(cat.id + (sessionStorage.getItem("dewDemoSeed") || "0")));
  const lc = String(cat.lightCategory || "medium").toLowerCase();
  let baseMoist = 62;
  let baseTemp = 22.5;
  let baseLux = 1750;
  let baseHum = 55;
  if (lc === "low") {
    baseMoist = 68;
    baseLux = 1100 + wobble() * 450;
  } else if (lc === "bright") {
    baseMoist = 48;
    baseLux = 2400 + wobble() * 700;
    baseTemp = 24;
  } else {
    baseLux = 1650 + wobble() * 550;
  }
  const moisture = clamp(baseMoist + (wobble() - 0.5) * 10, 18, 92);
  const temp = clamp(baseTemp + (wobble() - 0.5) * 1.4, 16, 32);
  const lux = clamp(baseLux + (wobble() - 0.5) * 450, 80, 4000);
  const humidity = clamp(baseHum + (wobble() - 0.5) * 10, 30, 88);
  const status = moisture < 42 ? "Moisture low" : "Healthy";
  const imgFile = cat.image || `${cat.id}.jpg`;
  const now = new Date().toISOString();
  return {
    id: cat.id,
    name: cat.name,
    species: cat.species,
    zone: FLEET_ZONES[index % FLEET_ZONES.length],
    indoor: true,
    image: imgFile,
    moisture: Math.round(moisture * 10) / 10,
    temp: Math.round(temp * 10) / 10,
    lux: Math.round(lux),
    humidity: Math.round(humidity),
    status,
    updatedAt: now,
    optimal: buildOptimalForCatalog(cat) || OPTIMAL_DEFAULT,
    usage: {
      first_used_at: new Date(Date.now() - 86400000 * (8 + (index % 30))).toISOString(),
      last_used_at: now,
      use_count: 24 + Math.floor(wobble() * 50) + index * 3,
      last_source: "telemetry",
    },
  };
}

/** Used by My Plants — same shape as GET /api/users/:uid/used-plants on the real server. */
function buildDemoUsedPlants() {
  const now = new Date().toISOString();
  return getDemoCatalog().map((cat, i) => ({
    ...cat,
    usage: {
      first_used_at: new Date(Date.now() - 86400000 * (16 + i * 2)).toISOString(),
      last_used_at: now,
      use_count: 18 + i * 7,
      last_source: "telemetry",
    },
  }));
}

function buildFleetPlants() {
  return getDemoCatalog().map((cat, i) => fleetPlantFromCatalog(cat, i));
}

let _fleetCache = null;
function getDemoFleet() {
  if (!_fleetCache) _fleetCache = buildFleetPlants();
  const plants = _fleetCache;
  const avgMoisture = Math.round(plants.reduce((s, p) => s + p.moisture, 0) / plants.length);
  return {
    plants,
    summary: {
      total: plants.length,
      telemetryLinked: plants.length,
      needsAttention: plants.filter((p) => /low|dry/i.test(p.status || "")).length,
      avgMoisture,
    },
  };
}

function generateTelemetry(plantId, hoursParam) {
  const fleet = getDemoFleet().plants;
  const plant = fleet.find((p) => p.id === plantId) || fleet[0];
  const hours = hoursParam === "all" ? 720 : Math.min(720, Math.max(1, parseInt(hoursParam, 10) || 24));
  const spanMs = hours * 3600 * 1000;
  const now = Date.now();
  const n = hours >= 168 ? 96 : hours >= 48 ? 72 : 48;
  const seed = hashStr(plantId + String(hours));
  const out = [];
  const b = plant;
  const opt = (plant && plant.optimal) || OPTIMAL_DEFAULT;
  const rnd = mulberry32(seed ^ hashStr(sessionStorage.getItem("dewDemoSeed") || "0"));

  // Build a few realistic "events": waterings (moisture spikes) and a midday light peak.
  // Watering count scales with range (1–5 events).
  const wateringCount = Math.max(1, Math.min(5, Math.round(lerp(1, 5, Math.min(1, hours / 720)))));
  const wateringAt = Array.from({ length: wateringCount }, (_, i) => {
    const t = (i + 1) / (wateringCount + 1);
    // jitter within +/- 6% of the span
    const jit = (rnd() - 0.5) * 0.12;
    return clamp(t + jit, 0.06, 0.94);
  }).sort((a, b) => a - b);

  function dayFraction(tsMs) {
    const d = new Date(tsMs);
    const mins = d.getHours() * 60 + d.getMinutes();
    return mins / (24 * 60);
  }

  function daylightCurve(frac) {
    // 0 at night, peaks around mid-day.
    // Shift peak slightly per plant for variation.
    const shift = (smoothWave(seed + 777, 3, 10) * 0.06);
    let x = frac + shift;
    x = x - Math.floor(x);
    // day window ~ 6:00–19:30
    const sunrise = 6 / 24;
    const sunset = 19.5 / 24;
    if (x < sunrise || x > sunset) return 0;
    const t = (x - sunrise) / (sunset - sunrise);
    // smooth bell
    return Math.sin(Math.PI * t) ** 1.4;
  }

  function wateringBoost(tNorm) {
    // Sum of short gaussian-ish bumps around watering events.
    let sum = 0;
    for (const w of wateringAt) {
      const d = Math.abs(tNorm - w);
      const width = 0.03 + rnd() * 0.02; // narrower for short windows
      const bump = Math.exp(-(d * d) / (2 * width * width));
      sum += bump;
    }
    return clamp(sum, 0, 2.2);
  }

  // Baselines anchored on current plant snapshot
  const mBase = Number(b.moisture || 50);
  const tBase = Number(b.temp || 22);
  const hBase = Number(b.humidity || 55);
  const lBase = Number(b.lux || 900);

  for (let i = 0; i < n; i++) {
    const t = now - spanMs + (spanMs * i) / (n - 1);
    const tNorm = i / Math.max(1, n - 1);
    const w = smoothWave(seed, i, n);
    const df = dayFraction(t);
    const sun = daylightCurve(df);
    const water = wateringBoost(tNorm);

    // Moisture: gradual dry-down with occasional watering spikes.
    const dryDown = -lerp(2, 10, Math.min(1, hours / 720)) * tNorm;
    const waterSpike = water * lerp(6, 12, rnd());
    const m = clamp(mBase + dryDown + waterSpike + w * 2.2, 10, 95);

    // Temperature: daily cycle + small drift.
    const tempCycle = (sun * 2.2) - 0.7; // warmer mid-day, cooler night
    const tempDrift = (w * 0.7) + (rnd() - 0.5) * 0.25;
    const tVal = clamp(tBase + tempCycle + tempDrift, 12, 35);

    // Lux: strong day/night + plant category scaling.
    const luxTarget = opt?.lux ? lerp(opt.lux.min, opt.lux.max, 0.72) : 1400;
    const nightLux = lerp(20, 120, rnd());
    const luxVal = clamp(nightLux + sun * (luxTarget + (rnd() - 0.5) * 450) + w * 90, 0, 5000);

    // Humidity: tends to be a bit higher at night, lower in afternoon.
    const humCycle = (1 - sun) * 4 - 2.5;
    const humVal = clamp(hBase + humCycle + w * 1.8 + (rnd() - 0.5) * 1.2, 25, 92);

    out.push({
      at: new Date(t).toISOString(),
      moisture: m,
      temp: tVal,
      lux: luxVal,
      humidity: humVal,
    });
  }
  return out;
}

function mockActivityFeed() {
  const plants = getDemoFleet().plants;
  return [
    { id: "d1", icon: "ri-drop-fill", title: "Irrigation check", desc: `${plants[0]?.name || "Plant"} · soil stable`, time: "2m ago" },
    { id: "d2", icon: "ri-wifi-line", title: "Plant Bot synced", desc: "DEW-IOT · sample stream", time: "6m ago" },
    { id: "d3", icon: "ri-temp-hot-line", title: "Temperature steady", desc: `${plants[1]?.name || "Plant"} · within range`, time: "18m ago" },
    { id: "d4", icon: "ri-sun-line", title: "Light levels optimal", desc: `${Math.round(plants[2]?.lux || 800)} lux`, time: "42m ago" },
    { id: "d5", icon: "ri-checkbox-circle-line", title: "Demo snapshot", desc: "Simulated activity — no devices connected", time: "1h ago" },
  ];
}

function mockDeskbotConfig() {
  const p = getDemoFleet().plants[0];
  return {
    plantId: p?.id || "pothos",
    line: `${p?.name || "Pothos"}: Moisture ~${Math.round(p?.moisture || 70)}% · thriving 🌿`,
    theme: "mint",
    mood: "happy",
    show: { temp: true, moisture: true, humidity: true, light: true, weather: true, health: true },
    updatedAt: new Date().toISOString(),
  };
}

function mockCommunities() {
  return [
    {
      id: "demo-1",
      name: "Houseplant Heroes",
      slug: "houseplant-heroes",
      description: "Tips, trades, and grow logs for indoor jungles.",
      member_count: 1280,
      post_count: 342,
      category: "plants",
      banner_url: null,
      logo_url: null,
      status: "public",
      creator_firebase_uid: DEMO_UID,
      logo_symbol: "🌿",
      joined: true,
    },
    {
      id: "demo-2",
      name: "Smart Garden Lab",
      slug: "smart-garden-lab",
      description: "ESP32, sensors, and automation — demo threads.",
      member_count: 890,
      post_count: 156,
      category: "tech",
      banner_url: null,
      logo_url: null,
      status: "public",
      creator_firebase_uid: "other",
      logo_symbol: "⚙️",
      joined: false,
    },
  ];
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parsePath(url) {
  try {
    const u = url.startsWith("http") ? new URL(url) : new URL(url, location.origin);
    return { pathname: u.pathname, searchParams: u.searchParams };
  } catch {
    return { pathname: "", searchParams: new URLSearchParams() };
  }
}

export function seedDemoSession() {
  try {
    if (!sessionStorage.getItem("dewDemoSeed")) {
      sessionStorage.setItem("dewDemoSeed", String(Date.now() & 0xffffffff));
    }
  } catch (_) {}
  const rnd = mulberry32(hashStr(sessionStorage.getItem("dewDemoSeed") || "1"));
  const name = NAME_POOL[Math.floor(rnd() * NAME_POOL.length)];
  const avatarSeed = encodeURIComponent(name);
  window.__dewDemoUser = {
    uid: DEMO_UID,
    displayName: name,
    email: "demo@dew.app",
    photoURL: `https://api.dicebear.com/7.x/avataaars/svg?seed=${avatarSeed}`,
    providerId: "demo",
    getIdToken: async () => "demo.id-token.stub",
    reload: () => Promise.resolve(),
  };
  window.__dewUid = DEMO_UID;
  _fleetCache = null;
}

export function installDemoFetch() {
  const orig = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    // Ensure full generated catalog is available before first /api/* demo response.
    await catalogLoadPromise;
    const url = typeof input === "string" ? input : input.url;
    const method = ((init && init.method) || "GET").toUpperCase();

    let path;
    try {
      const u = url.startsWith("http") ? new URL(url) : new URL(url, location.origin);
      if (u.origin !== location.origin) return orig(input, init);
      path = u.pathname + (u.search || "");
    } catch {
      return orig(input, init);
    }

    const base = path.split("?")[0];

    if (!base.startsWith("/api/")) return orig(input, init);

    const mock = routeDemoApi(base, path, method, init, orig, input);
    if (mock !== undefined) return mock;
    if (method !== "GET" && method !== "HEAD") {
      return jsonResponse({ ok: true, demo: true, message: "Demo mode — changes are not saved." });
    }
    try {
      const r = await orig(input, init);
      if (r.ok) return r;
    } catch (_) {}
    return jsonResponse([]);
  };
}

export function invalidateDemoFleetCache() {
  _fleetCache = null;
}

function routeDemoApi(base, fullPath, method, init, orig, input) {
  const { searchParams } = parsePath(fullPath);

  // Config endpoints: in demo mode, prefer live API if available, else return safe stubs.
  if (method === "GET" && base === "/api/config/firebase") {
    // Let firebase-config.js fall back to its embedded DEMO_FIREBASE_CONFIG if needed;
    // returning 503 here triggers that path without breaking demo mode.
    return jsonResponse({ ok: false, demo: true }, 503);
  }
  if (method === "GET" && base === "/api/config/supabase") {
    return jsonResponse({ url: "", anonKey: "", ok: true, demo: true });
  }
  if (method === "GET" && base === "/api/config/weather") {
    return jsonResponse({ openWeatherApiKey: "", ok: true, demo: true });
  }

  if (method === "GET" && base.match(/^\/api\/users\/[^/]+\/plant-fleet$/)) {
    return jsonResponse(getDemoFleet());
  }
  if (method === "GET" && base.match(/^\/api\/users\/[^/]+\/activity-feed$/)) {
    return jsonResponse(mockActivityFeed());
  }
  if (base.match(/^\/api\/users\/[^/]+\/ingest-token$/)) {
    if (method === "GET") return jsonResponse({ exists: true, token: "demo-ingest-token-not-real" });
    if (method === "POST") return jsonResponse({ ok: true, token: "demo-" + Date.now().toString(36) });
  }
  if (base === "/api/plantbot-choice") {
    if (method === "GET") {
      return jsonResponse({ plantId: demoPlantbotChoicePlantId || "pothos" });
    }
    if (method === "POST") {
      const raw = init?.body;
      try {
        const obj = typeof raw === "string" ? JSON.parse(raw) : raw || {};
        if (obj && (obj.plantId || obj.plant_id)) demoPlantbotChoicePlantId = String(obj.plantId || obj.plant_id);
      } catch (_) {}
      return jsonResponse({ ok: true, plantId: demoPlantbotChoicePlantId || "pothos" });
    }
  }
  if (method === "GET" && base.match(/^\/api\/users\/[^/]+\/location$/)) {
    const L = getDemoLocationPick();
    return jsonResponse({
      city: L.city,
      state: L.state || "",
      country: L.country,
      latitude: L.latitude,
      longitude: L.longitude,
      last_updated: new Date().toISOString(),
    });
  }
  if ((method === "PUT" || method === "POST") && base.match(/^\/api\/users\/[^/]+\/location$/)) {
    return jsonResponse({ ok: true, demo: true });
  }
  if (method === "GET" && base === "/api/plants/catalog") {
    return jsonResponse(getDemoCatalog());
  }
  if (method === "GET" && /^\/api\/plants\/catalog\/.+/.test(base)) {
    const raw = base.replace(/^\/api\/plants\/catalog\//, "");
    const id = decodeURIComponent(raw.split("/")[0] || "");
    const found = catalogById(id);
    return found ? jsonResponse(found) : jsonResponse({ error: "Plant not found" }, 404);
  }
  if (method === "GET" && base === "/api/plants") {
    return jsonResponse(getDemoFleet().plants);
  }
  if (method === "GET" && base.match(/^\/api\/plants\/[^/]+\/telemetry$/)) {
    const m = base.match(/^\/api\/plants\/([^/]+)\/telemetry$/);
    const plantId = m ? decodeURIComponent(m[1]) : "pothos";
    const hours = searchParams.get("hours") || "24";
    return jsonResponse(generateTelemetry(plantId, hours));
  }
  if (method === "GET" && base === "/api/activity") {
    return jsonResponse(mockActivityFeed());
  }
  if (method === "GET" && base === "/api/deskbot-config") {
    return jsonResponse(mockDeskbotConfig());
  }
  if (method === "POST" && base === "/api/deskbot-config") {
    return jsonResponse({ ...mockDeskbotConfig(), demoSaved: true });
  }
  if (method === "GET" && base.match(/^\/api\/device\/config$/)) {
    const cfg = mockDeskbotConfig();
    const plant = getDemoFleet().plants?.[0] || {};
    const mood = String(cfg.mood || "happy").toLowerCase();
    const show = cfg.show || {};
    const wantsData = !!(show.temp || show.humidity || show.light || show.moisture || show.health);
    const soil = plant.moisture != null ? plant.moisture : 50;
    return jsonResponse({
      mode: wantsData ? "data" : "expression",
      mood,
      plant_data: {
        temperature: plant.temp != null ? plant.temp : 25,
        humidity: plant.humidity != null ? plant.humidity : 60,
        light: plant.lux != null ? plant.lux : 800,
        soil,
        health: soil,
      },
      expression: mood,
      display_mode: wantsData ? "temperature" : "health",
      theme: cfg.theme || null,
      plant_id: cfg.plantId || "pothos",
    });
  }
  if (method === "GET" && base.startsWith("/api/weather")) {
    return jsonResponse(buildDemoWeatherApiPayload());
  }
  if ((method === "POST" || method === "PUT") && base.includes("/usage")) {
    return jsonResponse({ ok: true, demo: true });
  }
  if (method === "GET" && base.match(/^\/api\/users\/[^/]+\/stats$/)) {
    return jsonResponse({ plantsCount: 4, followersCount: 12, followingCount: 8 });
  }
  if (method === "GET" && base === "/api/alerts") {
    return jsonResponse([
      {
        id: "demo-a1",
        plantId: "snake-plant",
        plantName: "Snake Plant",
        type: "moisture",
        message: "Moisture is a bit low — consider watering soon.",
        severity: "warning",
        at: new Date(Date.now() - 3600000).toISOString(),
        read: false,
        resolved: false,
      },
    ]);
  }
  if (method === "GET" && base.includes("/alerts") && base.includes("/users/")) {
    return jsonResponse([]);
  }
  if (method === "GET" && base === "/api/alerts/count") {
    return jsonResponse({ count: 1 });
  }
  if (method === "GET" && base.match(/\/users\/[^/]+\/alerts\/count$/)) {
    return jsonResponse({ count: 0 });
  }
  if (method === "PATCH" || method === "POST") {
    if (base.includes("/alerts/")) return jsonResponse({ ok: true, demo: true });
  }
  if (method === "GET" && base === "/api/communities") {
    return jsonResponse(mockCommunities());
  }
  if (method === "GET" && base.match(/^\/api\/communities\/[^/]+\/highlights$/)) {
    return jsonResponse({ posts: [] });
  }
  if (method === "GET" && base.match(/^\/api\/communities\/[^/]+\/meta$/)) {
    return jsonResponse({ member_count: 100, post_count: 24 });
  }
  if (method === "GET" && base.match(/^\/api\/communities\/[^/]+\/messages$/)) {
    return jsonResponse([]);
  }
  if (method === "GET" && base.match(/^\/api\/communities\/[^/]+\/membership$/)) {
    return jsonResponse({ joined: false });
  }
  if (method === "GET" && base.match(/^\/api\/posts\//) && base.endsWith("/comments")) {
    return jsonResponse([]);
  }
  if (method === "GET" && base.startsWith("/api/posts/")) {
    return jsonResponse(null, 404);
  }
  if (method === "GET" && base === "/api/sensors/last-sync") {
    return jsonResponse({ lastSyncAt: new Date().toISOString(), plantId: "pothos", source: "demo" });
  }
  if (method === "POST" && base === "/api/sensors/sync") {
    return jsonResponse({ ok: true, demo: true, inserted: 0 });
  }
  if (method === "POST" && base === "/api/users/upsert") {
    return jsonResponse({ ok: true, demo: true });
  }
  if (method === "GET" && base.match(/^\/api\/users\/[^/]+\/favourites$/)) {
    return jsonResponse(["pothos", "peace-lily"]);
  }
  if (method === "POST" && base.match(/^\/api\/users\/[^/]+\/favourites$/)) {
    return jsonResponse({ ok: true, demo: true });
  }
  if (method === "GET" && base.match(/^\/api\/users\/[^/]+\/used-plants$/)) {
    return jsonResponse(buildDemoUsedPlants());
  }
  if (method === "GET" && base.includes("/weather-alerts")) {
    return jsonResponse([]);
  }

  return undefined;
}
