-- Dew: lock down Supabase for Firebase + Node API architecture
-- =============================================================================
-- Run in Supabase SQL Editor AFTER your tables exist (community_schema,
-- threaded_comments_schema, etc.).
--
-- Why: The web app uses Firebase Auth + anon Supabase key in the browser.
-- Permissive RLS (e.g. "insert posts to public communities") lets anyone with
-- the anon key bypass your Node server's privacy rules. Service role (server)
-- bypasses RLS, so API routes keep working.
--
-- Also run after deploying server routes:
--   POST /api/upload/avatar
--   POST /api/upload/community-post-media
--   POST /api/upload/comment-media
-- so the browser no longer uploads directly to Storage.
--
-- STORAGE: Restrictive policies block anon/authenticated INSERT/UPDATE/DELETE
-- on avatars + community buckets. Other buckets (e.g. plantbot-images) are
-- unaffected if they only have permissive policies.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Drop table RLS policies (RLS stays ON → no policies ⇒ no client access)
-- ---------------------------------------------------------------------------

-- profiles
drop policy if exists "Profiles read" on public.profiles;
drop policy if exists "Profiles update own" on public.profiles;

-- communities
drop policy if exists "Communities read" on public.communities;
drop policy if exists "Communities insert" on public.communities;
drop policy if exists "Communities update" on public.communities;

-- community_members (Supabase table, if present)
drop policy if exists "Community members read" on public.community_members;
drop policy if exists "Community members insert" on public.community_members;
drop policy if exists "Community members update" on public.community_members;

-- posts
drop policy if exists "Posts read" on public.posts;
drop policy if exists "Posts insert" on public.posts;
drop policy if exists "Posts update" on public.posts;
drop policy if exists "Posts delete" on public.posts;

-- legacy comments table (if used)
drop policy if exists "Comments read" on public.comments;
drop policy if exists "Comments insert" on public.comments;
drop policy if exists "Comments delete" on public.comments;

-- votes
drop policy if exists "Votes read" on public.votes;
drop policy if exists "Votes insert" on public.votes;
drop policy if exists "Votes update" on public.votes;

-- gamification (optional reads were wide open)
drop policy if exists "Badges read" on public.badges;
drop policy if exists "Achievements read" on public.achievements;
drop policy if exists "User badges read" on public.user_badges;
drop policy if exists "User achievements read" on public.user_achievements;

drop policy if exists "Community stats read" on public.community_stats;

-- threaded comments (from threaded_comments_schema.sql)
drop policy if exists "read post_comments" on public.post_comments;
drop policy if exists "insert own post_comments" on public.post_comments;
drop policy if exists "delete own post_comments" on public.post_comments;

drop policy if exists "read comment_votes" on public.comment_votes;
drop policy if exists "upsert own comment_votes" on public.comment_votes;
drop policy if exists "update own comment_votes" on public.comment_votes;
drop policy if exists "delete own comment_votes" on public.comment_votes;

-- Ensure RLS remains enabled (idempotent)
alter table if exists public.profiles enable row level security;
alter table if exists public.communities enable row level security;
alter table if exists public.community_members enable row level security;
alter table if exists public.posts enable row level security;
alter table if exists public.comments enable row level security;
alter table if exists public.votes enable row level security;
alter table if exists public.badges enable row level security;
alter table if exists public.achievements enable row level security;
alter table if exists public.user_badges enable row level security;
alter table if exists public.user_achievements enable row level security;
alter table if exists public.community_stats enable row level security;
alter table if exists public.post_comments enable row level security;
alter table if exists public.comment_votes enable row level security;

-- ---------------------------------------------------------------------------
-- 2) Block PostgREST RPC from browser (create_community is SECURITY DEFINER)
-- ---------------------------------------------------------------------------

do $$
begin
  revoke all on function public.create_community(text, text, text, text, text, text, text, boolean, text) from public;
  revoke all on function public.create_community(text, text, text, text, text, text, text, boolean, text) from anon;
  revoke all on function public.create_community(text, text, text, text, text, text, text, boolean, text) from authenticated;
exception
  when undefined_function then
    raise notice 'create_community(...) not found; skipped revoke (run community_schema.sql first).';
end $$;

-- ---------------------------------------------------------------------------
-- 3) Storage: block client writes to sensitive buckets (service role bypasses)
-- ---------------------------------------------------------------------------
-- Shortcut: to apply only this section, run storage_sensitive_buckets_lockdown.sql
-- Drop old permissive policies if you named them in Dashboard (adjust names):
-- drop policy if exists "Allow public uploads" on storage.objects;

drop policy if exists "dew_restrict_anon_sensitive_storage_ins" on storage.objects;
drop policy if exists "dew_restrict_auth_sensitive_storage_ins" on storage.objects;
drop policy if exists "dew_restrict_anon_sensitive_storage_upd" on storage.objects;
drop policy if exists "dew_restrict_auth_sensitive_storage_upd" on storage.objects;
drop policy if exists "dew_restrict_anon_sensitive_storage_del" on storage.objects;
drop policy if exists "dew_restrict_auth_sensitive_storage_del" on storage.objects;

-- INSERT: anon/authenticated cannot write to these buckets (RESTRICTIVE).
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

-- UPDATE / DELETE: same buckets
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

-- NOTE: Public SELECT on these buckets is unchanged. If a bucket is "public",
-- URLs still load in <img>. To make media private, switch buckets to non-public
-- and serve signed URLs from your API (future work).
