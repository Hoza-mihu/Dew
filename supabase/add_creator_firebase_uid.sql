-- Run this in Supabase SQL Editor if you get "Could not find the 'creator_firebase_uid' column".
-- Adds the column so community creation and Edit (admin-only) work.

alter table public.communities add column if not exists creator_firebase_uid text;
create index if not exists idx_communities_creator_firebase_uid on public.communities(creator_firebase_uid) where creator_firebase_uid is not null;
