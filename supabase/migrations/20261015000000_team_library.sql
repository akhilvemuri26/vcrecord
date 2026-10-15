-- Generic protected group mapping only. An administrator separately links the
-- reviewed teams; no memberships, invitations, recordings, or objects move.
create table public.team_library_links (
  team_id uuid primary key references public.teams(id) on delete cascade,
  canonical_team_id uuid not null references public.teams(id) on delete cascade
);
create index team_library_links_canonical_idx
  on public.team_library_links (canonical_team_id);
alter table public.team_library_links enable row level security;
revoke all on public.team_library_links from public, anon, authenticated;

-- canonical_team_id is one group key, not a recursively followed alias.
create or replace function public.is_team_member(p_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and (
    exists (
      select 1 from public.team_members tm
      where tm.team_id = p_team_id and tm.user_id = (select auth.uid())
    ) or exists (
      select 1
      from public.team_library_links requested
      join public.team_library_links member_link
        on member_link.canonical_team_id = requested.canonical_team_id
      join public.team_members tm on tm.team_id = member_link.team_id
      where requested.team_id = p_team_id and tm.user_id = (select auth.uid())
    )
  );
$$;
revoke all on function public.is_team_member(uuid) from public, anon, authenticated;
grant execute on function public.is_team_member(uuid) to authenticated;

create function public.accessible_teams()
returns table (team_id uuid, canonical_team_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;
  return query
    select tm.team_id, coalesce(link.canonical_team_id, tm.team_id)
    from public.team_members tm
    left join public.team_library_links link on link.team_id = tm.team_id
    where tm.user_id = (select auth.uid())
    union
    select accessible.team_id, accessible.canonical_team_id
    from public.team_members tm
    join public.team_library_links member_link on member_link.team_id = tm.team_id
    join public.team_library_links accessible
      on accessible.canonical_team_id = member_link.canonical_team_id
    where tm.user_id = (select auth.uid());
end;
$$;
revoke all on function public.accessible_teams() from public, anon, authenticated;
grant execute on function public.accessible_teams() to authenticated;

-- Existing answers and storage policies, immutable metadata trigger, path
-- constraints, private bucket, and invitation validation remain untouched.
