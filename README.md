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
  "uid": "YOUR_FIREBASE_USER_ID"
}
```

**Recommended (Option A):** put your **Firebase user id** in the JSON as **`uid`**. In the DEW dashboard, open **Plant Fleet → “Plant Bot · use this uid in JSON”** and copy the value into your ESP32 firmware or `scripts/telemetry_sender.py` (`DEW_UID` in `.env`).

Optional: send **`Authorization: Bearer <Firebase ID token>`** instead of `uid` in the body; the server verifies it if **Firebase Admin** is configured (`FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`).

While the dashboard is open, the app **polls your plant fleet** periodically so new bot readings show up without a full page refresh.

### Weather location (per user)

Your saved map location is stored in the server **SQLite** database (`user_weather_location`) and is used for the dashboard weather hero, **`GET /api/weather?user_id=...`** (devices), and **weather alerts**. It is **only updated** when you save location (Settings, “Change location”, or the first-run prompt)—not overwritten automatically on each visit.

---

## Tech stack

- **Node.js** (Express), **SQLite** (local data), **Supabase** (community + storage)
- **Firebase** (optional auth)
- Front end: vanilla JS, Chart.js, Remix Icon

---

## License

MIT
