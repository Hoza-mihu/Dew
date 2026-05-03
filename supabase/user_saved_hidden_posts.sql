-- Optional: durable saved / hidden post lists in Postgres (mirrored from API).
-- Run in Supabase SQL Editor. The Node server also keeps SQLite copies for local/dev.

create table if not exists public.user_saved_posts (
  uid text not null,
  post_id text not null,
  created_at timestamptz not null default now(),
  primary key (uid, post_id)
);

create index if not exists idx_user_saved_posts_uid on public.user_saved_posts (uid, created_at desc);

create table if not exists public.user_hidden_posts (
  uid text not null,
  post_id text not null,
  created_at timestamptz not null default now(),
  primary key (uid, post_id)
);

create index if not exists idx_user_hidden_posts_uid on public.user_hidden_posts (uid, created_at desc);

alter table public.user_saved_posts enable row level security;
alter table public.user_hidden_posts enable row level security;

-- No policies: only service role (server) accesses these tables, same as other admin-backed tables.
