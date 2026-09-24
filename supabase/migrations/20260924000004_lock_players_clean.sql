-- ============================================================
-- Close public read access to players_clean
--
-- After 20260924000002 the publishable key could still read every row: a
-- policy predating these migrations (e.g. the dashboard's "Enable read
-- access for all users") granted SELECT to anon/public, and policies are
-- permissive — any one that passes lets the row through.
--
-- Drops every policy on players_clean that lets anon/public read, update or
-- delete, keeping the insert-only PWA policy and the admin read policy.
-- ============================================================

alter table players_clean enable row level security;

do $$
declare
  p record;
begin
  for p in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'players_clean'
      and cmd in ('SELECT', 'UPDATE', 'DELETE', 'ALL')
      and roles && array['anon', 'public']::name[]
  loop
    raise notice 'dropping policy %', p.policyname;
    execute format('drop policy %I on public.players_clean', p.policyname);
  end loop;
end $$;

-- Result grid: what is left, and whether sl_no numbers itself (should be 'd').
select
  (select relrowsecurity from pg_class where oid = 'public.players_clean'::regclass) as rls_enabled,
  (select attidentity from pg_attribute
    where attrelid = 'public.players_clean'::regclass and attname = 'sl_no') as sl_no_identity,
  (select string_agg(format('%s [%s → %s]', policyname, cmd, array_to_string(roles, ',')), '; ')
     from pg_policies where schemaname = 'public' and tablename = 'players_clean') as policies;
