require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');

// Optional: map plant-bot device_id -> { plantId, uid }.
// Example:
//   DEW_PLANTBOT_DEVICE_MAP_JSON='{"plant_bot_01":{"plantId":"pothos","uid":"<firebase_uid>"}}'
let PLANTBOT_DEVICE_MAP = {};
try {
  if (process.env.DEW_PLANTBOT_DEVICE_MAP_JSON) {
    PLANTBOT_DEVICE_MAP = JSON.parse(process.env.DEW_PLANTBOT_DEVICE_MAP_JSON);
  }
} catch (e) {
  console.warn('Invalid DEW_PLANTBOT_DEVICE_MAP_JSON; continuing with empty map.');
}

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
const uploadLarge = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

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

    // Per-user weather location (Firebase uid); survives deploys unlike JSON file on ephemeral disks.
    db.run(
      `CREATE TABLE IF NOT EXISTS user_weather_location (
        uid TEXT NOT NULL PRIMARY KEY,
        city TEXT,
        state TEXT,
        country TEXT,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        updated_at TEXT NOT NULL
      )`
    );

    // Auto-created per Firebase user for Plant Bot: hash of secret token (plaintext shown once in dashboard).
    db.run(
      `CREATE TABLE IF NOT EXISTS user_ingest_token (
        uid TEXT NOT NULL PRIMARY KEY,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    );

    // Plant Bot "what plant should this device report to?" user preference
    // (set from the web app dropdown before the bot uploads telemetry).
    db.run(
      `CREATE TABLE IF NOT EXISTS plantbot_user_choice (
        uid TEXT NOT NULL PRIMARY KEY,
        plant_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    );

    // ============================================================
    // IoT: Plant Board / Tearboard (multi-device, controlled access)
    // ============================================================
    db.run(
      `CREATE TABLE IF NOT EXISTS iot_devices (
        device_id TEXT NOT NULL PRIMARY KEY,
        device_name TEXT,
        owner_uid TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS iot_device_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        FOREIGN KEY (device_id) REFERENCES iot_devices(device_id)
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_iot_device_tokens_hash ON iot_device_tokens(token_hash)');

    db.run(
      `CREATE TABLE IF NOT EXISTS iot_sensor_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        soil_moisture REAL,
        light_intensity REAL,
        temperature REAL,
        humidity REAL,
        battery REAL,
        battery_pct REAL,
        device_status TEXT,
        FOREIGN KEY (device_id) REFERENCES iot_devices(device_id)
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_iot_sensor_device_ts ON iot_sensor_readings(device_id, timestamp DESC)');

    db.run(
      `CREATE TABLE IF NOT EXISTS iot_device_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        storage_path TEXT,
        public_url TEXT,
        FOREIGN KEY (device_id) REFERENCES iot_devices(device_id)
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_iot_images_device_ts ON iot_device_images(device_id, timestamp DESC)');

    db.run(
      `CREATE TABLE IF NOT EXISTS tearboards (
        tearboard_id TEXT NOT NULL PRIMARY KEY,
        name TEXT,
        owner_uid TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS tearboard_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tearboard_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        FOREIGN KEY (tearboard_id) REFERENCES tearboards(tearboard_id)
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_tearboard_tokens_hash ON tearboard_tokens(token_hash)');

    db.run(
      `CREATE TABLE IF NOT EXISTS tearboard_device_map (
        tearboard_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tearboard_id, device_id),
        FOREIGN KEY (tearboard_id) REFERENCES tearboards(tearboard_id),
        FOREIGN KEY (device_id) REFERENCES iot_devices(device_id)
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_tb_map_device ON tearboard_device_map(device_id)');

    // ----------------------------------------------------------------
    // Compatibility layer (PlantBoardDatabase naming from spec)
    // These are READ-ONLY views over the canonical iot_* tables so the
    // database shape matches the requested table names without duplicating
    // data. Writes should go through the canonical tables/endpoints.
    // ----------------------------------------------------------------
    db.run(
      `CREATE VIEW IF NOT EXISTS plant_boards AS
       SELECT
         device_id AS id,
         COALESCE(device_name, device_id) AS device_name,
         created_at
       FROM iot_devices`
    );

    db.run(
      `CREATE VIEW IF NOT EXISTS sensor_data AS
       SELECT
         id,
         device_id,
         soil_moisture,
         light_intensity AS light_level,
         temperature,
         humidity,
         timestamp
       FROM iot_sensor_readings`
    );

    db.run(
      `CREATE VIEW IF NOT EXISTS images AS
       SELECT
         id,
         device_id,
         COALESCE(public_url, storage_path) AS image_url,
         timestamp
       FROM iot_device_images`
    );

    db.run(
      `CREATE VIEW IF NOT EXISTS tearboard_mapping AS
       SELECT
         (tearboard_id || ':' || device_id) AS id,
         tearboard_id,
         device_id AS plant_board_id
       FROM tearboard_device_map`
    );

    // --- Community: user directory + membership + moderators + meta (symbol) ---
    db.run(
      `CREATE TABLE IF NOT EXISTS users (
        uid TEXT PRIMARY KEY,
        display_name TEXT,
        email TEXT,
        updated_at TEXT NOT NULL
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_users_display_name ON users(display_name)');

    db.run(
      `CREATE TABLE IF NOT EXISTS community_members (
        community_slug TEXT NOT NULL,
        uid TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (community_slug, uid)
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_community_members_slug ON community_members(community_slug)');

    db.run(
      `CREATE TABLE IF NOT EXISTS community_moderators (
        community_slug TEXT NOT NULL,
        uid TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'moderator',
        added_at TEXT NOT NULL,
        PRIMARY KEY (community_slug, uid)
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_community_mods_slug ON community_moderators(community_slug)');

    db.run(
      `CREATE TABLE IF NOT EXISTS community_meta (
        community_slug TEXT PRIMARY KEY,
        logo_symbol TEXT,
        updated_at TEXT NOT NULL
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS community_notification_prefs (
        community_slug TEXT NOT NULL,
        uid TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'all',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (community_slug, uid)
      )`
    );

    // Weekly community stats (distinct users per week)
    db.run(
      `CREATE TABLE IF NOT EXISTS community_weekly_visitors (
        community_slug TEXT NOT NULL,
        week_start TEXT NOT NULL,
        uid TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        PRIMARY KEY (community_slug, week_start, uid)
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_weekly_visitors_slug_week ON community_weekly_visitors(community_slug, week_start)');

    db.run(
      `CREATE TABLE IF NOT EXISTS community_weekly_contributors (
        community_slug TEXT NOT NULL,
        week_start TEXT NOT NULL,
        uid TEXT NOT NULL,
        first_contributed_at TEXT NOT NULL,
        PRIMARY KEY (community_slug, week_start, uid)
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_weekly_contrib_slug_week ON community_weekly_contributors(community_slug, week_start)');

    db.run(
      `CREATE TABLE IF NOT EXISTS community_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        community_slug TEXT NOT NULL,
        from_uid TEXT NOT NULL,
        to_kind TEXT NOT NULL, -- 'admin' | 'mods' | 'user'
        to_uid TEXT,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_community_messages_slug ON community_messages(community_slug, created_at DESC)');

    // Community post engagement metrics (shares tracked here; score/comments mirrored from Supabase)
    db.run(
      `CREATE TABLE IF NOT EXISTS community_post_metrics (
        post_id TEXT PRIMARY KEY,
        community_slug TEXT NOT NULL,
        share_count INTEGER NOT NULL DEFAULT 0,
        last_seen_score INTEGER NOT NULL DEFAULT 0,
        last_seen_comments INTEGER NOT NULL DEFAULT 0,
        last_shared_at TEXT,
        updated_at TEXT NOT NULL
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_post_metrics_slug ON community_post_metrics(community_slug)');

    // ============================================================
    // Reddit-like post interactions stored in SQLite:
    // - post_comments (supports replies via parent_comment_id)
    // - post_votes (single up/down per user; toggle off supported)
    // - comment_votes (same rules as post votes)
    // ============================================================
    db.run(
      `CREATE TABLE IF NOT EXISTS post_votes (
        post_id TEXT NOT NULL,
        uid TEXT NOT NULL,
        value INTEGER NOT NULL CHECK (value IN (1, -1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (post_id, uid)
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_post_votes_post_id ON post_votes(post_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_post_votes_uid ON post_votes(uid)');

    db.run(
      `CREATE TABLE IF NOT EXISTS post_comments (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        community_slug TEXT NOT NULL,
        uid TEXT NOT NULL,
        parent_comment_id TEXT,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_post_comments_post_id_created ON post_comments(post_id, created_at DESC)');
    db.run('CREATE INDEX IF NOT EXISTS idx_post_comments_parent_comment_id ON post_comments(parent_comment_id)');

    db.run(
      `CREATE TABLE IF NOT EXISTS comment_votes (
        comment_id TEXT NOT NULL,
        uid TEXT NOT NULL,
        value INTEGER NOT NULL CHECK (value IN (1, -1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (comment_id, uid)
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_comment_votes_comment_id ON comment_votes(comment_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_comment_votes_uid ON comment_votes(uid)');

    db.run(
      `CREATE TABLE IF NOT EXISTS post_follows (
        post_id TEXT NOT NULL,
        uid TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (post_id, uid)
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_post_follows_uid ON post_follows(uid)');

    db.run(
      `CREATE TABLE IF NOT EXISTS post_saves (
        post_id TEXT NOT NULL,
        uid TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (post_id, uid)
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_post_saves_uid ON post_saves(uid)');

    db.run(
      `CREATE TABLE IF NOT EXISTS hidden_posts (
        post_id TEXT NOT NULL,
        uid TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (post_id, uid)
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_hidden_posts_uid ON hidden_posts(uid)');

    db.run(
      `CREATE TABLE IF NOT EXISTS post_reports (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        uid TEXT NOT NULL,
        reason TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_post_reports_post_id ON post_reports(post_id, created_at DESC)');
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

  // One-time migration: move weather locations from JSON into SQLite.
  try {
    const legacy = loadUserData();
    const locs = legacy.locations && typeof legacy.locations === 'object' ? legacy.locations : {};
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO user_weather_location (uid, city, state, country, latitude, longitude, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    Object.entries(locs).forEach(([uid, loc]) => {
      if (!uid || !loc || loc.latitude == null || loc.longitude == null) return;
      const lat = Number(loc.latitude);
      const lon = Number(loc.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      stmt.run(
        uid,
        loc.city || '',
        loc.state || '',
        loc.country || '',
        lat,
        lon,
        loc.last_updated || new Date().toISOString()
      );
    });
    stmt.finalize();
  } catch (e) {
    // Ignore migration failures.
  }

  return db;
}

const db = initDbAndMigrateFromJson();

function getWeekStartIso(d = new Date()) {
  const dt = new Date(d);
  dt.setHours(0, 0, 0, 0);
  // Monday as week start
  const day = (dt.getDay() + 6) % 7;
  dt.setDate(dt.getDate() - day);
  return dt.toISOString();
}

async function requireFirebaseUser(req) {
  if (!firebaseAdmin || !firebaseAdmin.auth) throw new Error('Firebase admin not configured');
  const h = req.headers.authorization || '';
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error('Missing Authorization bearer token');
  const decoded = await firebaseAdmin.auth().verifyIdToken(m[1]);
  if (!decoded?.uid) throw new Error('Invalid token');
  // Keep a lightweight local user directory for comment author display, mod tools, etc.
  // This avoids "Unknown" authors when rendering comments.
  try {
    const displayName = decoded.displayName || decoded.name || decoded.username || null;
    const email = decoded.email || null;
    await dbRunAsync(
      `INSERT INTO users (uid, display_name, email, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET
         display_name = excluded.display_name,
         email = excluded.email,
         updated_at = excluded.updated_at`,
      [String(decoded.uid).trim(), displayName ? String(displayName).trim() : null, email ? String(email).trim() : null, new Date().toISOString()]
    );
  } catch (_) {}
  return decoded.uid;
}

async function requireFirebaseUserClaims(req) {
  if (!firebaseAdmin || !firebaseAdmin.auth) throw new Error('Firebase admin not configured');
  const h = req.headers.authorization || '';
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error('Missing Authorization bearer token');
  const decoded = await firebaseAdmin.auth().verifyIdToken(m[1]);
  if (!decoded?.uid) throw new Error('Invalid token');
  // Keep a lightweight local user directory for comment author display, mod tools, etc.
  try {
    const displayName = decoded.displayName || decoded.name || decoded.username || null;
    const email = decoded.email || null;
    await dbRunAsync(
      `INSERT INTO users (uid, display_name, email, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET
         display_name = excluded.display_name,
         email = excluded.email,
         updated_at = excluded.updated_at`,
      [String(decoded.uid).trim(), displayName ? String(displayName).trim() : null, email ? String(email).trim() : null, new Date().toISOString()]
    );
  } catch (_) {}
  return decoded;
}

/** Resolve Firebase uid from Authorization: Bearer (optional; used by telemetry / deskbot). */
function optionalFirebaseUid(req) {
  return new Promise((resolve) => {
    if (!firebaseAdmin || !firebaseAdmin.auth) return resolve(null);
    const h = req.headers.authorization || '';
    const m = String(h).match(/^Bearer\s+(.+)$/i);
    if (!m) return resolve(null);
    firebaseAdmin
      .auth()
      .verifyIdToken(m[1])
      .then((d) => resolve(d && d.uid ? d.uid : null))
      .catch(() => resolve(null));
  });
}

function isFirebaseAuthConfigured() {
  return !!(firebaseAdmin && firebaseAdmin.auth);
}

/** Allow GET/PUT /location without Firebase only when explicitly set (local dev). Default: deny. */
function allowUnauthenticatedLocationApi() {
  return process.env.DEW_ALLOW_UNAUTH_LOCATION === '1';
}

/**
 * Per-user isolation for location APIs: require a valid Firebase Bearer token matching :uid.
 * Unauthenticated requests are rejected when Firebase Admin is available (production).
 */
async function requireUidMatchesToken(req, res, paramUid) {
  const uid = String(paramUid || '').trim();
  if (!uid) {
    res.status(400).json({ error: 'uid required' });
    return false;
  }
  if (!isFirebaseAuthConfigured()) {
    if (allowUnauthenticatedLocationApi()) {
      return true;
    }
    res.status(503).json({ error: 'Authentication not configured on server' });
    return false;
  }
  const authHeader = req.headers.authorization || '';
  if (!/^Bearer\s+\S+/i.test(authHeader)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  const tokenUid = await optionalFirebaseUid(req);
  if (!tokenUid || tokenUid !== uid) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

function hashIngestTokenSecret(raw) {
  return crypto.createHash('sha256').update(String(raw).trim(), 'utf8').digest('hex');
}

async function findUidByIngestToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const h = hashIngestTokenSecret(raw);
  const row = await dbGetAsync('SELECT uid FROM user_ingest_token WHERE token_hash = ?', [h]);
  return row && row.uid ? String(row.uid) : null;
}

function makeApiToken(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString('hex')}`;
}

function hashApiToken(raw) {
  return crypto.createHash('sha256').update(String(raw).trim(), 'utf8').digest('hex');
}

function readBearerOrHeaderToken(req, headerName) {
  const auth = String(req.headers.authorization || '');
  if (/^Bearer\s+\S+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const h = req.headers[headerName];
  if (h != null && String(h).trim() !== '') return String(h).trim();
  return '';
}

function iotAdminTokenConfigured() {
  return !!(process.env.DEW_IOT_ADMIN_TOKEN && String(process.env.DEW_IOT_ADMIN_TOKEN).trim());
}

function isIotAdminRequest(req) {
  const expected = String(process.env.DEW_IOT_ADMIN_TOKEN || '').trim();
  if (!expected) return false;
  const provided = readBearerOrHeaderToken(req, 'x-iot-admin-token');
  if (!provided) return false;
  return provided === expected;
}

async function requireFirebaseUidOr401(req, res) {
  const uid = await optionalFirebaseUid(req);
  if (!uid) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return String(uid).trim();
}

/** Per-user post flags stored in SQLite (follow / save / hide). */
async function getUserPostInteractionState(postId, uid) {
  if (!uid) return { following: false, saved: false, hidden: false };
  const pid = String(postId || '').trim();
  const u = String(uid || '').trim();
  if (!pid || !u) return { following: false, saved: false, hidden: false };
  try {
    const [f, s, h] = await Promise.all([
      dbGetAsync('SELECT 1 AS ok FROM post_follows WHERE post_id = ? AND uid = ? LIMIT 1', [pid, u]),
      dbGetAsync('SELECT 1 AS ok FROM post_saves WHERE post_id = ? AND uid = ? LIMIT 1', [pid, u]),
      dbGetAsync('SELECT 1 AS ok FROM hidden_posts WHERE post_id = ? AND uid = ? LIMIT 1', [pid, u]),
    ]);
    return {
      following: !!(f && f.ok),
      saved: !!(s && s.ok),
      hidden: !!(h && h.ok),
    };
  } catch (_) {
    return { following: false, saved: false, hidden: false };
  }
}

function isAuthErrorMessage(msg) {
  const m = String(msg || '').toLowerCase();
  return m.includes('missing authorization') || m.includes('invalid token') || m.includes('firebase admin not configured');
}

async function findDeviceIdByDeviceToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const h = hashApiToken(raw);
  const row = await dbGetAsync(
    `SELECT device_id FROM iot_device_tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
    [h]
  );
  return row && row.device_id ? String(row.device_id) : null;
}

async function findTearboardIdByToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const h = hashApiToken(raw);
  const row = await dbGetAsync(
    `SELECT tearboard_id FROM tearboard_tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
    [h]
  );
  return row && row.tearboard_id ? String(row.tearboard_id) : null;
}

async function getPlantbotChoicePlantId(uid) {
  if (!uid) return null;
  const row = await dbGetAsync('SELECT plant_id FROM plantbot_user_choice WHERE uid = ?', [uid]);
  if (!row || !row.plant_id) return null;
  const pid = String(row.plant_id).trim();
  return pid || null;
}

async function upsertPlantbotChoicePlantId(uid, plantId) {
  if (!uid || !plantId) return;
  const p = String(plantId).trim();
  if (!p) return;
  await dbRunAsync(
    `INSERT INTO plantbot_user_choice (uid, plant_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET
       plant_id = excluded.plant_id,
       updated_at = excluded.updated_at`,
    [String(uid).trim(), p, new Date().toISOString()]
  );
}

function dbGetAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAllAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function dbRunAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

// ============================================================
// Weather: Supabase-backed location preferences + caching
// ============================================================
const DEVICE_WEATHER_CACHE_MS = 12 * 60 * 1000; // 10–15 min: keep it fresh but avoid hammering API
const serverWeatherCache = new Map(); // key: "lat,lon" -> { at, payload }

function makeLocationName(city, state, country) {
  const parts = [city, state, country].map((p) => String(p || "").trim()).filter(Boolean);
  return parts.join(", ");
}

async function getUserWeatherLocationPref(uid) {
  const userId = String(uid || "").trim();
  if (!userId) return null;

  // 1) Primary: Supabase (persist across serverless deployments).
  // If Supabase isn't configured, we fall back to SQLite + JSON store.
  if (supabaseAdmin) {
    try {
      // Attempt modern schema first (city/state/country + updated_at).
      let data = null;
      let error = null;
      try {
        const resp = await supabaseAdmin
          .from("user_weather_preferences")
          .select("city,state,country,latitude,longitude,updated_at")
          .eq("user_id", userId)
          .single();
        data = resp.data;
        error = resp.error;
      } catch (e) {
        error = e;
      }

      if (error) {
        // Legacy schema fallback: location_name + created_at.
        const resp = await supabaseAdmin
          .from("user_weather_preferences")
          .select("location_name,latitude,longitude,created_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(1);
        if (resp.error) throw resp.error;
        data = Array.isArray(resp.data) ? resp.data[0] : resp.data;
      }

      const row = data;
      if (row && row.latitude != null && row.longitude != null) {
        const lat = Number(row.latitude);
        const lon = Number(row.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          const city =
            typeof row.city === "string"
              ? row.city
              : typeof row.location_name === "string"
                ? row.location_name
                : "";
          const state = typeof row.state === "string" ? row.state : "";
          const country = typeof row.country === "string" ? row.country : "";
          const lastUpdated =
            typeof row.updated_at === "string"
              ? row.updated_at
              : typeof row.created_at === "string"
                ? row.created_at
                : null;

          // Best-effort cache into SQLite + JSON for local dev + older tooling.
          const now = new Date().toISOString();
          dbRunAsync(
            `INSERT OR REPLACE INTO user_weather_location (uid, city, state, country, latitude, longitude, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [userId, city, state, country, lat, lon, lastUpdated || now]
          ).catch(() => {});
          if (!store.locations) store.locations = {};
          store.locations[userId] = {
            city,
            state,
            country,
            latitude: lat,
            longitude: lon,
            last_updated: lastUpdated || now,
          };
          saveUserData();

          return {
            city,
            state,
            country,
            latitude: lat,
            longitude: lon,
            last_updated: lastUpdated,
          };
        }
      }
    } catch (_) {
      // Continue to SQLite/JSON fallbacks.
    }
  }

  // 2) Fallback: SQLite (works locally / single-node servers).
  try {
    const row = await dbGetAsync(
      `SELECT city, state, country, latitude, longitude, updated_at FROM user_weather_location WHERE uid = ?`,
      [userId]
    );
    if (row && row.latitude != null && row.longitude != null) {
      const lat = Number(row.latitude);
      const lon = Number(row.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return {
          city: row.city || "",
          state: row.state || "",
          country: row.country || "",
          latitude: lat,
          longitude: lon,
          last_updated: row.updated_at || null,
        };
      }
    }
  } catch (_) {
    // continue to JSON fallback
  }

  const loc = (store.locations || {})[userId];
  if (!loc || loc.latitude == null || loc.longitude == null) return null;
  const lat = Number(loc.latitude);
  const lon = Number(loc.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    city: loc.city || "",
    state: loc.state || "",
    country: loc.country || "",
    latitude: lat,
    longitude: lon,
    last_updated: loc.last_updated || null,
  };
}

async function saveUserWeatherLocationPref(uid, body) {
  const userId = String(uid || "").trim();
  if (!userId) return false;

  const city = String(body?.city || "").trim();
  const state = String(body?.state || "").trim();
  const country = String(body?.country || "").trim();
  const latitude = Number(body?.latitude);
  const longitude = Number(body?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;

  const now = new Date().toISOString();

  // Primary: Supabase (if configured) so this persists across serverless deploys.
  if (supabaseAdmin) {
    try {
      const location_name = makeLocationName(city, state, country);
      // Try modern schema (single row per user_id).
      let upsertError = null;
      try {
        const resp = await supabaseAdmin
          .from("user_weather_preferences")
          .upsert(
            [
              {
                user_id: userId,
                city,
                state,
                country,
                location_name,
                latitude,
                longitude,
                updated_at: now,
              },
            ],
            { onConflict: "user_id" }
          );
        upsertError = resp.error || null;
      } catch (e) {
        upsertError = e;
      }
      if (upsertError) {
        // Legacy schema fallback.
        await supabaseAdmin.from("user_weather_preferences").delete().eq("user_id", userId);
        await supabaseAdmin.from("user_weather_preferences").insert([
          {
            user_id: userId,
            location_name,
            latitude,
            longitude,
          },
        ]);
      }
    } catch (e) {
      // If Supabase is present but failing, still allow local save paths.
    }
  }

  // Fallback / local cache: SQLite (one row per user; only updated when the user saves location).
  try {
    await dbRunAsync(
      `INSERT INTO user_weather_location (uid, city, state, country, latitude, longitude, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET
         city = excluded.city,
         state = excluded.state,
         country = excluded.country,
         latitude = excluded.latitude,
         longitude = excluded.longitude,
         updated_at = excluded.updated_at`,
      [userId, city, state, country, latitude, longitude, now]
    );
  } catch (e) {
    console.warn("user_weather_location save failed:", e.message);
  }

  // Mirror to JSON store for backward compatibility / local tooling.
  if (!store.locations) store.locations = {};
  store.locations[userId] = {
    city,
    state,
    country,
    latitude,
    longitude,
    last_updated: now,
  };
  saveUserData();

  return true;
}

function openMeteoCodeToCondition(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return { condition: "Unknown", animation: "cloudy" };
  // These ranges match the client-side mapping used for open-meteo weather_code.
  if (c === 0) return { condition: "Clear", animation: "sunny" };
  if (c >= 1 && c <= 3) return { condition: ["Mainly clear", "Partly cloudy", "Overcast"][c - 1], animation: "cloudy" };
  if (c >= 45 && c <= 48) return { condition: "Foggy", animation: "cloudy" };
  if (c >= 51 && c <= 67) return { condition: "Rain", animation: "rainy" };
  if (c >= 71 && c <= 77) return { condition: "Snow", animation: "snowy" };
  if (c >= 80 && c <= 82) return { condition: "Rain showers", animation: "rainy" };
  if (c >= 85 && c <= 86) return { condition: "Snow showers", animation: "snowy" };
  if (c >= 95 && c <= 99) return { condition: "Thunderstorm", animation: "thunderstorm" };
  return { condition: "Unknown", animation: "cloudy" };
}

async function fetchOpenMeteoWeather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lon)}` +
    `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&hourly=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&forecast_hours=12&timezone=auto` +
    `&daily=temperature_2m_max,temperature_2m_min,relative_humidity_2m_max,relative_humidity_2m_min,shortwave_radiation_sum,daylight_duration` +
    `&forecast_days=2`;

  const res = await fetch(url);
  if (!res.ok) throw new Error("Weather unavailable");
  const json = await res.json();
  const cur = json.current || {};
  const code = cur.weather_code;
  const mapped = openMeteoCodeToCondition(code);
  const temp = cur.temperature_2m != null ? Number(cur.temperature_2m) : null;
  const humidity = cur.relative_humidity_2m != null ? Number(cur.relative_humidity_2m) : null;
  const wind = cur.wind_speed_10m != null ? Number(cur.wind_speed_10m) : null;

  const hourly = json.hourly || {};
  const times = Array.isArray(hourly.time) ? hourly.time : [];
  const temps = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];
  const hums = Array.isArray(hourly.relative_humidity_2m) ? hourly.relative_humidity_2m : [];
  const codes = Array.isArray(hourly.weather_code) ? hourly.weather_code : [];
  const winds = Array.isArray(hourly.wind_speed_10m) ? hourly.wind_speed_10m : [];

  const forecast = times.slice(0, 8).map((t, i) => {
    const c = codes[i];
    const m = openMeteoCodeToCondition(c);
    return {
      time: t,
      temp_c: temps[i] != null ? Number(temps[i]) : null,
      humidity: hums[i] != null ? Number(hums[i]) : null,
      condition: m.condition,
      weather_code: c != null ? Number(c) : null,
      wind_kmh: winds[i] != null ? Number(winds[i]) : null,
    };
  });

  /** Today's calendar-day averages for the selected map area (not plant sensors). */
  let areaToday = null;
  const daily = json.daily || {};
  const tMax = daily.temperature_2m_max;
  const tMin = daily.temperature_2m_min;
  const hMax = daily.relative_humidity_2m_max;
  const hMin = daily.relative_humidity_2m_min;
  const radSum = daily.shortwave_radiation_sum;
  const dayDur = daily.daylight_duration;
  if (Array.isArray(tMax) && Array.isArray(tMin) && tMax[0] != null && tMin[0] != null) {
    const avgTempC = (Number(tMax[0]) + Number(tMin[0])) / 2;
    let avgHumidityPct = null;
    if (Array.isArray(hMax) && Array.isArray(hMin) && hMax[0] != null && hMin[0] != null) {
      avgHumidityPct = (Number(hMax[0]) + Number(hMin[0])) / 2;
    }
    let avgLuxApprox = null;
    if (Array.isArray(radSum) && Array.isArray(dayDur) && radSum[0] != null && dayDur[0] != null) {
      const dur = Number(dayDur[0]);
      if (dur > 0) {
        const wm2 = (Number(radSum[0]) * 1e6) / dur;
        avgLuxApprox = Math.round(Math.min(130000, Math.max(0, wm2 * 110)));
      }
    }
    areaToday = { avgTempC, avgHumidityPct, avgLuxApprox };
  }

  return {
    current: {
      temp,
      humidity,
      wind,
      condition: mapped.condition,
      animation: mapped.animation,
      weather_code: code != null ? Number(code) : null,
    },
    forecast,
    areaToday,
  };
}

async function getCommunityBySlug(slug) {
  if (!supabaseAdmin) throw new Error('Supabase not configured');
  const s = String(slug || '').trim().toLowerCase();
  if (!s) throw new Error('slug required');
  const { data, error } = await supabaseAdmin.from('communities').select('id,slug,status,creator_firebase_uid').eq('slug', s).single();
  if (error || !data) throw new Error('Community not found');
  return data;
}

async function isUserJoinedToCommunitySQLite(slug, uid) {
  const s = String(slug || '').trim().toLowerCase();
  const u = String(uid || '').trim();
  if (!s || !u) return false;
  const row = await dbGetAsync('SELECT 1 AS ok FROM community_members WHERE community_slug = ? AND uid = ? LIMIT 1', [s, u]);
  return !!row;
}

async function isModeratorToCommunitySQLite(slug, uid) {
  const s = String(slug || '').trim().toLowerCase();
  const u = String(uid || '').trim();
  if (!s || !u) return false;
  const row = await dbGetAsync('SELECT 1 AS ok FROM community_moderators WHERE community_slug = ? AND uid = ? LIMIT 1', [s, u]);
  return !!row;
}

async function canViewCommunity(slug, uid) {
  const comm = await getCommunityBySlug(slug);
  if (comm.status === 'public') return true;
  if (!uid) return false;
  if (comm.creator_firebase_uid && String(comm.creator_firebase_uid) === String(uid)) return true;
  if (await isUserJoinedToCommunitySQLite(slug, uid)) return true;
  if (await isModeratorToCommunitySQLite(slug, uid)) return true;
  return false;
}

/** Logged-in users may post to public communities; private/restricted require membership (same as can view). */
async function canPostToCommunity(slug, uid) {
  const u = String(uid || '').trim();
  if (!u) return false;
  const comm = await getCommunityBySlug(slug);
  const st = String(comm.status || 'public').toLowerCase();
  if (st === 'public') return true;
  return canViewCommunity(slug, u);
}

/** Community IDs whose posts the user is allowed to read (public + private/restricted they can access). */
async function getViewableCommunityIdsForUser(uid) {
  if (!supabaseAdmin) return [];
  const { data: publicRows, error } = await supabaseAdmin.from('communities').select('id').eq('status', 'public');
  if (error) throw error;
  const ids = new Set((publicRows || []).map((r) => r.id).filter(Boolean));
  const u = String(uid || '').trim();
  if (u) {
    const { data: ownedPriv } = await supabaseAdmin
      .from('communities')
      .select('id')
      .eq('creator_firebase_uid', u)
      .in('status', ['private', 'restricted']);
    (ownedPriv || []).forEach((r) => r.id && ids.add(r.id));

    const memRows = await dbAllAsync('SELECT DISTINCT community_slug FROM community_members WHERE uid = ?', [u]);
    const memSlugs = [...new Set((memRows || []).map((r) => String(r.community_slug || '').toLowerCase()).filter(Boolean))];
    if (memSlugs.length) {
      const { data: memComms } = await supabaseAdmin.from('communities').select('id').in('slug', memSlugs);
      (memComms || []).forEach((r) => r.id && ids.add(r.id));
    }
    const modRows = await dbAllAsync('SELECT DISTINCT community_slug FROM community_moderators WHERE uid = ?', [u]);
    const modSlugs = [...new Set((modRows || []).map((r) => String(r.community_slug || '').toLowerCase()).filter(Boolean))];
    if (modSlugs.length) {
      const { data: modComms } = await supabaseAdmin.from('communities').select('id').in('slug', modSlugs);
      (modComms || []).forEach((r) => r.id && ids.add(r.id));
    }
  }
  return [...ids];
}

async function canDeleteCommunity(slug, uid) {
  const comm = await getCommunityBySlug(slug);
  if (!uid) return false;
  return !!(comm.creator_firebase_uid && String(comm.creator_firebase_uid) === String(uid));
}

async function canDeletePost(postId, uid, firebaseClaims = null) {
  const postIdStr = String(postId || '').trim();
  if (!postIdStr || !uid) return false;
  const uidNorm = String(uid || '').trim();
  const selectWithFirebaseUid = 'id,community_id,title,author_username,author_firebase_uid';
  const selectBase = 'id,community_id,title,author_username';
  const attempt = await supabaseAdmin.from('posts').select(selectWithFirebaseUid).eq('id', postIdStr).single();
  let post = attempt.data || null;
  let postErr = attempt.error || null;
  if (postErr) {
    const msg = String(postErr?.message || '').toLowerCase();
    if (msg.includes('author_firebase_uid') || msg.includes('column')) {
      const fallback = await supabaseAdmin.from('posts').select(selectBase).eq('id', postIdStr).single();
      post = fallback.data || null;
      postErr = fallback.error || null;
    }
  }
  if (postErr || !post) return false;
  const comm = await supabaseAdmin.from('communities').select('slug,status,creator_firebase_uid').eq('id', post.community_id).single();
  if (comm.error || !comm.data) return false;
  const communityRow = comm.data;
  if (communityRow.creator_firebase_uid && String(communityRow.creator_firebase_uid).trim() === uidNorm) return true;
  if (await isModeratorToCommunitySQLite(communityRow.slug, uidNorm)) return true;

  // Strong check when available: the author_firebase_uid stored on the post.
  if (post.author_firebase_uid && String(post.author_firebase_uid).trim() === uidNorm) return true;

  // Fallback: allow if the author_username matches the user's display_name
  const authorUsername = String(post.author_username || '').trim().toLowerCase();
  const claimsName =
    firebaseClaims?.displayName ||
    firebaseClaims?.name ||
    firebaseClaims?.username ||
    '';
  const claimsEmail = firebaseClaims?.email || '';
  const claimsNameNorm = String(claimsName).trim().toLowerCase();
  const claimsEmailNorm = String(claimsEmail).trim().toLowerCase();

  if (claimsNameNorm && authorUsername && claimsNameNorm === authorUsername) return true;
  if (claimsEmailNorm && authorUsername && claimsEmailNorm === authorUsername) return true;

  const userRow = await dbGetAsync('SELECT display_name FROM users WHERE uid = ? LIMIT 1', [uid]);
  const userDisplayName = userRow?.display_name ? String(userRow.display_name).trim().toLowerCase() : '';
  if (userDisplayName && authorUsername && userDisplayName === authorUsername) return true;
  return false;
}

async function canDeleteComment(commentId, uid) {
  const cId = String(commentId || '').trim();
  if (!cId || !uid) return false;
  const comment = await dbGetAsync('SELECT id,post_id,uid FROM post_comments WHERE id = ? LIMIT 1', [cId]);
  if (!comment) return false;
  if (String(comment.uid) === String(uid)) return true;

  // Mods/creator can delete
  const { data: post, error } = await supabaseAdmin.from('posts').select('id,community_id').eq('id', comment.post_id).single();
  if (error || !post) return false;
  const comm = await supabaseAdmin.from('communities').select('slug,creator_firebase_uid').eq('id', post.community_id).single();
  if (comm.error || !comm.data) return false;
  const communityRow = comm.data;
  if (communityRow.creator_firebase_uid && String(communityRow.creator_firebase_uid) === String(uid)) return true;
  if (await isModeratorToCommunitySQLite(communityRow.slug, uid)) return true;
  return false;
}

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
    mood: 'happy',
    show: { moisture: false, temp: false, light: false, humidity: false, weather: false, health: false },
    updatedAt: new Date().toISOString(),
  },
  /** Last POST /api/device/status payload per device_id (memory only; optional UI/debug). */
  deskbotDeviceReports: {},
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
// ESP32-CAM uploads hourly images as base64 inside JSON.
// Default Express JSON limit can be too small for this, so we bump it.
app.use(express.json({ limit: '25mb' }));
// Avoid stale index.html / styles.css during local dev (browser disk cache).
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    const p = req.path;
    if (p === '/' || p === '/index.html' || p.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
    }
    next();
  });
}
app.use(express.static(path.join(__dirname, 'public')));

// --- API: User directory (for moderator search) ---
app.post('/api/users/upsert', async (req, res) => {
  const { uid, displayName, email } = req.body || {};
  const cleanUid = String(uid || '').trim();
  if (!cleanUid) return res.status(400).json({ error: 'uid required' });
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users (uid, display_name, email, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET
       display_name = excluded.display_name,
       email = excluded.email,
       updated_at = excluded.updated_at`,
    [cleanUid, String(displayName || '').trim() || null, String(email || '').trim() || null, now],
    (err) => {
      if (err) return res.status(500).json({ error: 'Failed to save user' });
      res.json({ ok: true });
    }
  );
});

app.get('/api/users/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const like = `%${q.replace(/%/g, '')}%`;
  db.all(
    `SELECT uid, display_name, email
     FROM users
     WHERE uid LIKE ? OR display_name LIKE ? OR email LIKE ?
     ORDER BY updated_at DESC
     LIMIT 20`,
    [like, like, like],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Search failed' });
      res.json((rows || []).map((r) => ({ uid: r.uid, displayName: r.display_name, email: r.email })));
    }
  );
});

async function requireCommunityCreator(slug, req) {
  const uid = await requireFirebaseUser(req);
  if (!supabaseAdmin) throw new Error('Supabase not configured');
  const { data: comm, error } = await supabaseAdmin
    .from('communities')
    .select('slug, creator_firebase_uid')
    .eq('slug', slug)
    .single();
  if (error || !comm) throw new Error('Community not found');
  const creatorUid = String(comm.creator_firebase_uid || '').trim();
  if (creatorUid && creatorUid !== uid) throw new Error('Only the community creator can manage moderators');
  return uid;
}

// --- API: Community membership + moderators + meta (symbol) ---
app.post('/api/communities/:slug/join', async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'slug required' });
  let uid;
  try {
    uid = await requireFirebaseUser(req);
  } catch (e) {
    return res.status(401).json({ error: e.message || 'Unauthorized' });
  }
  const now = new Date().toISOString();
  db.serialize(() => {
    db.run(
      'INSERT OR IGNORE INTO community_members (community_slug, uid, joined_at) VALUES (?, ?, ?)',
      [slug, uid, now],
      (err) => {
        if (err) return res.status(500).json({ error: 'Failed to join' });
        db.get('SELECT COUNT(*) AS n FROM community_members WHERE community_slug = ?', [slug], (err2, row) => {
          if (err2) return res.json({ ok: true, joined: true });
          res.json({ ok: true, joined: true, members: (row && row.n) || 0 });
        });
      }
    );
  });
});

app.post('/api/communities/:slug/leave', async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'slug required' });
  let uid;
  try {
    uid = await requireFirebaseUser(req);
  } catch (e) {
    return res.status(401).json({ error: e.message || 'Unauthorized' });
  }
  db.run('DELETE FROM community_members WHERE community_slug = ? AND uid = ?', [slug, uid], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to leave' });
    // If the user is also a moderator, remove them from moderator list too,
    // so "joined" doesn't come back.
    db.run('DELETE FROM community_moderators WHERE community_slug = ? AND uid = ?', [slug, uid], () => {
      db.get('SELECT COUNT(*) AS n FROM community_members WHERE community_slug = ?', [slug], (err2, row) => {
        if (err2) return res.json({ ok: true, joined: false });
        res.json({ ok: true, joined: false, members: (row && row.n) || 0 });
      });
    });
  });
});

app.get('/api/communities/:slug/membership', (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const uid = String(req.query.uid || '').trim();
  if (!slug || !uid) return res.json({ joined: false });
  db.get(
    'SELECT 1 AS ok FROM community_members WHERE community_slug = ? AND uid = ?',
    [slug, uid],
    (err, row) => {
      if (err) return res.json({ joined: false });
      res.json({ joined: !!row });
    }
  );
});

app.put('/api/communities/:slug/meta', async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'slug required' });
  try {
    await requireCommunityCreator(slug, req);
  } catch (e) {
    return res.status(403).json({ error: e.message || 'Forbidden' });
  }
  const symbol = String(req.body.logoSymbol || '').trim().slice(0, 6) || null;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO community_meta (community_slug, logo_symbol, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(community_slug) DO UPDATE SET
       logo_symbol = excluded.logo_symbol,
       updated_at = excluded.updated_at`,
    [slug, symbol, now],
    (err) => {
      if (err) return res.status(500).json({ error: 'Failed to update meta' });
      res.json({ ok: true, logoSymbol: symbol });
    }
  );
});

app.put('/api/communities/:slug/moderators', async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'slug required' });
  try {
    await requireCommunityCreator(slug, req);
  } catch (e) {
    return res.status(403).json({ error: e.message || 'Forbidden' });
  }
  const uids = Array.isArray(req.body.moderatorUids) ? req.body.moderatorUids : [];
  const clean = [...new Set(uids.map((u) => String(u || '').trim()).filter(Boolean))].slice(0, 50);
  const now = new Date().toISOString();
  db.serialize(() => {
    db.run('DELETE FROM community_moderators WHERE community_slug = ?', [slug], (delErr) => {
      if (delErr) return res.status(500).json({ error: 'Failed to update moderators' });
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO community_moderators (community_slug, uid, role, added_at) VALUES (?, ?, ?, ?)'
      );
      clean.forEach((u) => stmt.run(slug, u, 'moderator', now));
      stmt.finalize((insErr) => {
        if (insErr) return res.status(500).json({ error: 'Failed to update moderators' });
        // Auto-join moderators as members unless they later "leave".
        // (leave endpoint deletes both community_members + community_moderators)
        const memStmt = db.prepare(
          'INSERT OR IGNORE INTO community_members (community_slug, uid, joined_at) VALUES (?, ?, ?)'
        );
        clean.forEach((u) => memStmt.run(slug, u, now));
        memStmt.finalize((memErr) => {
          if (memErr) return res.status(500).json({ error: 'Failed to auto-join moderators' });
          res.json({ ok: true, moderators: clean });
        });
      });
    });
  });
});

app.put('/api/communities/:slug/notify', async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'slug required' });
  let uid;
  try {
    uid = await requireFirebaseUser(req);
  } catch (e) {
    return res.status(401).json({ error: e.message || 'Unauthorized' });
  }
  const levelRaw = String(req.body.level || 'all').trim().toLowerCase();
  const level = ['off', 'low', 'high', 'all'].includes(levelRaw) ? levelRaw : 'all';
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO community_notification_prefs (community_slug, uid, level, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(community_slug, uid) DO UPDATE SET
       level = excluded.level,
       updated_at = excluded.updated_at`,
    [slug, uid, level, now],
    (err) => {
      if (err) return res.status(500).json({ error: 'Failed to update notifications' });
      res.json({ ok: true, level });
    }
  );
});

app.post('/api/communities/:slug/visit', async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'slug required' });
  let uid;
  try {
    uid = await requireFirebaseUser(req);
  } catch (e) {
    return res.status(401).json({ error: e.message || 'Unauthorized' });
  }
  try {
    if (!(await canViewCommunity(slug, uid))) return res.status(403).json({ error: 'Not allowed' });
  } catch (_) {
    return res.status(404).json({ error: 'Community not found' });
  }
  const week = getWeekStartIso();
  const now = new Date().toISOString();
  db.run(
    'INSERT OR IGNORE INTO community_weekly_visitors (community_slug, week_start, uid, first_seen_at) VALUES (?, ?, ?, ?)',
    [slug, week, uid, now],
    (err) => {
      if (err) return res.status(500).json({ error: 'Failed to record visit' });
      res.json({ ok: true });
    }
  );
});

app.post('/api/communities/:slug/contribute', async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'slug required' });
  let uid;
  try {
    uid = await requireFirebaseUser(req);
  } catch (e) {
    return res.status(401).json({ error: e.message || 'Unauthorized' });
  }
  try {
    if (!(await canPostToCommunity(slug, uid))) return res.status(403).json({ error: 'Not allowed' });
  } catch (_) {
    return res.status(404).json({ error: 'Community not found' });
  }
  const week = getWeekStartIso();
  const now = new Date().toISOString();
  db.run(
    'INSERT OR IGNORE INTO community_weekly_contributors (community_slug, week_start, uid, first_contributed_at) VALUES (?, ?, ?, ?)',
    [slug, week, uid, now],
    (err) => {
      if (err) return res.status(500).json({ error: 'Failed to record contribution' });
      res.json({ ok: true });
    }
  );
});

app.get('/api/communities/:slug/weekly-stats', (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'slug required' });
  const week = getWeekStartIso();
  db.get(
    'SELECT COUNT(*) AS n FROM community_weekly_visitors WHERE community_slug = ? AND week_start = ?',
    [slug, week],
    (err1, vRow) => {
      if (err1) return res.status(500).json({ error: 'Failed to load stats' });
      db.get(
        'SELECT COUNT(*) AS n FROM community_weekly_contributors WHERE community_slug = ? AND week_start = ?',
        [slug, week],
        (err2, cRow) => {
          if (err2) return res.status(500).json({ error: 'Failed to load stats' });
          res.json({ week_start: week, visitors: (vRow && vRow.n) || 0, contributors: (cRow && cRow.n) || 0 });
        }
      );
    }
  );
});

app.post('/api/communities/:slug/messages', async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'slug required' });
  let uid;
  try {
    uid = await requireFirebaseUser(req);
  } catch (e) {
    return res.status(401).json({ error: e.message || 'Unauthorized' });
  }
  const toKind = String(req.body.toKind || 'mods').trim().toLowerCase();
  const body = String(req.body.body || '').trim();
  const toUid = String(req.body.toUid || '').trim() || null;
  if (!body) return res.status(400).json({ error: 'Message required' });
  if (!['admin', 'mods', 'user'].includes(toKind)) return res.status(400).json({ error: 'Invalid toKind' });
  const now = new Date().toISOString();
  db.run(
    'INSERT INTO community_messages (community_slug, from_uid, to_kind, to_uid, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [slug, uid, toKind, toUid, body, now],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to send message' });
      res.json({ ok: true, id: String(this.lastID) });
    }
  );
});

app.post('/api/posts/:id/share', async (req, res) => {
  const postId = String(req.params.id || '').trim();
  let slug = String(req.body.communitySlug || '').trim().toLowerCase();
  if (!postId) return res.status(400).json({ error: 'post id required' });
  // Backward-compatible: allow missing communitySlug by inferring from post.
  if (!slug) {
    try {
      if (!supabaseAdmin) throw new Error('Supabase not configured');
      const { data: post, error: pErr } = await supabaseAdmin.from('posts').select('community_id').eq('id', postId).single();
      if (pErr || !post) throw new Error('Post not found');
      const { data: comm, error: cErr } = await supabaseAdmin.from('communities').select('slug').eq('id', post.community_id).single();
      if (cErr || !comm?.slug) throw new Error('Community not found');
      slug = String(comm.slug).trim().toLowerCase();
    } catch (e) {
      return res.status(400).json({ error: 'post id and communitySlug required' });
    }
  }
  let uid;
  try {
    uid = await requireFirebaseUser(req);
  } catch (e) {
    return res.status(401).json({ error: e.message || 'Unauthorized' });
  }
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO community_post_metrics (post_id, community_slug, share_count, updated_at, last_shared_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(post_id) DO UPDATE SET
       share_count = community_post_metrics.share_count + 1,
       updated_at = excluded.updated_at,
       last_shared_at = excluded.last_shared_at`,
    [postId, slug, now, now],
    (err) => {
      if (err) return res.status(500).json({ error: 'Failed to record share' });
      res.json({ ok: true });
    }
  );
});

app.post('/api/posts/:id/metrics', async (req, res) => {
  const postId = String(req.params.id || '').trim();
  let slug = String(req.body.communitySlug || '').trim().toLowerCase();
  const score = Number(req.body.score || 0);
  const comments = Number(req.body.comments || 0);
  if (!postId) return res.status(400).json({ error: 'post id required' });
  // Backward-compatible: allow missing communitySlug by inferring from post.
  if (!slug) {
    try {
      if (!supabaseAdmin) throw new Error('Supabase not configured');
      const { data: post, error: pErr } = await supabaseAdmin.from('posts').select('community_id').eq('id', postId).single();
      if (pErr || !post) throw new Error('Post not found');
      const { data: comm, error: cErr } = await supabaseAdmin.from('communities').select('slug').eq('id', post.community_id).single();
      if (cErr || !comm?.slug) throw new Error('Community not found');
      slug = String(comm.slug).trim().toLowerCase();
    } catch (e) {
      return res.status(400).json({ error: 'post id and communitySlug required' });
    }
  }
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO community_post_metrics (post_id, community_slug, share_count, last_seen_score, last_seen_comments, updated_at)
     VALUES (?, ?, 0, ?, ?, ?)
     ON CONFLICT(post_id) DO UPDATE SET
       community_slug = excluded.community_slug,
       last_seen_score = excluded.last_seen_score,
       last_seen_comments = excluded.last_seen_comments,
       updated_at = excluded.updated_at`,
    [postId, slug, Number.isFinite(score) ? score : 0, Number.isFinite(comments) ? comments : 0, now],
    (err) => {
      if (err) return res.status(500).json({ error: 'Failed to update metrics' });
      res.json({ ok: true });
    }
  );
});

// ============================================================
// Reddit-style: post page + comments + votes (SQLite store)
// ============================================================

// Read post details (media + author + counts)
app.get('/api/posts/:id', async (req, res) => {
  const postId = String(req.params.id || '').trim();
  if (!postId) return res.status(400).json({ error: 'post id required' });
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });

    let uid = null;
    const authHeader = req.headers.authorization || '';
    if (authHeader) {
      try {
        uid = await requireFirebaseUser(req);
      } catch (_) {
        uid = null;
      }
    }

    const selectFullMedia =
      'id,community_id,title,body,created_at,author_username,author_firebase_uid,image_url,media_urls,media_types,score,comment_count';
    const selectLegacyMedia =
      'id,community_id,title,body,created_at,author_username,image_url,media_urls,media_types,score,comment_count';
    const selectFullBase =
      'id,community_id,title,body,created_at,author_username,author_firebase_uid,image_url,score,comment_count';
    const selectLegacyBase =
      'id,community_id,title,body,created_at,author_username,image_url,score,comment_count';
    const trySelect = async (sel) => {
      const { data, error } = await supabaseAdmin.from('posts').select(sel).eq('id', postId).single();
      return { data, error };
    };

    let post = null;
    let postErr = null;
    for (const sel of [selectFullMedia, selectLegacyMedia, selectFullBase, selectLegacyBase]) {
      const attempt = await trySelect(sel);
      if (!attempt.error && attempt.data) {
        post = attempt.data;
        postErr = null;
        break;
      }
      postErr = attempt.error;
    }
    if (postErr || !post) return res.status(404).json({ error: 'Post not found' });

    const { data: comm, error: commErr } = await supabaseAdmin
      .from('communities')
      .select('id,slug,status,creator_firebase_uid')
      .eq('id', post.community_id)
      .single();
    if (commErr || !comm) return res.status(404).json({ error: 'Community not found' });

    // Enforce community visibility rules (public/restricted/private).
    // Public is viewable by anyone; restricted/private requires membership/mod/creator.
    if (!(await canViewCommunity(comm.slug, uid))) return res.status(403).json({ error: 'Not allowed' });

    // Prefer Supabase-backed vote counts when available (cross-device persistence). Fallback to SQLite.
    const postVotesRowP = (async () => {
      try {
        const resp = await supabaseAdmin
          .from('post_votes_firebase')
          .select('value')
          .eq('post_id', postId);
        if (resp.error) throw resp.error;
        const score = (resp.data || []).reduce((acc, r) => acc + Number(r.value || 0), 0);
        return { score };
      } catch (_) {
        return await dbGetAsync('SELECT COALESCE(SUM(value), 0) AS score FROM post_votes WHERE post_id = ?', [postId]);
      }
    })();
    const commentCountRowP = (async () => {
      try {
        const resp = await supabaseAdmin
          .from('post_comments')
          .select('id', { count: 'exact', head: true })
          .eq('post_id', postId)
          .is('deleted_at', null);
        if (resp.error) throw resp.error;
        return { n: Number(resp.count ?? 0) };
      } catch (_) {
        return await dbGetAsync('SELECT COUNT(*) AS n FROM post_comments WHERE post_id = ?', [postId]);
      }
    })();
    const [postVotesRow, commentCountRow] = await Promise.all([postVotesRowP, commentCountRowP]);

    let myVote = 0;
    if (uid) {
      try {
        const mine = await supabaseAdmin.from('post_votes_firebase').select('value').eq('post_id', postId).eq('uid', uid).maybeSingle();
        if (!mine.error && mine.data && mine.data.value != null) myVote = Number(mine.data.value);
      } catch (_) {
        const mine = await dbGetAsync('SELECT value FROM post_votes WHERE post_id = ? AND uid = ? LIMIT 1', [postId, uid]);
        if (mine && mine.value != null) myVote = Number(mine.value);
      }
    }

    const myInteractions = uid ? await getUserPostInteractionState(postId, uid) : { following: false, saved: false, hidden: false };

    res.json({
      post: {
        ...post,
        score: Number(postVotesRow?.score ?? 0),
        comment_count: Number(commentCountRow?.n ?? 0),
        my_vote: myVote,
        my_interactions: myInteractions,
      },
      community: {
        id: comm.id,
        slug: comm.slug,
        status: comm.status,
        creator_firebase_uid: comm.creator_firebase_uid,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to load post' });
  }
});

app.get('/api/posts/:id/comments', async (req, res) => {
  const postId = String(req.params.id || '').trim();
  if (!postId) return res.status(400).json({ error: 'post id required' });
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });

    let uid = null;
    const authHeader = req.headers.authorization || '';
    if (authHeader) {
      try {
        uid = await requireFirebaseUser(req);
      } catch (_) {
        uid = null;
      }
    }

    const { data: post, error: postErr } = await supabaseAdmin
      .from('posts')
      .select('id,community_id')
      .eq('id', postId)
      .single();
    if (postErr || !post) return res.status(404).json({ error: 'Post not found' });

    const { data: comm, error: commErr } = await supabaseAdmin
      .from('communities')
      .select('slug,status')
      .eq('id', post.community_id)
      .single();
    if (commErr || !comm) return res.status(404).json({ error: 'Community not found' });

    // Enforce community visibility rules (public/restricted/private).
    if (!(await canViewCommunity(comm.slug, uid))) return res.status(403).json({ error: 'Not allowed' });

    // Prefer Supabase-backed comments when available (serverless-safe). Fallback to SQLite.
    let comments = [];
    let myVotesByComment = new Map();
    try {
      const { data: rows, error } = await supabaseAdmin
        .from('post_comments')
        .select('id,parent_comment_id,post_id,author_firebase_uid,author_display_name,body,created_at,deleted_at')
        .eq('post_id', postId)
        .is('deleted_at', null)
        .order('created_at', { ascending: true });
      if (error) throw error;
      comments = (rows || []).map((r) => {
        const uid = r.author_firebase_uid || null;
        return {
          id: String(r.id),
          parent_comment_id: r.parent_comment_id ? String(r.parent_comment_id) : null,
          post_id: r.post_id,
          uid,
          display_name: r.author_display_name || null,
          author_avatar_url: publicAvatarUrlForFirebaseUid(uid),
          body: r.body,
          created_at: r.created_at,
        };
      });
      // Votes (best-effort; if table not present or RLS blocks, just return zeros)
      const ids = comments.map((c) => String(c.id)).filter(Boolean);
      if (ids.length) {
        try {
          const { data: vRows, error: vErr } = await supabaseAdmin
            .from('comment_votes_firebase')
            .select('comment_id,uid,value')
            .in('comment_id', ids);
          if (!vErr && Array.isArray(vRows)) {
            const scoreById = new Map();
            vRows.forEach((v) => {
              const cid = String(v.comment_id);
              scoreById.set(cid, (scoreById.get(cid) || 0) + Number(v.value || 0));
            });
            comments.forEach((c) => (c.score = scoreById.get(String(c.id)) || 0));
          }
          if (uid && !vErr && Array.isArray(vRows)) {
            vRows.forEach((v) => {
              if (String(v.uid || '') === String(uid)) myVotesByComment.set(String(v.comment_id), Number(v.value || 0));
            });
          }
        } catch (_) {}
      }
    } catch (_) {
      const sqliteRows = await dbAllAsync(
        `SELECT
           pc.id,
           pc.parent_comment_id,
           pc.post_id,
           pc.uid,
           u.display_name,
           pc.body,
           pc.created_at,
           COALESCE(SUM(cv.value), 0) AS score
         FROM post_comments pc
         LEFT JOIN comment_votes cv ON cv.comment_id = pc.id
         LEFT JOIN users u ON u.uid = pc.uid
         WHERE pc.post_id = ?
         GROUP BY pc.id
         ORDER BY pc.created_at ASC`,
        [postId]
      );
      comments = (sqliteRows || []).map((row) => ({
        ...row,
        author_avatar_url: publicAvatarUrlForFirebaseUid(row.uid),
      }));
      if (uid) {
        const voted = await dbAllAsync('SELECT comment_id, value FROM comment_votes WHERE uid = ?', [uid]);
        voted.forEach((v) => myVotesByComment.set(String(v.comment_id), Number(v.value)));
      }
    }

    res.json({
      community_slug: comm.slug,
      comments: (comments || []).map((c) => ({
        id: String(c.id),
        parent_comment_id: c.parent_comment_id ? String(c.parent_comment_id) : null,
        uid: c.uid || null,
        author_display_name: c.display_name || c.author_display_name || 'Unknown',
        author_avatar_url: c.author_avatar_url || publicAvatarUrlForFirebaseUid(c.uid) || null,
        body: c.body,
        created_at: c.created_at,
        score: Number(c.score ?? 0),
        my_vote: myVotesByComment.get(String(c.id)) || 0,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to load comments' });
  }
});

app.post('/api/posts/:id/comments', async (req, res) => {
  const postId = String(req.params.id || '').trim();
  const body = String(req.body.body || '').trim();
  const parentCommentId = req.body.parentCommentId ? String(req.body.parentCommentId).trim() : null;
  if (!postId) return res.status(400).json({ error: 'post id required' });
  if (!body) return res.status(400).json({ error: 'comment body required' });

  try {
    const claims = await requireFirebaseUserClaims(req);
    const uid = claims.uid;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });

    const { data: post, error: postErr } = await supabaseAdmin
      .from('posts')
      .select('id,community_id')
      .eq('id', postId)
      .single();
    if (postErr || !post) return res.status(404).json({ error: 'Post not found' });

    const { data: comm, error: commErr } = await supabaseAdmin
      .from('communities')
      .select('slug,status')
      .eq('id', post.community_id)
      .single();
    if (commErr || !comm) return res.status(404).json({ error: 'Community not found' });

    if (!(await canViewCommunity(comm.slug, uid))) return res.status(403).json({ error: 'Not allowed' });

    // Try Supabase threaded comments first (persistent).
    try {
      // Validate parent belongs to the same post (when provided)
      if (parentCommentId) {
        const { data: parent, error: pErr } = await supabaseAdmin
          .from('post_comments')
          .select('id,post_id')
          .eq('id', parentCommentId)
          .single();
        if (pErr || !parent || String(parent.post_id) !== String(postId)) {
          return res.status(400).json({ error: 'Invalid parent comment' });
        }
      }

      const displayName = claims.displayName || claims.name || claims.username || 'Unknown';
      const { data: inserted, error: insErr } = await supabaseAdmin.from('post_comments').insert({
        community_id: post.community_id,
        post_id: postId,
        author_firebase_uid: uid,
        author_display_name: String(displayName || '').trim() || 'Unknown',
        body,
        parent_comment_id: parentCommentId || null,
      }).select('id').single();
      if (insErr) throw insErr;

      // Update posts.comment_count for feed consistency (in case trigger isn't installed).
      const countResp = await supabaseAdmin.from('post_comments').select('id', { count: 'exact', head: true }).eq('post_id', postId).is('deleted_at', null);
      if (!countResp.error) await supabaseAdmin.from('posts').update({ comment_count: Number(countResp.count ?? 0) }).eq('id', postId);

      return res.json({ ok: true, commentId: String(inserted?.id || ''), comment_count: Number(countResp.count ?? 0) });
    } catch (_) {
      // Fallback to SQLite (local dev / legacy)
      // Validate parent belongs to the same post (when provided)
      if (parentCommentId) {
        const parent = await dbGetAsync('SELECT id FROM post_comments WHERE id = ? AND post_id = ? LIMIT 1', [parentCommentId, postId]);
        if (!parent) return res.status(400).json({ error: 'Invalid parent comment' });
      }

      const now = new Date().toISOString();
      const commentId = `c_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      await dbRunAsync(
        'INSERT INTO post_comments (id, post_id, community_slug, uid, parent_comment_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [commentId, postId, comm.slug, uid, parentCommentId, body, now]
      );

      const commentCountRow = await dbGetAsync('SELECT COUNT(*) AS n FROM post_comments WHERE post_id = ?', [postId]);
      const commentCount = Number(commentCountRow?.n ?? 0);
      await supabaseAdmin.from('posts').update({ comment_count: commentCount }).eq('id', postId);

      return res.json({ ok: true, commentId, comment_count: commentCount });
    }
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to create comment' });
  }
});

app.delete('/api/posts/:postId/comments/:commentId', async (req, res) => {
  const postId = String(req.params.postId || '').trim();
  const commentId = String(req.params.commentId || '').trim();
  if (!postId || !commentId) return res.status(400).json({ error: 'postId and commentId required' });
  try {
    const uid = await requireFirebaseUser(req);
    // Prefer Supabase threaded comments when available (persistent). Fallback to SQLite.
    try {
      if (!supabaseAdmin) throw new Error('Supabase not configured');
      const { data: postRow, error: postErr } = await supabaseAdmin.from('posts').select('id,community_id').eq('id', postId).single();
      if (postErr || !postRow) throw new Error('Post not found');
      const { data: comm, error: commErr } = await supabaseAdmin.from('communities').select('slug,creator_firebase_uid').eq('id', postRow.community_id).single();
      if (commErr || !comm) throw new Error('Community not found');
      if (!(await canViewCommunity(comm.slug, uid))) return res.status(403).json({ error: 'Not allowed' });

      const { data: cRow, error: cErr } = await supabaseAdmin
        .from('post_comments')
        .select('id,author_firebase_uid')
        .eq('id', commentId)
        .single();
      if (cErr || !cRow) throw new Error('Comment not found');
      const isAuthor = cRow.author_firebase_uid && String(cRow.author_firebase_uid) === String(uid);
      const isCreator = comm.creator_firebase_uid && String(comm.creator_firebase_uid) === String(uid);
      const isMod = await isModeratorToCommunitySQLite(comm.slug, uid);
      if (!(isAuthor || isCreator || isMod)) return res.status(403).json({ error: 'Not allowed' });

      const { error: delErr } = await supabaseAdmin.from('post_comments').delete().eq('id', commentId);
      if (delErr) throw delErr;

      const countResp = await supabaseAdmin.from('post_comments').select('id', { count: 'exact', head: true }).eq('post_id', postId).is('deleted_at', null);
      if (!countResp.error) await supabaseAdmin.from('posts').update({ comment_count: Number(countResp.count ?? 0) }).eq('id', postId);

      return res.json({ ok: true, comment_count: Number(countResp.count ?? 0) });
    } catch (_) {
      if (!(await canDeleteComment(commentId, uid))) return res.status(403).json({ error: 'Not allowed' });

      // Collect descendants (simple iterative BFS)
      const toDelete = [commentId];
      const seen = new Set([commentId]);
      let i = 0;
      while (i < toDelete.length) {
        const batch = toDelete[i];
        const rows = await dbAllAsync('SELECT id FROM post_comments WHERE parent_comment_id = ?', [batch]);
        for (const r of rows || []) {
          const id = String(r.id);
          if (!seen.has(id)) {
            seen.add(id);
            toDelete.push(id);
          }
        }
        i += 1;
      }

      const placeholders = toDelete.map(() => '?').join(',');
      await dbRunAsync(`DELETE FROM comment_votes WHERE comment_id IN (${placeholders})`, toDelete);
      await dbRunAsync(`DELETE FROM post_comments WHERE id IN (${placeholders})`, toDelete);

      const commentCountRow = await dbGetAsync('SELECT COUNT(*) AS n FROM post_comments WHERE post_id = ?', [postId]);
      const commentCount = Number(commentCountRow?.n ?? 0);
      await supabaseAdmin.from('posts').update({ comment_count: commentCount }).eq('id', postId);

      return res.json({ ok: true, comment_count: commentCount });
    }
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to delete comment' });
  }
});

app.post('/api/posts/:id/vote', async (req, res) => {
  const postId = String(req.params.id || '').trim();
  const valueRaw = req.body.value ?? req.body.delta ?? null;
  const value = Number(valueRaw);
  if (!postId) return res.status(400).json({ error: 'post id required' });
  if (![1, -1].includes(value)) return res.status(400).json({ error: 'value must be 1 or -1' });

  try {
    const uid = await requireFirebaseUser(req);
    if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });

    const { data: post, error: postErr } = await supabaseAdmin.from('posts').select('id,community_id').eq('id', postId).single();
    if (postErr || !post) return res.status(404).json({ error: 'Post not found' });
    const { data: comm, error: commErr } = await supabaseAdmin.from('communities').select('slug,status').eq('id', post.community_id).single();
    if (commErr || !comm) return res.status(404).json({ error: 'Community not found' });

    if (!(await canViewCommunity(comm.slug, uid))) return res.status(403).json({ error: 'Not allowed' });

    // Persistent votes in Supabase (Firebase uid). Keep SQLite in sync for local fallback.
    let toggledOff = false;
    let existingValue = 0;
    try {
      const mine = await supabaseAdmin.from('post_votes_firebase').select('value').eq('post_id', postId).eq('uid', uid).maybeSingle();
      if (!mine.error && mine.data && mine.data.value != null) existingValue = Number(mine.data.value);
    } catch (_) {}

    if (existingValue === value) {
      toggledOff = true;
      try {
        await supabaseAdmin.from('post_votes_firebase').delete().eq('post_id', postId).eq('uid', uid);
      } catch (_) {}
      try {
        await dbRunAsync('DELETE FROM post_votes WHERE post_id = ? AND uid = ?', [postId, uid]);
      } catch (_) {}
    } else {
      const now = new Date().toISOString();
      try {
        await supabaseAdmin
          .from('post_votes_firebase')
          .upsert({ post_id: postId, uid, value, updated_at: now }, { onConflict: 'post_id,uid' });
      } catch (_) {}
      try {
        await dbRunAsync(
          `INSERT INTO post_votes (post_id, uid, value, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(post_id, uid) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`,
          [postId, uid, value, now, now]
        );
      } catch (_) {}
    }

    // Recompute score from Supabase when possible; fallback to SQLite.
    let score = 0;
    try {
      const { data: vRows, error: vErr } = await supabaseAdmin.from('post_votes_firebase').select('value').eq('post_id', postId);
      if (vErr) throw vErr;
      score = (vRows || []).reduce((acc, r) => acc + Number(r.value || 0), 0);
    } catch (_) {
      const scoreRow = await dbGetAsync('SELECT COALESCE(SUM(value), 0) AS score FROM post_votes WHERE post_id = ?', [postId]);
      score = Number(scoreRow?.score ?? 0);
    }
    await supabaseAdmin.from('posts').update({ score }).eq('id', postId);

    const my_vote = toggledOff ? 0 : value;
    res.json({ ok: true, score, my_vote });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to vote' });
  }
});

async function assertUserCanAccessPost(postId, uid) {
  if (!supabaseAdmin) throw new Error('Supabase not configured');
  const pid = String(postId || '').trim();
  const { data: post, error: postErr } = await supabaseAdmin.from('posts').select('id,community_id').eq('id', pid).single();
  if (postErr || !post) {
    const err = new Error('Post not found');
    err.statusCode = 404;
    throw err;
  }
  const { data: comm, error: commErr } = await supabaseAdmin.from('communities').select('slug').eq('id', post.community_id).single();
  if (commErr || !comm) {
    const err = new Error('Community not found');
    err.statusCode = 404;
    throw err;
  }
  if (!(await canViewCommunity(comm.slug, uid))) {
    const err = new Error('Not allowed');
    err.statusCode = 403;
    throw err;
  }
  return { postId: pid, slug: comm.slug };
}

/** Public Storage URL for a Firebase user's avatar (same path as POST /api/upload/avatar). */
function publicAvatarUrlForFirebaseUid(firebaseUid) {
  const u = String(firebaseUid || '').trim();
  if (!u || !supabaseAdmin) return null;
  try {
    const { data } = supabaseAdmin.storage.from('avatars').getPublicUrl(`${u}/avatar.jpg`);
    return data?.publicUrl || null;
  } catch (_) {
    return null;
  }
}

/** Chunked Supabase fetch — avoids long `.in()` URLs and tries slimmer column sets if the schema differs. */
async function supabaseFetchPostsByIdsOrdered(ids) {
  const uniqueOrdered = [];
  const seen = new Set();
  for (const raw of ids || []) {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniqueOrdered.push(id);
  }
  if (!uniqueOrdered.length) return [];
  if (!supabaseAdmin) return [];

  const selectVariants = [
    'id,title,body,created_at,author_username,author_firebase_uid,community_id,image_url,media_urls,media_types,tags,score,comment_count',
    'id,title,body,created_at,author_username,community_id,image_url,media_urls,media_types,tags,score,comment_count',
    'id,title,body,created_at,author_username,community_id,image_url,tags,score,comment_count',
    'id,title,created_at,author_username,community_id,score,comment_count',
    'id,title,community_id,created_at',
  ];
  const chunkSize = 25;
  const byId = new Map();

  for (let i = 0; i < uniqueOrdered.length; i += chunkSize) {
    const chunk = uniqueOrdered.slice(i, i + chunkSize);
    let rows = null;
    let lastErrMsg = '';
    for (const sel of selectVariants) {
      const attempt = await supabaseAdmin.from('posts').select(sel).in('id', chunk);
      if (!attempt.error && Array.isArray(attempt.data)) {
        rows = attempt.data;
        break;
      }
      lastErrMsg = String(attempt.error?.message || attempt.error || '');
    }
    if (!rows) {
      throw new Error(lastErrMsg || 'Could not load posts from database');
    }
    for (const row of rows) {
      byId.set(String(row.id), row);
    }
  }

  return uniqueOrdered.map((id) => byId.get(id)).filter(Boolean);
}

async function mergeSavedPostIdList(uid) {
  const u = String(uid || '').trim();
  if (!u) return [];
  let fromSql = [];
  try {
    fromSql = await dbAllAsync(
      'SELECT post_id, created_at FROM post_saves WHERE uid = ? ORDER BY created_at DESC LIMIT 100',
      [u]
    );
  } catch (_) {
    fromSql = [];
  }
  fromSql = fromSql || [];
  let fromPg = [];
  if (supabaseAdmin) {
    const { data, error } = await supabaseAdmin
      .from('user_saved_posts')
      .select('post_id, created_at')
      .eq('uid', u)
      .order('created_at', { ascending: false })
      .limit(100);
    if (!error && Array.isArray(data)) fromPg = data;
  }
  const map = new Map();
  for (const r of fromSql) {
    const id = String(r.post_id || '').trim();
    if (!id) continue;
    map.set(id, String(r.created_at || ''));
  }
  for (const r of fromPg) {
    const id = String(r.post_id || '').trim();
    if (!id) continue;
    const t = String(r.created_at || '');
    const prev = map.get(id);
    if (!prev || t > prev) map.set(id, t);
  }
  return Array.from(map.entries())
    .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
    .slice(0, 80)
    .map(([id]) => id);
}

async function mergeHiddenPostIdList(uid) {
  const u = String(uid || '').trim();
  if (!u) return [];
  let fromSql = [];
  try {
    fromSql = await dbAllAsync(
      'SELECT post_id, created_at FROM hidden_posts WHERE uid = ? ORDER BY created_at DESC LIMIT 100',
      [u]
    );
  } catch (_) {
    fromSql = [];
  }
  fromSql = fromSql || [];
  let fromPg = [];
  if (supabaseAdmin) {
    const { data, error } = await supabaseAdmin
      .from('user_hidden_posts')
      .select('post_id, created_at')
      .eq('uid', u)
      .order('created_at', { ascending: false })
      .limit(100);
    if (!error && Array.isArray(data)) fromPg = data;
  }
  const map = new Map();
  for (const r of fromSql) {
    const id = String(r.post_id || '').trim();
    if (!id) continue;
    map.set(id, String(r.created_at || ''));
  }
  for (const r of fromPg) {
    const id = String(r.post_id || '').trim();
    if (!id) continue;
    const t = String(r.created_at || '');
    const prev = map.get(id);
    if (!prev || t > prev) map.set(id, t);
  }
  return Array.from(map.entries())
    .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
    .slice(0, 80)
    .map(([id]) => id);
}

async function mirrorUserSavedPost(uid, postId, saved) {
  if (!supabaseAdmin) return;
  const u = String(uid || '').trim();
  const p = String(postId || '').trim();
  if (!u || !p) return;
  try {
    if (saved) {
      await supabaseAdmin.from('user_saved_posts').upsert(
        { uid: u, post_id: p, created_at: new Date().toISOString() },
        { onConflict: 'uid,post_id' }
      );
    } else {
      await supabaseAdmin.from('user_saved_posts').delete().eq('uid', u).eq('post_id', p);
    }
  } catch (_) {}
}

async function mirrorUserHiddenPost(uid, postId, hidden) {
  if (!supabaseAdmin) return;
  const u = String(uid || '').trim();
  const p = String(postId || '').trim();
  if (!u || !p) return;
  try {
    if (hidden) {
      await supabaseAdmin.from('user_hidden_posts').upsert(
        { uid: u, post_id: p, created_at: new Date().toISOString() },
        { onConflict: 'uid,post_id' }
      );
    } else {
      await supabaseAdmin.from('user_hidden_posts').delete().eq('uid', u).eq('post_id', p);
    }
  } catch (_) {}
}

// Toggle: notify on new comments (stored for future notifications / digest).
app.post('/api/posts/:id/follow', async (req, res) => {
  const postId = String(req.params.id || '').trim();
  if (!postId) return res.status(400).json({ error: 'post id required' });
  try {
    const uid = await requireFirebaseUser(req);
    await assertUserCanAccessPost(postId, uid);
    const existing = await dbGetAsync('SELECT post_id FROM post_follows WHERE post_id = ? AND uid = ? LIMIT 1', [postId, uid]);
    if (existing) {
      await dbRunAsync('DELETE FROM post_follows WHERE post_id = ? AND uid = ?', [postId, uid]);
      return res.json({ ok: true, following: false });
    }
    await dbRunAsync('INSERT INTO post_follows (post_id, uid, created_at) VALUES (?, ?, ?)', [
      postId,
      uid,
      new Date().toISOString(),
    ]);
    res.json({ ok: true, following: true });
  } catch (e) {
    if (isAuthErrorMessage(e.message)) return res.status(401).json({ error: 'Unauthorized' });
    const code = Number(e.statusCode);
    if (code === 403) return res.status(403).json({ error: e.message || 'Not allowed' });
    if (code === 404) return res.status(404).json({ error: e.message || 'Not found' });
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/posts/:id/save', async (req, res) => {
  const postId = String(req.params.id || '').trim();
  if (!postId) return res.status(400).json({ error: 'post id required' });
  try {
    const uid = await requireFirebaseUser(req);
    await assertUserCanAccessPost(postId, uid);
    const existing = await dbGetAsync('SELECT post_id FROM post_saves WHERE post_id = ? AND uid = ? LIMIT 1', [postId, uid]);
    if (existing) {
      await dbRunAsync('DELETE FROM post_saves WHERE post_id = ? AND uid = ?', [postId, uid]);
      await mirrorUserSavedPost(uid, postId, false);
      return res.json({ ok: true, saved: false });
    }
    await dbRunAsync('INSERT INTO post_saves (post_id, uid, created_at) VALUES (?, ?, ?)', [
      postId,
      uid,
      new Date().toISOString(),
    ]);
    await mirrorUserSavedPost(uid, postId, true);
    res.json({ ok: true, saved: true });
  } catch (e) {
    if (isAuthErrorMessage(e.message)) return res.status(401).json({ error: 'Unauthorized' });
    const code = Number(e.statusCode);
    if (code === 403) return res.status(403).json({ error: e.message || 'Not allowed' });
    if (code === 404) return res.status(404).json({ error: e.message || 'Not found' });
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

// Hide from this user's feed only (not deleted for others).
app.post('/api/posts/:id/hide', async (req, res) => {
  const postId = String(req.params.id || '').trim();
  if (!postId) return res.status(400).json({ error: 'post id required' });
  try {
    const uid = await requireFirebaseUser(req);
    await assertUserCanAccessPost(postId, uid);
    await dbRunAsync('INSERT OR IGNORE INTO hidden_posts (post_id, uid, created_at) VALUES (?, ?, ?)', [
      postId,
      uid,
      new Date().toISOString(),
    ]);
    await mirrorUserHiddenPost(uid, postId, true);
    res.json({ ok: true });
  } catch (e) {
    if (isAuthErrorMessage(e.message)) return res.status(401).json({ error: 'Unauthorized' });
    const code = Number(e.statusCode);
    if (code === 403) return res.status(403).json({ error: e.message || 'Not allowed' });
    if (code === 404) return res.status(404).json({ error: e.message || 'Not found' });
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.delete('/api/posts/:id/hide', async (req, res) => {
  const postId = String(req.params.id || '').trim();
  if (!postId) return res.status(400).json({ error: 'post id required' });
  try {
    const uid = await requireFirebaseUser(req);
    await assertUserCanAccessPost(postId, uid);
    await dbRunAsync('DELETE FROM hidden_posts WHERE post_id = ? AND uid = ?', [postId, uid]);
    await mirrorUserHiddenPost(uid, postId, false);
    res.json({ ok: true });
  } catch (e) {
    if (isAuthErrorMessage(e.message)) return res.status(401).json({ error: 'Unauthorized' });
    const code = Number(e.statusCode);
    if (code === 403) return res.status(403).json({ error: e.message || 'Not allowed' });
    if (code === 404) return res.status(404).json({ error: e.message || 'Not found' });
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/posts/:id/report', async (req, res) => {
  const postId = String(req.params.id || '').trim();
  if (!postId) return res.status(400).json({ error: 'post id required' });
  const reason = String(req.body.reason || '')
    .trim()
    .toLowerCase();
  const allowed = ['spam', 'abuse', 'rules'];
  if (!allowed.includes(reason)) {
    return res.status(400).json({ error: 'reason must be spam, abuse, or rules' });
  }
  const details = String(req.body.details || '').trim().slice(0, 2000);
  try {
    const uid = await requireFirebaseUser(req);
    await assertUserCanAccessPost(postId, uid);
    const id = crypto.randomUUID();
    await dbRunAsync(
      'INSERT INTO post_reports (id, post_id, uid, reason, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, postId, uid, reason, details || null, new Date().toISOString()]
    );
    res.json({ ok: true });
  } catch (e) {
    if (isAuthErrorMessage(e.message)) return res.status(401).json({ error: 'Unauthorized' });
    const code = Number(e.statusCode);
    if (code === 403) return res.status(403).json({ error: e.message || 'Not allowed' });
    if (code === 404) return res.status(404).json({ error: e.message || 'Not found' });
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/me/saved-posts', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const uid = await requireFirebaseUser(req);
    const ids = await mergeSavedPostIdList(uid);
    if (!ids.length) return res.json({ posts: [] });

    let ordered;
    try {
      ordered = await supabaseFetchPostsByIdsOrdered(ids);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Failed to load posts' });
    }

    const visible = [];
    for (const p of ordered) {
      const cid = String(p.community_id || '');
      if (!cid) continue;
      const { data: crow } = await supabaseAdmin.from('communities').select('slug,status').eq('id', cid).single();
      const slug = crow?.slug ? String(crow.slug) : '';
      if (slug && (await canViewCommunity(slug, uid))) visible.push({ ...p, community_slug: slug });
    }

    res.json({ posts: visible });
  } catch (e) {
    if (isAuthErrorMessage(e.message)) return res.status(401).json({ error: 'Unauthorized' });
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/me/hidden-posts', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const uid = await requireFirebaseUser(req);
    const ids = await mergeHiddenPostIdList(uid);
    if (!ids.length) return res.json({ posts: [] });

    let ordered;
    try {
      ordered = await supabaseFetchPostsByIdsOrdered(ids);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Failed to load posts' });
    }

    const visible = [];
    for (const p of ordered) {
      const cid = String(p.community_id || '');
      if (!cid) continue;
      const { data: crow } = await supabaseAdmin.from('communities').select('slug,status').eq('id', cid).single();
      const slug = crow?.slug ? String(crow.slug) : '';
      if (slug && (await canViewCommunity(slug, uid))) visible.push({ ...p, community_slug: slug });
    }

    res.json({ posts: visible });
  } catch (e) {
    if (isAuthErrorMessage(e.message)) return res.status(401).json({ error: 'Unauthorized' });
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/comments/:id/vote', async (req, res) => {
  const commentId = String(req.params.id || '').trim();
  const valueRaw = req.body.value ?? req.body.delta ?? null;
  const value = Number(valueRaw);
  if (!commentId) return res.status(400).json({ error: 'comment id required' });
  if (![1, -1].includes(value)) return res.status(400).json({ error: 'value must be 1 or -1' });

  try {
    const uid = await requireFirebaseUser(req);
    if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });

    // Load comment from Supabase first (persistent), fallback to SQLite.
    let comment = null;
    try {
      const { data, error } = await supabaseAdmin.from('post_comments').select('id,post_id,community_id').eq('id', commentId).maybeSingle();
      if (!error && data) comment = data;
    } catch (_) {}
    if (!comment) {
      comment = await dbGetAsync('SELECT id,post_id,community_slug FROM post_comments WHERE id = ? LIMIT 1', [commentId]);
    }
    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    // Community visibility
    if (comment.community_slug) {
      if (!(await canViewCommunity(comment.community_slug, uid))) return res.status(403).json({ error: 'Not allowed' });
    } else if (comment.community_id) {
      const { data: comm } = await supabaseAdmin.from('communities').select('slug').eq('id', comment.community_id).maybeSingle();
      if (!comm?.slug) return res.status(404).json({ error: 'Community not found' });
      if (!(await canViewCommunity(String(comm.slug), uid))) return res.status(403).json({ error: 'Not allowed' });
    }

    // Toggle/upsert vote in Supabase (Firebase uid), keep SQLite best-effort.
    let toggledOff = false;
    let existingValue = 0;
    try {
      const mine = await supabaseAdmin.from('comment_votes_firebase').select('value').eq('comment_id', commentId).eq('uid', uid).maybeSingle();
      if (!mine.error && mine.data && mine.data.value != null) existingValue = Number(mine.data.value);
    } catch (_) {}

    if (existingValue === value) {
      toggledOff = true;
      try {
        await supabaseAdmin.from('comment_votes_firebase').delete().eq('comment_id', commentId).eq('uid', uid);
      } catch (_) {}
      try {
        await dbRunAsync('DELETE FROM comment_votes WHERE comment_id = ? AND uid = ?', [commentId, uid]);
      } catch (_) {}
    } else {
      const now = new Date().toISOString();
      try {
        await supabaseAdmin
          .from('comment_votes_firebase')
          .upsert({ comment_id: commentId, uid, value, updated_at: now }, { onConflict: 'comment_id,uid' });
      } catch (_) {}
      try {
        await dbRunAsync(
          `INSERT INTO comment_votes (comment_id, uid, value, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(comment_id, uid) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`,
          [commentId, uid, value, now, now]
        );
      } catch (_) {}
    }

    let score = 0;
    try {
      const { data: vRows, error: vErr } = await supabaseAdmin.from('comment_votes_firebase').select('value').eq('comment_id', commentId);
      if (vErr) throw vErr;
      score = (vRows || []).reduce((acc, r) => acc + Number(r.value || 0), 0);
    } catch (_) {
      const scoreRow = await dbGetAsync('SELECT COALESCE(SUM(value), 0) AS score FROM comment_votes WHERE comment_id = ?', [commentId]);
      score = Number(scoreRow?.score ?? 0);
    }

    const my_vote = toggledOff ? 0 : value;
    res.json({ ok: true, score, my_vote });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to vote' });
  }
});

app.delete('/api/posts/:id', async (req, res) => {
  const postId = String(req.params.id || '').trim();
  if (!postId) return res.status(400).json({ error: 'post id required' });
  try {
    const claims = await requireFirebaseUserClaims(req);
    const uid = claims.uid;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });
    if (!(await canDeletePost(postId, uid, claims))) return res.status(403).json({ error: 'Not allowed' });

    // Delete from Supabase (posts cascade if you have FK to comments in Supabase schema)
    const { error } = await supabaseAdmin.from('posts').delete().eq('id', postId);
    if (error) throw new Error('Failed to delete post');

    // Cleanup SQLite comment/vote tables
    await dbRunAsync('DELETE FROM comment_votes WHERE comment_id IN (SELECT id FROM post_comments WHERE post_id = ?)', [postId]);
    await dbRunAsync('DELETE FROM post_comments WHERE post_id = ?', [postId]);
    await dbRunAsync('DELETE FROM post_votes WHERE post_id = ?', [postId]);
    await dbRunAsync('DELETE FROM post_follows WHERE post_id = ?', [postId]);
    await dbRunAsync('DELETE FROM post_saves WHERE post_id = ?', [postId]);
    await dbRunAsync('DELETE FROM hidden_posts WHERE post_id = ?', [postId]);
    await dbRunAsync('DELETE FROM post_reports WHERE post_id = ?', [postId]);
    try {
      await supabaseAdmin.from('user_saved_posts').delete().eq('post_id', postId);
      await supabaseAdmin.from('user_hidden_posts').delete().eq('post_id', postId);
    } catch (_) {}

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to delete post' });
  }
});

// --- API: check if current user can delete a post (UI helper) ---
// This reuses the same server-side authorization logic as DELETE /api/posts/:id.
app.get('/api/posts/:id/can-delete', async (req, res) => {
  const postId = String(req.params.id || '').trim();
  if (!postId) return res.status(400).json({ error: 'post id required' });
  try {
    const claims = await requireFirebaseUserClaims(req);
    const uid = claims.uid;
    const ok = await canDeletePost(postId, uid, claims);
    return res.json({ canDelete: !!ok });
  } catch (e) {
    // Treat auth errors as "cannot delete" to avoid leaking info.
    return res.json({ canDelete: false });
  }
});

app.delete('/api/communities/:slug/delete', async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'slug required' });
  try {
    const uid = await requireFirebaseUser(req);
    if (!(await canDeleteCommunity(slug, uid))) return res.status(403).json({ error: 'Not allowed' });

    if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });
    const { data: comm, error: commErr } = await supabaseAdmin.from('communities').select('id').eq('slug', slug).single();
    if (commErr || !comm) return res.status(404).json({ error: 'Community not found' });

    const { error } = await supabaseAdmin.from('communities').delete().eq('id', comm.id);
    if (error) throw new Error('Failed to delete community');

    // SQLite cleanup
    await dbRunAsync('DELETE FROM community_post_metrics WHERE community_slug = ?', [slug]);
    await dbRunAsync('DELETE FROM community_messages WHERE community_slug = ?', [slug]);
    await dbRunAsync('DELETE FROM community_members WHERE community_slug = ?', [slug]);
    await dbRunAsync('DELETE FROM community_moderators WHERE community_slug = ?', [slug]);

    const { data: posts } = await supabaseAdmin.from('posts').select('id').eq('community_id', comm.id);
    const postIds = (posts || []).map((p) => String(p.id));
    if (postIds.length) {
      const placeholders = postIds.map(() => '?').join(',');
      await dbRunAsync(`DELETE FROM comment_votes WHERE comment_id IN (SELECT id FROM post_comments WHERE post_id IN (${placeholders}))`, postIds);
      await dbRunAsync(`DELETE FROM post_comments WHERE post_id IN (${placeholders})`, postIds);
      await dbRunAsync(`DELETE FROM post_votes WHERE post_id IN (${placeholders})`, postIds);
      await dbRunAsync(`DELETE FROM post_follows WHERE post_id IN (${placeholders})`, postIds);
      await dbRunAsync(`DELETE FROM post_saves WHERE post_id IN (${placeholders})`, postIds);
      await dbRunAsync(`DELETE FROM hidden_posts WHERE post_id IN (${placeholders})`, postIds);
      await dbRunAsync(`DELETE FROM post_reports WHERE post_id IN (${placeholders})`, postIds);
      try {
        await supabaseAdmin.from('user_saved_posts').delete().in('post_id', postIds);
        await supabaseAdmin.from('user_hidden_posts').delete().in('post_id', postIds);
      } catch (_) {}
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to delete community' });
  }
});

app.get('/api/communities/:slug/highlights', async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'slug required' });
  if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });
  const uidHi = await optionalFirebaseUid(req);
  if (!(await canViewCommunity(slug, uidHi))) return res.status(403).json({ error: 'Not allowed' });
  const { data: comm, error: commErr } = await supabaseAdmin
    .from('communities')
    .select('id, slug')
    .eq('slug', slug)
    .single();
  if (commErr || !comm) return res.status(404).json({ error: 'Community not found' });
  const { data: posts, error: postsErr } = await supabaseAdmin
    .from('posts')
    .select('id,title,created_at,author_username,score,comment_count,image_url')
    .eq('community_id', comm.id)
    .limit(200);
  if (postsErr) return res.status(500).json({ error: 'Failed to load posts' });
  const list = Array.isArray(posts) ? posts : [];
  const ids = list.map((p) => String(p.id));
  const sharesById = new Map();
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    await new Promise((resolve) => {
      db.all(
        `SELECT post_id, share_count FROM community_post_metrics WHERE post_id IN (${ph})`,
        ids,
        (e, rows) => {
          (rows || []).forEach((r) => sharesById.set(String(r.post_id), r.share_count || 0));
          resolve();
        }
      );
    });
  }
  const scored = list.map((p) => {
    const share = sharesById.get(String(p.id)) || 0;
    const score = p.score ?? 0;
    const comments = p.comment_count ?? 0;
    const popularity = score + comments * 2 + share * 3;
    return { ...p, share_count: share, popularity };
  });
  const top = scored.slice().sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0)).slice(0, 4);
  const recent = scored.slice().sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)).slice(0, 4);
  res.json({ top, recent });
});

/** Minimal community card for routing / join UI (includes private communities by slug). */
app.get('/api/communities/:slug/summary', async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'slug required' });
  if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const uid = await optionalFirebaseUid(req);
    const { data: row, error } = await supabaseAdmin
      .from('communities')
      .select(
        'id,name,slug,description,status,member_count,post_count,category,banner_url,logo_url,creator_firebase_uid,created_at'
      )
      .eq('slug', slug)
      .single();
    if (error || !row) return res.status(404).json({ error: 'Community not found' });
    const joined =
      !!uid &&
      ((row.creator_firebase_uid && String(row.creator_firebase_uid) === String(uid)) ||
        (await isUserJoinedToCommunitySQLite(slug, uid)) ||
        (await isModeratorToCommunitySQLite(slug, uid)));
    const modRows = await dbAllAsync('SELECT uid FROM community_moderators WHERE community_slug = ?', [slug]);
    const modUids = [...new Set((modRows || []).map((r) => String(r.uid || '').trim()).filter(Boolean))];
    const userNameByUid = new Map();
    if (modUids.length) {
      const ph = modUids.map(() => '?').join(',');
      const urows = await dbAllAsync(`SELECT uid, display_name FROM users WHERE uid IN (${ph})`, modUids);
      (urows || []).forEach((r) => userNameByUid.set(String(r.uid), r.display_name || null));
    }
    const moderators = modUids.map((u) => ({ uid: u, displayName: userNameByUid.get(u) || null }));
    let logo_symbol = null;
    await new Promise((resolve) => {
      db.get('SELECT logo_symbol FROM community_meta WHERE community_slug = ?', [slug], (e, r) => {
        if (r && r.logo_symbol) logo_symbol = String(r.logo_symbol);
        resolve();
      });
    });
    const week = getWeekStartIso();
    let weekly_visitors = 0;
    let weekly_contributors = 0;
    await new Promise((resolve) => {
      db.get(
        'SELECT COUNT(*) AS n FROM community_weekly_visitors WHERE week_start = ? AND community_slug = ?',
        [week, slug],
        (e, r) => {
          weekly_visitors = r && r.n != null ? Number(r.n) : 0;
          resolve();
        }
      );
    });
    await new Promise((resolve) => {
      db.get(
        'SELECT COUNT(*) AS n FROM community_weekly_contributors WHERE week_start = ? AND community_slug = ?',
        [week, slug],
        (e, r) => {
          weekly_contributors = r && r.n != null ? Number(r.n) : 0;
          resolve();
        }
      );
    });
    res.json({
      community: {
        ...row,
        slug: String(row.slug || '').toLowerCase(),
        joined,
        moderators,
        logo_symbol,
        members_count: row.member_count ?? 0,
        weekly_visitors,
        weekly_contributors,
        notify_level: 'all',
        can_view_feed: await canViewCommunity(slug, uid),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to load community' });
  }
});

/**
 * Server-filtered community posts (respects private/restricted visibility).
 * Query: community = slug | all
 */
app.get('/api/community-feed/posts', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const uid = await optionalFirebaseUid(req);
    const commParam = String(req.query.community || 'all').trim().toLowerCase();
    let communityIds = [];
    if (commParam && commParam !== 'all') {
      if (!(await canViewCommunity(commParam, uid))) return res.status(403).json({ error: 'Not allowed' });
      const { data: crow, error: cErr } = await supabaseAdmin.from('communities').select('id').eq('slug', commParam).single();
      if (cErr || !crow) return res.status(404).json({ error: 'Community not found' });
      communityIds = [crow.id];
    } else {
      communityIds = await getViewableCommunityIdsForUser(uid);
    }
    if (!communityIds.length) return res.json({ posts: [] });

    const selectWithMedia =
      'id,title,body,created_at,author_username,author_firebase_uid,community_id,image_url,media_urls,media_types,tags,score,comment_count';
    const selectLegacyMedia =
      'id,title,body,created_at,author_username,community_id,image_url,media_urls,media_types,tags,score,comment_count';
    const selectBase =
      'id,title,body,created_at,author_username,author_firebase_uid,community_id,image_url,tags,score,comment_count';
    const selectLegacyBase = 'id,title,body,created_at,author_username,community_id,image_url,tags,score,comment_count';

    const trySelect = async (sel) => {
      const { data, error } = await supabaseAdmin
        .from('posts')
        .select(sel)
        .in('community_id', communityIds)
        .order('created_at', { ascending: false })
        .limit(150);
      return { data, error };
    };

    let rows = [];
    for (const sel of [selectWithMedia, selectLegacyMedia, selectBase, selectLegacyBase]) {
      const attempt = await trySelect(sel);
      if (!attempt.error) {
        rows = Array.isArray(attempt.data) ? attempt.data : [];
        break;
      }
      const msg = String(attempt.error?.message || '').toLowerCase();
      if (!msg.includes('column') && !msg.includes('schema')) break;
    }

    const hiddenForUser = new Set();
    const allRowIds = rows.map((r) => String(r.id || '').trim()).filter(Boolean);
    if (uid && allRowIds.length) {
      const phH = allRowIds.map(() => '?').join(',');
      try {
        const hRows = await dbAllAsync(
          `SELECT post_id FROM hidden_posts WHERE uid = ? AND post_id IN (${phH})`,
          [uid, ...allRowIds]
        );
        for (const row of hRows || []) hiddenForUser.add(String(row.post_id));
      } catch (_) {}
    }
    const visibleRows = rows.filter((r) => !hiddenForUser.has(String(r.id || '')));

    const postIds = visibleRows.map((r) => String(r.id || '').trim()).filter(Boolean);
    const scoresByPost = new Map();
    const myVoteByPost = new Map();
    const followingByPost = new Map();
    const savedByPost = new Map();
    let voteRowsLoaded = false;
    if (postIds.length) {
      const ph = postIds.map(() => '?').join(',');
      try {
        const aggRows = await dbAllAsync(
          `SELECT post_id, COALESCE(SUM(value), 0) AS score FROM post_votes WHERE post_id IN (${ph}) GROUP BY post_id`,
          postIds
        );
        voteRowsLoaded = true;
        for (const row of aggRows || []) {
          scoresByPost.set(String(row.post_id), Number(row.score ?? 0));
        }
        if (uid) {
          const [mineRows, fRows, sRows] = await Promise.all([
            dbAllAsync(`SELECT post_id, value FROM post_votes WHERE uid = ? AND post_id IN (${ph})`, [uid, ...postIds]),
            dbAllAsync(`SELECT post_id FROM post_follows WHERE uid = ? AND post_id IN (${ph})`, [uid, ...postIds]),
            dbAllAsync(`SELECT post_id FROM post_saves WHERE uid = ? AND post_id IN (${ph})`, [uid, ...postIds]),
          ]);
          for (const row of mineRows || []) {
            myVoteByPost.set(String(row.post_id), Number(row.value));
          }
          for (const row of fRows || []) followingByPost.set(String(row.post_id), true);
          for (const row of sRows || []) savedByPost.set(String(row.post_id), true);
        }
      } catch (_) {
        voteRowsLoaded = false;
      }
    }

    const enriched = visibleRows.map((p) => {
      const id = String(p.id || '');
      const baseScore = Number(p.score ?? 0);
      const score = voteRowsLoaded ? (scoresByPost.has(id) ? scoresByPost.get(id) : 0) : baseScore;
      const my_vote = uid && voteRowsLoaded ? myVoteByPost.get(id) || 0 : 0;
      const my_interactions = uid
        ? { following: followingByPost.has(id), saved: savedByPost.has(id) }
        : { following: false, saved: false };
      return { ...p, score, my_vote, my_interactions };
    });

    res.json({ posts: enriched });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to load posts' });
  }
});

app.get('/api/communities', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });
  const uid = String(req.query.uid || '').trim() || null;
  const selectCols = 'id,name,slug,description,member_count,post_count,category,banner_url,logo_url,status,creator_firebase_uid';

  const { data: publicComm, error: pubErr } = await supabaseAdmin
    .from('communities')
    .select(selectCols)
    .eq('status', 'public')
    .order('post_count', { ascending: false })
    .limit(200);
  if (pubErr) return res.status(500).json({ error: 'Failed to load communities' });

  const bySlug = new Map();
  for (const c of publicComm || []) {
    bySlug.set(String(c.slug || '').toLowerCase(), c);
  }

  if (uid) {
    const { data: ownedPriv } = await supabaseAdmin
      .from('communities')
      .select(selectCols)
      .eq('creator_firebase_uid', uid)
      .in('status', ['private', 'restricted']);
    for (const c of ownedPriv || []) {
      bySlug.set(String(c.slug || '').toLowerCase(), c);
    }

    const memRows = await dbAllAsync('SELECT DISTINCT community_slug FROM community_members WHERE uid = ?', [uid]);
    const memSlugs = [...new Set((memRows || []).map((r) => String(r.community_slug || '').toLowerCase()).filter(Boolean))];
    const missingMem = memSlugs.filter((s) => !bySlug.has(s));
    if (missingMem.length) {
      const { data: extra } = await supabaseAdmin.from('communities').select(selectCols).in('slug', missingMem);
      for (const c of extra || []) bySlug.set(String(c.slug || '').toLowerCase(), c);
    }

    const modRows = await dbAllAsync('SELECT DISTINCT community_slug FROM community_moderators WHERE uid = ?', [uid]);
    const modSlugs = [...new Set((modRows || []).map((r) => String(r.community_slug || '').toLowerCase()).filter(Boolean))];
    const missingMod = modSlugs.filter((s) => !bySlug.has(s));
    if (missingMod.length) {
      const { data: extra } = await supabaseAdmin.from('communities').select(selectCols).in('slug', missingMod);
      for (const c of extra || []) bySlug.set(String(c.slug || '').toLowerCase(), c);
    }
  }

  const list = [...bySlug.values()].sort((a, b) => (b.post_count ?? 0) - (a.post_count ?? 0));
  const slugs = list.map((c) => String(c.slug || '').toLowerCase()).filter(Boolean);
  if (!slugs.length) return res.json([]);

  const placeholders = slugs.map(() => '?').join(',');
  const metaBySlug = new Map();
  const memberCountBySlug = new Map();
  const joinedBySlug = new Map();
  const modsBySlug = new Map();

  await new Promise((resolve) => {
    db.all(`SELECT community_slug, logo_symbol FROM community_meta WHERE community_slug IN (${placeholders})`, slugs, (e, rows) => {
      (rows || []).forEach((r) => metaBySlug.set(String(r.community_slug), { logo_symbol: r.logo_symbol }));
      resolve();
    });
  });

  await new Promise((resolve) => {
    db.all(
      `SELECT community_slug, COUNT(*) AS n FROM community_members WHERE community_slug IN (${placeholders}) GROUP BY community_slug`,
      slugs,
      (e, rows) => {
        (rows || []).forEach((r) => memberCountBySlug.set(String(r.community_slug), r.n || 0));
        resolve();
      }
    );
  });

  await new Promise((resolve) => {
    db.all(
      `SELECT community_slug, uid FROM community_moderators WHERE community_slug IN (${placeholders})`,
      slugs,
      (e, rows) => {
        (rows || []).forEach((r) => {
          const s = String(r.community_slug);
          if (!modsBySlug.has(s)) modsBySlug.set(s, []);
          modsBySlug.get(s).push(String(r.uid));
        });
        resolve();
      }
    );
  });

  if (uid) {
    await new Promise((resolve) => {
      db.all(
        `SELECT community_slug FROM community_members WHERE uid = ? AND community_slug IN (${placeholders})`,
        [uid, ...slugs],
        (e, rows) => {
          (rows || []).forEach((r) => joinedBySlug.set(String(r.community_slug), true));
          resolve();
        }
      );
    });
  }

  const notifyBySlug = new Map();
  if (uid) {
    await new Promise((resolve) => {
      db.all(
        `SELECT community_slug, level FROM community_notification_prefs WHERE uid = ? AND community_slug IN (${placeholders})`,
        [uid, ...slugs],
        (e, rows) => {
          (rows || []).forEach((r) => notifyBySlug.set(String(r.community_slug), r.level || 'all'));
          resolve();
        }
      );
    });
  }

  const week = getWeekStartIso();
  const weeklyVisitorsBySlug = new Map();
  const weeklyContribBySlug = new Map();
  await new Promise((resolve) => {
    db.all(
      `SELECT community_slug, COUNT(*) AS n
       FROM community_weekly_visitors
       WHERE week_start = ? AND community_slug IN (${placeholders})
       GROUP BY community_slug`,
      [week, ...slugs],
      (e, rows) => {
        (rows || []).forEach((r) => weeklyVisitorsBySlug.set(String(r.community_slug), r.n || 0));
        resolve();
      }
    );
  });
  await new Promise((resolve) => {
    db.all(
      `SELECT community_slug, COUNT(*) AS n
       FROM community_weekly_contributors
       WHERE week_start = ? AND community_slug IN (${placeholders})
       GROUP BY community_slug`,
      [week, ...slugs],
      (e, rows) => {
        (rows || []).forEach((r) => weeklyContribBySlug.set(String(r.community_slug), r.n || 0));
        resolve();
      }
    );
  });

  // Resolve moderator display names
  const allModUids = [...new Set([].concat(...[...modsBySlug.values()]))];
  const userNameByUid = new Map();
  if (allModUids.length) {
    const ph = allModUids.map(() => '?').join(',');
    await new Promise((resolve) => {
      db.all(`SELECT uid, display_name FROM users WHERE uid IN (${ph})`, allModUids, (e, rows) => {
        (rows || []).forEach((r) => userNameByUid.set(String(r.uid), r.display_name || null));
        resolve();
      });
    });
  }

  res.json(
    list.map((c) => {
      const slug = String(c.slug || '').toLowerCase();
      const meta = metaBySlug.get(slug) || {};
      const moderators = (modsBySlug.get(slug) || []).map((u) => ({
        uid: u,
        displayName: userNameByUid.get(u) || null,
      }));
      const members = memberCountBySlug.has(slug) ? memberCountBySlug.get(slug) : (c.member_count ?? 0);
      const creatorUid = String(c.creator_firebase_uid || '').trim();
      const isCreator = !!(uid && creatorUid && uid === creatorUid);
      const isModerator = !!(uid && (modsBySlug.get(slug) || []).includes(uid));

      // Ensure there's a `community_members` record for creator/admins/moderators
      // so "joined" is persisted in the DB.
      if (uid && (isModerator || isCreator) && !joinedBySlug.get(slug)) {
        joinedBySlug.set(slug, true);
        db.run(
          'INSERT OR IGNORE INTO community_members (community_slug, uid, joined_at) VALUES (?, ?, ?)',
          [slug, uid, new Date().toISOString()]
        );
      }
      return {
        ...c,
        slug,
        logo_symbol: meta.logo_symbol || null,
        members_count: members,
        // Joined is based on the member record. Moderators are auto-joined by being inserted
        // into community_members when they are added as moderators.
        joined: uid ? !!joinedBySlug.get(slug) || isModerator : false,
        moderators,
        notify_level: uid ? (notifyBySlug.get(slug) || 'all') : 'all',
        weekly_visitors: weeklyVisitorsBySlug.get(slug) || 0,
        weekly_contributors: weeklyContribBySlug.get(slug) || 0,
      };
    })
  );
});

// --- API: Plants (latest readings) ---
app.get('/api/plants', (req, res) => {
  const plantsWithOptimal = (store.plants || []).map((p) => ({
    ...p,
    optimal: PLANT_OPTIMAL_BY_ID[p.id] || PLANT_OPTIMAL_DEFAULT,
  }));
  res.json(plantsWithOptimal);
});

// --- API: User plant fleet (live readings + per-user usage / sensor link) ---
// Plants appear here once the user has a row in `user_plant_usage` (dashboard, deskbot, or ESP telemetry).
app.get('/api/users/:uid/plant-fleet', (req, res) => {
  const uid = String(req.params.uid || '').trim();
  if (!uid) return res.status(400).json({ error: 'uid required' });
  db.all(
    `SELECT plant_id, first_used_at, last_used_at, use_count, last_source
     FROM user_plant_usage WHERE uid = ? ORDER BY datetime(last_used_at) DESC`,
    [uid],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to load plant fleet' });
      const plantsById = new Map((store.plants || []).map((p) => [p.id, p]));
      const seen = new Set();
      const list = [];
      (rows || []).forEach((r) => {
        if (seen.has(r.plant_id)) return;
        seen.add(r.plant_id);
        const live = plantsById.get(r.plant_id);
        if (!live) return;
        list.push({
          ...live,
          optimal: PLANT_OPTIMAL_BY_ID[live.id] || PLANT_OPTIMAL_DEFAULT,
          usage: {
            first_used_at: r.first_used_at,
            last_used_at: r.last_used_at,
            use_count: r.use_count || 0,
            last_source: r.last_source || null,
          },
        });
      });
      const telemetryLinked = list.filter((p) => String(p.usage?.last_source || '') === 'telemetry').length;
      const needsAttention = list.filter((p) => /low|dry|drying/i.test(String(p.status || ''))).length;
      const avgMoisture =
        list.length > 0
          ? Math.round(list.reduce((s, p) => s + (Number(p.moisture) || 0), 0) / list.length)
          : null;
      res.json({
        plants: list,
        summary: {
          total: list.length,
          telemetryLinked,
          needsAttention,
          avgMoisture,
        },
      });
    }
  );
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
// Links readings to a user via: (1) Bearer Firebase ID token, (2) JSON ingestToken (auto-created per user), or (3) legacy JSON uid.
app.post('/api/telemetry', async (req, res) => {
  const { plantId, moisture, temp, lux, humidity, battery, status: bodyStatus, uid: bodyUid, ingestToken: bodyIngest } = req.body || {};
  const headerIngest = req.headers['x-dew-ingest-token'] || req.headers['x-dew-device-token'];
  const rawIngest =
    bodyIngest != null && String(bodyIngest).trim() !== ''
      ? String(bodyIngest).trim()
      : headerIngest != null && String(headerIngest).trim() !== ''
        ? String(headerIngest).trim()
        : '';

  if (!plantId) return res.status(400).json({ error: 'plantId required' });

  const plant = store.plants.find(p => p.id === plantId);
  if (!plant) return res.status(404).json({ error: 'Plant not found' });

  try {
    const tokenUid = await optionalFirebaseUid(req);
    let uid = null;
    if (tokenUid) {
      uid = String(tokenUid).trim();
    } else if (rawIngest) {
      const u = await findUidByIngestToken(rawIngest);
      if (!u) return res.status(401).json({ error: 'Invalid ingest token' });
      uid = u;
    } else if (bodyUid && String(bodyUid).trim()) {
      uid = String(bodyUid).trim();
    }

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
    if (bodyStatus != null && String(bodyStatus).trim() !== '') {
      plant.status = String(bodyStatus).trim();
    } else {
      plant.status = reading.moisture < 40 ? 'Moisture low' : reading.moisture < 50 ? 'Drying' : 'Healthy';
    }
    if (uid) {
      upsertUserPlantUsage(uid, [plantId], 'telemetry', (err) => {
        if (!err) saveUserData();
      });
    }

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
  } catch (e) {
    res.status(500).json({ error: e.message || 'Telemetry failed' });
  }
});

// --- API: Plant Bot selection (which plant this device reports to) ---
// Web app calls this when the user picks a plant in Bots -> Plant Bot.
// The Plant Bot firmware does not call this; it uploads telemetry using the
// user's ingest token so the server can apply the stored selection.
app.post('/api/plantbot-choice', async (req, res) => {
  try {
    const uid = await optionalFirebaseUid(req);
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });

    const body = req.body || {};
    const plantId = String(body.plantId || body.plant_id || '').trim();
    if (!plantId) return res.status(400).json({ error: 'plantId required' });

    // Validate against known catalog plants.
    const plant = (store.plants || []).find((p) => p.id === plantId);
    if (!plant) return res.status(404).json({ error: 'Plant not found' });

    await upsertPlantbotChoicePlantId(String(uid).trim(), plantId);
    res.json({ ok: true, plantId });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Could not save plant choice' });
  }
});

app.get('/api/plantbot-choice', async (req, res) => {
  try {
    const uid = await optionalFirebaseUid(req);
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });
    const plantId = await getPlantbotChoicePlantId(uid);
    res.json({ plantId: plantId || null });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Could not load plant choice' });
  }
});

// --- API: Plant Bot sensor ingestion (ESP32-CAM JSON) ---
// Firmware posts:
// {
//   device_id, timestamp,
//   temperature, humidity,
//   soil_moisture, light,
//   battery
// }
// We map device_id -> plantId (and optionally uid) using DEW_PLANTBOT_DEVICE_MAP_JSON.
app.post('/api/sensor-data', async (req, res) => {
  try {
    const body = req.body || {};
    const deviceId = String(body.device_id || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'device_id required' });

    const temperature = body.temperature;
    const humidity = body.humidity;
    const moisture = body.soil_moisture;
    const lux = body.light;
    const battery = body.battery;
    const timestamp = body.timestamp || new Date().toISOString();
    const bodyStatus = body.status || '';

    const resolved = PLANTBOT_DEVICE_MAP[deviceId] || {};
    // Attempt to derive plantId from device_id if env map not provided.
    const derivedPlantId =
      typeof resolved.plantId === 'string' && resolved.plantId.trim()
        ? String(resolved.plantId).trim()
        : /^plant[-_]?(.+)$/i.test(deviceId)
          ? String(deviceId).replace(/^plant[-_]?/i, '').trim()
          : null;

    let plantId =
      derivedPlantId ||
      (store?.deskbotConfig?.plantId ? String(store.deskbotConfig.plantId) : null) ||
      (Array.isArray(store?.plants) && store.plants[0] ? store.plants[0].id : null);

    if (!plantId) return res.status(400).json({ error: 'Could not resolve plantId for device_id' });

    let plant = (store.plants || []).find((p) => p.id === plantId);
    if (!plant) return res.status(404).json({ error: 'Plant not found' });

    // Determine uid for user_plant_usage linking
    let uid = null;
    const headerUid = await optionalFirebaseUid(req);
    if (headerUid) uid = String(headerUid).trim();
    if (!uid && resolved.uid) uid = String(resolved.uid).trim();
    if (!uid && body.uid) uid = String(body.uid).trim();
    if (!uid) {
      const headerIngest = req.headers['x-dew-ingest-token'] || req.headers['x-dew-device-token'];
      if (headerIngest && String(headerIngest).trim() !== '') {
        const u = await findUidByIngestToken(String(headerIngest).trim());
        if (!u) return res.status(401).json({ error: 'Invalid ingest token' });
        uid = u;
      }
    }

    // If the user selected a specific plant for this bot, override the plantId.
    // This is how the web app "Plants -> Plant Bot dropdown" binds telemetry to the correct plant.
    if (uid) {
      const chosenPlantId = await getPlantbotChoicePlantId(uid);
      if (chosenPlantId && chosenPlantId !== plantId) {
        plantId = chosenPlantId;
        plant = (store.plants || []).find((p) => p.id === plantId);
        if (!plant) return res.status(404).json({ error: 'Chosen plant not found' });
      }
    }

    const reading = {
      plantId,
      moisture: moisture != null ? Number(moisture) : plant.moisture,
      temp: temperature != null ? Number(temperature) : plant.temp,
      lux: lux != null ? Number(lux) : plant.lux,
      humidity: humidity != null ? Number(humidity) : 52,
      battery,
      at: timestamp,
    };

    if (![reading.moisture, reading.temp, reading.lux, reading.humidity].every((n) => Number.isFinite(Number(n)))) {
      return res.status(400).json({ error: 'Invalid sensor values' });
    }

    // Update in-memory plant + telemetry history (so dashboard charts can show immediately)
    store.telemetry.push(reading);
    if (store.telemetry.length > 500) store.telemetry = store.telemetry.slice(-400);

    plant.moisture = reading.moisture;
    plant.temp = reading.temp;
    plant.lux = reading.lux;
    plant.updatedAt = reading.at;
    if (bodyStatus != null && String(bodyStatus).trim()) plant.status = String(bodyStatus).trim();
    else plant.status = reading.moisture < 40 ? 'Moisture low' : reading.moisture < 50 ? 'Drying' : 'Healthy';

    // Link to user plant usage if we know uid
    if (uid) upsertUserPlantUsage(uid, [plantId], 'telemetry', () => {});

    // Persist to Supabase sensor tables (optional; requires sensors_sync_schema.sql)
    if (uid && supabaseAdmin) {
      try {
        const recordedAt = reading.at || new Date().toISOString();
        await upsertSupabaseSensorReading({
          uid,
          deviceId,
          plantId,
          sensorType: 'temperature',
          unit: '°C',
          value: reading.temp,
          recordedAt,
        });
        await upsertSupabaseSensorReading({
          uid,
          deviceId,
          plantId,
          sensorType: 'humidity',
          unit: '%',
          value: reading.humidity,
          recordedAt,
        });
        await upsertSupabaseSensorReading({
          uid,
          deviceId,
          plantId,
          sensorType: 'moisture',
          unit: '%',
          value: reading.moisture,
          recordedAt,
        });
        await upsertSupabaseSensorReading({
          uid,
          deviceId,
          plantId,
          sensorType: 'light',
          unit: 'lux',
          value: reading.lux,
          recordedAt,
        });
      } catch (e) {
        // Do not fail ingest if Supabase isn't ready; app still works via in-memory telemetry
        console.warn('Supabase persist failed (sensor-data):', e?.message || e);
      }
    }

    // Optional alert when moisture low
    if (reading.moisture < 40 && (store.plants || []).find((p) => p.id === plantId)) {
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

    res.json({ ok: true, plantId, deviceId });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Sensor ingest failed' });
  }
});

// --- API: Plant Bot image upload (ESP32-CAM base64 JSON) ---
// Firmware posts:
// { device_id, timestamp, image_b64 }
app.post('/api/upload-image', async (req, res) => {
  try {
    const body = req.body || {};
    const deviceId = String(body.device_id || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'device_id required' });

    const b64 = body.image_b64;
    if (!b64 || typeof b64 !== 'string') return res.status(400).json({ error: 'image_b64 required' });

    // Strip possible data URL prefix
    const cleanB64 = b64.includes(',') ? b64.split(',').pop() : b64;
    const buf = Buffer.from(cleanB64, 'base64');
    if (!buf || !buf.length) return res.status(400).json({ error: 'Invalid base64 image' });

    // Determine uid (optional) so we can store in Supabase with ownership
    let uid = null;
    const headerUid = await optionalFirebaseUid(req);
    if (headerUid) uid = String(headerUid).trim();
    if (!uid && body.uid) uid = String(body.uid).trim();
    if (!uid) {
      const headerIngest = req.headers['x-dew-ingest-token'] || req.headers['x-dew-device-token'];
      if (headerIngest && String(headerIngest).trim() !== '') {
        const u = await findUidByIngestToken(String(headerIngest).trim());
        if (u) uid = u;
      }
    }

    const tsIso = body.timestamp || new Date().toISOString();
    const tsSafe = new Date(tsIso).toISOString().replace(/[:.]/g, '-');
    const filename = `${deviceId}-${tsSafe}.jpg`;

    // Prefer Supabase Storage if configured; fall back to local disk.
    if (supabaseAdmin && uid) {
      const resolved = PLANTBOT_DEVICE_MAP[deviceId] || {};
      const derivedPlantId =
        typeof resolved.plantId === 'string' && resolved.plantId.trim()
          ? String(resolved.plantId).trim()
          : /^plant[-_]?(.+)$/i.test(deviceId)
            ? String(deviceId).replace(/^plant[-_]?/i, '').trim()
            : null;
      const plantId =
        derivedPlantId ||
        (store?.deskbotConfig?.plantId ? String(store.deskbotConfig.plantId) : null) ||
        (Array.isArray(store?.plants) && store.plants[0] ? store.plants[0].id : null) ||
        null;

      const storagePath = `${uid}/${deviceId}/${filename}`;
      const up = await supabaseAdmin.storage.from('plantbot-images').upload(storagePath, buf, {
        contentType: 'image/jpeg',
        upsert: true,
      });
      if (up.error) throw up.error;
      const { data: urlData } = supabaseAdmin.storage.from('plantbot-images').getPublicUrl(storagePath);
      const publicUrl = urlData?.publicUrl || null;

      // Optional DB row for easy listing
      try {
        await supabaseAdmin.from('plantbot_photos').insert({
          user_id: uid,
          device_id: deviceId,
          plant_id: plantId,
          captured_at: tsIso,
          storage_path: storagePath,
          public_url: publicUrl,
        });
      } catch (_) {}

      return res.json({ ok: true, stored: true, filename, storage: 'supabase', publicUrl });
    }

    if (!fs.existsSync(path.join(DATA_DIR, 'device-images'))) fs.mkdirSync(path.join(DATA_DIR, 'device-images'), { recursive: true });
    const outPath = path.join(DATA_DIR, 'device-images', filename);
    fs.writeFileSync(outPath, buf);

    res.json({ ok: true, stored: true, filename, storage: 'local' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Image upload failed' });
  }
});

// --- API: List Plant Bot images (Supabase or local fallback) ---
app.get('/api/plantbot/images', async (req, res) => {
  try {
    const deviceId = String(req.query.device_id || '').trim();
    const uidParam = String(req.query.uid || '').trim();
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

    // Prefer Supabase table if available (and user is authenticated)
    const uidToken = await optionalFirebaseUid(req);
    const uid = uidToken ? String(uidToken).trim() : uidParam || null;
    if (supabaseAdmin && uid) {
      const q = supabaseAdmin
        .from('plantbot_photos')
        .select('id,device_id,plant_id,captured_at,public_url,storage_path')
        .eq('user_id', uid)
        .order('captured_at', { ascending: false })
        .limit(limit);
      if (deviceId) q.eq('device_id', deviceId);
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ ok: true, storage: 'supabase', images: data || [] });
    }

    // Local fallback: return filenames (no auth)
    const dir = path.join(DATA_DIR, 'device-images');
    if (!fs.existsSync(dir)) return res.json({ ok: true, storage: 'local', images: [] });
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.jpg') && (!deviceId || f.startsWith(`${deviceId}-`)))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((f) => ({ filename: f }));
    return res.json({ ok: true, storage: 'local', images: files });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Could not list images' });
  }
});

// --- API: Plant Bot battery alert (JSON) ---
// Firmware posts:
// { device_id, battery, battery_pct, timestamp }
app.post('/api/battery-alert', async (req, res) => {
  try {
    const body = req.body || {};
    const deviceId = String(body.device_id || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'device_id required' });

    const batteryV = body.battery != null ? Number(body.battery) : null;
    const batteryPct = body.battery_pct != null ? Number(body.battery_pct) : null;
    const timestamp = body.timestamp || new Date().toISOString();

    if (batteryPct == null || !Number.isFinite(batteryPct)) return res.status(400).json({ error: 'battery_pct required' });

    const resolved = PLANTBOT_DEVICE_MAP[deviceId] || {};
    const derivedPlantId =
      typeof resolved.plantId === 'string' && resolved.plantId.trim()
        ? String(resolved.plantId).trim()
        : /^plant[-_]?(.+)$/i.test(deviceId)
          ? String(deviceId).replace(/^plant[-_]?/i, '').trim()
          : null;

    let plantId =
      derivedPlantId ||
      (store?.deskbotConfig?.plantId ? String(store.deskbotConfig.plantId) : null) ||
      (Array.isArray(store?.plants) && store.plants[0] ? store.plants[0].id : 'unknown');

    let plant = (store.plants || []).find((p) => p.id === plantId) || null;
    let plantName = plant?.name || 'Sensor Device';

    // Determine uid for display
    let uid = null;
    const headerUid = await optionalFirebaseUid(req);
    if (headerUid) uid = String(headerUid).trim();
    if (!uid && resolved.uid) uid = String(resolved.uid).trim();
    if (!uid && body.uid) uid = String(body.uid).trim();
    if (!uid) {
      const headerIngest = req.headers['x-dew-ingest-token'] || req.headers['x-dew-device-token'];
      if (headerIngest && String(headerIngest).trim() !== '') {
        const u = await findUidByIngestToken(String(headerIngest).trim());
        if (!u) return res.status(401).json({ error: 'Invalid ingest token' });
        uid = u;
      }
    }

    // Override plantId based on the user-selected Plant Bot binding.
    if (uid) {
      const chosenPlantId = await getPlantbotChoicePlantId(uid);
      if (chosenPlantId && chosenPlantId !== plantId) {
        plantId = chosenPlantId;
        plant = (store.plants || []).find((p) => p.id === plantId) || null;
        plantName = plant?.name || 'Sensor Device';
      }
    }

    const severity = batteryPct <= 10 ? 'error' : 'warning';
    const alert = {
      id: String(alertIdCounter++),
      userId: uid || null,
      plantId,
      plantName,
      type: 'battery',
      message: `Low battery: ${batteryPct}%${batteryV != null ? ` (${batteryV.toFixed(2)}V)` : ''}`,
      severity,
      at: timestamp,
      read: false,
      resolved: false,
      snoozedUntil: null,
    };
    insertSensorAlert(alert);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Battery alert failed' });
  }
});

// ============================================================
// IoT: Plant Board ingestion + Tearboard secure reads (SQLite)
// ============================================================

// --- API: Device registry (owner creates devices + tokens) ---
// Requires Firebase auth OR IoT admin token (DEW_IOT_ADMIN_TOKEN).
app.get('/api/iot/devices', async (req, res) => {
  try {
    const isAdmin = isIotAdminRequest(req);
    const uid = isAdmin ? null : await requireFirebaseUidOr401(req, res);
    if (!isAdmin && !uid) return;
    const rows = isAdmin
      ? await dbAllAsync(
          `SELECT device_id, device_name, created_at, last_seen_at, owner_uid
           FROM iot_devices
           ORDER BY created_at DESC`,
          []
        )
      : await dbAllAsync(
          `SELECT device_id, device_name, created_at, last_seen_at
           FROM iot_devices
           WHERE owner_uid = ?
           ORDER BY created_at DESC`,
          [uid]
        );
    res.json({ ok: true, devices: rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to list devices' });
  }
});

app.post('/api/iot/devices', async (req, res) => {
  try {
    const isAdmin = isIotAdminRequest(req);
    const uid = isAdmin ? null : await requireFirebaseUidOr401(req, res);
    if (!isAdmin && !uid) return;
    const body = req.body || {};
    const deviceId = String(body.device_id || body.deviceId || '').trim() || `plantboard_${crypto.randomBytes(6).toString('hex')}`;
    const deviceName = String(body.device_name || body.deviceName || deviceId).trim();
    const now = new Date().toISOString();

    await dbRunAsync(
      `INSERT INTO iot_devices (device_id, device_name, owner_uid, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(device_id) DO UPDATE SET
         device_name = excluded.device_name,
         owner_uid = excluded.owner_uid`,
      [deviceId, deviceName, uid, now]
    );

    // Create a new device token (plaintext returned once)
    const raw = makeApiToken('dev');
    const hash = hashApiToken(raw);
    await dbRunAsync(
      `INSERT INTO iot_device_tokens (device_id, token_hash, created_at, revoked_at)
       VALUES (?, ?, ?, NULL)`,
      [deviceId, hash, now]
    );

    res.json({ ok: true, device_id: deviceId, device_name: deviceName, device_token: raw });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to create device' });
  }
});

// Rename / edit device name.
app.patch('/api/iot/devices/:deviceId', async (req, res) => {
  try {
    const isAdmin = isIotAdminRequest(req);
    const uid = isAdmin ? null : await requireFirebaseUidOr401(req, res);
    if (!isAdmin && !uid) return;
    const deviceId = String(req.params.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const body = req.body || {};
    const deviceName = String(body.device_name || body.deviceName || '').trim();
    if (!deviceName) return res.status(400).json({ error: 'device_name required' });

    if (!isAdmin) {
      const owner = await dbGetAsync(`SELECT owner_uid FROM iot_devices WHERE device_id = ? LIMIT 1`, [deviceId]);
      if (!owner || String(owner.owner_uid || '') !== uid) return res.status(403).json({ error: 'Forbidden' });
    }

    await dbRunAsync(`UPDATE iot_devices SET device_name = ? WHERE device_id = ?`, [deviceName, deviceId]);
    res.json({ ok: true, device_id: deviceId, device_name: deviceName });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to update device' });
  }
});

app.post('/api/iot/devices/:deviceId/rotate-token', async (req, res) => {
  try {
    const isAdmin = isIotAdminRequest(req);
    const uid = isAdmin ? null : await requireFirebaseUidOr401(req, res);
    if (!isAdmin && !uid) return;
    const deviceId = String(req.params.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    if (!isAdmin) {
      const owner = await dbGetAsync(`SELECT owner_uid FROM iot_devices WHERE device_id = ? LIMIT 1`, [deviceId]);
      if (!owner || String(owner.owner_uid || '') !== uid) return res.status(403).json({ error: 'Forbidden' });
    }

    const now = new Date().toISOString();
    await dbRunAsync(`UPDATE iot_device_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL`, [now, deviceId]);

    const raw = makeApiToken('dev');
    const hash = hashApiToken(raw);
    await dbRunAsync(
      `INSERT INTO iot_device_tokens (device_id, token_hash, created_at, revoked_at)
       VALUES (?, ?, ?, NULL)`,
      [deviceId, hash, now]
    );

    res.json({ ok: true, device_id: deviceId, device_token: raw });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to rotate token' });
  }
});

// --- API: Data ingestion (Plant Boards) ---
// Auth: Authorization: Bearer <dev_...>  OR  x-dew-device-token: <dev_...>
app.post('/api/upload-data', async (req, res) => {
  try {
    const rawToken = readBearerOrHeaderToken(req, 'x-dew-device-token');
    const authedDeviceId = await findDeviceIdByDeviceToken(rawToken);
    if (!authedDeviceId) return res.status(401).json({ error: 'Invalid device token' });

    const body = req.body || {};
    const deviceId = String(body.device_id || body.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'device_id required' });
    if (deviceId !== authedDeviceId) return res.status(403).json({ error: 'Token does not match device_id' });

    const ts = body.timestamp ? new Date(body.timestamp).toISOString() : new Date().toISOString();
    const soil = body.soil_moisture != null ? Number(body.soil_moisture) : null;
    const light = body.light_intensity != null ? Number(body.light_intensity) : body.light != null ? Number(body.light) : null;
    const temperature = body.temperature != null ? Number(body.temperature) : null;
    const humidity = body.humidity != null ? Number(body.humidity) : null;
    const battery = body.battery != null ? Number(body.battery) : null;
    const batteryPct = body.battery_pct != null ? Number(body.battery_pct) : null;
    const status = body.device_status != null ? String(body.device_status).trim() : body.status != null ? String(body.status).trim() : null;

    await dbRunAsync(
      `INSERT INTO iot_sensor_readings
        (device_id, timestamp, soil_moisture, light_intensity, temperature, humidity, battery, battery_pct, device_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [deviceId, ts, soil, light, temperature, humidity, battery, batteryPct, status]
    );
    await dbRunAsync(`UPDATE iot_devices SET last_seen_at = ? WHERE device_id = ?`, [new Date().toISOString(), deviceId]);

    res.json({ ok: true, device_id: deviceId, timestamp: ts });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Upload failed' });
  }
});

// --- API (compat): Data ingestion (Plant Boards) ---
// Matches spec: POST /api/plant-data and requires device_token.
// Accepts token via:
// - Authorization: Bearer dev_...
// - x-dew-device-token: dev_...
// - JSON body: { device_token: "dev_..." }
app.post('/api/plant-data', async (req, res) => {
  try {
    const body = req.body || {};
    const bodyTok = body.device_token != null ? String(body.device_token).trim() : '';
    const headerTok = readBearerOrHeaderToken(req, 'x-dew-device-token');
    const rawToken = bodyTok || headerTok;
    if (!rawToken) return res.status(401).json({ error: 'device_token required' });

    const authedDeviceId = await findDeviceIdByDeviceToken(rawToken);
    if (!authedDeviceId) return res.status(401).json({ error: 'Invalid device token' });

    const deviceId = String(body.device_id || body.deviceId || authedDeviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'device_id required' });
    if (deviceId !== authedDeviceId) return res.status(403).json({ error: 'Token does not match device_id' });

    const ts = body.timestamp ? new Date(body.timestamp).toISOString() : new Date().toISOString();
    const soil = body.soil_moisture != null ? Number(body.soil_moisture) : null;
    const light = body.light_level != null ? Number(body.light_level) : body.light_intensity != null ? Number(body.light_intensity) : null;
    const temperature = body.temperature != null ? Number(body.temperature) : null;
    const humidity = body.humidity != null ? Number(body.humidity) : null;
    const status = body.device_status != null ? String(body.device_status).trim() : null;

    await dbRunAsync(
      `INSERT INTO iot_sensor_readings
        (device_id, timestamp, soil_moisture, light_intensity, temperature, humidity, battery, battery_pct, device_status)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      [deviceId, ts, soil, light, temperature, humidity, status]
    );
    await dbRunAsync(`UPDATE iot_devices SET last_seen_at = ? WHERE device_id = ?`, [new Date().toISOString(), deviceId]);

    res.json({ ok: true, device_id: deviceId, timestamp: ts });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Plant data upload failed' });
  }
});

// --- API (compat): Image upload (Plant Boards) ---
// POST /api/plant-image
// Auth: same as /api/plant-data (device_token via header or body)
// Payload:
// { device_id, timestamp, image_b64 }
// Stores file locally (data/device-images-iot) and records a row in iot_device_images.
app.post('/api/plant-image', async (req, res) => {
  try {
    const body = req.body || {};
    const bodyTok = body.device_token != null ? String(body.device_token).trim() : '';
    const headerTok = readBearerOrHeaderToken(req, 'x-dew-device-token');
    const rawToken = bodyTok || headerTok;
    if (!rawToken) return res.status(401).json({ error: 'device_token required' });

    const authedDeviceId = await findDeviceIdByDeviceToken(rawToken);
    if (!authedDeviceId) return res.status(401).json({ error: 'Invalid device token' });

    const deviceId = String(body.device_id || body.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'device_id required' });
    if (deviceId !== authedDeviceId) return res.status(403).json({ error: 'Token does not match device_id' });

    const b64 = body.image_b64;
    if (!b64 || typeof b64 !== 'string') return res.status(400).json({ error: 'image_b64 required' });

    const cleanB64 = b64.includes(',') ? b64.split(',').pop() : b64;
    const buf = Buffer.from(cleanB64, 'base64');
    if (!buf || !buf.length) return res.status(400).json({ error: 'Invalid base64 image' });

    const tsIso = body.timestamp ? new Date(body.timestamp).toISOString() : new Date().toISOString();
    const tsSafe = new Date(tsIso).toISOString().replace(/[:.]/g, '-');
    const filename = `${deviceId}-${tsSafe}.jpg`;

    const dir = path.join(DATA_DIR, 'device-images-iot');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, filename);
    fs.writeFileSync(outPath, buf);

    const storagePath = `device-images-iot/${filename}`;
    const imageUrl = `/data/${storagePath}`;

    // Record in unified IoT table
    await dbRunAsync(
      `INSERT INTO iot_device_images (device_id, timestamp, storage_path, public_url)
       VALUES (?, ?, ?, ?)`,
      [deviceId, tsIso, storagePath, null]
    );
    await dbRunAsync(`UPDATE iot_devices SET last_seen_at = ? WHERE device_id = ?`, [new Date().toISOString(), deviceId]);

    res.json({ ok: true, device_id: deviceId, timestamp: tsIso, filename });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Plant image upload failed' });
  }
});

// --- API: Tearboards (owner creates tearboards + maps devices) ---
app.get('/api/iot/tearboards', async (req, res) => {
  try {
    const uid = await requireFirebaseUidOr401(req, res);
    if (!uid) return;
    const rows = await dbAllAsync(
      `SELECT tearboard_id, name, created_at
       FROM tearboards
       WHERE owner_uid = ?
       ORDER BY created_at DESC`,
      [uid]
    );
    res.json({ ok: true, tearboards: rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to list tearboards' });
  }
});

app.post('/api/iot/tearboards', async (req, res) => {
  try {
    const uid = await requireFirebaseUidOr401(req, res);
    if (!uid) return;
    const body = req.body || {};
    const name = String(body.name || 'Tearboard').trim() || 'Tearboard';
    const tearboardId = String(body.tearboard_id || body.tearboardId || '').trim() || `tb_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    await dbRunAsync(
      `INSERT INTO tearboards (tearboard_id, name, owner_uid, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tearboard_id) DO UPDATE SET name = excluded.name`,
      [tearboardId, name, uid, now]
    );

    const raw = makeApiToken('tb');
    const hash = hashApiToken(raw);
    await dbRunAsync(
      `INSERT INTO tearboard_tokens (tearboard_id, token_hash, created_at, revoked_at)
       VALUES (?, ?, ?, NULL)`,
      [tearboardId, hash, now]
    );

    // Optional: map an initial device_id (must be owned by the user)
    const deviceId = String(body.device_id || body.deviceId || '').trim();
    if (deviceId) {
      const d = await dbGetAsync(`SELECT owner_uid FROM iot_devices WHERE device_id = ? LIMIT 1`, [deviceId]);
      if (d && String(d.owner_uid || '') === uid) {
        await dbRunAsync(
          `INSERT OR IGNORE INTO tearboard_device_map (tearboard_id, device_id, created_at) VALUES (?, ?, ?)`,
          [tearboardId, deviceId, now]
        );
      }
    }

    res.json({ ok: true, tearboard_id: tearboardId, name, tearboard_token: raw });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to create tearboard' });
  }
});

app.post('/api/iot/tearboards/:tearboardId/map-device', async (req, res) => {
  try {
    const uid = await requireFirebaseUidOr401(req, res);
    if (!uid) return;
    const tearboardId = String(req.params.tearboardId || '').trim();
    if (!tearboardId) return res.status(400).json({ error: 'tearboardId required' });

    const tb = await dbGetAsync(`SELECT owner_uid FROM tearboards WHERE tearboard_id = ? LIMIT 1`, [tearboardId]);
    if (!tb || String(tb.owner_uid || '') !== uid) return res.status(403).json({ error: 'Forbidden' });

    const deviceId = String((req.body || {}).device_id || (req.body || {}).deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'device_id required' });

    const d = await dbGetAsync(`SELECT owner_uid FROM iot_devices WHERE device_id = ? LIMIT 1`, [deviceId]);
    if (!d || String(d.owner_uid || '') !== uid) return res.status(403).json({ error: 'Device not owned by user' });

    const now = new Date().toISOString();
    await dbRunAsync(
      `INSERT OR IGNORE INTO tearboard_device_map (tearboard_id, device_id, created_at) VALUES (?, ?, ?)`,
      [tearboardId, deviceId, now]
    );
    res.json({ ok: true, tearboard_id: tearboardId, device_id: deviceId });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to map device' });
  }
});

// --- API: Tearboard data (locked down by tearboard token; no device_id param needed) ---
async function listMappedDevicesForTearboard(tearboardId) {
  const rows = await dbAllAsync(
    `SELECT device_id FROM tearboard_device_map WHERE tearboard_id = ? ORDER BY device_id ASC`,
    [tearboardId]
  );
  return (rows || []).map((r) => String(r.device_id));
}

app.get('/api/tearboard/get-device-data', async (req, res) => {
  try {
    const rawToken = readBearerOrHeaderToken(req, 'x-tearboard-token');
    const tearboardId = await findTearboardIdByToken(rawToken);
    if (!tearboardId) return res.status(401).json({ error: 'Invalid tearboard token' });

    const deviceIds = await listMappedDevicesForTearboard(tearboardId);
    if (!deviceIds.length) return res.json({ ok: true, tearboard_id: tearboardId, devices: [], readings: [] });

    // For now, return the latest reading for each mapped device (fast UI).
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const out = [];
    for (const did of deviceIds) {
      const readings = await dbAllAsync(
        `SELECT id, device_id, timestamp, soil_moisture, light_intensity, temperature, humidity, battery, battery_pct, device_status
         FROM iot_sensor_readings
         WHERE device_id = ?
         ORDER BY timestamp DESC
         LIMIT ?`,
        [did, limit]
      );
      const latestImage = await dbGetAsync(
        `SELECT id, device_id, timestamp, public_url, storage_path
         FROM iot_device_images
         WHERE device_id = ?
         ORDER BY timestamp DESC
         LIMIT 1`,
        [did]
      );
      out.push({ device_id: did, readings: readings || [], latest_image: latestImage || null });
    }

    res.json({ ok: true, tearboard_id: tearboardId, devices: deviceIds, data: out });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to fetch tearboard data' });
  }
});

// --- API (compat): Web app / Tearboard data fetch ---
// Matches spec: GET /api/data
// Auth via tearboard token:
// - Authorization: Bearer tb_...
// - x-tearboard-token: tb_...
// Returns ONLY mapped device data.
app.get('/api/data', async (req, res) => {
  try {
    const rawToken = readBearerOrHeaderToken(req, 'x-tearboard-token');
    const tearboardId = await findTearboardIdByToken(rawToken);
    if (!tearboardId) return res.status(401).json({ error: 'Invalid tearboard token' });

    const deviceIds = await listMappedDevicesForTearboard(tearboardId);
    if (!deviceIds.length) return res.json({ ok: true, tearboard_id: tearboardId, device_id: null, sensor_data: [], images: [] });

    // Default: first mapped device (1-to-1). If you later allow multi-map, add a query param.
    const deviceId = deviceIds[0];
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));

    const readings = await dbAllAsync(
      `SELECT id, device_id, timestamp, soil_moisture, light_intensity AS light_level, temperature, humidity, device_status
       FROM iot_sensor_readings
       WHERE device_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
      [deviceId, limit]
    );
    const imgs = await dbAllAsync(
      `SELECT id, device_id, timestamp, COALESCE(public_url, storage_path) AS image_url
       FROM iot_device_images
       WHERE device_id = ?
       ORDER BY timestamp DESC
       LIMIT 50`,
      [deviceId]
    );

    res.json({ ok: true, tearboard_id: tearboardId, device_id: deviceId, sensor_data: readings || [], images: imgs || [] });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to load data' });
  }
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
    .map(r => ({
      at: r.at,
      moisture: r.moisture,
      temp: r.temp,
      lux: r.lux,
      humidity: r.humidity,
      ...(r.battery != null ? { battery: r.battery } : {}),
    }));
  res.json(readings);
});

// --- API: Desk Bot config (GET = Desk Bot polls; POST = dashboard saves) ---
app.get('/api/deskbot-config', (req, res) => {
  res.json(store.deskbotConfig);
});

// --- API: Desk Bot device config (used by ESP32-C3 firmware poll) ---
// Firmware expects:
// {
//   mode: "expression" | "data",
//   mood: "happy" | "neutral" | "sad" | "angry",
//   plant_data: { temperature, humidity, light, soil }
// }
// Also returns legacy fields used by older firmware:
// - expression, display_mode, plant_data.health
app.get('/api/device/config', (req, res) => {
  const deviceId = String(req.query.device_id || '').trim();
  if (!deviceId) return res.status(400).json({ error: 'device_id required' });

  const cfg = store.deskbotConfig || {};
  const show = cfg.show || {};

  const mood = String(cfg.mood || 'happy').toLowerCase();

  // If any "show sensor" toggle is enabled, we treat the device as in "data" mode.
  const wantsData = !!(
    show.temp || show.humidity || show.light || show.moisture || show.health || show.weather
  );
  const mode = wantsData ? 'data' : 'expression';

  const plantId = cfg.plantId || (store.plants && store.plants[0] ? store.plants[0].id : null);
  const plant = plantId ? (store.plants || []).find((p) => p.id === plantId) : null;

  const soil = plant && plant.moisture != null ? Number(plant.moisture) : null;
  const plant_data = {
    temperature: plant && plant.temp != null ? Number(plant.temp) : null,
    humidity: plant && plant.humidity != null ? Number(plant.humidity) : null,
    light: plant && plant.lux != null ? Number(plant.lux) : null,
    soil,
    // legacy
    health: soil,
  };

  // Legacy mapping: pick a single display_mode for older firmware.
  let displayMode = 'temperature';
  if (show.temp) displayMode = 'temperature';
  else if (show.humidity) displayMode = 'humidity';
  else if (show.light) displayMode = 'light';
  else if (show.moisture || show.health) displayMode = 'health';

  res.json({
    mode,
    mood,
    plant_data,
    // Preferred by newer Desk Bot firmware (same values as plant_data)
    data: plant_data,
    expression: mood,

    // legacy fields (older firmware)
    display_mode: displayMode,
    theme: cfg.theme || null,
    plant_id: plantId,
  });
});

// Desk Bot telemetry (firmware POST; used for presence / debugging)
app.post('/api/device/status', (req, res) => {
  const deviceId = String(req.body?.device_id || req.query.device_id || '').trim();
  if (!deviceId) return res.status(400).json({ error: 'device_id required' });
  if (!store.deskbotDeviceReports || typeof store.deskbotDeviceReports !== 'object') {
    store.deskbotDeviceReports = {};
  }
  store.deskbotDeviceReports[deviceId] = {
    ...req.body,
    receivedAt: new Date().toISOString(),
  };
  res.json({ ok: true });
});

app.post('/api/deskbot-config', (req, res) => {
  const { plantId, line, theme, mood, show } = req.body;
  if (plantId !== undefined) store.deskbotConfig.plantId = plantId;
  if (line !== undefined) store.deskbotConfig.line = line;
  if (theme !== undefined) store.deskbotConfig.theme = theme;
  if (mood !== undefined) store.deskbotConfig.mood = mood;
  if (show !== undefined) store.deskbotConfig.show = { ...store.deskbotConfig.show, ...show };
  store.deskbotConfig.updatedAt = new Date().toISOString();
  const effectivePlantId = store.deskbotConfig.plantId;
  optionalFirebaseUid(req).then((tokenUid) => {
    if (tokenUid && effectivePlantId) {
      upsertUserPlantUsage(tokenUid, [effectivePlantId], 'deskbot', (err) => {
        if (!err) saveUserData();
      });
    }
    res.json(store.deskbotConfig);
  });
});

async function upsertSupabaseSensorReading({ uid, deviceId, plantId, sensorType, unit, value, recordedAt }) {
  if (!supabaseAdmin) return { stored: false };
  if (!uid) return { stored: false };
  if (value == null || Number.isNaN(Number(value))) return { stored: false };
  const v = Number(value);
  const at = recordedAt || new Date().toISOString();

  const { data: selRows, error: selErr } = await supabaseAdmin
    .from('sensors')
    .select('id')
    .eq('user_id', uid)
    .eq('sensor_type', sensorType)
    .eq('device_id', deviceId)
    .limit(1);
  if (selErr) throw selErr;
  let sensorId = Array.isArray(selRows) && selRows[0] ? selRows[0].id : null;
  if (!sensorId) {
    const { data: ins, error: insErr } = await supabaseAdmin
      .from('sensors')
      .insert({
        user_id: uid,
        sensor_type: sensorType,
        device_id: deviceId,
        plant_id: plantId || null,
      })
      .select('id')
      .single();
    if (insErr) throw insErr;
    sensorId = ins.id;
  }

  const { error: readErr } = await supabaseAdmin.from('sensor_readings').insert({
    sensor_id: sensorId,
    value: v,
    unit: unit || null,
    recorded_at: at,
  });
  if (readErr) throw readErr;
  return { stored: true };
}

// --- API: Sensor sync (mirror Plant Bot readings to Supabase) ---
// Some browsers / tools issue GET /api/sensors/sync (prefetch); avoid noisy 404 on dashboards.
app.get('/api/sensors/sync', (req, res) => {
  res.status(200).json({
    ok: true,
    message: 'Use POST with Authorization: Bearer <Firebase ID token> to sync sensor readings.',
  });
});
app.post('/api/sensors/sync', async (req, res) => {
  const uid = await optionalFirebaseUid(req);
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });
  const syncedAt = new Date().toISOString();
  if (!supabaseAdmin) {
    return res.json({
      ok: true,
      stored: false,
      syncedAt,
      message: 'Supabase not configured on server; live data still loads from the dashboard store.',
    });
  }
  try {
    const rows = await dbAllAsync(`SELECT plant_id FROM user_plant_usage WHERE uid = ?`, [uid]);
    const plantIds = [...new Set((rows || []).map((r) => r.plant_id).filter(Boolean))];
    const plantsById = new Map((store.plants || []).map((p) => [p.id, p]));
    const plants = plantIds.map((id) => plantsById.get(id)).filter(Boolean);
    if (plants.length === 0) {
      return res.json({
        ok: true,
        stored: false,
        syncedAt,
        plantsProcessed: 0,
        warning: 'No plants linked yet — connect a Plant Bot or open Bots to get started.',
      });
    }

    const metricDefs = [
      { sensor_type: 'temperature', unit: '°C', pick: (p) => p.temp },
      { sensor_type: 'humidity', unit: '%', pick: (p) => p.humidity },
      { sensor_type: 'moisture', unit: '%', pick: (p) => p.moisture },
      { sensor_type: 'light', unit: 'lux', pick: (p) => p.lux },
    ];

    for (const plant of plants) {
      const deviceId = `plant-${plant.id}`;
      for (const t of metricDefs) {
        const raw = t.pick(plant);
        if (raw == null || Number.isNaN(Number(raw))) continue;
        await upsertSupabaseSensorReading({
          uid,
          deviceId,
          plantId: plant.id,
          sensorType: t.sensor_type,
          unit: t.unit,
          value: raw,
          recordedAt: syncedAt,
        });
      }
    }

    await supabaseAdmin.from('sync_logs').insert({
      user_id: uid,
      status: 'success',
      synced_at: syncedAt,
    });

    res.json({
      ok: true,
      stored: true,
      syncedAt,
      plantsProcessed: plants.length,
    });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : 'Sync failed';
    try {
      await supabaseAdmin.from('sync_logs').insert({
        user_id: uid,
        status: 'failed',
        message: msg.slice(0, 500),
        synced_at: syncedAt,
      });
    } catch (_) {}
    res.status(500).json({ error: msg, syncedAt });
  }
});

app.get('/api/sensors/last-sync', async (req, res) => {
  const uid = await optionalFirebaseUid(req);
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });
  if (!supabaseAdmin) return res.json({ lastSync: null, status: null });
  const { data, error } = await supabaseAdmin
    .from('sync_logs')
    .select('synced_at, status')
    .eq('user_id', uid)
    .order('synced_at', { ascending: false })
    .limit(1);
  if (error) return res.status(500).json({ error: error.message });
  const row = data && data[0];
  res.json({ lastSync: row?.synced_at || null, status: row?.status || null });
});

function activityIconForWeatherAlertType(t) {
  const s = String(t || '').toLowerCase();
  if (s.includes('rain')) return 'ri-rainy-line';
  if (s.includes('wind')) return 'ri-windy-line';
  if (s.includes('temp') || s.includes('heat') || s.includes('cold') || s.includes('frost')) return 'ri-temp-hot-line';
  return 'ri-cloudy-line';
}

function activityIconForSensorType(t) {
  const s = String(t || '').toLowerCase();
  if (s.includes('moisture')) return 'ri-drop-fill';
  if (s.includes('temp')) return 'ri-temp-hot-line';
  return 'ri-alarm-warning-line';
}

// --- API: Activity (merged from DB: weather + sensor alerts + recent telemetry for user's plants) ---
app.get('/api/users/:uid/activity-feed', async (req, res) => {
  const paramUid = String(req.params.uid || '').trim();
  if (!(await requireUidMatchesToken(req, res, paramUid))) return;
  try {
    const [weatherRows, sensorRows, plantUsageRows] = await Promise.all([
      dbAllAsync(
        `SELECT id, alert_type, alert_message, weather_condition, created_at, is_read, status
         FROM weather_alerts WHERE user_id = ? ORDER BY datetime(created_at) DESC LIMIT 25`,
        [paramUid]
      ),
      dbAllAsync(
        `SELECT id, plant_id, plant_name, alert_type, message, severity, created_at, is_read, status
         FROM sensor_alerts WHERE user_id = ? ORDER BY datetime(created_at) DESC LIMIT 25`,
        [paramUid]
      ),
      dbAllAsync(`SELECT plant_id FROM user_plant_usage WHERE uid = ?`, [paramUid]),
    ]);

    const plantUsageIds = new Set((plantUsageRows || []).map((r) => r.plant_id));
    const merged = [];

    (weatherRows || []).forEach((r) => {
      merged.push({
        id: `w-${r.id}`,
        source: 'weather',
        icon: activityIconForWeatherAlertType(r.alert_type),
        title: r.alert_message || 'Weather alert',
        desc: [r.weather_condition, r.alert_type].filter(Boolean).join(' · ') || '',
        at: r.created_at,
        kind: 'alert',
        read: !!r.is_read,
        status: r.status || 'active',
      });
    });

    (sensorRows || []).forEach((r) => {
      merged.push({
        id: `s-${r.id}`,
        source: 'sensor',
        icon: activityIconForSensorType(r.alert_type),
        title: r.message || 'Sensor alert',
        desc: [r.plant_name, r.plant_id].filter(Boolean).join(' · ') || '',
        at: r.created_at,
        kind: 'alert',
        severity: r.severity,
        read: !!r.is_read,
        status: r.status || 'active',
      });
    });

    if (plantUsageIds.size && store.telemetry && store.telemetry.length) {
      const plantById = new Map((store.plants || []).map((p) => [p.id, p]));
      const recent = [...store.telemetry].filter((t) => t && plantUsageIds.has(t.plantId));
      recent.sort((a, b) => new Date(b.at) - new Date(a.at));
      recent.slice(0, 15).forEach((t) => {
        const name = plantById.get(t.plantId)?.name || t.plantId;
        const bits = [];
        if (t.moisture != null) bits.push(`${Math.round(Number(t.moisture))}% moisture`);
        if (t.temp != null) bits.push(`${Number(t.temp).toFixed(1)}°C`);
        if (t.lux != null) bits.push(`${Number(t.lux).toLocaleString()} lx`);
        merged.push({
          id: `t-${t.plantId}-${t.at}`,
          source: 'telemetry',
          icon: 'ri-wifi-line',
          title: 'Sensor data synced',
          desc: `${name}${bits.length ? ' · ' + bits.join(' · ') : ''}`,
          at: t.at,
          kind: 'telemetry',
          read: false,
          status: 'active',
        });
      });
    }

    merged.sort((a, b) => new Date(b.at) - new Date(a.at));
    res.json(merged.slice(0, 50));
  } catch (e) {
    res.status(500).json({ error: e.message || 'Activity feed failed' });
  }
});

// --- API: Activity (demo fallback when not using user feed) ---
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

// --- API: User location (for weather on dashboard) — one SQLite row per Firebase uid ---
app.get('/api/users/:uid/location', async (req, res) => {
  try {
    const paramUid = String(req.params.uid || '').trim();
    if (!(await requireUidMatchesToken(req, res, paramUid))) return;
    const loc = await getUserWeatherLocationPref(paramUid);
    if (!loc) return res.json(null);
    res.json(loc);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to load location' });
  }
});

app.put('/api/users/:uid/location', async (req, res) => {
  try {
    const paramUid = String(req.params.uid || '').trim();
    if (!(await requireUidMatchesToken(req, res, paramUid))) return;
    const ok = await saveUserWeatherLocationPref(paramUid, req.body || {});
    if (!ok) return res.status(400).json({ error: 'Invalid location payload' });
    const loc = await getUserWeatherLocationPref(paramUid);
    res.json(loc);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to save location' });
  }
});

// --- API: Plant Bot ingest token (auto per user; hash stored; plaintext shown once in dashboard) ---
app.get('/api/users/:uid/ingest-token', async (req, res) => {
  try {
    const paramUid = String(req.params.uid || '').trim();
    if (!(await requireUidMatchesToken(req, res, paramUid))) return;
    const row = await dbGetAsync('SELECT 1 AS ok FROM user_ingest_token WHERE uid = ?', [paramUid]);
    res.json({ exists: !!row });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to read ingest token' });
  }
});

app.post('/api/users/:uid/ingest-token', async (req, res) => {
  try {
    const paramUid = String(req.params.uid || '').trim();
    if (!(await requireUidMatchesToken(req, res, paramUid))) return;
    const regenerate = !!(req.body && req.body.regenerate);
    const row = await dbGetAsync('SELECT 1 AS ok FROM user_ingest_token WHERE uid = ?', [paramUid]);
    const exists = !!row;
    if (exists && !regenerate) {
      return res.json({ exists: true, token: null });
    }
    const raw = `dew_${crypto.randomBytes(32).toString('hex')}`;
    const hash = hashIngestTokenSecret(raw);
    const now = new Date().toISOString();
    await dbRunAsync(
      `INSERT INTO user_ingest_token (uid, token_hash, created_at) VALUES (?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at`,
      [paramUid, hash, now]
    );
    try {
      await dbRunAsync(
        `INSERT OR IGNORE INTO users (uid, display_name, email, updated_at) VALUES (?, '', '', ?)`,
        [paramUid, now]
      );
    } catch (_) {}
    res.json({ exists: true, token: raw });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to create ingest token' });
  }
});

// --- API: Device-friendly weather endpoint (uses saved location) ---
// GET /api/weather?user_id=...
app.get('/api/weather', async (req, res) => {
  const userId = String(req.query.user_id || '').trim();
  if (!userId) return res.status(400).json({ error: 'user_id required' });

  try {
    const tokenUid = await optionalFirebaseUid(req);
    if (tokenUid && tokenUid !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const loc = await getUserWeatherLocationPref(userId);
    if (!loc || loc.latitude == null || loc.longitude == null) {
      return res.status(200).json({ ok: false, error: 'Location not set' });
    }

    const lat = Number(loc.latitude);
    const lon = Number(loc.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(200).json({ ok: false, error: 'Invalid location' });
    }

    const cacheKey = `v2:${lat},${lon}`;
    const now = Date.now();
    const cached = serverWeatherCache.get(cacheKey);
    if (cached && cached.at && now - cached.at < DEVICE_WEATHER_CACHE_MS) {
      return res.json(cached.payload);
    }

    const weather = await fetchOpenMeteoWeather(lat, lon);
    const payload = {
      ok: true,
      location: {
        city: loc.city || '',
        state: loc.state || '',
        country: loc.country || '',
        latitude: lat,
        longitude: lon,
        last_updated: loc.last_updated || null,
      },
      weather: weather.current,
      forecast: weather.forecast,
      /** Daily averages for saved map area (Open-Meteo today), for dashboard metrics row. */
      areaToday: weather.areaToday || null,
    };

    serverWeatherCache.set(cacheKey, { at: now, payload });
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Weather failed' });
  }
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

// --- API: Supabase anon key (embedded in client). After rls_and_storage_lockdown.sql,
// use only for legacy paths (e.g. create-community fallback); uploads use /api/upload/*.
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
  // Auto-join creator/admin to their own community unless they leave later.
  if (creatorFirebaseUid) {
    const now = new Date().toISOString();
    db.run(
      'INSERT OR IGNORE INTO community_members (community_slug, uid, joined_at) VALUES (?, ?, ?)',
      [slug, creatorFirebaseUid, now]
    );
  }
  res.status(201).json({ id: inserted?.id, slug });
});

// --- API: Create post (enforces private/restricted membership) ---
app.post('/api/communities/:slug/posts', async (req, res) => {
  const slug = String(req.params.slug || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  if (!slug) return res.status(400).json({ error: 'Invalid slug' });
  if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });
  let claims;
  try {
    claims = await requireFirebaseUserClaims(req);
  } catch (e) {
    return res.status(401).json({ error: e.message || 'Unauthorized' });
  }
  const uid = claims.uid;
  try {
    if (!(await canPostToCommunity(slug, uid))) return res.status(403).json({ error: 'Not allowed' });
    const { data: comm, error: cErr } = await supabaseAdmin.from('communities').select('id').eq('slug', slug).single();
    if (cErr || !comm) return res.status(404).json({ error: 'Community not found' });

    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title required' });
    const body = req.body.body == null || req.body.body === '' ? null : String(req.body.body).trim() || null;
    const authorUsername = String(
      req.body.author_username || claims.displayName || claims.name || claims.username || 'Warden'
    ).trim();
    let tags = req.body.tags;
    if (typeof tags === 'string') {
      try {
        tags = JSON.parse(tags);
      } catch (_) {
        tags = tags.split(',').map((t) => t.trim()).filter(Boolean);
      }
    }
    if (!Array.isArray(tags)) tags = [];
    let media_urls = req.body.media_urls;
    let media_types = req.body.media_types;
    if (typeof media_urls === 'string') {
      try {
        media_urls = JSON.parse(media_urls);
      } catch (_) {
        media_urls = [];
      }
    }
    if (typeof media_types === 'string') {
      try {
        media_types = JSON.parse(media_types);
      } catch (_) {
        media_types = [];
      }
    }
    if (!Array.isArray(media_urls)) media_urls = [];
    if (!Array.isArray(media_types)) media_types = [];
    const image_url = req.body.image_url ? String(req.body.image_url).trim() || null : media_urls[0] || null;

    const basePayload = {
      community_id: comm.id,
      title,
      body,
      author_username: authorUsername,
      author_firebase_uid: uid,
      image_url,
      tags,
      score: 0,
      comment_count: 0,
    };

    let inserted = null;
    if (media_urls.length) {
      const r = await supabaseAdmin
        .from('posts')
        .insert({ ...basePayload, media_urls, media_types })
        .select('id')
        .single();
      if (!r.error && r.data) inserted = r.data;
    }
    if (!inserted) {
      const r2 = await supabaseAdmin.from('posts').insert(basePayload).select('id').single();
      if (r2.error || !r2.data) return res.status(500).json({ error: r2.error?.message || 'Insert failed' });
      inserted = r2.data;
    }
    res.json({ ok: true, id: String(inserted.id) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to create post' });
  }
});

// --- API: Media uploads (service role; Storage lockdown blocks anon writes) ---
app.post('/api/upload/avatar', upload.single('file'), async (req, res) => {
  try {
    const uid = await requireFirebaseUser(req);
    if (!supabaseAdmin) return res.status(503).json({ error: 'Supabase not configured' });
    const file = req.file;
    if (!file || !file.buffer) return res.status(400).json({ error: 'file required' });
    const path = `${String(uid).trim()}/avatar.jpg`;
    const { error: upErr } = await supabaseAdmin.storage.from('avatars').upload(path, file.buffer, {
      contentType: file.mimetype || 'image/jpeg',
      upsert: true,
      cacheControl: '3600',
    });
    if (upErr) return res.status(500).json({ error: upErr.message || 'Upload failed' });
    const { data: urlData } = supabaseAdmin.storage.from('avatars').getPublicUrl(path);
    res.json({ ok: true, url: urlData?.publicUrl || null });
  } catch (e) {
    const msg = e?.message || String(e);
    if (/bearer|token|Unauthorized/i.test(msg)) return res.status(401).json({ error: 'Unauthorized' });
    res.status(500).json({ error: msg });
  }
});

app.post('/api/upload/community-post-media', uploadLarge.single('file'), async (req, res) => {
  try {
    const uid = await requireFirebaseUser(req);
    if (!supabaseAdmin) return res.status(503).json({ error: 'Supabase not configured' });
    const slug = String(req.body.communitySlug || req.body.slug || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '');
    if (!slug) return res.status(400).json({ error: 'communitySlug required' });
    if (!(await canPostToCommunity(slug, uid))) return res.status(403).json({ error: 'Not allowed' });
    const file = req.file;
    if (!file || !file.buffer) return res.status(400).json({ error: 'file required' });
    const idx = String(req.body.index || '0').replace(/[^0-9]/g, '') || '0';
    const orig = String(req.body.originalName || file.originalname || 'media');
    const safeBase = orig.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-\.]/g, '').slice(0, 120) || 'media';
    let ext = String(req.body.ext || path.extname(safeBase).slice(1) || 'bin')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '') || 'bin';
    if (ext === 'jpeg') ext = 'jpg';
    const baseNoExt = safeBase.replace(/\.[^.]+$/, '');
    const storagePath = `${slug}/posts/${Date.now()}_${idx}_${baseNoExt}.${ext}`;
    const buckets = ['community-posts', 'community-assets'];
    let lastErr = null;
    for (const bucket of buckets) {
      const { error: upErr } = await supabaseAdmin.storage.from(bucket).upload(storagePath, file.buffer, {
        contentType: file.mimetype || 'application/octet-stream',
        upsert: false,
        cacheControl: '3600',
      });
      if (!upErr) {
        const { data: urlData } = supabaseAdmin.storage.from(bucket).getPublicUrl(storagePath);
        return res.json({ ok: true, url: urlData?.publicUrl || null });
      }
      lastErr = upErr;
    }
    return res.status(500).json({ error: lastErr?.message || 'Upload failed for all buckets' });
  } catch (e) {
    const msg = e?.message || String(e);
    if (/bearer|token|Unauthorized/i.test(msg)) return res.status(401).json({ error: 'Unauthorized' });
    res.status(500).json({ error: msg });
  }
});

/** Attach images/GIFs to comments (same buckets as posts; Storage locked to service role). */
app.post('/api/upload/comment-media', uploadLarge.single('file'), async (req, res) => {
  try {
    const uid = await requireFirebaseUser(req);
    if (!supabaseAdmin) return res.status(503).json({ error: 'Supabase not configured' });
    const postId = String(req.body.postId || '').trim();
    const slug = String(req.body.communitySlug || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '');
    if (!postId || !slug) return res.status(400).json({ error: 'postId and communitySlug required' });
    if (!(await canPostToCommunity(slug, uid))) return res.status(403).json({ error: 'Not allowed' });
    const { data: post, error: pErr } = await supabaseAdmin.from('posts').select('id,community_id').eq('id', postId).single();
    if (pErr || !post) return res.status(404).json({ error: 'Post not found' });
    const { data: comm, error: cErr } = await supabaseAdmin.from('communities').select('slug').eq('id', post.community_id).single();
    if (cErr || !comm || String(comm.slug || '').toLowerCase() !== slug) return res.status(400).json({ error: 'Community mismatch' });
    const file = req.file;
    if (!file || !file.buffer) return res.status(400).json({ error: 'file required' });
    const orig = String(req.body.originalName || file.originalname || 'media');
    const safeBase = orig.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-\.]/g, '').slice(0, 120) || 'media';
    let ext = String(req.body.ext || path.extname(safeBase).slice(1) || 'bin')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '') || 'bin';
    if (ext === 'jpeg') ext = 'jpg';
    const baseNoExt = safeBase.replace(/\.[^.]+$/, '');
    const uq = String(uid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'user';
    const storagePath = `${slug}/comments/${postId}/${Date.now()}_${uq}_${baseNoExt}.${ext}`;
    const buckets = ['community-posts', 'community-assets'];
    let lastErr = null;
    for (const bucket of buckets) {
      const { error: upErr } = await supabaseAdmin.storage.from(bucket).upload(storagePath, file.buffer, {
        contentType: file.mimetype || 'application/octet-stream',
        upsert: false,
        cacheControl: '3600',
      });
      if (!upErr) {
        const { data: urlData } = supabaseAdmin.storage.from(bucket).getPublicUrl(storagePath);
        return res.json({ ok: true, url: urlData?.publicUrl || null });
      }
      lastErr = upErr;
    }
    return res.status(500).json({ error: lastErr?.message || 'Upload failed for all buckets' });
  } catch (e) {
    const msg = e?.message || String(e);
    if (/bearer|token|Unauthorized/i.test(msg)) return res.status(401).json({ error: 'Unauthorized' });
    res.status(500).json({ error: msg });
  }
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
    return res.status(403).json({ error: 'Only the community creator can update this community' });
  }
  const updates = {};
  if (!communityCreatorUid) updates.creator_firebase_uid = uid;
  if (typeof req.body.description === 'string') updates.description = req.body.description.trim() || null;
  const rawStatus = typeof req.body.status === 'string' ? req.body.status.trim().toLowerCase() : '';
  if (['public', 'private', 'restricted'].includes(rawStatus)) updates.status = rawStatus;
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
