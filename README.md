# DEW · Eco Warden

**IoT plant monitoring, community feed, and garden dashboard.**

DEW Eco Warden is a web app for tracking plants with connected sensors, viewing analytics, and taking part in a Reddit-style community around gardening and eco topics.

---

## Features

- **Responsive layout** – **Breakpoints:** mobile **≤640px**, tablet **641–1023px**, desktop **≥1024px**. Safe-area insets for notched devices, touch-friendly controls (44px+ where it matters), and a **slide-out menu** (☰) below the desktop breakpoint so the sidebar stays off-canvas on phones and tablets. Widen past **1024px** for the full persistent sidebar. Grids (metrics, insights) collapse 4 → 2 → 1 columns; charts resize with the container (`ResizeObserver`).
- **Dashboard** – Plants, sensor readings, and activity
- **Bots** – Sidebar **Bots** opens `/bots` (unified Plant Bot + Desk Bot). Routes: `/bots`, `/bots/plant-bot`, `/bots/desk-bot`. Lazy-loaded `bots-pages.js`.
- **Sync Data** – Sidebar **Sync Data** opens `/sync-data`: sensor cards (temp, humidity, soil, light), sparklines, optimal-range bar, **Sync now** (writes readings to Supabase when configured). Lazy-loaded `sync-data-page.js`.
- **Plant analytics** – Charts and summaries (24h, 7d, 30d, all time) for plants with devices
- **Community** – Create communities, post, comment, and browse by topic (public / restricted / private)
- **Profiles** – User profile, favourites, and settings
- **Supabase** – Storage for community banners/logos and post images; optional Firebase Auth for admin edit. **Sensor sync** (optional): run `supabase/sensors_sync_schema.sql` in the Supabase SQL editor, then `POST /api/sensors/sync` (with Firebase Bearer token) mirrors Plant Bot readings into `sensors`, `sensor_readings`, and `sync_logs`. If you use `weather_preferences.sql` or those sensor tables, also run **`supabase/rls_sensor_and_weather_tables.sql`** so Row Level Security is enabled (clears **“RLS Disabled in Public”** in Supabase advisors; the server uses the service role key and keeps working).

### Demo Mode (no login)

On the **login** page, **Try Demo** opens the full dashboard with **simulated** plants, sensors, charts, bots, sync, and community lists. Data is generated client-side (`sessionStorage` flag `dewDemoMode`); `POST`/`PUT`/`PATCH` requests return success without persisting. Use **Exit Demo** (sidebar, above Sign out) or **Sign Out** to return to login. Firebase config still loads from `/api/config/firebase` when the API is running (or `VITE_FIREBASE_*` in dev).

---

## New laptop / teammate setup

**Sharing only `package.json` is not enough.** Whoever runs the app needs the **full repository** (clone from GitHub or a zip of the project **excluding** `node_modules`). The folder you open in VS Code must contain **`package.json`** next to `server.js`.

1. **Install [Node.js LTS](https://nodejs.org)** (includes `npm`). Restart the terminal after installing.
2. **Clone or copy the whole project**, then open that folder in VS Code:
   ```bash
   git clone <YOUR_GITHUB_REPO_URL>.git
   cd <repo-folder>
   ```
3. **Install dependencies** (must be run in the same directory as `package.json`):
   ```bash
   npm install
   ```
4. **Environment file:** copy `.env.example` to `.env`. Fill in Firebase and Supabase values. Get real secrets from the team lead over a **private** channel (not WhatsApp class groups)—**never commit `.env`**.
5. **Firebase Admin (optional but common):** place the service account JSON in the project root (or another path) and set `GOOGLE_APPLICATION_CREDENTIALS` in `.env` to point to it. Do **not** commit that JSON file.
6. **Windows PowerShell:** if `npm` errors with *running scripts is disabled*, run once:
   ```powershell
   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
   ```
   Or use **Command Prompt** / run `npm.cmd install` instead of `npm install`.

**If `npm install` says it cannot find `package.json`:** you are in the wrong folder (e.g. only `.env` was copied). Open the repo root that contains `package.json`, or clone again from GitHub.

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
3. Run the app (pick one):

   **Single server (simplest)** — API + static files on port **3000**:
   ```bash
   npm start
   ```
   Open [http://localhost:3000](http://localhost:3000).

   **Vite dev server (HMR on port 5173)** — needs **two** terminals, because Vite only proxies `/api` to the backend:
   ```bash
   # Terminal 1 — API on :3000
   npm run dev:api
   ```
   ```bash
   # Terminal 2 — Vite on :5173
   npm run dev
   ```
   Open [http://localhost:5173](http://localhost:5173). If you see `http proxy error … ECONNREFUSED` or **502** on `/api/...`, start the API in terminal 1 or set **`VITE_FIREBASE_*`** in `.env` (same values as `FIREBASE_*`, see `.env.example`) so login can load Firebase config without the API.

4. **Test a production build on localhost** (minified bundles, same as deploy — still needs the API for `/api` routes):

   ```bash
   # Terminal 1 — API on :3000
   npm run dev:api
   ```
   ```bash
   # Terminal 2 — build + Vite preview on :4173 (proxies /api → :3000)
   npm run preview:prod
   ```
   Open [http://localhost:4173](http://localhost:4173).

   Use this before shipping to catch build-only issues. **Sign-in still needs network** (Firebase); “offline” here means **running everything on your machine**, not airplane mode. For fully offline auth you’d use the [Firebase Emulator Suite](https://firebase.google.com/docs/emulator-suite) (not wired in this repo by default).

---

## Plant Bot / ESP32 → dashboard (signed-in Plant Fleet)

The dashboard **Plant Fleet** lists plants tied to your account after usage is recorded (Desk Bot save, dashboard, or sensor data).

### Simple steps (everyone)

1. **Sign in** to the DEW dashboard in your browser.
2. In **Plant Fleet**, open **How to connect your plant sensor**.
3. **Copy** your private key and paste it into your Wi‑Fi plant gadget (or the test script on your computer) **once**.
4. When the device sends readings, your plants show up in the table. Use **Regenerate** only if you lose the key or replace the device.

### For developers: API and examples

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

The **Activity** panel loads **`GET /api/users/:uid/activity-feed`** (requires sign-in): it merges **weather alerts**, **plant sensor alerts**, and recent **telemetry sync** lines (for plants in your fleet) from SQLite / server state.

### Weather location (per user)

Your saved map location is stored in the server **SQLite** database (`user_weather_location`, **one row per Firebase user id**). User A’s coordinates never overwrite user B’s. It powers the dashboard weather hero, **`GET /api/weather?user_id=...`**, and **weather alerts**. It **only changes** when that user saves location (Settings, “Change location”, or the first-run prompt)—not on every visit. **GET/PUT `/api/users/:uid/location`** require a valid **Firebase Bearer** token matching the URL `uid` whenever Firebase Admin is configured. Requests **without** `Authorization` are rejected (**401**). If Firebase Admin is not configured, the server returns **503** unless you set **`DEW_ALLOW_UNAUTH_LOCATION=1`** (local dev only—never in production).

---

## Deployment (Vercel + Railway)

The production setup uses **`vercel.json`**: the static app is built to **`dist/`** and **`/api/*`** is proxied to the backend on Railway (`dew.up.railway.app`).

| What changed | Where to deploy |
|--------------|-----------------|
| Dashboard UI, `public/`, Vite | **Vercel** (static) |
| `server.js`, API, SQLite logic | **Railway** (or your API host) |

**One-command production deploy (Vercel CLI):**

```bash
npm run deploy
```

Requires a one-time `npx vercel login` and `npx vercel link` in this folder (or connect the Git repo in the Vercel dashboard for automatic deploys on push).

Preview (non-prod) URL:

```bash
npm run deploy:preview
```

**Cursor:** the project rule *dew-build-and-deploy* tells the assistant to run **`npm run build`** after client changes and to use **`npm run deploy`** when you ask to ship or go live.

---

## Tech stack

- **Node.js** (Express), **SQLite** (local data), **Supabase** (community + storage)
- **Firebase** (optional auth)
- Front end: vanilla JS, Chart.js, Remix Icon

---

## License

MIT
