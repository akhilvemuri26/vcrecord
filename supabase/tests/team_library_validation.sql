-- Root/operator only. Run after the reviewed link is present:
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v canonical_team=UUID -v legacy_team=UUID -f supabase/tests/team_library_validation.sql
-- No tokens or real recording content are printed. Every fixture and mutation
-- is rolled back. SQL storage probes test metadata RLS; use signed download QA
-- separately to verify the actual private bytes.
\set ON_ERROR_STOP on
begin;
-- Permit SQL deletes of synthetic storage metadata inside this rolled-back probe.
-- Storage RLS remains active; this setting expires with the transaction.
set local storage.allow_delete_query = 'true';

create temporary table library_probe as
select :'canonical_team'::uuid as canonical_team,
       :'legacy_team'::uuid as legacy_team,
       gen_random_uuid() as canonical_holder,
       gen_random_uuid() as legacy_holder,
       gen_random_uuid() as stranger,
       gen_random_uuid() as unrelated_team,
       gen_random_uuid() as canonical_answer,
       gen_random_uuid() as legacy_answer;
create temporary table library_original_answers as
select a.* from public.answers a, library_probe p
where a.team_id in (p.canonical_team, p.legacy_team);
create temporary table library_original_objects as
select o.id, o.name from storage.objects o, library_probe p
where o.bucket_id = 'recordings'
  and split_part(o.name, '/', 1) in (p.canonical_team::text, p.legacy_team::text);
grant select on library_probe, library_original_answers, library_original_objects to authenticated;

create function pg_temp.library_assert(ok boolean, detail text) returns void
language plpgsql as $$ begin
  if ok is distinct from true then raise exception 'Library probe failed: %', detail; end if;
end $$;

select pg_temp.library_assert(
  p.canonical_team <> p.legacy_team
  and (select count(*) from public.team_library_links l
       where l.team_id in (p.canonical_team, p.legacy_team)
         and l.canonical_team_id = p.canonical_team) = 2
  and (select count(*) from public.team_library_links l
       where l.canonical_team_id = p.canonical_team) = 2,
  'expected exactly the two reviewed mappings') from library_probe p;
select pg_temp.library_assert(
  not has_table_privilege('authenticated', 'public.team_library_links', 'SELECT')
  and not has_table_privilege('authenticated', 'public.team_library_links', 'INSERT')
  and not has_function_privilege('anon', 'public.accessible_teams()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.is_team_member(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.accessible_teams()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.is_team_member(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.can_access_recording(text,boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.can_access_recording(text,boolean)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.create_team(text,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.create_team(text,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.join_team(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.join_team(uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.keep_answer_recording_identity()', 'EXECUTE'),
  'protected mapping and function grants');

-- Synthetic future invite holders get direct membership only in their original
-- team. This avoids changing any real user's membership or invitation hash.
insert into auth.users (id)
select canonical_holder from library_probe union all
select legacy_holder from library_probe union all
select stranger from library_probe;
insert into public.team_members (team_id, user_id)
select canonical_team, canonical_holder from library_probe union all
select legacy_team, legacy_holder from library_probe;
insert into public.teams (id, name, invite_hash, created_by)
select unrelated_team, 'Rolled-back library probe', decode(repeat('00', 32), 'hex'), stranger
from library_probe;
insert into public.team_members (team_id, user_id)
select unrelated_team, stranger from library_probe;

select set_config('request.jwt.claim.sub', canonical_holder::text, true),
       set_config('request.jwt.claims', json_build_object('sub', canonical_holder, 'role', 'authenticated')::text, true)
from library_probe;
set local role authenticated;
select pg_temp.library_assert(
  public.is_team_member(p.canonical_team) and public.is_team_member(p.legacy_team)
  and not public.is_team_member(p.unrelated_team)
  and (select count(*) from public.accessible_teams()) = 2
  and (select count(*) from public.accessible_teams() a where a.canonical_team_id = p.canonical_team) = 2
  and (select count(*) from public.answers a where a.team_id in (p.canonical_team, p.legacy_team))
      = (select count(*) from library_original_answers)
  and (select count(*) from storage.objects o where o.bucket_id = 'recordings'
       and split_part(o.name, '/', 1) in (p.canonical_team::text, p.legacy_team::text))
      = (select count(*) from library_original_objects),
  'future canonical member reads both libraries and objects') from library_probe p;

-- Original owner checks use existing IDs only inside the transaction and never
-- update real answers. Display names do not participate in these decisions.
do $$ declare original record; begin
  for original in select distinct owner_user_id from library_original_answers loop
    perform set_config('request.jwt.claim.sub', original.owner_user_id::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', original.owner_user_id, 'role', 'authenticated')::text, true);
    perform pg_temp.library_assert(
      (select count(*) from public.answers a where a.owner_user_id = original.owner_user_id
       and a.id in (select id from library_original_answers))
      = (select count(*) from library_original_answers a where a.owner_user_id = original.owner_user_id),
      'original owner retains access');
    perform pg_temp.library_assert(not exists (
      select 1 from library_original_answers a where a.owner_user_id = original.owner_user_id
      and not public.can_access_recording(a.object_path, true)), 'original owner retains storage ownership');
  end loop;
end $$;
reset role;

select set_config('request.jwt.claim.sub', canonical_holder::text, true),
       set_config('request.jwt.claims', json_build_object('sub', canonical_holder, 'role', 'authenticated')::text, true)
from library_probe;
set local role authenticated;
-- An owner can create a new answer in either linked team without moving any
-- existing answer. Use synthetic metadata and no actual video upload.
insert into public.answers (id, team_id, owner_user_id, question_id, question, created_at, duration, mime, object_path)
select canonical_answer, canonical_team, canonical_holder, 'ipg-0', 'Rolled-back probe', now(), 1, 'video/webm',
canonical_team::text || '/' || canonical_holder::text || '/' || canonical_answer::text from library_probe;
insert into storage.objects (bucket_id, name)
select 'recordings', canonical_team::text || '/' || canonical_holder::text || '/' || canonical_answer::text from library_probe;
do $$ declare n integer; begin
  update public.answers set transcript = 'Rolled-back owner edit'
  where id = (select canonical_answer from library_probe);
  get diagnostics n = row_count;
  perform pg_temp.library_assert(n = 1, 'owner can update mutable metadata');
  begin
    update public.answers set person = 'Changed identity' where id = (select canonical_answer from library_probe);
    raise exception 'Library probe failed: immutable metadata was changed';
  exception when raise_exception then
    if sqlerrm <> 'Recording identity and metadata are immutable' then raise; end if;
  end;
end $$;
reset role;

select set_config('request.jwt.claim.sub', legacy_holder::text, true),
       set_config('request.jwt.claims', json_build_object('sub', legacy_holder, 'role', 'authenticated')::text, true)
from library_probe;
set local role authenticated;
select pg_temp.library_assert(
  public.is_team_member(p.canonical_team) and public.is_team_member(p.legacy_team)
  and (select count(*) from public.accessible_teams()) = 2
  and (select count(*) from public.answers a where a.team_id in (p.canonical_team, p.legacy_team))
      = (select count(*) + 1 from library_original_answers)
  and public.can_access_recording(p.canonical_team::text || '/' || p.canonical_holder::text || '/' || p.canonical_answer::text, false)
  and not public.can_access_recording(p.canonical_team::text || '/' || p.canonical_holder::text || '/' || p.canonical_answer::text, true),
  'future legacy member reads both libraries but does not own canonical holder video') from library_probe p;
insert into public.answers (id, team_id, owner_user_id, question_id, question, created_at, duration, mime, object_path)
select legacy_answer, canonical_team, legacy_holder, 'ipg-0', 'Rolled-back linked destination probe', now(), 1, 'video/webm',
canonical_team::text || '/' || legacy_holder::text || '/' || legacy_answer::text from library_probe;
do $$ declare n integer; begin
  update public.answers set transcript = 'Unauthorized' where id = (select canonical_answer from library_probe);
  get diagnostics n = row_count;
  perform pg_temp.library_assert(n = 0, 'nonowner update denied');
  delete from public.answers where id = (select canonical_answer from library_probe);
  get diagnostics n = row_count;
  perform pg_temp.library_assert(n = 0, 'nonowner delete denied');
  delete from storage.objects where bucket_id = 'recordings'
    and name = (select canonical_team::text || '/' || canonical_holder::text || '/' || canonical_answer::text from library_probe);
  get diagnostics n = row_count;
  perform pg_temp.library_assert(n = 0, 'nonowner storage delete denied');
  update storage.objects set metadata = metadata where bucket_id = 'recordings'
    and name = (select canonical_team::text || '/' || canonical_holder::text || '/' || canonical_answer::text from library_probe);
  get diagnostics n = row_count;
  perform pg_temp.library_assert(n = 0, 'nonowner storage update denied');
  begin
    -- Keep the path constraint valid so only the ownership policy is tested.
    with fixture_id as (select gen_random_uuid() as id)
    insert into public.answers (id, team_id, owner_user_id, question_id, question, created_at, duration, mime, object_path)
    select f.id, canonical_team, canonical_holder, 'ipg-0', 'Forbidden', now(), 1, 'video/webm',
      canonical_team::text || '/' || canonical_holder::text || '/' || f.id::text from library_probe cross join fixture_id f;
    raise exception 'Library probe failed: nonowner insert allowed';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects (bucket_id, name)
    select 'recordings', canonical_team::text || '/' || canonical_holder::text || '/' || gen_random_uuid()::text from library_probe;
    raise exception 'Library probe failed: nonowner storage insert allowed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

select set_config('request.jwt.claim.sub', canonical_holder::text, true),
       set_config('request.jwt.claims', json_build_object('sub', canonical_holder, 'role', 'authenticated')::text, true)
from library_probe;
set local role authenticated;
do $$ declare n integer; begin
  update storage.objects set metadata = metadata where bucket_id = 'recordings'
    and name = (select canonical_team::text || '/' || canonical_holder::text || '/' || canonical_answer::text from library_probe);
  get diagnostics n = row_count;
  perform pg_temp.library_assert(n = 1, 'owner storage update allowed');
  delete from public.answers where id = (select canonical_answer from library_probe);
  get diagnostics n = row_count;
  perform pg_temp.library_assert(n = 1, 'owner answer delete allowed');
  delete from storage.objects where bucket_id = 'recordings'
    and name = (select canonical_team::text || '/' || canonical_holder::text || '/' || canonical_answer::text from library_probe);
  get diagnostics n = row_count;
  perform pg_temp.library_assert(n = 1, 'owner storage delete allowed');
end $$;
reset role;

select set_config('request.jwt.claim.sub', stranger::text, true),
       set_config('request.jwt.claims', json_build_object('sub', stranger, 'role', 'authenticated')::text, true)
from library_probe;
set local role authenticated;
select pg_temp.library_assert(
  not public.is_team_member(p.canonical_team) and not public.is_team_member(p.legacy_team)
  and (select count(*) from public.accessible_teams()) = 1
  and exists (select 1 from public.accessible_teams() a where a.team_id = p.unrelated_team and a.canonical_team_id = p.unrelated_team)
  and not exists (select 1 from public.answers a where a.team_id in (p.canonical_team, p.legacy_team))
  and not exists (select 1 from storage.objects o where o.bucket_id = 'recordings'
    and split_part(o.name, '/', 1) in (p.canonical_team::text, p.legacy_team::text)),
  'unrelated identity denied; unmapped direct membership maps to itself') from library_probe p;
reset role;

select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '{}', true);
set local role authenticated;
select pg_temp.library_assert(not public.is_team_member(canonical_team), 'null identity denied') from library_probe;
do $$ begin
  begin
    perform * from public.accessible_teams();
    raise exception 'Library probe failed: null identity discovery allowed';
  exception when raise_exception then
    if sqlerrm <> 'Authentication required' then raise; end if;
  end;
end $$;
reset role;

-- Fixtures may change; every original row and object identity must be intact.
select pg_temp.library_assert(
  not exists (select 1 from library_original_answers original
    left join public.answers current on current.id = original.id
    where current.id is null or to_jsonb(current) is distinct from to_jsonb(original))
  and not exists (select 1 from library_original_objects original
    left join storage.objects current on current.id = original.id
    where current.id is null or current.name is distinct from original.name),
  'all original recording metadata and object identities unchanged');
rollback;
