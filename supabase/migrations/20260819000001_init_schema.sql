-- ============================================================
-- BVL Player Registration POC — Supabase schema
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor)
-- before running 02_centres_seed.sql and the sync script.
-- ============================================================

-- 1. Centre registry (one clean source of truth for centres)
create table if not exists centres (
  id           uuid primary key default gen_random_uuid(),
  centre_code  text not null unique,          -- stable slug, matches Kobo choice 'name'
  centre_name  text not null,
  district     text not null,
  created_at   timestamptz not null default now()
);

-- 2. Player registrations (one row per Kobo submission)
create table if not exists players (
  id                 uuid primary key default gen_random_uuid(),

  -- Kobo identifiers (used for idempotent upserts)
  kobo_id            bigint not null unique,   -- Kobo's numeric _id
  kobo_uuid          text unique,              -- Kobo's _uuid

  -- Registration fields (mirror the XLSForm)
  player_name        text not null check (length(player_name) >= 3),
  sex                text not null check (sex in ('M', 'F', 'O')),
  dob                date not null check (dob <= current_date),
  height_cm          integer check (height_cm between 100 and 220),
  joining_date       date check (joining_date >= date '2018-01-01'
                                 and joining_date <= current_date),
  performance_levels text[] not null default '{}',   -- e.g. {bvl,district}
  achievements       text,
  centre_code        text not null references centres (centre_code),
  district           text,
  guardian_consent   boolean not null default false,

  -- Audit / provenance
  submitted_at       timestamptz,              -- Kobo _submission_time
  raw_submission     jsonb,                    -- full original payload
  synced_at          timestamptz not null default now(),

  constraint joining_after_birth check (joining_date is null or joining_date >= dob)
);

create index if not exists idx_players_centre  on players (centre_code);
create index if not exists idx_players_dob     on players (dob);

-- 3. Row Level Security
-- The sync script uses the service_role key, which bypasses RLS.
-- Enabling RLS with no permissive policies means the anon/public key
-- can read or write NOTHING — important, since these are records of minors.
alter table centres enable row level security;
alter table players enable row level security;

-- Optional: allow logged-in dashboard users read-only access.
-- create policy "authenticated read players"
--   on players for select to authenticated using (true);
-- create policy "authenticated read centres"
--   on centres for select to authenticated using (true);

-- 4. Convenience view for dashboards (Looker Studio / Metabase)
create or replace view v_registrations as
select
  p.player_name,
  p.sex,
  p.dob,
  date_part('year', age(p.dob))::int as age_years,
  p.height_cm,
  p.joining_date,
  array_to_string(p.performance_levels, '/') as performance,
  c.centre_name,
  c.district,
  p.submitted_at
from players p
join centres c using (centre_code);
