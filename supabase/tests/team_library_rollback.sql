-- Root/operator only. Dry run by default. Supply the same two reviewed IDs:
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v canonical_team=UUID -v legacy_team=UUID -f supabase/tests/team_library_rollback.sql
-- To apply after review, explicitly replace the final ROLLBACK with COMMIT.
-- This never deletes or moves recordings, memberships, invitation hashes, or
-- storage objects. It refuses to remove infrastructure used by other groups.
\set ON_ERROR_STOP on
begin;
create temporary table library_rollback_targets as
select :'canonical_team'::uuid as canonical_team, :'legacy_team'::uuid as legacy_team;
lock table public.team_library_links in exclusive mode;
do $$ begin
  if exists (
    select 1 from public.team_library_links l, library_rollback_targets t
    where l.team_id not in (t.canonical_team, t.legacy_team)
       or l.canonical_team_id <> t.canonical_team
  ) then raise exception 'Rollback refused: other mappings require their own review'; end if;
end $$;
delete from public.team_library_links l using library_rollback_targets t
where l.team_id in (t.canonical_team, t.legacy_team) and l.canonical_team_id = t.canonical_team;
drop function public.accessible_teams();
create or replace function public.is_team_member(p_team_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.team_members tm
    where tm.team_id = p_team_id and tm.user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_team_member(uuid) from public, anon, authenticated;
grant execute on function public.is_team_member(uuid) to authenticated;
drop table public.team_library_links;
rollback;
