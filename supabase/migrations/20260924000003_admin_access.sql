-- ============================================================
-- Read access for the web admin dashboard (pwa/admin/)
--
-- The dashboard runs in a browser, so it cannot hold the secret key. Admins
-- sign in with Supabase Auth instead, and these policies let a signed-in user
-- read player records ONLY if they are listed in `admins`. Signing up is not
-- enough — an account must be added here by hand:
--
--   insert into admins (user_id, email)
--   select id, email from auth.users where email = 'someone@example.org';
--
-- Also turn off "Allow new users to sign up" (Authentication -> Sign In /
-- Providers) so strangers cannot even create an account.
-- ============================================================

create table if not exists admins (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  email    text not null,
  added_at timestamptz not null default now()
);
alter table admins enable row level security;

-- security definer so the check can read `admins` without granting it out.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- An admin can see their own row — how the dashboard tells an admin from
-- any other signed-in account.
drop policy if exists "see own admin row" on admins;
create policy "see own admin row"
  on admins for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "admins read players_clean" on players_clean;
create policy "admins read players_clean"
  on players_clean for select to authenticated
  using (public.is_admin());

drop policy if exists "admins read players" on players;
create policy "admins read players"
  on players for select to authenticated
  using (public.is_admin());

-- The existing centres policy covers only `anon`; a signed-in session uses
-- the `authenticated` role. Centres are not personal data.
drop policy if exists "authenticated read centres" on centres;
create policy "authenticated read centres"
  on centres for select to authenticated
  using (true);
