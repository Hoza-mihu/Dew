-- Eco-Eco / Dew Community Platform – Supabase schema
-- Run this in Supabase SQL Editor to create tables, RLS, and functions.
-- Requires: Supabase project with Auth enabled.

-- =============================================================================
-- 1. PROFILES (extends auth.users for display name, avatar, privacy)
-- =============================================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  display_name text,
  avatar_url text,
  is_private boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- =============================================================================
-- 2. COMMUNITIES (r/CommunityName)
-- =============================================================================
create table if not exists public.communities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  banner_url text,
  logo_url text,
  category text not null default 'Other',
  created_by uuid references auth.users(id) on delete set null,
  status text not null default 'public' check (status in ('public', 'restricted', 'private')),
  is_mature boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  member_count int default 0,
  post_count int default 0,
  creator_firebase_uid text
);

create index if not exists idx_communities_slug on public.communities(slug);
create index if not exists idx_communities_creator_firebase_uid on public.communities(creator_firebase_uid) where creator_firebase_uid is not null;
create index if not exists idx_communities_category on public.communities(category);
create index if not exists idx_communities_post_count on public.communities(post_count desc);

-- =============================================================================
-- 3. COMMUNITY MEMBERS (join state, roles)
-- =============================================================================
create table if not exists public.community_members (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'moderator', 'member')),
  joined_at timestamptz default now(),
  muted boolean default false,
  unique(community_id, user_id)
);

create index if not exists idx_community_members_community on public.community_members(community_id);
create index if not exists idx_community_members_user on public.community_members(user_id);

-- =============================================================================
-- 4. POSTS (belong to a community)
-- =============================================================================
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  author_username text not null default 'warden',
  title text not null,
  body text,
  image_url text,
  -- Multi-media support (Reddit-like): store ordered URLs + simple kind labels.
  -- Example: media_types = ['image','video','image']
  media_urls text[] default '{}'::text[],
  media_types text[] default '{}'::text[],
  tags text[] default '{}',
  score int default 0,
  comment_count int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_posts_community on public.posts(community_id);
create index if not exists idx_posts_created_at on public.posts(created_at desc);
create index if not exists idx_posts_score on public.posts(score desc);

-- =============================================================================
-- 5. COMMENTS
-- =============================================================================
create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  author_username text not null default 'warden',
  body text not null,
  created_at timestamptz default now()
);

create index if not exists idx_comments_post on public.comments(post_id);

-- =============================================================================
-- 6. VOTES (one vote per user per post: 1 up, -1 down)
-- =============================================================================
create table if not exists public.votes (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  value smallint not null check (value in (1, -1)),
  primary key (post_id, user_id)
);

create index if not exists idx_votes_post on public.votes(post_id);

-- Trigger: keep posts.score in sync with votes
create or replace function public.update_post_score()
returns trigger as $$
begin
  update public.posts
  set score = (select coalesce(sum(value), 0) from public.votes where post_id = coalesce(new.post_id, old.post_id)),
      updated_at = now()
  where id = coalesce(new.post_id, old.post_id);
  return coalesce(new, old);
end;
$$ language plpgsql security definer;

drop trigger if exists votes_update_score on public.votes;
create trigger votes_update_score
  after insert or update or delete on public.votes
  for each row execute function public.update_post_score();

-- =============================================================================
-- 7. BADGES & ACHIEVEMENTS
-- =============================================================================
create table if not exists public.badges (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  icon_url text
);

create table if not exists public.achievements (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  criteria text
);

create table if not exists public.user_badges (
  user_id uuid not null references auth.users(id) on delete cascade,
  badge_id uuid not null references public.badges(id) on delete cascade,
  earned_at timestamptz default now(),
  primary key (user_id, badge_id)
);

create table if not exists public.user_achievements (
  user_id uuid not null references auth.users(id) on delete cascade,
  achievement_id uuid not null references public.achievements(id) on delete cascade,
  earned_at timestamptz default now(),
  primary key (user_id, achievement_id)
);

-- =============================================================================
-- 8. COMMUNITY STATS (weekly analytics)
-- =============================================================================
create table if not exists public.community_stats (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  week_start date not null,
  weekly_visitors int default 0,
  weekly_posts int default 0,
  weekly_comments int default 0,
  unique(community_id, week_start)
);

create index if not exists idx_community_stats_community_week on public.community_stats(community_id, week_start desc);

-- =============================================================================
-- 9. ROW LEVEL SECURITY (RLS) – enable and basic policies
-- =============================================================================
alter table public.profiles enable row level security;
alter table public.communities enable row level security;
alter table public.community_members enable row level security;
alter table public.posts enable row level security;
alter table public.comments enable row level security;
alter table public.votes enable row level security;
alter table public.badges enable row level security;
alter table public.achievements enable row level security;
alter table public.user_badges enable row level security;
alter table public.user_achievements enable row level security;
alter table public.community_stats enable row level security;

-- Profiles: read public or own
drop policy if exists "Profiles read" on public.profiles;
drop policy if exists "Profiles update own" on public.profiles;
create policy "Profiles read" on public.profiles for select using (not is_private or id = auth.uid());
create policy "Profiles update own" on public.profiles for update using (id = auth.uid());

-- Communities: read all public; members read private if member
drop policy if exists "Communities read" on public.communities;
drop policy if exists "Communities insert" on public.communities;
drop policy if exists "Communities update" on public.communities;
create policy "Communities read" on public.communities for select using (
  status = 'public' or exists (select 1 from public.community_members m where m.community_id = id and m.user_id = auth.uid())
);
create policy "Communities insert" on public.communities for insert with check (true);
create policy "Communities update" on public.communities for update using (created_by = auth.uid() or exists (select 1 from public.community_members m where m.community_id = communities.id and m.user_id = auth.uid() and m.role = 'admin'));

-- Community members: read members of communities you're in or public communities
drop policy if exists "Community members read" on public.community_members;
drop policy if exists "Community members insert" on public.community_members;
drop policy if exists "Community members update" on public.community_members;
create policy "Community members read" on public.community_members for select using (true);
create policy "Community members insert" on public.community_members for insert with check (user_id = auth.uid());
create policy "Community members update" on public.community_members for update using (user_id = auth.uid());

-- Posts: read if community is public or you're a member
drop policy if exists "Posts read" on public.posts;
drop policy if exists "Posts insert" on public.posts;
drop policy if exists "Posts update" on public.posts;
create policy "Posts read" on public.posts for select using (
  exists (select 1 from public.communities c where c.id = posts.community_id and (c.status = 'public' or exists (select 1 from public.community_members m where m.community_id = c.id and m.user_id = auth.uid())))
);

-- Posts: allow posting to public communities without requiring "Join".
-- For restricted/private communities, require membership.
create policy "Posts insert" on public.posts for insert with check (
  -- Allow anyone (including Supabase anon) to insert into public communities.
  exists (
    select 1
    from public.communities c
    where c.id = posts.community_id
      and c.status = 'public'
  )
  or exists (
    -- Restricted/private: must be a member (requires Supabase auth uid).
    select 1
    from public.community_members m
    where m.community_id = posts.community_id
      and m.user_id = auth.uid()
  )
);
create policy "Posts update" on public.posts for update using (author_id = auth.uid());

-- Posts: only the author OR an admin/moderator of the community can delete.
drop policy if exists "Posts delete" on public.posts;
create policy "Posts delete" on public.posts for delete using (
  author_id = auth.uid()
  or exists (
    select 1
    from public.community_members m
    where m.community_id = posts.community_id
      and m.user_id = auth.uid()
      and m.role in ('admin', 'moderator')
  )
);

-- Comments: read/write when post is readable
drop policy if exists "Comments read" on public.comments;
drop policy if exists "Comments insert" on public.comments;
create policy "Comments read" on public.comments for select using (true);
create policy "Comments insert" on public.comments for insert with check (author_id = auth.uid());

-- Comments: only the comment author OR an admin/moderator of the post's community can delete.
drop policy if exists "Comments delete" on public.comments;
create policy "Comments delete" on public.comments for delete using (
  author_id = auth.uid()
  or exists (
    select 1
    from public.posts p
    join public.community_members m
      on m.community_id = p.community_id
    where p.id = comments.post_id
      and m.user_id = auth.uid()
      and m.role in ('admin', 'moderator')
  )
);

-- Votes: insert/update own
drop policy if exists "Votes read" on public.votes;
drop policy if exists "Votes insert" on public.votes;
drop policy if exists "Votes update" on public.votes;
create policy "Votes read" on public.votes for select using (true);
create policy "Votes insert" on public.votes for insert with check (user_id = auth.uid());
create policy "Votes update" on public.votes for update using (user_id = auth.uid());

-- Badges / achievements: read only
drop policy if exists "Badges read" on public.badges;
drop policy if exists "Achievements read" on public.achievements;
drop policy if exists "User badges read" on public.user_badges;
drop policy if exists "User achievements read" on public.user_achievements;
create policy "Badges read" on public.badges for select using (true);
create policy "Achievements read" on public.achievements for select using (true);
create policy "User badges read" on public.user_badges for select using (true);
create policy "User achievements read" on public.user_achievements for select using (true);

-- Community stats: read for all
drop policy if exists "Community stats read" on public.community_stats;
create policy "Community stats read" on public.community_stats for select using (true);

-- =============================================================================
-- 10. SEED: no default communities (only communities created via the app are shown)
-- =============================================================================
-- To remove any previously seeded demo communities, run in SQL Editor:
--   delete from public.communities where slug in ('indoor-plants','plant-care-help','smart-plant-tech','hydroponics','plant-showcases','pest-disease-help');

-- =============================================================================
-- 11. SEED: default badges and achievements (optional)
-- =============================================================================
insert into public.badges (name, description) values
  ('Helpful Gardener', 'Helped others with plant care'),
  ('Plant Expert', 'Consistent expert contributions'),
  ('Community Builder', 'Created or grew a community'),
  ('Discussion Starter', 'Started engaging discussions')
on conflict (name) do nothing;

insert into public.achievements (name, description, criteria) values
  ('Top Poster', 'Most posts in a community', 'Highest post count in period'),
  ('Top Commenter', 'Most comments', 'Highest comment count'),
  ('Super Contributor', 'High votes received', 'Posts with most upvotes'),
  ('Community Elder', 'Long-term active member', 'Member for 6+ months')
on conflict (name) do nothing;

-- =============================================================================
-- 12. HELPER: create community and set creator as admin
-- =============================================================================
create or replace function public.create_community(
  p_name text,
  p_slug text,
  p_description text default null,
  p_category text default 'Other',
  p_banner_url text default null,
  p_logo_url text default null,
  p_status text default 'public',
  p_is_mature boolean default false,
  p_creator_firebase_uid text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  c_id uuid;
  uid uuid := auth.uid();
begin
  insert into public.communities (name, slug, description, category, created_by, banner_url, logo_url, member_count, status, is_mature, creator_firebase_uid)
  values (p_name, lower(p_slug), p_description, p_category, uid, p_banner_url, p_logo_url, case when uid is not null then 1 else 0 end, coalesce(p_status, 'public'), coalesce(p_is_mature, false), nullif(trim(p_creator_firebase_uid), ''))
  returning id into c_id;
  if uid is not null then
    insert into public.community_members (community_id, user_id, role)
    values (c_id, uid, 'admin');
  end if;
  return c_id;
end;
$$;

-- =============================================================================
-- 13. COMMENT COUNT TRIGGER
-- =============================================================================
create or replace function public.update_post_comment_count()
returns trigger as $$
begin
  update public.posts
  set comment_count = (select count(*) from public.comments where post_id = coalesce(new.post_id, old.post_id)),
      updated_at = now()
  where id = coalesce(new.post_id, old.post_id);
  return coalesce(new, old);
end;
$$ language plpgsql security definer;

drop trigger if exists comments_update_count on public.comments;
create trigger comments_update_count
  after insert or delete on public.comments
  for each row execute function public.update_post_comment_count();
