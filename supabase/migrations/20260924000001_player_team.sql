-- ============================================================
-- Team (age group + gender) for each registration
--
-- Asked for by the PWA form. Nullable on purpose: Kobo submissions have no
-- team field, and registrations already queued offline on phones were saved
-- before the field existed — both must still be accepted. The PWA makes it
-- required for new registrations.
-- ============================================================

alter table players add column if not exists team text;

alter table players drop constraint if exists players_team_known;
alter table players add constraint players_team_known
  check (team is null or team in ('u12_boys', 'u12_girls', 'u16_boys', 'u16_girls'));

-- New columns may only be appended to an existing view.
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
  p.submitted_at,
  p.team
from players p
join centres c using (centre_code);
