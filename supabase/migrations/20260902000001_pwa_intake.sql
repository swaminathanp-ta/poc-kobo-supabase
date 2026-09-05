-- ============================================================
-- Second intake channel: the BVL registration PWA
--
-- Two changes:
--   1. Player identity becomes source-agnostic, so submissions from
--      KoboToolbox and from the PWA can coexist in one table instead of
--      one having to replace the other.
--   2. Row level security policies that let the PWA write registrations
--      using only the PUBLISHABLE key — which, on its own, can read nothing.
-- ============================================================

-- ---------- 1. Source-agnostic identity -------------------------------
alter table players add column if not exists source    text;
alter table players add column if not exists source_id text;

update players set source = 'kobo' where source is null;
update players set source_id = kobo_id::text where source_id is null and kobo_id is not null;

alter table players alter column source set default 'kobo';
alter table players alter column source set not null;

-- kobo_id stays (and stays unique) so the existing sync keeps working
-- unchanged, but it is no longer required — a PWA row has none.
alter table players alter column kobo_id drop not null;

-- The new identity. A resubmission of the same device-generated id is the
-- same player, which is what makes the offline queue safe to retry.
create unique index if not exists players_source_uidx on players (source, source_id);

alter table players add constraint players_source_known
  check (source in ('kobo', 'pwa')) not valid;

-- ---------- 2. Policies for the PWA ------------------------------------
-- The PWA ships the PUBLISHABLE key, which is designed to be public. These
-- policies decide what that key can actually do — and the answer is: insert
-- a registration, and read the centre list. Nothing else.

-- Centres are not personal data: names of villages and volleyball clubs.
-- The form needs them for the district -> centre picker.
drop policy if exists "anon can read centres" on centres;
create policy "anon can read centres"
  on centres for select to anon
  using (true);

-- Write-only on players. There is deliberately NO select policy for anon,
-- so the same key cannot read back a single child's record.
drop policy if exists "anon can submit registrations" on players;
create policy "anon can submit registrations"
  on players for insert to anon
  with check (
    source = 'pwa'                         -- cannot impersonate the Kobo channel
    and guardian_consent = true            -- consent is enforced in the database,
                                           -- not only in the form
    and char_length(player_name) between 3 and 120
    and dob > current_date - interval '30 years'
    and dob < current_date
  );

comment on policy "anon can submit registrations" on players is
  'Insert-only. The publishable key can add a registration but cannot read, '
  'update or delete any record. Consent and basic sanity are enforced here so '
  'they hold even if the client is bypassed.';
