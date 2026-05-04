-- Firebase UID based voting persistence (server/service-role writes)
-- Run in Supabase SQL editor. Safe to re-run.

create table if not exists public.post_votes (
  post_id uuid not null references public.posts(id) on delete cascade,
  uid text not null,
  value smallint not null check (value in (1, -1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (post_id, uid)
);

create index if not exists idx_post_votes_post_id on public.post_votes(post_id);
create index if not exists idx_post_votes_uid on public.post_votes(uid);

create table if not exists public.comment_votes (
  comment_id uuid not null references public.post_comments(id) on delete cascade,
  uid text not null,
  value smallint not null check (value in (1, -1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (comment_id, uid)
);

create index if not exists idx_comment_votes_comment_id on public.comment_votes(comment_id);
create index if not exists idx_comment_votes_uid on public.comment_votes(uid);

alter table public.post_votes enable row level security;
alter table public.comment_votes enable row level security;
