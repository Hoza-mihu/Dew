-- Dew: Storage-only lockdown (run in Supabase SQL Editor)
-- =============================================================================
-- Use this if you already applied table RLS elsewhere, or you only ran part of
-- rls_and_storage_lockdown.sql (e.g. DELETE policies only).
--
-- This script (re)creates all six restrictive policies on storage.objects so
-- anon + authenticated cannot INSERT/UPDATE/DELETE in:
--   avatars, community-assets, community-posts
--
-- Your Node API uses the service role → bypasses RLS (uploads still work).
-- Comment media uses the same buckets as post media → no extra buckets here.
-- =============================================================================

drop policy if exists "dew_restrict_anon_sensitive_storage_ins" on storage.objects;
drop policy if exists "dew_restrict_auth_sensitive_storage_ins" on storage.objects;
drop policy if exists "dew_restrict_anon_sensitive_storage_upd" on storage.objects;
drop policy if exists "dew_restrict_auth_sensitive_storage_upd" on storage.objects;
drop policy if exists "dew_restrict_anon_sensitive_storage_del" on storage.objects;
drop policy if exists "dew_restrict_auth_sensitive_storage_del" on storage.objects;

create policy "dew_restrict_anon_sensitive_storage_ins"
on storage.objects
as restrictive
for insert
to anon
with check (
  bucket_id not in ('avatars', 'community-assets', 'community-posts')
);

create policy "dew_restrict_auth_sensitive_storage_ins"
on storage.objects
as restrictive
for insert
to authenticated
with check (
  bucket_id not in ('avatars', 'community-assets', 'community-posts')
);

create policy "dew_restrict_anon_sensitive_storage_upd"
on storage.objects
as restrictive
for update
to anon
using (bucket_id not in ('avatars', 'community-assets', 'community-posts'))
with check (bucket_id not in ('avatars', 'community-assets', 'community-posts'));

create policy "dew_restrict_auth_sensitive_storage_upd"
on storage.objects
as restrictive
for update
to authenticated
using (bucket_id not in ('avatars', 'community-assets', 'community-posts'))
with check (bucket_id not in ('avatars', 'community-assets', 'community-posts'));

create policy "dew_restrict_anon_sensitive_storage_del"
on storage.objects
as restrictive
for delete
to anon
using (bucket_id not in ('avatars', 'community-assets', 'community-posts'));

create policy "dew_restrict_auth_sensitive_storage_del"
on storage.objects
as restrictive
for delete
to authenticated
using (bucket_id not in ('avatars', 'community-assets', 'community-posts'));
