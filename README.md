# DEW · Eco Warden

**IoT plant monitoring, community feed, and garden dashboard.**

DEW Eco Warden is a web app for tracking plants with connected sensors, viewing analytics, and taking part in a Reddit-style community around gardening and eco topics.

---

## Features

- **Dashboard** – Plants, sensor readings, and activity
- **Plant analytics** – Charts and summaries (24h, 7d, 30d, all time) for plants with devices
- **Community** – Create communities, post, comment, and browse by topic (public / restricted / private)
- **Profiles** – User profile, favourites, and settings
- **Supabase** – Storage for community banners/logos and post images; optional Firebase Auth for admin edit

---

## Quick start

1. Clone the repo and install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and set:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY` (and `SUPABASE_SERVICE_ROLE_KEY` for community create/edit with images)
   - Firebase config (e.g. `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID`) if using auth
   - Optional: `GOOGLE_APPLICATION_CREDENTIALS` path to Firebase service account JSON for admin edit
3. Run the app:
   ```bash
   npm start
   ```
   Or for development with auto-reload: `npm run dev`

4. Open [http://localhost:3000](http://localhost:3000).

---

## Plant Bot / ESP32 → dashboard (signed-in Plant Fleet)

The dashboard **Plant Fleet** lists plants tied to your account after usage is recorded (Desk Bot save, dashboard, or sensor data).

**`POST /api/telemetry`** accepts readings, for example:

```json
{
  "plantId": "pothos",
  "moisture": 72,
  "temp": 23,
  "lux": 2100,
  "ingestToken": "dew_…"
}
```

**Recommended:** each account gets a **device ingest token** automatically the first time you open the dashboard (**Plant Fleet → device token**). Put that string in your ESP32 / `DEW_INGEST_TOKEN` in `.env` for `scripts/telemetry_sender.py`. The server stores only a hash; you don’t need to copy your Firebase uid manually.

**Legacy:** JSON **`uid`** with your Firebase user id still works. You can also send **`Authorization: Bearer <Firebase ID token>`** if **Firebase Admin** is configured on the server.

While the dashboard is open, the app **polls your plant fleet** periodically so new bot readings show up without a full page refresh.

### Weather location (per user)

Your saved map location is stored in the server **SQLite** database (`user_weather_location`, **one row per Firebase user id**). User A’s coordinates never overwrite user B’s. It powers the dashboard weather hero, **`GET /api/weather?user_id=...`**, and **weather alerts**. It **only changes** when that user saves location (Settings, “Change location”, or the first-run prompt)—not on every visit. **GET/PUT `/api/users/:uid/location`** require a valid **Firebase Bearer** token matching the URL `uid` whenever Firebase Admin is configured. Requests **without** `Authorization` are rejected (**401**). If Firebase Admin is not configured, the server returns **503** unless you set **`DEW_ALLOW_UNAUTH_LOCATION=1`** (local dev only—never in production).

---

## Tech stack

- **Node.js** (Express), **SQLite** (local data), **Supabase** (community + storage)
- **Firebase** (optional auth)
- Front end: vanilla JS, Chart.js, Remix Icon

---

## License

MIT
