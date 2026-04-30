-- Add Firebase UID to posts for robust "author can delete" checks.
-- Run in Supabase SQL Editor (safe to re-run).

alter table public.posts
  add column if not exists author_firebase_uid text;

create index if not exists idx_posts_author_firebase_uid
  on public.posts(author_firebase_uid)
  where author_firebase_uid is not null;

