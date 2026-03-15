-- Run this in Supabase SQL Editor to fix banner/logo not showing.
-- Uses project ref from your Supabase URL (Settings → API). Change the host if your project is different.

update public.communities
set
  banner_url = 'https://jtqrqyzgtxexzbhdhaqf.supabase.co/storage/v1/object/public/community-assets/first-community/banner.jpg',
  logo_url   = 'https://jtqrqyzgtxexzbhdhaqf.supabase.co/storage/v1/object/public/community-assets/first-community/logo.jpg',
  updated_at = now()
where slug = 'first-community';
