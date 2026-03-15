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

## Tech stack

- **Node.js** (Express), **SQLite** (local data), **Supabase** (community + storage)
- **Firebase** (optional auth)
- Front end: vanilla JS, Chart.js, Remix Icon

---

## License

MIT
