-- Dew: sensor sync storage (Plant Bot readings mirrored to Supabase)
-- Run in Supabase SQL editor after creating project.
-- Server uses SUPABASE_SERVICE_ROLE_KEY to insert (bypasses RLS).

create table if not exists public.sensors (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  sensor_type text not null check (sensor_type in (
    'temperature', 'humidity', 'moisture', 'light', 'air_quality', 'ph'
  )),
  device_id text not null,
  plant_id text,
  created_at timestamptz not null default now(),
  unique (user_id, sensor_type, device_id)
);

create index if not exists sensors_user_id_idx on public.sensors (user_id);
create index if not exists sensors_plant_idx on public.sensors (plant_id);

create table if not exists public.sensor_readings (
  id uuid primary key default gen_random_uuid(),
  sensor_id uuid not null references public.sensors (id) on delete cascade,
  value double precision,
  unit text,
  recorded_at timestamptz not null default now()
);

create index if not exists sensor_readings_sensor_time_idx
  on public.sensor_readings (sensor_id, recorded_at desc);

create table if not exists public.sync_logs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  status text not null check (status in ('success', 'failed')),
  message text,
  synced_at timestamptz not null default now()
);

create index if not exists sync_logs_user_time_idx on public.sync_logs (user_id, synced_at desc);

comment on table public.sensors is 'Logical sensors per user + Plant Bot device';
comment on table public.sensor_readings is 'Time-series readings from sync';
comment on table public.sync_logs is 'Audit log for manual / dashboard sync';

-- After creating tables, run rls_sensor_and_weather_tables.sql in the SQL editor
-- to enable RLS (recommended; server uses service role and bypasses RLS).
