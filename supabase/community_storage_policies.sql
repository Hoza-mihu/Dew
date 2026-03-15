-- Community-based Storage policies for Supabase
-- Run this in Supabase SQL Editor after community_schema.sql.
-- Requires: communities and community_members tables; bucket "community-assets" (and optionally "community-posts") created in Dashboard.
--
-- IMPORTANT: If you get "must be owner of table objects" (42501), the Storage section
-- below cannot be run in the SQL Editor. Run only PART A (migration), then create
-- storage policies in the Dashboard: Storage → Policies → New policy → For full
-- customization. See docs/COMMUNITY_STORAGE_SETUP.md for the policy expressions.

-- =============================================================================
-- PART A – MIGRATION (run this in SQL Editor; you own public.communities)
-- =============================================================================
alter table public.communities drop constraint if exists communities_status_check;
alter table public.communities add constraint communities_status_check
  check (status in ('public', 'restricted', 'private'));
alter table public.communities add column if not exists is_mature boolean not null default false;
alter table public.communities add column if not exists creator_firebase_uid text;

-- =============================================================================
-- PART B – STORAGE POLICIES (run only if you do NOT get 42501)
-- If you get "must be owner of table objects", skip to Storage → Policies in the
-- Dashboard and add policies there (see docs/COMMUNITY_STORAGE_SETUP.md).
-- =============================================================================
-- alter table storage.objects enable row level security;

-- Convention: store files under path "{community_slug}/..." so we can enforce per-community rules.

-- [STORAGE POLICIES SKIPPED – use Dashboard to avoid "must be owner of table objects"]
-- In Supabase, storage.objects is owned by the storage system. Create policies in the UI:
--   1. Storage → Policies → New policy → "For full customization"
--   2. For community-assets: add "Allow public read" (SELECT, bucket_id = 'community-assets')
--      and "Allow uploads" (INSERT) if you want client uploads; or rely on server (POST/PATCH)
--      with SUPABASE_SERVICE_ROLE_KEY for banner/logo.
-- See docs/COMMUNITY_STORAGE_SETUP.md for details.
