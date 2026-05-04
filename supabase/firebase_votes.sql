-- Firebase UID based voting persistence (server/service-role writes)
-- Run in Supabase SQL editor. Safe to re-run.

-- IMPORTANT: use *_firebase names to avoid conflicts with existing tables like
-- `public.votes` (auth user_id) or other legacy `post_votes` schemas.

create table if not exists public.post_votes_firebase (
  post_id uuid not null references public.posts(id) on delete cascade,
  uid text not null,
  value smallint not null check (value in (1, -1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (post_id, uid)
);

create index if not exists idx_post_votes_firebase_post_id on public.post_votes_firebase(post_id);
create index if not exists idx_post_votes_firebase_uid on public.post_votes_firebase(uid);

create table if not exists public.comment_votes_firebase (
  comment_id uuid not null references public.post_comments(id) on delete cascade,
  uid text not null,
  value smallint not null check (value in (1, -1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (comment_id, uid)
);

create index if not exists idx_comment_votes_firebase_comment_id on public.comment_votes_firebase(comment_id);
create index if not exists idx_comment_votes_firebase_uid on public.comment_votes_firebase(uid);

alter table public.post_votes_firebase enable row level security;
alter table public.comment_votes_firebase enable row level security;
