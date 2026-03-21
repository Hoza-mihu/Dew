-- Optional Supabase mirror for weather location (Firebase uid as text).
-- Canonical storage for Railway/Node is SQLite table `user_weather_location` in server.js.
-- Use this only if you want a Supabase copy for analytics; the app works without it.

create extension if not exists "uuid-ossp";

create table if not exists public.user_weather_preferences (
  id uuid primary key default uuid_generate_v4(),
  user_id text not null,
  location_name text,
  latitude double precision,
  longitude double precision,
  created_at timestamp default now()
);

create index if not exists idx_user_weather_preferences_user_id on public.user_weather_preferences (user_id);

