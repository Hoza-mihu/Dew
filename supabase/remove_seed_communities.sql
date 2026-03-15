-- One-time: remove demo/seed communities so only app-created communities remain.
-- Run this once in Supabase SQL Editor if you previously ran the old seed.

delete from public.communities
where slug in (
  'indoor-plants',
  'plant-care-help',
  'smart-plant-tech',
  'hydroponics',
  'plant-showcases',
  'pest-disease-help'
);
