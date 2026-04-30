-- Threaded (Reddit/Instagram-style) comments, community-isolated
-- Run in Supabase SQL Editor after community_schema.sql
--
-- Design goals:
-- - Logical isolation by community_id (tenant key)
-- - Adjacency list for nesting (parent_comment_id)
-- - Fast reads via composite indexes + cursor pagination
-- - Simple moderation deletes (author/mod/admin enforced in API; optional RLS below)

-- =============================================================================
-- 1) Threaded comments table
-- =============================================================================
create table if not exists public.post_comments (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  -- Firebase-auth support (this repo uses Firebase for web auth).
  author_firebase_uid text,
  author_display_name text,
  body text not null,
  parent_comment_id uuid references public.post_comments(id) on delete cascade,
  created_at timestamptz not null default now(),
  deleted_at timestamptz

  -- NOTE: Postgres does not allow subqueries in CHECK constraints.
  -- Parent post/community consistency is enforced via a trigger below.
);

-- Core read patterns:
-- - Load top-level comments: where post_id = ? and parent_comment_id is null order by created_at
-- - Load replies for a parent: where post_id = ? and parent_comment_id = ? order by created_at
-- - Moderation ops: where community_id = ?
create index if not exists idx_post_comments_post_root_created
  on public.post_comments(post_id, created_at asc)
  where parent_comment_id is null and deleted_at is null;

create index if not exists idx_post_comments_post_parent_created
  on public.post_comments(post_id, parent_comment_id, created_at asc)
  where deleted_at is null;

create index if not exists idx_post_comments_community_created
  on public.post_comments(community_id, created_at desc);

create index if not exists idx_post_comments_author_created
  on public.post_comments(author_id, created_at desc);

create index if not exists idx_post_comments_author_firebase_uid
  on public.post_comments(author_firebase_uid)
  where author_firebase_uid is not null;

-- Safe re-run for existing installs (adds Firebase columns if table already existed).
alter table public.post_comments
  add column if not exists author_firebase_uid text;
alter table public.post_comments
  add column if not exists author_display_name text;

-- Enforce: parent_comment_id must reference a comment with the same post_id + community_id.
create or replace function public.validate_post_comment_parent()
returns trigger as $$
declare
  p_post_id uuid;
  p_community_id uuid;
begin
  if new.parent_comment_id is null then
    return new;
  end if;

  select pc2.post_id, pc2.community_id
    into p_post_id, p_community_id
  from public.post_comments pc2
  where pc2.id = new.parent_comment_id;

  if p_post_id is null then
    raise exception 'Invalid parent_comment_id: parent does not exist';
  end if;

  if p_post_id <> new.post_id then
    raise exception 'Invalid parent_comment_id: parent belongs to different post';
  end if;

  if p_community_id <> new.community_id then
    raise exception 'Invalid parent_comment_id: parent belongs to different community';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_validate_post_comment_parent on public.post_comments;
create trigger trg_validate_post_comment_parent
  before insert or update of parent_comment_id, post_id, community_id on public.post_comments
  for each row
  execute function public.validate_post_comment_parent();

-- =============================================================================
-- 2) Comment votes (optional; mirrors your SQLite comment_votes)
-- =============================================================================
create table if not exists public.comment_votes (
  comment_id uuid not null references public.post_comments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  value smallint not null check (value in (1, -1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create index if not exists idx_comment_votes_comment on public.comment_votes(comment_id);
create index if not exists idx_comment_votes_user on public.comment_votes(user_id);

-- =============================================================================
-- 3) Keep posts.comment_count in sync (cheap aggregate per post)
-- =============================================================================
create or replace function public.update_post_comment_count()
returns trigger as $$
declare
  pid uuid;
begin
  pid := coalesce(new.post_id, old.post_id);
  update public.posts
    set comment_count = (
      select count(*) from public.post_comments
      where post_id = pid and deleted_at is null
    ),
    updated_at = now()
  where id = pid;
  return coalesce(new, old);
end;
$$ language plpgsql security definer;

drop trigger if exists post_comments_update_count on public.post_comments;
create trigger post_comments_update_count
  after insert or update or delete on public.post_comments
  for each row execute function public.update_post_comment_count();

-- =============================================================================
-- 4) Minimal RLS (optional; if you keep writes server-only you can skip this)
-- =============================================================================
alter table public.post_comments enable row level security;
alter table public.comment_votes enable row level security;

-- Anyone can read comments (like Instagram/Reddit)
drop policy if exists "read post_comments" on public.post_comments;
create policy "read post_comments"
on public.post_comments for select
using (true);

-- Only authenticated users can insert their own comments
drop policy if exists "insert own post_comments" on public.post_comments;
create policy "insert own post_comments"
on public.post_comments for insert
with check (auth.uid() = author_id);

-- Delete: author can delete their own comment
drop policy if exists "delete own post_comments" on public.post_comments;
create policy "delete own post_comments"
on public.post_comments for delete
using (auth.uid() = author_id);

-- Votes: authenticated users can read and upsert their own vote
drop policy if exists "read comment_votes" on public.comment_votes;
create policy "read comment_votes"
on public.comment_votes for select
using (true);

drop policy if exists "upsert own comment_votes" on public.comment_votes;
create policy "upsert own comment_votes"
on public.comment_votes for insert
with check (auth.uid() = user_id);

drop policy if exists "update own comment_votes" on public.comment_votes;
create policy "update own comment_votes"
on public.comment_votes for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "delete own comment_votes" on public.comment_votes;
create policy "delete own comment_votes"
on public.comment_votes for delete
using (auth.uid() = user_id);

