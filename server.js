require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');

let firebaseAdmin = null;
let supabaseAdmin = null;
try {
  firebaseAdmin = require('firebase-admin');
  if (!firebaseAdmin.apps.length) {
    const cred = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (cred) {
      const key = typeof cred === 'string' ? JSON.parse(cred) : cred;
      firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(key) });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_PROJECT_ID) {
      firebaseAdmin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
    }
  }
} catch (e) {
  // firebase-admin optional for community admin edit
}
try {
  const { createClient } = require('@supabase/supabase-js');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supabaseUrl && supabaseServiceKey) supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
} catch (e) {
  // @supabase/supabase-js optional
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const USER_DATA_FILE = path.join(DATA_DIR, 'user-data.json');
const DB_FILE = path.join(DATA_DIR, 'dew.db');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function openDb() {
  ensureDataDir();
  return new sqlite3.Database(DB_FILE);
}

function initDbAndMigrateFromJson() {
  const db = openDb();
  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS favourites (
        uid TEXT NOT NULL,
        plantId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (uid, plantId)
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS weather_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        alert_type TEXT NOT NULL,
        alert_message TEXT NOT NULL,
        weather_condition TEXT,
        created_at TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active'
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS user_plant_usage (
        uid TEXT NOT NULL,
        plant_id TEXT NOT NULL,
        first_used_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 1,
        last_source TEXT,
        PRIMARY KEY (uid, plant_id)
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS sensor_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        plant_id TEXT NOT NULL,
        plant_name TEXT,
        alert_type TEXT NOT NULL,
        message TEXT NOT NULL,
        severity TEXT DEFAULT 'warning',
        created_at TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        snoozed_until TEXT
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_user_plant_usage_uid_last ON user_plant_usage(uid, last_used_at DESC)');
    db.run('CREATE INDEX IF NOT EXISTS idx_sensor_alerts_created ON sensor_alerts(created_at DESC)');
    db.run('CREATE INDEX IF NOT EXISTS idx_sensor_alerts_user_created ON sensor_alerts(user_id, created_at DESC)');
  });

  // Migration: add status column to weather_alerts if it doesn't exist (existing DBs)
  db.get("SELECT 1 FROM pragma_table_info('weather_alerts') WHERE name = 'status'", (err, row) => {
    if (!err && !row) {
      db.run("ALTER TABLE weather_alerts ADD COLUMN status TEXT DEFAULT 'active'", (alterErr) => {
        if (!alterErr) db.run("UPDATE weather_alerts SET status = 'active' WHERE status IS NULL");
      });
    }
  });

  // One-time migration: move favourites from JSON into SQLite (idempotent via PRIMARY KEY).
  try {
    const legacy = loadUserData();
    const fav = legacy.favourites && typeof legacy.favourites === 'object' ? legacy.favourites : {};
    const stmt = db.prepare('INSERT OR IGNORE INTO favourites (uid, plantId, createdAt) VALUES (?, ?, ?)');
    Object.entries(fav).forEach(([uid, plantIds]) => {
      if (!uid || !Array.isArray(plantIds)) return;
      const at = new Date().toISOString();
      plantIds.forEach((pid) => stmt.run(uid, pid, at));
    });
    stmt.finalize();
  } catch (e) {
    // Ignore migration failures; app will still work.
  }

  // One-time migration: move user plant usage history from JSON into SQLite.
  try {
    const legacy = loadUserData();
    const usage = legacy.plantUsage && typeof legacy.plantUsage === 'object' ? legacy.plantUsage : {};
    const now = new Date().toISOString();
    const stmt = db.prepare(
      `INSERT INTO user_plant_usage (uid, plant_id, first_used_at, last_used_at, use_count, last_source)
       VALUES (?, ?, ?, ?, 1, 'legacy-json')
       ON CONFLICT(uid, plant_id) DO UPDATE SET
         last_used_at = excluded.last_used_at,
         use_count = user_plant_usage.use_count + 1`
    );
    Object.entries(usage).forEach(([uid, plantIds]) => {
      if (!uid || !Array.isArray(plantIds)) return;
      plantIds.forEach((pid) => {
        if (!pid) return;
        stmt.run(uid, pid, now, now);
      });
    });
    stmt.finalize();
  } catch (e) {
    // Ignore migration failures; app will still work.
  }

  return db;
}

const db = initDbAndMigrateFromJson();

function loadUserData() {
  try {
    const raw = fs.readFileSync(USER_DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      favourites: data.favourites && typeof data.favourites === 'object' ? data.favourites : {},
      follows: Array.isArray(data.follows) ? data.follows : [],
      plantUsage: data.plantUsage && typeof data.plantUsage === 'object' ? data.plantUsage : {},
      locations: data.locations && typeof data.locations === 'object' ? data.locations : {},
    };
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('Could not load user data:', e.message);
    return { favourites: {}, follows: [], plantUsage: {}, locations: {} };
  }
}

function saveUserData() {
  try {
    ensureDataDir();
    fs.writeFileSync(
      USER_DATA_FILE,
      JSON.stringify(
        {
          // favourites are now stored in SQLite (kept for backward compatibility / export)
          favourites: store.favourites,
          follows: store.follows || [],
          plantUsage: store.plantUsage || {},
          locations: store.locations || {},
        },
        null,
        2
      ),
      'utf8'
    );
  } catch (e) {
    console.warn('Could not save user data:', e.message);
  }
}

// In-memory store (favourites and follows persisted to data/user-data.json)
// For analytics, we also define ideal environmental ranges for each plant.
const PLANT_OPTIMAL_DEFAULT = {
  temp: { min: 18, max: 30 },          // °C
  humidity: { min: 40, max: 70 },      // %
  moisture: { min: 30, max: 60 },      // %
  lux: { min: 200, max: 1500 },        // lux
};
const PLANT_OPTIMAL_BY_ID = {
  pothos: PLANT_OPTIMAL_DEFAULT,
  'snake-plant': {
    temp: { min: 16, max: 29 },
    humidity: { min: 30, max: 60 },
    moisture: { min: 20, max: 50 },
    lux: { min: 150, max: 1200 },
  },
  'spider-plant': PLANT_OPTIMAL_DEFAULT,
  'peace-lily': {
    temp: { min: 18, max: 27 },
    humidity: { min: 50, max: 80 },
    moisture: { min: 40, max: 70 },
    lux: { min: 150, max: 800 },
  },
  monstera: PLANT_OPTIMAL_DEFAULT,
};
const store = {
  // User's connected / monitored plants (dashboard telemetry).
  plants: [
    { id: 'pothos', name: 'Pothos', species: 'Epipremnum aureum', zone: 'Zone A', indoor: true, image: 'pothos.jpg', moisture: 72, temp: 23.1, lux: 2100, status: 'Healthy', updatedAt: new Date().toISOString() },
    { id: 'snake-plant', name: 'Snake Plant', species: 'Dracaena trifasciata', zone: 'Zone B', indoor: true, image: 'snake plant.jpg', moisture: 38, temp: 24.5, lux: 1200, status: 'Moisture low', updatedAt: new Date().toISOString() },
    { id: 'spider-plant', name: 'Spider Plant', species: 'Chlorophytum comosum', zone: 'Zone C', indoor: true, image: 'spider plant.jpg', moisture: 65, temp: 21.8, lux: 1800, status: 'Healthy', updatedAt: new Date().toISOString() },
    { id: 'peace-lily', name: 'Peace Lily', species: 'Spathiphyllum', zone: 'Zone D', indoor: true, image: 'peace lily.jpg', moisture: 78, temp: 22.0, lux: 1500, status: 'Healthy', updatedAt: new Date().toISOString() },
    { id: 'monstera', name: 'Swiss Cheese Plant', species: 'Monstera deliciosa', zone: 'Window', indoor: true, image: 'swiss cheese plant.jpg', moisture: 58, temp: 25.2, lux: 2400, status: 'Healthy', updatedAt: new Date().toISOString() },
  ],
  // Full plant catalog available in the app (used for the new "Plants" section).
  plantCatalog: [
    {
      id: 'pothos',
      name: 'Golden Pothos',
      species: 'Epipremnum aureum',
      indoor: true,
      image: 'pothos.jpg',
      lightCategory: 'low',
      difficulty: 1,
      toxicity: 'Toxic to pets (cats/dogs) if ingested.',
      summary:
        'A fast-growing trailing vine that tolerates low light and bounces back quickly—ideal for beginners.',
      care: {
        light: 'Low to bright indirect light (best: bright indirect).',
        water: 'Water when top 2 in (5 cm) of soil is dry.',
        soil: 'Well-draining potting mix.',
        temp: '18–29°C (65–85°F), avoid <10°C (50°F).',
        humidity: 'Average home OK; prefers 50%+.',
        fertilizer: 'Feed monthly in spring and summer with a balanced liquid houseplant fertiliser at half strength; none in winter.',
      },
    },
    {
      id: 'snake-plant',
      name: 'Snake Plant',
      species: 'Dracaena trifasciata',
      indoor: true,
      image: 'snake plant.jpg',
      lightCategory: 'low',
      difficulty: 1,
      toxicity: 'Toxic to pets if ingested.',
      summary:
        'A tough, upright plant that thrives on neglect—great for low-light corners and busy schedules.',
      care: {
        light: 'Low to bright indirect light; tolerates low light.',
        water: 'Let soil dry out completely; water sparingly.',
        soil: 'Gritty, well-draining mix (cactus/succulent mix works).',
        temp: '18–30°C (65–86°F), avoid cold drafts.',
        humidity: 'Normal home humidity.',
        fertilizer: 'Light feeder—apply a balanced succulent fertiliser at half strength once a month in spring and summer only.',
      },
    },
    {
      id: 'spider-plant',
      name: 'Spider Plant',
      species: 'Chlorophytum comosum',
      indoor: true,
      image: 'spider plant.jpg',
      lightCategory: 'medium',
      difficulty: 1,
      toxicity: 'Generally considered non-toxic to pets.',
      summary:
        'A classic arching plant that’s easy to propagate—makes “baby” plantlets on long stems.',
      care: {
        light: 'Bright indirect light; avoid harsh midday sun.',
        water: 'Let top layer dry slightly, then water thoroughly.',
        soil: 'All-purpose potting mix with good drainage.',
        temp: '18–27°C (65–80°F).',
        humidity: 'Average; higher humidity reduces brown tips.',
        fertilizer: 'Use a balanced liquid fertiliser at half strength every 2–4 weeks in spring and summer; pause in winter.',
      },
    },
    {
      id: 'peace-lily',
      name: 'Peace Lily',
      species: 'Spathiphyllum spp.',
      indoor: true,
      image: 'peace lily.jpg',
      lightCategory: 'low',
      difficulty: 2,
      toxicity: 'Toxic to pets if ingested.',
      summary:
        'An elegant, shade-tolerant plant with white blooms; droops dramatically when thirsty.',
      care: {
        light: 'Medium to bright indirect light; avoid direct sun.',
        water: 'Keep lightly moist; water when surface starts to dry.',
        soil: 'Moisture-retentive but well-draining mix.',
        temp: '20–29°C (68–85°F), avoid <4°C (40°F).',
        humidity: 'Prefers high humidity (50–60%+).',
        fertilizer: 'Feed every 2–4 weeks in spring and summer with a balanced liquid fertiliser at half strength; reduce in winter.',
      },
    },
    {
      id: 'monstera',
      name: 'Swiss Cheese Plant',
      species: 'Monstera deliciosa',
      indoor: true,
      image: 'swiss cheese plant.jpg',
      lightCategory: 'bright',
      difficulty: 2,
      toxicity: 'Toxic to pets and humans if ingested.',
      summary:
        'Large “Swiss-cheese” leaves and tropical vibes—give it space and bright filtered light.',
      care: {
        light: 'Bright indirect light; avoid direct sun.',
        water: 'Water when top 2 in (5 cm) of soil is dry.',
        soil: 'Chunky, well-draining aroid mix (soil + bark + perlite).',
        temp: '18–29°C (65–85°F), avoid <10°C (50°F).',
        humidity: 'Prefers 60%+; grows fine in average homes.',
        fertilizer: 'Feed once a month in spring and summer with a balanced fertiliser at half strength; do not fertilise in winter.',
      },
    },
    {
      id: 'lucky-bamboo',
      name: 'Lucky Bamboo',
      species: 'Dracaena sanderiana',
      indoor: true,
      image: 'lucky bamboo.jpg',
      lightCategory: 'low',
      difficulty: 1,
      toxicity: 'Toxic to pets if ingested; may irritate skin.',
      summary:
        'A dracaena often grown in water. Keep it out of direct sun and refresh water regularly.',
      care: {
        light: 'Bright indirect light.',
        water: 'If grown in water: change weekly; if in soil: water when top inch is dry.',
        soil: 'If potted: well-draining indoor mix.',
        temp: '18–32°C (65–90°F), avoid cold drafts.',
        humidity: 'Average home humidity.',
        fertilizer: 'If grown in water, use a very weak liquid fertiliser only once every 1–2 months; if potted, feed lightly in spring and summer.',
      },
    },
    {
      id: 'dracaena-marginata',
      name: 'Dragon Tree',
      species: 'Dracaena marginata',
      indoor: true,
      image: 'dragon tree.jpg',
      lightCategory: 'medium',
      difficulty: 1,
      toxicity: 'Toxic to pets if ingested.',
      summary:
        'A sculptural cane plant with thin arching leaves—excellent for modern interiors and low maintenance.',
      care: {
        light: 'Medium to bright indirect light; tolerates lower light.',
        water: 'Let top half of soil dry before watering.',
        soil: 'Well-draining potting mix.',
        temp: '18–29°C (65–85°F).',
        humidity: 'Average home humidity.',
        fertilizer: 'Apply a balanced houseplant fertiliser at half strength every 4–6 weeks during the growing season.',
      },
    },
    {
      id: 'zz-plant',
      name: 'ZZ Plant',
      species: 'Zamioculcas zamiifolia',
      indoor: true,
      // IMPORTANT: file name is case-sensitive on Vercel/Linux
      image: 'ZZ Plant.jpg',
      lightCategory: 'low',
      difficulty: 1,
      toxicity: 'Toxic to pets and humans if ingested.',
      summary:
        'Extremely drought-tolerant with glossy leaves—one of the easiest low-light houseplants.',
      care: {
        light: 'Low to bright indirect light; avoid harsh direct sun.',
        water: 'Allow soil to dry completely; water sparingly.',
        soil: 'Fast-draining potting mix.',
        temp: '18–32°C (65–90°F).',
        humidity: 'Normal home humidity.',
        fertilizer: 'Light feeder—fertilise once a month in spring and summer with a diluted balanced fertiliser; skip winter.',
      },
    },
    {
      id: 'philodendron',
      name: 'Heartleaf Philodendron',
      species: 'Philodendron hederaceum',
      indoor: true,
      image: 'heartleaf philodendron.jpg',
      lightCategory: 'low',
      difficulty: 1,
      toxicity: 'Toxic to pets if ingested.',
      summary:
        'A forgiving trailing plant with heart-shaped leaves—great for shelves and hanging pots.',
      care: {
        light: 'Medium to bright indirect light; tolerates low light.',
        water: 'Water when top 2–3 cm is dry.',
        soil: 'Well-draining potting mix.',
        temp: '18–29°C (65–85°F).',
        humidity: 'Prefers moderate humidity but adapts well.',
        fertilizer: 'Feed every 4 weeks in spring and summer with a balanced fertiliser at half strength.',
      },
    },
    {
      id: 'fiddle-leaf-fig',
      name: 'Fiddle Leaf Fig',
      species: 'Ficus lyrata',
      indoor: true,
      image: 'fiddle leaf fig.jpg',
      lightCategory: 'bright',
      difficulty: 4,
      toxicity: 'Sap can irritate; toxic to pets if ingested.',
      summary:
        'A statement tree with big leaves. Likes consistency: bright light, stable temps, and careful watering.',
      care: {
        light: 'Bright indirect light; avoid hot direct sun.',
        water: 'Water when top 2 in (5 cm) is dry; don’t let it sit in water.',
        soil: 'Well-draining soil with perlite for aeration.',
        temp: '18–24°C (65–75°F), avoid sudden changes.',
        humidity: '40%+; higher is better.',
        fertilizer: 'Medium feeder—fertilise monthly in spring and summer with a balanced liquid fertiliser at half strength.',
      },
    },
    {
      id: 'jade-plant',
      name: 'Jade Plant',
      species: 'Crassula ovata',
      indoor: true,
      image: 'jade plant.jpg',
      lightCategory: 'bright',
      difficulty: 2,
      toxicity: 'Toxic to pets if ingested.',
      summary:
        'A classic succulent with thick leaves. Needs lots of light and very infrequent watering.',
      care: {
        light: 'Bright light with some direct sun (4+ hours).',
        water: 'Water only when soil is fully dry (soak & dry).',
        soil: 'Cactus/succulent mix, very well-draining.',
        temp: '18–27°C (65–80°F), protect from frost.',
        humidity: 'Low/average; avoid overly humid spots.',
        fertilizer: 'Use a cactus/succulent fertiliser at half strength 2–3 times during spring and summer; none in winter.',
      },
    },
    {
      id: 'aloe-vera',
      name: 'Aloe Vera',
      species: 'Aloe barbadensis Miller',
      indoor: true,
      image: 'aloe vera.jpg',
      lightCategory: 'bright',
      difficulty: 2,
      toxicity: 'Toxic to pets if ingested.',
      summary:
        'A sun-loving succulent with gel-filled leaves. Overwatering is the quickest way to harm it.',
      care: {
        light: 'Bright light; a few hours of direct sun is ideal.',
        water: 'Let soil dry completely; water deeply but infrequently.',
        soil: 'Cactus/succulent mix.',
        temp: '18–27°C (65–80°F), avoid <10°C (50°F).',
        humidity: 'Low/average.',
        fertilizer: 'Feed with a cactus fertiliser at half strength 2–3 times in spring and summer; do not fertilise in winter.',
      },
    },
    {
      id: 'boston-fern',
      name: 'Boston Fern',
      species: 'Nephrolepis exaltata',
      indoor: true,
      image: 'boston fern.jpg',
      lightCategory: 'medium',
      difficulty: 4,
      toxicity: 'Generally considered non-toxic to pets.',
      summary:
        'A lush fern that rewards humidity and steady moisture—perfect for bathrooms with bright light.',
      care: {
        light: 'Bright indirect light; avoid direct sun.',
        water: 'Keep evenly moist; don’t let it fully dry out.',
        soil: 'Moisture-retentive mix with good drainage.',
        temp: '18–24°C (65–75°F).',
        humidity: 'High (50–70%+).',
        fertilizer: 'Apply a diluted balanced fertiliser every 4 weeks during the growing season; avoid overfeeding.',
      },
    },
    {
      id: 'calathea',
      name: 'Prayer Plant (Calathea)',
      species: 'Calathea roseopicta',
      indoor: true,
      image: 'prayer plant.jpg',
      lightCategory: 'medium',
      difficulty: 5,
      toxicity: 'Generally considered non-toxic to pets.',
      summary:
        'A dramatic foliage plant that needs warm temps, soft water, and high humidity to look its best.',
      care: {
        light: 'Medium to bright indirect light; no direct sun.',
        water: 'Keep lightly moist; water when surface just starts to dry.',
        soil: 'Moist, well-draining mix (coir/peat + perlite).',
        temp: '18–24°C (65–75°F).',
        humidity: 'High (60%+).',
        fertilizer: 'Feed with a gentle, balanced fertiliser at quarter to half strength every 4 weeks in spring and summer.',
      },
    },
    {
      id: 'chinese-evergreen',
      name: 'Chinese Evergreen',
      species: 'Aglaonema commutatum',
      indoor: true,
      image: 'chinese evergreen.jpg',
      lightCategory: 'low',
      difficulty: 2,
      toxicity: 'Toxic to pets if ingested.',
      summary:
        'A slow-growing foliage plant valued for its patterned leaves and ability to tolerate low indoor light.',
      care: {
        light: 'Low to moderate indirect light; avoid direct sun.',
        water: 'Keep soil lightly moist and let the top 2–3 cm dry between waterings.',
        soil: 'Well-draining potting mix that holds some moisture (peat/coir with perlite).',
        temp: '20–27°C (68–80°F); avoid temperatures below 13°C (55°F).',
        humidity: 'Average indoor humidity; appreciates slightly higher humidity.',
        fertilizer: 'Feed every 4–6 weeks in spring and summer with a balanced fertiliser at half strength.',
      },
    },
    {
      id: 'house-sleek',
      name: 'House Sleek',
      species: 'Sempervivum tectorum',
      indoor: true,
      image: 'house sleek.jpg',
      lightCategory: 'bright',
      difficulty: 2,
      toxicity: 'Generally considered non-toxic.',
      summary:
        'A hardy rosette succulent (“hens and chicks”) that needs sun and very little water.',
      care: {
        light: 'Full sun / strong light (6+ hours direct if possible).',
        water: 'Deep but infrequent; let soil dry completely.',
        soil: 'Gritty, very well-draining succulent mix.',
        temp: 'Very hardy; indoors: 15–27°C (59–80°F).',
        humidity: 'Low/average.',
        fertilizer: 'Use a low-nitrogen succulent fertiliser once or twice during spring and summer only.',
      },
    },
    {
      id: 'echeveria-elegans',
      name: 'Mexican Snowball',
      species: 'Echeveria elegans',
      indoor: true,
      image: 'mexican snowball.jpg',
      lightCategory: 'bright',
      difficulty: 2,
      toxicity: 'Generally considered non-toxic.',
      summary:
        'A compact “Mexican snowball” succulent. Needs bright sun and strict dry-down between waterings.',
      care: {
        light: 'Bright light with direct sun (4–6 hours).',
        water: 'Soak & dry; water only when fully dry.',
        soil: 'Cactus/succulent mix with extra grit/perlite.',
        temp: '10–27°C (50–80°F), protect from frost indoors.',
        humidity: 'Low/average.',
        fertilizer: 'Fertilise very lightly 2–3 times per growing season with a diluted cactus fertiliser.',
      },
    },
    {
      id: 'wandering-jew',
      name: 'Wandering Jew',
      species: 'Tradescantia zebrina',
      indoor: true,
      image: 'wandering jew.jpg',
      lightCategory: 'medium',
      difficulty: 2,
      toxicity: 'Sap may irritate skin; generally treated as mildly toxic to pets.',
      summary:
        'A trailing plant with purple and silver striped leaves that colors up best in bright, indirect light.',
      care: {
        light: 'Bright, indirect light; avoid harsh afternoon sun.',
        water: 'Keep soil lightly moist, watering when the top 2–3 cm is dry.',
        soil: 'Well-draining potting mix that does not stay soggy.',
        temp: '16–27°C (60–80°F), protect from cold drafts.',
        humidity: 'Average to high indoor humidity; enjoys occasional misting.',
        fertilizer: 'Feed every 2–4 weeks in spring and summer with a diluted balanced fertiliser.',
      },
    },
    {
      id: 'polka-dot-plant',
      name: 'Polka Dot Plant',
      species: 'Hypoestes phyllostachya',
      indoor: true,
      image: 'polka dot plant.jpg',
      lightCategory: 'medium',
      difficulty: 3,
      toxicity: 'Generally considered non-toxic to pets and humans.',
      summary:
        'A compact foliage plant with colorful speckled leaves that stays bushy in bright, filtered light.',
      care: {
        light: 'Bright, filtered light; avoid strong direct midday sun.',
        water: 'Water when the top 2–3 cm of soil is dry; do not let it sit in water.',
        soil: 'Rich, well-draining potting mix.',
        temp: '18–27°C (65–80°F); avoid cold drafts.',
        humidity: 'Moderate to high humidity helps prevent leaf curl.',
        fertilizer: 'Use a balanced fertiliser at quarter to half strength every 2–4 weeks in the growing season.',
      },
    },
    {
      id: 'parlor-palm',
      name: 'Parlor Palm',
      species: 'Chamaedorea elegans',
      indoor: true,
      image: 'parlor palm.jpg',
      lightCategory: 'low',
      difficulty: 2,
      toxicity: 'Generally regarded as non-toxic to pets.',
      summary:
        'A classic slow-growing palm that tolerates low indoor light and brings a soft, tropical look to corners.',
      care: {
        light: 'Low to bright indirect light; avoid direct sun on fronds.',
        water: 'Water when the top 2–3 cm of soil feels dry; keep evenly moist but not soggy.',
        soil: 'Well-draining potting mix with some organic matter.',
        temp: '18–27°C (65–80°F), away from cold drafts and vents.',
        humidity: 'Average indoor humidity; appreciates occasional misting.',
        fertilizer: 'Light feeder—apply a palm fertiliser or balanced fertiliser at half strength every 6–8 weeks in spring and summer.',
      },
    },
    {
      id: 'cast-iron-plant',
      name: 'Cast Iron Plant',
      species: 'Aspidistra elatior',
      indoor: true,
      image: 'cast iron plant.jpg',
      lightCategory: 'low',
      difficulty: 1,
      toxicity: 'Non-toxic to pets and humans.',
      summary:
        'One of the toughest houseplants—tolerates low light, neglect, and dry air. Leathery dark green leaves.',
      care: {
        light: 'Low to bright indirect light; tolerates deep shade and artificial light.',
        water: 'Let top half of soil dry between waterings in spring/summer; reduce in winter.',
        soil: 'Rich, well-draining potting mix.',
        temp: '15–24°C (59–75°F).',
        humidity: 'Average home humidity.',
        fertilizer: 'Balanced liquid fertiliser at half strength once in spring and midsummer.',
      },
    },
    {
      id: 'birds-nest-fern',
      name: "Bird's Nest Fern",
      species: 'Asplenium nidus',
      indoor: true,
      image: 'birds nest fern.jpg',
      lightCategory: 'medium',
      difficulty: 3,
      toxicity: 'Non-toxic to pets.',
      summary:
        'Tropical fern with wavy, bright green fronds forming a nest-like rosette. Prefers humidity and filtered light.',
      care: {
        light: 'Bright indirect light or partial shade; east or north-facing window. Avoid direct sun.',
        water: 'Keep soil consistently moist; water when top inch is dry. Water around outer edge, not the centre.',
        soil: 'Rich, well-draining peat-based mix.',
        temp: '18–27°C (65–80°F); avoid below 10°C (50°F).',
        humidity: 'High (60–70%); use humidifier or pebble tray.',
        fertilizer: 'Dilute liquid fertiliser monthly at half strength in spring and summer.',
      },
    },
    {
      id: 'watermelon-peperomia',
      name: 'Watermelon Peperomia',
      species: 'Peperomia argyreia',
      indoor: true,
      image: 'watermelon peperomia.jpg',
      lightCategory: 'medium',
      difficulty: 2,
      toxicity: 'Non-toxic to pets.',
      summary:
        'Compact plant with rounded leaves striped like watermelon rind. Ideal for desks and small spaces.',
      care: {
        light: 'Bright indirect light; east or west window, a few feet from direct sun.',
        water: 'Water when top 2–3 in of soil is dry; every 7–10 days in summer, less in winter.',
        soil: 'Well-draining, peat-based mix; slightly acidic to neutral.',
        temp: '18–24°C (65–75°F); avoid drafts and heating vents.',
        humidity: 'Average to 40–50%; pebble tray or grouping helps.',
        fertilizer: 'Balanced liquid fertiliser at half strength every 2–4 weeks in spring and summer.',
      },
    },
    {
      id: 'burros-tail',
      name: "Burro's Tail",
      species: 'Sedum morganianum',
      indoor: true,
      image: 'burros tail.jpg',
      lightCategory: 'bright',
      difficulty: 3,
      toxicity: 'Generally considered non-toxic.',
      summary:
        'Trailing succulent with plump, blue-green leaves on long stems. Perfect for hanging baskets.',
      care: {
        light: 'Bright indirect light; some gentle direct sun from east/west. Avoid hot afternoon sun.',
        water: 'Let soil dry completely between waterings; water more in spring/summer, less in winter.',
        soil: 'Fast-draining cactus or succulent mix with extra perlite.',
        temp: '10–27°C (50–80°F); protect from frost.',
        humidity: 'Low to average; high humidity increases rot risk.',
        fertilizer: 'Diluted balanced or succulent fertiliser monthly in growing season only.',
      },
    },
    {
      id: 'string-of-pearls',
      name: 'String of Pearls',
      species: 'Curio rowleyanus',
      indoor: true,
      image: 'string of pearls.jpg',
      lightCategory: 'bright',
      difficulty: 3,
      toxicity: 'Toxic to pets and humans if ingested.',
      summary:
        'Trailing succulent with bead-like leaves on delicate stems. Loves bright light and infrequent watering.',
      care: {
        light: '6–8 hours bright light; 2–4 hours direct morning sun, indirect afternoon. East/south/west window.',
        water: 'Water every 7–14 days when top 1–2 in of soil is dry. Avoid overwatering.',
        soil: 'Well-draining cactus or succulent mix; ensure drainage holes.',
        temp: '15–27°C (60–80°F); cooler 13–16°C (55–60°F) in winter is fine.',
        humidity: 'Prefers under 40% humidity.',
        fertilizer: 'Half-strength balanced fertiliser every 2 weeks spring–fall; every 6 weeks in winter.',
      },
    },
  ],
  telemetry: [], // last N readings per plant
  deskbotConfig: {
    plantId: 'pothos',
    line: 'Pothos: Moisture at 72% · comfy 🌱',
    theme: 'mint',
    show: { moisture: true, temp: true, light: true },
    updatedAt: new Date().toISOString(),
  },
  /** Per-user favourite plant IDs (uid -> plantIds[]). Persisted to disk; maintained until user changes. */
  favourites: (() => { const d = loadUserData(); return d.favourites; })(),
  /** DEW Community: follow relationships. Persisted to disk. */
  follows: (() => { const d = loadUserData(); return d.follows; })(),
  /** Per-user plant usage: distinct plant IDs the user has used with the app (dashboard, deskbot, etc.). Used for profile "Plants" count. */
  plantUsage: (() => { const d = loadUserData(); return d.plantUsage; })(),
  /** Per-user location for weather: uid -> { city, state, country, latitude, longitude, last_updated }. Persisted to disk. */
  locations: (() => { const d = loadUserData(); return d.locations || {}; })(),
  activity: [
    { id: '1', icon: 'ri-drop-fill', title: 'Auto-irrigation triggered', desc: 'Snake Plant · Zone B', time: '2m ago' },
    { id: '2', icon: 'ri-wifi-line', title: 'Sensor Node A1 synced', desc: 'DEW-IOT-001 → Cloud', time: '8m ago' },
    { id: '3', icon: 'ri-temp-hot-line', title: 'Temperature spike detected', desc: 'Zone D · Spider Plant', time: '25m ago' },
    { id: '4', icon: 'ri-sun-foggy-line', title: 'Pothos entered ideal light', desc: 'Optimal 2.1k lux', time: '1h ago' },
    { id: '5', icon: 'ri-checkbox-circle-line', title: 'Full IoT sync complete', desc: '5 devices · all OK', time: '2h ago' },
  ],
  /** Sensor alerts from ESP32: { id, plantId, type, message, severity, at, read }. Max 200. */
  sensorAlerts: [],
};

// Per-plant unique facts + ratings (0–5). Kept separate for easy editing.
const PLANT_EXTRAS = {
  'pothos': {
    facts: [
      'Often called “devil’s ivy” because it stays green even in very poor light and is hard to kill.',
      'In the wild it can climb trees to more than 20 metres high, with leaves far larger than typical indoor plants.',
      'It is native to Mo’orea in French Polynesia but has naturalised across many tropical regions of the world.',
      'In several countries it is nicknamed “money plant” and is used as a good‑luck symbol in homes and offices.',
      'Mature pothos plants in the wild can produce true flowers, but indoor specimens almost never bloom.',
    ],
    benefits: [
      'Tolerates low to medium light, so it can green up apartments, dorms, and offices that don’t get full sun.',
      'Fast trailing growth quickly softens shelves, window ledges, and monitor arms, reducing visual harshness.',
      'Very forgiving of missed waterings, lowering the stress of plant care for beginners.',
      'Easy to propagate from cuttings, which encourages sharing plants instead of buying more—good for low‑waste gifting.',
      'In sealed test rooms, pothos has helped reduce some airborne VOCs, supporting cleaner-feeling indoor air.',
    ],
    ratings: { ease: 4.8, benefits: 4.2, cost: 4.6, popularity: 4.8 },
  },
  'snake-plant': {
    facts: [
      'Also known as “mother‑in‑law’s tongue” because of its long, sharp‑edged leaves.',
      'Uses CAM photosynthesis, taking in most of its carbon dioxide at night rather than during the day.',
      'Wild populations are native to West Africa, where the plant can form dense stands on rocky ground.',
      'Fibres from related Sansevieria species have historically been used to make cordage and bowstrings.',
      'Clumps slowly expand from underground rhizomes, allowing old plants to be divided into many new ones.',
    ],
    benefits: [
      'Extremely drought-tolerant, ideal for busy people who might forget to water regularly.',
      'Performs well in low light, so it can add greenery to bedrooms, hallways, and offices away from windows.',
      'Clean, upright leaves bring a strong architectural accent that fits modern interiors.',
      'Often promoted as a bedroom plant because it can release oxygen at night under CAM metabolism.',
      'Can be used to demonstrate hardy, low‑resource planting in sustainability or smart‑home projects.',
    ],
    ratings: { ease: 4.9, benefits: 4.0, cost: 4.7, popularity: 4.6 },
  },
  'spider-plant': {
    facts: [
      'Famous for its dangling “spiderettes”, plantlets that naturally form tiny root nubs while still attached.',
      'Variegated forms were popular Victorian houseplants long before modern houseplant trends.',
      'The species is native to coastal areas of South Africa but has become common worldwide indoors.',
      'Research in sealed test chambers found spider plants can help reduce certain airborne pollutants.',
      'In some cultures it is given as a house‑warming gift to symbolise new beginnings and growth.',
    ],
    benefits: [
      'Generally considered pet‑friendly, so it suits homes and classrooms with cats and dogs.',
      'Produces many plantlets, making it easy to share plants with friends or use in teaching propagation.',
      'Graceful arching leaves add movement and softness to shelves, countertops, and hanging baskets.',
      'Can help slightly raise humidity around it through transpiration, useful in dry heated rooms.',
      'In sealed test chambers, spider plants helped reduce certain airborne pollutants, supporting cleaner-feeling air.',
    ],
    ratings: { ease: 4.7, benefits: 4.1, cost: 4.6, popularity: 4.3 },
  },
  'peace-lily': {
    facts: [
      'Despite the name, peace lilies are not true lilies; they belong to the Araceae family.',
      'The white “flowers” are spathes, specialised leaves that surround a central flower spike called a spadix.',
      'Peace lilies were one of the plants featured in early NASA clean‑air studies on indoor pollutants.',
      'They originate from tropical rainforests of Central and South America, often growing on the forest floor.',
      'Because they visibly droop when thirsty, they are sometimes used to teach children about plant signals.',
    ],
    benefits: [
      'Produces elegant white blooms even in lower light, bringing a calmer, more refined look to dark corners.',
      'Broad leaves transpire moisture, which can make dry, heated rooms feel a little more comfortable.',
      'Clear drooping “thirst” signal helps new plant owners learn when to water and observe plant responses.',
      'Often used in offices, reception areas, and wellness spaces to soften hard surfaces and screens.',
      'Can be used in educational projects about shade plants and indoor humidity management.',
    ],
    ratings: { ease: 3.9, benefits: 4.3, cost: 4.0, popularity: 4.2 },
  },
  'monstera': {
    facts: [
      'The species name “deliciosa” refers to its large, edible fruit, which tastes like a mix of banana and pineapple.',
      'Characteristic leaf holes and splits are called fenestrations and become more dramatic as the plant matures.',
      'In the wild it is a hemi‑epiphyte, starting life on the ground and then climbing trees high into the canopy.',
      'Monstera motifs are widely used in tropical interior design and graphic design as a symbol of lush nature.',
      'Young plants usually have solid leaves; the famous Swiss‑cheese pattern appears only on older foliage.',
    ],
    benefits: [
      'Large, fenestrated leaves create a strong biophilic focal point that can make indoor spaces feel more natural.',
      'Supports vertical training on a pole, adding greenery without taking up much floor space—great for apartments.',
      'Responds visibly to good care and light, which keeps people engaged with long‑term plant monitoring.',
      'Pairs well with sensor data to show how light and moisture affect leaf size and fenestration.',
      'Helps visually divide open‑plan rooms without building hard partitions, keeping spaces open yet defined.',
    ],
    ratings: { ease: 3.8, benefits: 4.4, cost: 3.6, popularity: 4.9 },
  },
  'lucky-bamboo': {
    facts: [
      'Lucky bamboo is actually a species of Dracaena and is not a true bamboo at all.',
      'In feng shui, different numbers of stalks are said to attract luck in love, health, or prosperity.',
      'The plant is native to Central Africa, even though it is culturally associated with East Asia.',
      'Stems can be coaxed into spirals and braids by carefully controlling the direction of light over time.',
      'Small arrangements are often given as gifts for new businesses or homes to symbolise good fortune.',
    ],
    benefits: [
      'Can be grown in water, so there is no potting mix to spill on desks or worktops.',
      'Vertical, compact form fits easily on office desks, shelves, and countertops without blocking views.',
      'Tolerates lower light better than many sun‑loving plants, so it works in rooms with small windows.',
      'Simple, sculptural look adds a calming, minimalist accent in study and work areas.',
      'Commonly used in cultural and decorative displays, helping personalise indoor spaces.',
    ],
    ratings: { ease: 4.4, benefits: 3.8, cost: 4.4, popularity: 4.1 },
  },
  'dracaena-marginata': {
    facts: [
      'Commonly called the Madagascar dragon tree, even though it is now grown worldwide indoors.',
      'Its thin, arching leaves with coloured margins give a strong architectural look in modern interiors.',
      'In the wild it can eventually reach several metres tall, forming branching, tree‑like canes.',
      'Specimens are often sold with multiple canes of different heights to create a layered silhouette.',
      'Like many dracaenas, it stores water in its canes, allowing it to cope with periods of drought.',
    ],
    benefits: [
      'Slim, upright canes add vertical greenery without taking much floor space in corners or next to furniture.',
      'Slow growth and modest water needs make it a low‑maintenance choice for homes and offices.',
      'Dark, fine-textured foliage softens stark walls and glass surfaces.',
      'Works well in containers near seating areas, improving the perceived comfort of the space.',
      'Useful for teaching about cane‑forming shrubs and how pruning affects indoor tree shape.',
    ],
    ratings: { ease: 4.3, benefits: 3.9, cost: 4.0, popularity: 4.0 },
  },
  'zz-plant': {
    facts: [
      'Originally described by botanists in the 19th century but only became a popular houseplant in the 1990s.',
      'Its scientific name Zamioculcas zamiifolia reflects its similarity to cycads (Zamia) and a foliage form like some ferns.',
      'Large, potato‑like rhizomes beneath the soil act as water tanks, allowing survival through long dry seasons.',
      'The natural habitat is dry grassland and forest in eastern Africa, including Kenya and Tanzania.',
      'Because of its tolerance of low light and infrequent watering, it is widely used in shopping malls and airports.',
    ],
    benefits: [
      'Excellent low‑light performance, greening up offices, corridors, and shaded rooms where many plants fail.',
      'Water‑storing rhizomes mean very infrequent watering, ideal for low‑maintenance setups.',
      'Glossy, symmetrical foliage looks tidy with minimal pruning, keeping spaces professional.',
      'A strong example of drought‑tolerant indoor planting for sustainability‑focused projects.',
      'Works well in decorative planters to frame doorways or seating areas without demanding extra care.',
    ],
    ratings: { ease: 4.9, benefits: 3.9, cost: 4.2, popularity: 4.4 },
  },
  'philodendron': {
    facts: [
      'The name Philodendron comes from Greek words meaning “love” and “tree”, a nod to its climbing habit.',
      'Heartleaf philodendron is native to tropical regions of Central and South America.',
      'Many philodendron species were first collected by European botanists exploring rainforests in the 1800s.',
      'Some species can change leaf shape dramatically between juvenile and adult stages (juvenile heterophylly).',
      'Vining forms naturally climb trees in the wild using aerial roots to anchor themselves to bark.',
    ],
    benefits: [
      'Trailing vines soften shelves, desks, and monitor arms, making workspaces feel more natural.',
      'Very easy to propagate from cuttings so you can share plants instead of buying more—good for low‑waste projects.',
      'Tolerates a wide range of indoor conditions, helping you keep consistent greenery even in less‑than‑ideal rooms.',
      'Works well in hanging planters to pull the eye upward and balance screens and furniture.',
      'A forgiving plant for experiments with sensors and automation because it recovers from minor care mistakes.',
    ],
    ratings: { ease: 4.6, benefits: 4.1, cost: 4.5, popularity: 4.3 },
  },
  'fiddle-leaf-fig': {
    facts: [
      'Native to the lowland rainforests of western Africa, where it can grow over 12 metres tall.',
      'The huge, violin‑shaped leaves inspired its common name “fiddle‑leaf fig”.',
      'In nature it often starts life as an epiphyte in tree canopies before sending roots down to the ground.',
      'It became an interior‑design icon in the 2010s and is frequently featured in magazines and show homes.',
      'Despite its popularity, it rarely produces edible figs indoors, even on very old specimens.',
    ],
    benefits: [
      'A dramatic statement plant that can visually anchor a living room, lobby, or studio corner.',
      'Tree‑like form adds structure and height to interior layouts without needing built‑in planters.',
      'Responds clearly to over‑ or under‑watering, making it a good “feedback plant” for sensor dashboards.',
      'Large leaves intercept light and soften strong window lines, improving visual comfort.',
      'Encourages owners to develop consistent care habits, which can translate to better support for other plants.',
    ],
    ratings: { ease: 2.6, benefits: 4.6, cost: 3.0, popularity: 4.6 },
  },
  'jade-plant': {
    facts: [
      'Also known as the money tree or friendship tree in many cultures.',
      'Native to South Africa and Mozambique, where it can grow into a large, woody shrub.',
      'Thick, fleshy leaves can develop a red margin when exposed to strong sunlight.',
      'Old jade plants can be trained as miniature bonsai‑style trees with thick trunks.',
      'In some traditions it is given as a gift to wish prosperity and good luck in business.',
    ],
    benefits: [
      'Very water‑efficient succulent, excellent for low‑maintenance households and sunny offices.',
      'Compact, sculptural growth adds a bonsai‑like accent to windowsills and bright desks.',
      'Long‑lived plants can be passed between generations, supporting low‑waste, long‑term use.',
      'Good example of “soak and dry” watering that can be monitored with soil‑moisture sensors.',
      'Pairs well with other drought‑tolerant plants for low‑input indoor displays.',
    ],
    ratings: { ease: 4.1, benefits: 3.7, cost: 4.6, popularity: 4.0 },
  },
  'aloe-vera': {
    facts: [
      'Aloe vera has been used for thousands of years in traditional medicine and is mentioned in ancient Egyptian texts.',
      'The clear inner gel and the bitter yellow sap (latex) come from different parts of the leaf.',
      'It is thought to originate from the Arabian Peninsula but is now naturalised in many warm regions.',
      'Mature plants can produce tall flower spikes with tubular yellow or orange blooms.',
      'The species is widely studied for cosmetic and pharmaceutical uses, though effects vary with preparation.',
    ],
    benefits: [
      'Tolerates heat and dry air better than many tropical houseplants, ideal for sunny windowsills.',
      'Stores water in its leaves, demonstrating how succulents cope with drought conditions.',
      'Works well in bright, sunny windows where other leafy plants may scorch or dry out.',
      'A familiar plant for discussing traditional uses of aloe gel in educational settings.',
      'Helps teach precise “soak and dry” watering, which can be tracked with soil‑moisture data.',
    ],
    ratings: { ease: 4.0, benefits: 4.4, cost: 4.6, popularity: 4.2 },
  },
  'boston-fern': {
    facts: [
      'The popular Boston form of Nephrolepis exaltata is believed to have arisen from a chance mutation in the 1890s.',
      'It became extremely fashionable as a Victorian parlor plant and later in early 20th‑century homes.',
      'Each frond is made of dozens of small leaflets that unfurl from tight fiddleheads.',
      'In frost‑free climates it can be grown outdoors where it may form large, arching clumps.',
      'Because of its cascading habit, it is often used in hanging baskets on verandas and porches.',
    ],
    benefits: [
      'Adds lush, soft texture that contrasts nicely with hard modern materials like glass and metal.',
      'Acts as a “humidity indicator” because fronds crisp quickly when air or soil becomes too dry.',
      'Thrives in bright bathrooms and kitchens, taking advantage of naturally higher humidity.',
      'Helps visually cool hot, sunny rooms by introducing dense green foliage.',
      'Good choice for demonstrating the impact of humidity readings from indoor sensors.',
    ],
    ratings: { ease: 2.8, benefits: 4.2, cost: 3.8, popularity: 3.9 },
  },
  'calathea': {
    facts: [
      'Many calatheas are grown primarily for their striking, painterly leaf patterns.',
      'Leaves often fold upward at night and unfurl again in the morning, a movement called nyctinasty.',
      'They are native to the understory of tropical American rainforests.',
      'Some related species have leaves traditionally used for wrapping food in parts of South America.',
      'New leaves typically emerge tightly rolled, then slowly unscroll to reveal fresh patterns.',
    ],
    benefits: [
      'Striking patterned foliage provides high visual reward when humidity and water quality are well managed.',
      'Pet‑friendly reputation makes it popular in animal‑friendly homes and classrooms.',
      'Encourages careful humidity management, making it ideal for sensor‑driven care tracking projects.',
      'Moving “prayer” leaves draw attention and spark curiosity about plant behaviour.',
      'Teaches how small environmental changes—like drier air or harder water—show up as leaf curl or spotting.',
    ],
    ratings: { ease: 2.2, benefits: 4.4, cost: 3.4, popularity: 4.0 },
  },
  'chinese-evergreen': {
    facts: [
      'Chinese evergreens (Aglaonema) are native to the humid forests of Southeast Asia.',
      'They are prized for their patterned leaves, which can be silver, pink, red, or speckled green.',
      'In parts of Asia they are considered symbols of good fortune and long life.',
      'Cultivars have won multiple horticultural awards for their decorative foliage.',
      'Their tolerance of low indoor light has made them a staple of shopping centres and offices.',
    ],
    benefits: [
      'Handles office‑style low to medium light better than many tropical foliage plants.',
      'Slow, compact growth is ideal for desks, side tables, and reception counters.',
      'Dense foliage provides a calm green focal point that can help reduce visual stress.',
      'Good choice for lobbies and waiting rooms where consistent, dependable greenery is needed.',
      'Demonstrates how foliage color can stay rich even under moderate light conditions.',
    ],
    ratings: { ease: 4.1, benefits: 4.0, cost: 4.0, popularity: 4.0 },
  },
  'house-sleek': {
    facts: [
      'Commonly known as hens and chicks because baby rosettes cluster around the mother plant.',
      'Belongs to the Sempervivum group, whose Latin name means “always alive”.',
      'In traditional European folklore it was grown on roofs to ward off lightning and fire.',
      'Rosettes can change colour through the seasons, often taking on red or purple tones in strong sun.',
      'After flowering once, the main rosette typically dies back, leaving offsets to continue the colony.',
    ],
    benefits: [
      'Hardy succulent that thrives with minimal watering, illustrating efficient water use.',
      'Offsets quickly form clusters, allowing you to expand plantings without additional purchases.',
      'Great choice for very sunny windows where tropical foliage plants would scorch or dry out.',
      'Compact rosettes create neat, geometric patterns that suit modern design schemes.',
      'Can be used to demonstrate how strong light intensity produces compact, healthy growth in succulents.',
    ],
    ratings: { ease: 4.0, benefits: 3.6, cost: 4.5, popularity: 3.7 },
  },
  'echeveria-elegans': {
    facts: [
      'Often called the Mexican snowball for its tight, pale blue‑green rosettes.',
      'Native to rocky slopes in Mexico, where it forms carpets of many rosettes.',
      'Produces arching flower stalks with small pink and yellow bell‑shaped blooms.',
      'Leaves are covered with a thin, waxy coating that helps reduce water loss.',
      'Rosettes can detach and root where they land, slowly spreading over time.',
    ],
    benefits: [
      'Compact rosette fits small pots, making it perfect for desks, shelves, and bright windowsills.',
      'Very water‑efficient when grown correctly, contributing to low‑resource planting schemes.',
      'Excellent teaching plant for precise light placement and careful, infrequent watering.',
      'Adds sculptural, geometric interest to succulent groupings and indoor rock gardens.',
      'Shows clearly how insufficient light leads to stretching, helping learners connect environment to growth.',
    ],
    ratings: { ease: 3.9, benefits: 3.7, cost: 4.4, popularity: 3.9 },
  },
  'wandering-jew': {
    facts: [
      'Also known as inch plant or Tradescantia zebrina, recognised by its purple and silver striped leaves.',
      'The common name “wandering Jew” reflects how easily it spreads and roots wherever stems touch soil.',
      'Native to Mexico and Central America, where it often grows as groundcover in warm climates.',
      'Stems can trail for many feet, making it a dramatic hanging‑basket plant.',
      'Different cultivars show varying amounts of silver, green, and purple striping on their foliage.',
    ],
    benefits: [
      'Fast trailing growth quickly fills hanging baskets and shelf edges, adding movement to a room.',
      'Very easy to propagate from stem cuttings, ideal for sharing plants or classroom projects.',
      'Colorful purple and silver foliage provides strong visual contrast in all‑green collections.',
      'Encourages regular pruning, helping people learn how trimming shapes plant form.',
      'Good candidate for experimenting with light levels and tracking how foliage color responds.',
    ],
    ratings: { ease: 4.2, benefits: 4.1, cost: 4.5, popularity: 4.0 },
  },
  'polka-dot-plant': {
    facts: [
      'Named for its natural polka‑dot pattern, which can be pink, red, or white on green leaves.',
      'Hypoestes phyllostachya is native to Madagascar and nearby islands.',
      'Compact forms are popular for terrariums and small dish gardens.',
      'Plant breeders have created many colour variations, including confetti‑like mixes.',
      'Outdoors in tropical climates it can self‑seed and appear in unexpected spots in the garden.',
    ],
    benefits: [
      'Bright, speckled leaves add playful color to desks, shelves, and terrariums.',
      'Compact size fits small spaces where larger foliage plants would feel crowded.',
      'Great for learning pruning and shaping because regular pinching keeps it bushy.',
      'Useful in educational setups to show how light intensity affects leaf color and pattern.',
      'Pairs well with neutral interiors to introduce a controlled pop of color without flowers.',
    ],
    ratings: { ease: 3.4, benefits: 4.2, cost: 4.3, popularity: 3.8 },
  },
  'parlor-palm': {
    facts: [
      'Became famous as a Victorian parlour plant because it survived in dim sitting rooms.',
      'Native to the rainforests of southern Mexico and Guatemala.',
      'Mature plants can produce small yellow flower clusters and tiny black fruits indoors.',
      'Commercial specimens are usually grown as clumps of many seedlings planted together.',
      'Often recommended as a pet‑friendly palm since it is generally regarded as non‑toxic.',
    ],
    benefits: [
      'Soft, feathery fronds add height and texture without sharp edges, making it safe near walkways.',
      'Handles office‑style low light better than many palms, so it thrives away from bright windows.',
      'Generally regarded as non‑toxic, a popular choice for homes with pets and small children.',
      'Slow, steady growth means it stays manageable in containers for many years.',
      'Helps create a calm, lounge‑like atmosphere in living rooms, studios, and waiting areas.',
    ],
    ratings: { ease: 4.3, benefits: 4.1, cost: 4.0, popularity: 4.4 },
  },
  'cast-iron-plant': {
    facts: [
      'Earned its name from exceptional resilience—it tolerates neglect, low light, and dry air.',
      'Native to Japan and Taiwan; an evergreen that can live 25–30 years with minimal care.',
      'Can survive under pure artificial light, making it ideal for windowless offices and corridors.',
      'Victorian-era favourite; often featured in dim parlours and hallways.',
      'Leaves are stiff and leathery; wiping dust monthly helps them breathe and stay glossy.',
    ],
    benefits: [
      'One of the easiest low-light houseplants, greening up dark corners and busy offices.',
      'Non-toxic and pet-safe, suitable for households with cats and dogs.',
      'Improves air quality and adds lush foliage without demanding frequent watering.',
      'Compact size (about 1.5–2.5 ft) fits desks, side tables, and shaded shelves.',
      'Slow growth means less repotting and pruning—ideal for low-maintenance, long-term displays.',
    ],
    ratings: { ease: 4.9, benefits: 4.0, cost: 4.2, popularity: 4.0 },
  },
  'birds-nest-fern': {
    facts: [
      'Fronds emerge from a central "nest" of fuzzy brown fibres, which collect moisture and debris in the wild.',
      'Native to tropical Asia and Australasia, where it grows as an epiphyte on trees.',
      'Unlike many ferns, it does not produce spores on the undersides of fronds in the same way.',
      'The wavy, undulating leaf edges help shed water and reduce damage in humid forests.',
      'Watering around the outer edge of the pot (not the centre) helps prevent crown rot and mould.',
    ],
    benefits: [
      'Adds soft, tropical texture and works well in bathrooms or rooms with higher humidity.',
      'Non-toxic to pets, so it is safe for homes with cats and dogs.',
      'Bright green, arching fronds create a focal point without needing direct sun.',
      'Moderate size fits on plant stands, in corners, or next to a north- or east-facing window.',
      'Steady moisture needs make it a good plant to pair with humidity or soil-moisture sensors.',
    ],
    ratings: { ease: 3.6, benefits: 4.2, cost: 4.0, popularity: 4.1 },
  },
  'watermelon-peperomia': {
    facts: [
      'The silvery stripes on its rounded leaves resemble watermelon rind, giving it the common name.',
      'Peperomia argyreia is native to South America (Brazil and surrounding areas).',
      'Leaves are held on long, reddish petioles and grow in a compact, bushy habit.',
      'Part of the Piperaceae family, related to black pepper, though it is grown only for foliage.',
      'Direct sun can fade or scorch the patterned leaves; bright indirect light keeps colours vivid.',
    ],
    benefits: [
      'Compact size is ideal for desks, shelves, and small apartments.',
      'Distinctive foliage adds visual interest without needing a large pot or bright direct light.',
      'Non-toxic to pets, making it a safe choice for homes with animals.',
      'Moderate watering needs and tolerance for average humidity suit most indoor spaces.',
      'Ideal for terrariums and grouped plantings where its patterned leaves stand out.',
    ],
    ratings: { ease: 4.0, benefits: 4.1, cost: 4.3, popularity: 4.2 },
  },
  'burros-tail': {
    facts: [
      'Also called donkey\'s tail; the species name morganianum honours a botanist who described it.',
      'Native to southern Mexico and Honduras; leaves easily detach when brushed—handle gently.',
      'Stems can trail several feet long, making it ideal for hanging baskets and high shelves.',
      'Blue-green, plump leaves store water; overwatering is the main cause of failure.',
      'Pink or red-tinted flowers can appear at stem tips in spring with enough light.',
    ],
    benefits: [
      'Dramatic trailing form adds height and movement to windowsills and hanging planters.',
      'Very water-efficient once established; good for low-maintenance or forgetful waterers.',
      'Unique texture contrasts well with leafy tropicals and other succulents.',
      'Propagates easily from fallen leaves, so you can share or expand your collection.',
      'Suits dry, sunny spots where high humidity would risk rot—good for hot windowsills.',
    ],
    ratings: { ease: 3.5, benefits: 4.0, cost: 4.2, popularity: 4.3 },
  },
  'string-of-pearls': {
    facts: [
      'The spherical leaves are an adaptation to store water and reduce surface area in dry habitats.',
      'Formerly Senecio rowleyanus, now often classified as Curio rowleyanus; native to southwest Africa.',
      'In the wild it trails across dry ground; indoors it is usually grown in hanging baskets.',
      'Small white, cinnamon-scented flowers can appear in spring with enough light.',
      'Flattened or wrinkled pearls are a sign of thirst; plump pearls indicate good hydration.',
    ],
    benefits: [
      'Striking, unusual form makes it a conversation piece on shelves and in hanging pots.',
      'Succulent leaves mean infrequent watering once you learn the rhythm.',
      'Fast-growing trails can reach several feet, filling vertical space without much floor room.',
      'Keep out of reach of pets and small children due to toxicity if ingested.',
      'Clear visual feedback (plump vs wrinkled pearls) helps you tune watering and sensor thresholds.',
    ],
    ratings: { ease: 3.4, benefits: 4.0, cost: 4.0, popularity: 4.5 },
  },
};

function decorateCatalogPlant(p) {
  const extras = PLANT_EXTRAS[p?.id] || {};
  return {
    ...p,
    ...extras,
    facts: extras.facts || p.facts || [],
    benefits: extras.benefits || p.benefits || [],
    tips: extras.tips || p.tips || [],
    ratings: extras.ratings || p.ratings || { ease: 0, benefits: 0, cost: 0, popularity: 0 },
  };
}

let alertIdCounter = 1;
const MAX_ALERTS = 200;
const ALERT_RETENTION_LIMIT = 10;

function pruneWeatherAlerts(uid) {
  if (!uid) return;
  db.run(
    `DELETE FROM weather_alerts
     WHERE user_id = ?
       AND id NOT IN (
         SELECT id FROM weather_alerts
         WHERE user_id = ?
         ORDER BY datetime(created_at) DESC, id DESC
         LIMIT ?
       )`,
    [uid, uid, ALERT_RETENTION_LIMIT]
  );
}

function pruneSensorAlerts(uid) {
  if (uid) {
    db.run(
      `DELETE FROM sensor_alerts
       WHERE user_id = ?
         AND id NOT IN (
           SELECT id FROM sensor_alerts
           WHERE user_id = ?
           ORDER BY datetime(created_at) DESC, id DESC
           LIMIT ?
         )`,
      [uid, uid, ALERT_RETENTION_LIMIT]
    );
    return;
  }
  db.run(
    `DELETE FROM sensor_alerts
     WHERE user_id IS NULL
       AND id NOT IN (
         SELECT id FROM sensor_alerts
         WHERE user_id IS NULL
         ORDER BY datetime(created_at) DESC, id DESC
         LIMIT ?
       )`,
    [ALERT_RETENTION_LIMIT]
  );
}

function upsertUserPlantUsage(uid, plantIds, source = 'app-usage', done) {
  if (!uid || !Array.isArray(plantIds) || plantIds.length === 0) {
    if (typeof done === 'function') done(null);
    return;
  }
  const unique = [...new Set(plantIds.filter(Boolean))];
  if (!unique.length) {
    if (typeof done === 'function') done(null);
    return;
  }
  const now = new Date().toISOString();
  db.serialize(() => {
    const stmt = db.prepare(
      `INSERT INTO user_plant_usage (uid, plant_id, first_used_at, last_used_at, use_count, last_source)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(uid, plant_id) DO UPDATE SET
         last_used_at = excluded.last_used_at,
         use_count = user_plant_usage.use_count + 1,
         last_source = excluded.last_source`
    );
    unique.forEach((plantId) => stmt.run(uid, plantId, now, now, source));
    stmt.finalize((err) => {
      if (!err) {
        if (!store.plantUsage) store.plantUsage = {};
        const set = new Set(store.plantUsage[uid] || []);
        unique.forEach((id) => set.add(id));
        store.plantUsage[uid] = [...set];
      }
      if (typeof done === 'function') done(err || null);
    });
  });
}

function insertSensorAlert(alert, done) {
  const uid = alert.userId || null;
  db.run(
    `INSERT INTO sensor_alerts
      (user_id, plant_id, plant_name, alert_type, message, severity, created_at, is_read, status, snoozed_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uid,
      alert.plantId || 'unknown',
      alert.plantName || alert.plantId || 'Sensor',
      alert.type || 'sensor',
      alert.message || 'Sensor alert',
      alert.severity || 'warning',
      alert.at || new Date().toISOString(),
      alert.read ? 1 : 0,
      alert.resolved ? 'resolved' : 'active',
      alert.snoozedUntil || null,
    ],
    function (err) {
      if (err) {
        if (typeof done === 'function') done(err);
        return;
      }
      pruneSensorAlerts(uid);
      if (typeof done === 'function') done(null, String(this.lastID));
    }
  );
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API: Plants (latest readings) ---
app.get('/api/plants', (req, res) => {
  const plantsWithOptimal = (store.plants || []).map((p) => ({
    ...p,
    optimal: PLANT_OPTIMAL_BY_ID[p.id] || PLANT_OPTIMAL_DEFAULT,
  }));
  res.json(plantsWithOptimal);
});

// --- API: Plant catalog (all available plants in app) ---
app.get('/api/plants/catalog', (req, res) => {
  res.json((store.plantCatalog || []).map(decorateCatalogPlant));
});

app.get('/api/plants/catalog/:id', (req, res) => {
  const id = req.params.id;
  const plant = (store.plantCatalog || []).find((p) => p.id === id);
  if (!plant) return res.status(404).json({ error: 'Plant not found' });
  res.json(decorateCatalogPlant(plant));
});

// --- API: Telemetry (ESP32 Plant Bot POST) ---
app.post('/api/telemetry', (req, res) => {
  const { plantId, moisture, temp, lux, humidity, battery, uid } = req.body;
  if (!plantId) return res.status(400).json({ error: 'plantId required' });

  const plant = store.plants.find(p => p.id === plantId);
  if (!plant) return res.status(404).json({ error: 'Plant not found' });

  const reading = {
    plantId,
    moisture: moisture ?? plant.moisture,
    temp: temp ?? plant.temp,
    lux: lux ?? plant.lux,
    humidity: humidity ?? 52,
    battery,
    at: new Date().toISOString(),
  };

  store.telemetry.push(reading);
  if (store.telemetry.length > 500) store.telemetry = store.telemetry.slice(-400);

  plant.moisture = reading.moisture;
  plant.temp = reading.temp;
  plant.lux = reading.lux;
  plant.updatedAt = reading.at;
  plant.status = reading.moisture < 40 ? 'Moisture low' : reading.moisture < 50 ? 'Drying' : 'Healthy';
  if (uid) upsertUserPlantUsage(uid, [plantId], 'telemetry');

  if (reading.moisture < 40 && store.plants.find(p => p.id === plantId)) {
    const alert = {
      id: String(alertIdCounter++),
      userId: uid || null,
      plantId,
      plantName: plant.name,
      type: 'moisture',
      message: `Low moisture: ${reading.moisture}% — ${plant.name} needs water`,
      severity: reading.moisture < 25 ? 'error' : 'warning',
      at: reading.at,
      read: false,
      resolved: false,
      snoozedUntil: null,
    };
    insertSensorAlert(alert);
  }

  res.json({ ok: true, plant });
});

// --- API: History (for charts) ---
app.get('/api/history', (req, res) => {
  const metric = req.query.metric || 'moisture';
  const plantId = req.query.plantId;
  const raw = store.telemetry.filter(r => !plantId || r.plantId === plantId);
  const byPlant = {};
  raw.forEach(r => {
    if (!byPlant[r.plantId]) byPlant[r.plantId] = [];
    byPlant[r.plantId].push({ t: r.at, [metric]: r[metric] ?? r[metric === 'temperature' ? 'temp' : metric] });
  });
  res.json(byPlant);
});

// --- API: Plant telemetry for analytics (time-range filtered) ---
app.get('/api/plants/:plantId/telemetry', (req, res) => {
  const plantId = req.params.plantId;
  const allTime = req.query.hours === 'all';
  let raw = (store.telemetry || []).filter(r => r.plantId === plantId);
  if (!allTime) {
    const hours = Math.min(720, Math.max(1, parseInt(req.query.hours, 10) || 24));
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    raw = raw.filter(r => r.at >= since);
  }
  const readings = raw
    .slice(-200)
    .map(r => ({ at: r.at, moisture: r.moisture, temp: r.temp, lux: r.lux, humidity: r.humidity }));
  res.json(readings);
});

// --- API: Desk Bot config (GET = Desk Bot polls; POST = dashboard saves) ---
app.get('/api/deskbot-config', (req, res) => {
  res.json(store.deskbotConfig);
});

app.post('/api/deskbot-config', (req, res) => {
  const { plantId, line, theme, show } = req.body;
  if (plantId !== undefined) store.deskbotConfig.plantId = plantId;
  if (line !== undefined) store.deskbotConfig.line = line;
  if (theme !== undefined) store.deskbotConfig.theme = theme;
  if (show !== undefined) store.deskbotConfig.show = { ...store.deskbotConfig.show, ...show };
  store.deskbotConfig.updatedAt = new Date().toISOString();
  res.json(store.deskbotConfig);
});

// --- API: Activity (optional: append from backend) ---
app.get('/api/activity', (req, res) => {
  res.json(store.activity);
});

// --- API: Sensor alerts (ESP32 POST; web app GET) ---
function isAlertActive(a) {
  if (a.resolved) return false;
  if (a.snoozedUntil) {
    try { if (new Date(a.snoozedUntil) > new Date()) return false; } catch (_) {}
  }
  return true;
}
const ALERT_DISPLAY_LIMIT = 10;

app.get('/api/alerts', (req, res) => {
  const filter = req.query.filter || 'active';
  const unreadOnly = req.query.unread === 'true';
  const uid = typeof req.query.uid === 'string' && req.query.uid.trim() ? req.query.uid.trim() : null;
  const where = [];
  const params = [];
  if (uid) {
    where.push('(user_id = ?)');
    params.push(uid);
  } else {
    where.push('(user_id IS NULL)');
  }
  if (filter === 'active') {
    where.push("(status = 'active' OR status IS NULL)");
    where.push('(snoozed_until IS NULL OR datetime(snoozed_until) <= datetime(\'now\'))');
  } else if (filter === 'resolved') {
    where.push("(status = 'resolved')");
  } else if (filter === 'snoozed') {
    where.push('(snoozed_until IS NOT NULL AND datetime(snoozed_until) > datetime(\'now\'))');
  }
  if (unreadOnly) where.push('(is_read = 0)');
  const sql = `SELECT id, plant_id, plant_name, alert_type, message, severity, created_at, is_read, status, snoozed_until
               FROM sensor_alerts
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY datetime(created_at) DESC, id DESC
               LIMIT ?`;
  db.all(sql, [...params, ALERT_DISPLAY_LIMIT], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to load alerts' });
    const list = (rows || []).map((r) => ({
      id: String(r.id),
      plantId: r.plant_id,
      plantName: r.plant_name,
      type: r.alert_type,
      message: r.message,
      severity: r.severity || 'warning',
      at: r.created_at,
      read: !!r.is_read,
      resolved: (r.status || 'active') === 'resolved',
      snoozedUntil: r.snoozed_until || null,
    }));
    res.json(list);
  });
});

app.post('/api/alerts', (req, res) => {
  const { plantId, type, message, severity, uid } = req.body;
  const plant = store.plants.find(p => p.id === plantId);
  const plantName = plant ? plant.name : plantId || 'Sensor';
  const alert = {
    id: String(alertIdCounter++),
    userId: uid || null,
    plantId: plantId || 'unknown',
    plantName,
    type: type || 'sensor',
    message: message || 'Sensor alert',
    severity: severity || 'warning',
    at: new Date().toISOString(),
    read: false,
    resolved: false,
    snoozedUntil: null,
  };
  insertSensorAlert(alert, (err, id) => {
    if (err) return res.status(500).json({ error: 'Failed to create alert' });
    res.status(201).json({ ...alert, id: String(id || alert.id) });
  });
});

app.patch('/api/alerts/:id', (req, res) => {
  const id = req.params.id;
  const changes = [];
  const params = [];
  if (req.body.read !== undefined) {
    changes.push('is_read = ?');
    params.push(req.body.read ? 1 : 0);
  }
  if (req.body.resolved !== undefined) {
    changes.push('status = ?');
    params.push(req.body.resolved ? 'resolved' : 'active');
  }
  if (req.body.snoozedUntil !== undefined) {
    changes.push('snoozed_until = ?');
    params.push(req.body.snoozedUntil || null);
  }
  if (!changes.length) return res.status(400).json({ error: 'No updates provided' });
  params.push(id);
  db.run(`UPDATE sensor_alerts SET ${changes.join(', ')} WHERE id = ?`, params, function (err) {
    if (err) return res.status(500).json({ error: 'Failed to update alert' });
    if (this.changes === 0) return res.status(404).json({ error: 'Alert not found' });
    db.get(
      'SELECT id, plant_id, plant_name, alert_type, message, severity, created_at, is_read, status, snoozed_until FROM sensor_alerts WHERE id = ?',
      [id],
      (fetchErr, row) => {
        if (fetchErr || !row) return res.json({ ok: true });
        res.json({
          id: String(row.id),
          plantId: row.plant_id,
          plantName: row.plant_name,
          type: row.alert_type,
          message: row.message,
          severity: row.severity || 'warning',
          at: row.created_at,
          read: !!row.is_read,
          resolved: (row.status || 'active') === 'resolved',
          snoozedUntil: row.snoozed_until || null,
        });
      }
    );
  });
});

app.get('/api/alerts/count', (req, res) => {
  const uid = typeof req.query.uid === 'string' && req.query.uid.trim() ? req.query.uid.trim() : null;
  const whereUid = uid ? 'user_id = ?' : 'user_id IS NULL';
  const uidParams = uid ? [uid] : [];
  const totalSql = `SELECT COUNT(*) AS n FROM sensor_alerts WHERE ${whereUid}`;
  const activeSql = `SELECT COUNT(*) AS n FROM sensor_alerts WHERE ${whereUid} AND (status = 'active' OR status IS NULL) AND (snoozed_until IS NULL OR datetime(snoozed_until) <= datetime('now'))`;
  const unreadSql = `SELECT COUNT(*) AS n FROM sensor_alerts WHERE ${whereUid} AND (status = 'active' OR status IS NULL) AND (snoozed_until IS NULL OR datetime(snoozed_until) <= datetime('now')) AND is_read = 0`;
  db.get(totalSql, uidParams, (errTotal, totalRow) => {
    if (errTotal) return res.status(500).json({ total: 0, active: 0, unread: 0 });
    db.get(activeSql, uidParams, (errActive, activeRow) => {
      if (errActive) return res.status(500).json({ total: 0, active: 0, unread: 0 });
      db.get(unreadSql, uidParams, (errUnread, unreadRow) => {
        if (errUnread) return res.status(500).json({ total: 0, active: 0, unread: 0 });
        res.json({
          total: (totalRow && totalRow.n) || 0,
          active: (activeRow && activeRow.n) || 0,
          unread: (unreadRow && unreadRow.n) || 0,
        });
      });
    });
  });
});

// --- API: Weather-based alerts (per user, stored in SQLite) ---
const WEATHER_ALERT_RULES = [
  { type: 'weather_sunny', condition: (w) => /clear|sunny/i.test(String(w.condition)), message: '☀️ Good weather today. Great time to check your plants and ensure they are getting enough light.', weatherCondition: 'Clear' },
  { type: 'weather_rain', condition: (w) => /rain|drizzle/i.test(String(w.condition)), message: '🌧 Rain expected today. If you have outdoor plants, check drainage and protect sensitive plants.', weatherCondition: 'Rain' },
  { type: 'weather_cold', condition: (w) => /snow/i.test(String(w.condition)) || (w.temp != null && Number(w.temp) < 0), message: '❄ Very cold conditions detected. Indoor plants may need additional warmth and reduced watering.', weatherCondition: 'Cold / Snow' },
  { type: 'weather_cloudy', condition: (w) => /cloud|overcast|mist|fog|haze/i.test(String(w.condition)), message: '☁ Overcast conditions today. Indoor lighting may help plants that require more sunlight.', weatherCondition: 'Cloudy' },
  { type: 'weather_storm', condition: (w) => /thunderstorm|storm/i.test(String(w.condition)), message: '⛈ Storm conditions detected. Secure outdoor plants and avoid watering until the weather stabilizes.', weatherCondition: 'Thunderstorm' },
  { type: 'weather_high_temp', condition: (w) => w.temp != null && Number(w.temp) >= 30, message: '🔥 High temperature detected. Check soil moisture and water plants if necessary.', weatherCondition: 'High temperature' },
  { type: 'weather_high_humidity', condition: (w) => w.humidity != null && Number(w.humidity) >= 80, message: '💧 High humidity levels today. Ensure proper airflow around plants to avoid fungal issues.', weatherCondition: 'High humidity' },
];

function getWeatherAlertsToCreate(weather) {
  const condition = String(weather.condition || '').toLowerCase();
  const temp = weather.temp != null ? Number(weather.temp) : null;
  const humidity = weather.humidity != null ? Number(weather.humidity) : null;
  const w = { condition, temp, humidity };
  return WEATHER_ALERT_RULES.filter((r) => r.condition(w)).map((r) => ({
    alert_type: r.type,
    alert_message: r.message,
    weather_condition: r.weatherCondition,
  }));
}

const WEATHER_ALERT_DEDUPE_HOURS = 6;
const WEATHER_ALERT_MAX_PER_DAY = 5;

app.post('/api/users/:uid/weather-alerts', (req, res) => {
  const uid = req.params.uid;
  const { temp, condition, humidity, wind } = req.body;
  const weather = { temp, condition: condition || '', humidity, wind };
  const toCreate = getWeatherAlertsToCreate(weather);
  if (toCreate.length === 0) return res.json({ created: 0, alerts: [] });

  const now = new Date().toISOString();
  const created = [];

  db.serialize(() => {
    db.get(
      "SELECT COUNT(*) AS n FROM weather_alerts WHERE user_id = ? AND date(created_at) = date(?)",
      [uid, now],
      (err, row) => {
        if (err) return res.status(500).json({ error: 'Failed to check alert limit' });
        const todayCount = (row && row.n) || 0;
        const remaining = Math.max(0, WEATHER_ALERT_MAX_PER_DAY - todayCount);
        if (remaining === 0) {
          pruneWeatherAlerts(uid);
          return res.json({ created: 0, alerts: [] });
        }

        const runOne = (index) => {
          if (index >= toCreate.length) {
            pruneWeatherAlerts(uid);
            return res.json({ created: created.length, alerts: created });
          }
          const one = toCreate[index];
          db.get(
            "SELECT id FROM weather_alerts WHERE user_id = ? AND alert_type = ? AND created_at > datetime('now', ?) LIMIT 1",
            [uid, one.alert_type, `-${WEATHER_ALERT_DEDUPE_HOURS} hours`],
            (err2, existing) => {
              if (err2) return runOne(index + 1);
              if (existing) return runOne(index + 1);
              if (created.length >= remaining) {
                pruneWeatherAlerts(uid);
                return res.json({ created: created.length, alerts: created });
              }
              db.run(
                'INSERT INTO weather_alerts (user_id, alert_type, alert_message, weather_condition, created_at, is_read) VALUES (?, ?, ?, ?, ?, 0)',
                [uid, one.alert_type, one.alert_message, one.weather_condition, now],
                function (err3) {
                  if (!err3 && this.lastID) created.push({ id: this.lastID, ...one, created_at: now, is_read: 0 });
                  runOne(index + 1);
                }
              );
            }
          );
        };
        runOne(0);
      }
    );
  });
});

app.get('/api/users/:uid/alerts', (req, res) => {
  const uid = req.params.uid;
  const filter = req.query.filter || 'all';
  let sql = 'SELECT id, alert_type, alert_message, weather_condition, created_at, is_read, status FROM weather_alerts WHERE user_id = ?';
  const params = [uid];
  if (filter === 'unread') {
    sql += " AND is_read = 0 AND (status = 'active' OR status IS NULL)";
  } else if (filter === 'active') {
    sql += " AND is_read = 0 AND (status = 'active' OR status IS NULL)";
  } else if (filter === 'resolved') {
    sql += " AND (status = 'resolved' OR is_read = 1)";
  }
  sql += ' ORDER BY created_at DESC LIMIT ' + ALERT_DISPLAY_LIMIT;
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to load alerts' });
    res.json((rows || []).map((r) => ({
      id: String(r.id),
      source: 'weather',
      alert_type: r.alert_type,
      message: r.alert_message,
      weather_condition: r.weather_condition,
      at: r.created_at,
      created_at: r.created_at,
      read: !!r.is_read,
      status: r.status || 'active',
    })));
  });
});

app.get('/api/users/:uid/alerts/count', (req, res) => {
  const uid = req.params.uid;
  db.get(
    "SELECT COUNT(*) AS n FROM weather_alerts WHERE user_id = ? AND is_read = 0 AND (status = 'active' OR status IS NULL)",
    [uid],
    (err, row) => {
      if (err) return res.status(500).json({ unread: 0 });
      res.json({ unread: (row && row.n) || 0 });
    }
  );
});

function markWeatherAlertResolved(uid, id, res) {
  db.run(
    "UPDATE weather_alerts SET is_read = 1, status = 'resolved' WHERE id = ? AND user_id = ?",
    [id, uid],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to update' });
      if (this.changes === 0) return res.status(404).json({ error: 'Alert not found' });
      res.json({ ok: true });
    }
  );
}

app.patch('/api/users/:uid/alerts/:id/read', (req, res) => {
  markWeatherAlertResolved(req.params.uid, req.params.id, res);
});

app.patch('/api/users/:uid/alerts/:id/resolve', (req, res) => {
  markWeatherAlertResolved(req.params.uid, req.params.id, res);
});

// --- API: User favourite plants (public read so others can see; write by uid) ---
app.get('/api/users/:uid/favourites', (req, res) => {
  const uid = req.params.uid;
  db.all('SELECT plantId FROM favourites WHERE uid = ? ORDER BY createdAt DESC', [uid], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to load favourites' });
    res.json((rows || []).map((r) => r.plantId));
  });
});

app.put('/api/users/:uid/favourites', (req, res) => {
  const uid = req.params.uid;
  const plantIds = Array.isArray(req.body.plantIds) ? req.body.plantIds : [];
  // Write-through to sqlite (replace set).
  db.serialize(() => {
    db.run('DELETE FROM favourites WHERE uid = ?', [uid], (delErr) => {
      if (delErr) return res.status(500).json({ error: 'Failed to update favourites' });
      const stmt = db.prepare('INSERT OR IGNORE INTO favourites (uid, plantId, createdAt) VALUES (?, ?, ?)');
      const at = new Date().toISOString();
      plantIds.forEach((pid) => stmt.run(uid, pid, at));
      stmt.finalize((insErr) => {
        if (insErr) return res.status(500).json({ error: 'Failed to update favourites' });
        // Keep JSON mirror updated (optional)
        store.favourites[uid] = plantIds;
        upsertUserPlantUsage(uid, plantIds, 'favourites', (usageErr) => {
          if (usageErr) return res.status(500).json({ error: 'Failed to update usage from favourites' });
          saveUserData();
          res.json(store.favourites[uid]);
        });
      });
    });
  });
});

/** Merge plant IDs into user's usage list (distinct). */
function mergePlantUsage(uid, plantIds) {
  if (!uid || !Array.isArray(plantIds)) return;
  if (!store.plantUsage) store.plantUsage = {};
  const set = new Set(store.plantUsage[uid] || []);
  plantIds.forEach(id => set.add(id));
  store.plantUsage[uid] = [...set];
}

// --- API: Record plants used by user (dashboard view, deskbot focus, etc.) ---
app.post('/api/users/:uid/usage', (req, res) => {
  const uid = req.params.uid;
  const plantIds = Array.isArray(req.body.plantIds) ? req.body.plantIds : [];
  upsertUserPlantUsage(uid, plantIds, req.body.source || 'app-usage', (err) => {
    if (err) return res.status(500).json({ error: 'Failed to record plant usage' });
    saveUserData();
    db.get('SELECT COUNT(*) AS n FROM user_plant_usage WHERE uid = ?', [uid], (countErr, row) => {
      if (countErr) return res.status(500).json({ error: 'Failed to read plant usage count' });
      res.json({ ok: true, plantsCount: (row && row.n) || 0 });
    });
  });
});

// --- API: Plants used by user (derived from usage + catalog) ---
app.get('/api/users/:uid/used-plants', (req, res) => {
  const uid = req.params.uid;
  db.all(
    'SELECT plant_id, first_used_at, last_used_at, use_count, last_source FROM user_plant_usage WHERE uid = ? ORDER BY datetime(last_used_at) DESC',
    [uid],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to load used plants' });
      const byId = new Map((store.plantCatalog || []).map(p => [p.id, p]));
      const usedPlants = (rows || [])
        .map((r) => {
          const base = byId.get(r.plant_id);
          if (!base) return null;
          return {
            ...decorateCatalogPlant(base),
            usage: {
              first_used_at: r.first_used_at,
              last_used_at: r.last_used_at,
              use_count: r.use_count || 0,
              last_source: r.last_source || null,
            },
          };
        })
        .filter(Boolean);
      res.json(usedPlants);
    }
  );
});

// --- API: Full usage history metadata for a user (past + present sensor-linked usage) ---
app.get('/api/users/:uid/usage-history', (req, res) => {
  const uid = req.params.uid;
  db.all(
    'SELECT plant_id, first_used_at, last_used_at, use_count, last_source FROM user_plant_usage WHERE uid = ? ORDER BY datetime(last_used_at) DESC',
    [uid],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to load usage history' });
      res.json((rows || []).map((r) => ({
        plantId: r.plant_id,
        firstUsedAt: r.first_used_at,
        lastUsedAt: r.last_used_at,
        useCount: r.use_count || 0,
        lastSource: r.last_source || null,
      })));
    }
  );
});

// --- API: User profile stats (plants = distinct plants used with app; followers/following) ---
app.get('/api/users/:uid/stats', (req, res) => {
  const uid = req.params.uid;
  db.get('SELECT COUNT(*) AS n FROM user_plant_usage WHERE uid = ?', [uid], (err, row) => {
    if (err) return res.status(500).json({ error: 'Failed to load user stats' });
    const followersCount = (store.follows || []).filter(f => f.toUid === uid).length;
    const followingCount = (store.follows || []).filter(f => f.fromUid === uid).length;
    res.json({
      plantsCount: (row && row.n) || 0,
      followersCount,
      followingCount,
    });
  });
});

app.post('/api/users/:toUid/follow', (req, res) => {
  const toUid = req.params.toUid;
  const fromUid = req.body.followerUid;
  if (!fromUid || !toUid || fromUid === toUid) return res.status(400).json({ error: 'Invalid follow' });
  if (!store.follows) store.follows = [];
  const exists = store.follows.some(f => f.fromUid === fromUid && f.toUid === toUid);
  if (!exists) {
    store.follows.push({ fromUid, toUid });
  }
  saveUserData();
  const followersCount = store.follows.filter(f => f.toUid === toUid).length;
  res.json({ ok: true, followersCount });
});

app.delete('/api/users/:toUid/follow', (req, res) => {
  const toUid = req.params.toUid;
  const fromUid = req.query.followerUid;
  if (!fromUid || !toUid) return res.status(400).json({ error: 'Invalid unfollow' });
  if (store.follows) store.follows = store.follows.filter(f => !(f.fromUid === fromUid && f.toUid === toUid));
  saveUserData();
  const followersCount = (store.follows || []).filter(f => f.toUid === toUid).length;
  res.json({ ok: true, followersCount });
});

// --- API: User location (for weather on dashboard) ---
app.get('/api/users/:uid/location', (req, res) => {
  const uid = req.params.uid;
  const loc = (store.locations || {})[uid];
  if (!loc) return res.json(null);
  res.json({
    city: loc.city,
    state: loc.state,
    country: loc.country,
    latitude: loc.latitude,
    longitude: loc.longitude,
    last_updated: loc.last_updated,
  });
});

app.put('/api/users/:uid/location', (req, res) => {
  const uid = req.params.uid;
  const { city, state, country, latitude, longitude } = req.body;
  if (latitude == null || longitude == null || !Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) {
    return res.status(400).json({ error: 'latitude and longitude required' });
  }
  if (!store.locations) store.locations = {};
  store.locations[uid] = {
    city: city || '',
    state: state || '',
    country: country || '',
    latitude: Number(latitude),
    longitude: Number(longitude),
    last_updated: new Date().toISOString(),
  };
  saveUserData();
  res.json(store.locations[uid]);
});

// --- API: Firebase config (from .env for auth and Firebase processes) ---
app.get('/api/config/firebase', (req, res) => {
  const config = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID,
  };
  const missing = Object.entries(config).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    return res.status(503).json({
      error: 'Firebase config incomplete',
      message: 'Set ' + missing.join(', ') + ' in .env (see .env.example).',
    });
  }
  res.json(config);
});

// --- API: Supabase config (for profile photo storage; anon key is safe for client) ---
app.get('/api/config/supabase', (req, res) => {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return res.status(503).json({
      error: 'Supabase config incomplete',
      message: 'Set SUPABASE_URL and SUPABASE_ANON_KEY in .env (see .env.example).',
    });
  }
  res.json({ url, anonKey });
});

// Weather API key for dashboard (optional – OpenWeather). If not set, client uses Open-Meteo.
app.get('/api/config/weather', (req, res) => {
  const key = (process.env.OPENWEATHER_API_KEY || '').trim();
  res.json({ openWeatherApiKey: key });
});

// Debug: verify Firebase config is loaded (does not expose full key)
app.get('/api/config/firebase/check', (req, res) => {
  const key = process.env.FIREBASE_API_KEY || '';
  const ok = key.length >= 20 && key.startsWith('AIza');
  res.json({
    ok,
    keyLoaded: !!key,
    keyHint: key ? `${key.slice(0, 4)}...${key.slice(-4)}` : 'not set',
    projectId: process.env.FIREBASE_PROJECT_ID || 'not set',
  });
});

// --- API: Create community (with banner/logo upload via service role so images persist) ---
app.post('/api/communities', upload.fields([{ name: 'banner', maxCount: 1 }, { name: 'logo', maxCount: 1 }]), async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Community create with images not configured',
      message: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env so banner/logo can be stored.',
    });
  }
  const name = (req.body.name || '').trim();
  const slug = (req.body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || (name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const description = (req.body.description || '').trim() || null;
  const category = (req.body.category || 'Other').trim();
  const status = (req.body.status || 'public').trim();
  const isMature = req.body.is_mature === 'true' || req.body.is_mature === true;
  let creatorFirebaseUid = (req.body.creator_firebase_uid || '').trim() || null;
  if (req.body.firebase_id_token && firebaseAdmin) {
    try {
      const decoded = await firebaseAdmin.auth().verifyIdToken(req.body.firebase_id_token);
      creatorFirebaseUid = decoded.uid;
    } catch (_) {}
  }
  if (!name || !slug) return res.status(400).json({ error: 'Name and slug required' });
  const ext = (name) => (name && path.extname(name).slice(1)) || 'jpg';
  let bannerUrl = null;
  let logoUrl = null;
  const bannerFile = req.files && req.files.banner && req.files.banner[0];
  const logoFile = req.files && req.files.logo && req.files.logo[0];
  if (bannerFile) {
    const fileExt = (ext(bannerFile.originalname) || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, 'jpg');
    const storagePath = `${slug}/banner-${Date.now()}.${fileExt}`;
    const { error: upErr } = await supabaseAdmin.storage
      .from('community-assets')
      .upload(storagePath, bannerFile.buffer, { contentType: bannerFile.mimetype || 'image/jpeg', upsert: true, cacheControl: '0' });
    if (upErr) {
      return res.status(500).json({ error: `Banner upload failed: ${upErr.message || 'unknown error'}` });
    }
    const { data: urlData } = supabaseAdmin.storage.from('community-assets').getPublicUrl(storagePath);
    bannerUrl = urlData?.publicUrl || null;
  }
  if (logoFile) {
    const fileExt = (ext(logoFile.originalname) || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, 'jpg');
    const storagePath = `${slug}/logo-${Date.now()}.${fileExt}`;
    const { error: upErr } = await supabaseAdmin.storage
      .from('community-assets')
      .upload(storagePath, logoFile.buffer, { contentType: logoFile.mimetype || 'image/jpeg', upsert: true, cacheControl: '0' });
    if (upErr) {
      return res.status(500).json({ error: `Logo upload failed: ${upErr.message || 'unknown error'}` });
    }
    const { data: urlData } = supabaseAdmin.storage.from('community-assets').getPublicUrl(storagePath);
    logoUrl = urlData?.publicUrl || null;
  }
  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from('communities')
    .insert({
      name,
      slug,
      description,
      category,
      status: status || 'public',
      is_mature: !!isMature,
      created_by: null,
      banner_url: bannerUrl,
      logo_url: logoUrl,
      creator_firebase_uid: creatorFirebaseUid,
    })
    .select('id')
    .single();
  if (insertErr) {
    if (insertErr.code === '23505') return res.status(409).json({ error: 'A community with this slug already exists.', code: 'duplicate_slug' });
    return res.status(500).json({ error: insertErr.message });
  }
  res.status(201).json({ id: inserted?.id, slug });
});

// --- API: Update community (banner, logo, description) – admin/creator only ---
app.patch('/api/communities/:slug', upload.fields([{ name: 'banner', maxCount: 1 }, { name: 'logo', maxCount: 1 }]), async (req, res) => {
  const slug = (req.params.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!slug) return res.status(400).json({ error: 'Invalid slug' });
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Missing Authorization: Bearer <Firebase ID token>' });
  if (!firebaseAdmin || !supabaseAdmin) {
    return res.status(503).json({
      error: 'Community edit not configured',
      message: 'Set FIREBASE_SERVICE_ACCOUNT_JSON (or GOOGLE_APPLICATION_CREDENTIALS), SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY in .env',
    });
  }
  let uid;
  try {
    const decoded = await firebaseAdmin.auth().verifyIdToken(token);
    uid = decoded.uid;
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  const { data: community, error: fetchErr } = await supabaseAdmin
    .from('communities')
    .select('id, creator_firebase_uid, banner_url, logo_url')
    .eq('slug', slug)
    .single();
  if (fetchErr || !community) return res.status(404).json({ error: 'Community not found' });
  const communityCreatorUid = typeof community.creator_firebase_uid === 'string' ? community.creator_firebase_uid.trim() : '';
  // Backward compatibility: legacy communities may have null creator_firebase_uid.
  // In that case, allow this authenticated user to claim creator ownership.
  if (communityCreatorUid && communityCreatorUid !== uid) {
    return res.status(403).json({ error: 'Only the community creator can update banner, logo, and description' });
  }
  const updates = {};
  if (!communityCreatorUid) updates.creator_firebase_uid = uid;
  if (typeof req.body.description === 'string') updates.description = req.body.description.trim() || null;
  const bannerFile = req.files && req.files.banner && req.files.banner[0];
  const logoFile = req.files && req.files.logo && req.files.logo[0];
  const ext = (name) => (name && path.extname(name).slice(1)) || 'jpg';
  if (bannerFile) {
    const fileExt = ext(bannerFile.originalname).toLowerCase().replace(/[^a-z0-9]/g, 'jpg') || 'jpg';
    const storagePath = `${slug}/banner-${Date.now()}.${fileExt}`;
    const { error: upErr } = await supabaseAdmin.storage
      .from('community-assets')
      .upload(storagePath, bannerFile.buffer, { contentType: bannerFile.mimetype || 'image/jpeg', upsert: true, cacheControl: '0' });
    if (upErr) return res.status(500).json({ error: `Banner upload failed: ${upErr.message || 'unknown error'}` });
    const { data: urlData } = supabaseAdmin.storage.from('community-assets').getPublicUrl(storagePath);
    updates.banner_url = urlData?.publicUrl || null;
  }
  if (logoFile) {
    const fileExt = ext(logoFile.originalname).toLowerCase().replace(/[^a-z0-9]/g, 'jpg') || 'jpg';
    const storagePath = `${slug}/logo-${Date.now()}.${fileExt}`;
    const { error: upErr } = await supabaseAdmin.storage
      .from('community-assets')
      .upload(storagePath, logoFile.buffer, { contentType: logoFile.mimetype || 'image/jpeg', upsert: true, cacheControl: '0' });
    if (upErr) return res.status(500).json({ error: `Logo upload failed: ${upErr.message || 'unknown error'}` });
    const { data: urlData } = supabaseAdmin.storage.from('community-assets').getPublicUrl(storagePath);
    updates.logo_url = urlData?.publicUrl || null;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updates provided' });
  updates.updated_at = new Date().toISOString();
  const { error: updateErr } = await supabaseAdmin.from('communities').update(updates).eq('id', community.id);
  if (updateErr) return res.status(500).json({ error: updateErr.message });
  res.json({ ok: true, slug, updates: Object.keys(updates) });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), ts: new Date().toISOString() });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`DEW Eco Warden server running at http://0.0.0.0:${PORT}`);
});
