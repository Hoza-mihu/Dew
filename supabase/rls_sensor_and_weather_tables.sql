-- Dew: enable Row Level Security on sensor + weather mirror tables
-- Run in Supabase SQL Editor after sensors_sync_schema.sql and weather_preferences.sql.
--
-- Why: Supabase advisors flag "RLS Disabled in Public" when anyone with the anon key
-- could read/write these tables. This app only accesses them from Node (server.js) using
-- SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS — so enabling RLS blocks public API access
-- without changing app behavior.
--
-- If you later query these tables from the browser with the anon key, add policies
-- (e.g. auth.uid() or a custom claim) — do not rely on Firebase uid in Supabase JWT
-- unless you wire a matching auth setup.

alter table if exists public.sensor_readings enable row level security;
alter table if exists public.sensors enable row level security;
alter table if exists public.sync_logs enable row level security;
alter table if exists public.user_weather_preferences enable row level security;

-- Optional: document intent (no policies = only service_role / backend can access)
comment on table public.sensor_readings is 'Time-series readings from sync';
comment on table public.sensors is 'Logical sensors per user + Plant Bot device (RLS on; server access via service role)';
comment on table public.sync_logs is 'Audit log for manual / dashboard sync (RLS on; server access via service role)';
comment on table public.user_weather_preferences is 'Optional Supabase mirror for weather location (RLS on; server access via service role)';
