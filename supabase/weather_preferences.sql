-- Weather location (Firebase uid as text).
-- Recommended for serverless (Vercel) so location persists across deploys/instances.
-- The Node server will still mirror into SQLite/JSON for local dev, but Supabase is treated as primary when configured.

create extension if not exists "uuid-ossp";

create table if not exists public.user_weather_preferences (
  -- One row per Firebase user.
  user_id text primary key,
  location_name text,
  city text,
  state text,
  country text,
  latitude double precision not null,
  longitude double precision not null,
  updated_at timestamp with time zone default now(),
  created_at timestamp with time zone default now()
);

create index if not exists idx_user_weather_preferences_user_id on public.user_weather_preferences (user_id);

-- Enable RLS: run ../rls_sensor_and_weather_tables.sql (covers this table and sensor tables).
