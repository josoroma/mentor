-- Saved scenarios are complete snapshots: regenerated scenarios never invalidate a bookmark.
-- Removals remain as tombstones so delayed offline sync cannot revive an older saved state.
create table if not exists public.scenario_bookmarks (
  user_id uuid not null references auth.users(id) on delete cascade,
  scenario_id text not null,
  scenario jsonb not null check (
    jsonb_typeof(scenario) = 'object' and scenario ->> 'id' = scenario_id
  ),
  level text not null check (level in ('A2', 'B1', 'B2', 'C1', 'C2')),
  saved_at timestamptz not null,
  updated_at timestamptz not null check (updated_at >= saved_at),
  saved boolean not null default true,
  primary key (user_id, scenario_id)
);

create index if not exists scenario_bookmarks_user_saved_idx
  on public.scenario_bookmarks (user_id, saved_at desc, scenario_id)
  where saved = true;

alter table public.scenario_bookmarks enable row level security;
revoke all on public.scenario_bookmarks from anon, authenticated;
grant select, insert, update, delete on public.scenario_bookmarks to authenticated;

create policy "Learners read their own scenario bookmarks"
  on public.scenario_bookmarks for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Learners create their own scenario bookmarks"
  on public.scenario_bookmarks for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Learners update their own scenario bookmarks"
  on public.scenario_bookmarks for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Learners delete their own scenario bookmarks"
  on public.scenario_bookmarks for delete to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.guard_scenario_bookmark_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (
    new.updated_at < old.updated_at or
    (new.updated_at = old.updated_at and old.saved = false and new.saved = true)
  ) then
    return old;
  end if;
  return new;
end;
$$;

-- Take the learner lock before row locks, including for a batch upsert.
create or replace function public.lock_scenario_bookmark_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text, 0));
  end if;
  return null;
end;
$$;

create trigger serialize_scenario_bookmark_write
  before insert or update or delete on public.scenario_bookmarks
  for each statement execute function public.lock_scenario_bookmark_write();

create trigger protect_scenario_bookmark_revision
  before insert or update on public.scenario_bookmarks
  for each row execute function public.guard_scenario_bookmark_update();

-- Preserve the caller's identity and shared scenario configuration during reset.
create or replace function public.reset_learning_data()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  learner_id uuid := auth.uid();
  deleted_sessions integer;
  deleted_profiles integer;
  deleted_bookmarks integer;
begin
  if learner_id is null then
    raise exception 'Authentication is required to reset learning data.'
      using errcode = '28000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(learner_id::text, 0));

  delete from public.scenario_bookmarks where user_id = learner_id;
  get diagnostics deleted_bookmarks = row_count;

  delete from public.learning_sessions where user_id = learner_id;
  get diagnostics deleted_sessions = row_count;

  delete from public.learning_profiles where user_id = learner_id;
  get diagnostics deleted_profiles = row_count;

  return jsonb_build_object(
    'deletedSessions', deleted_sessions,
    'deletedProfiles', deleted_profiles,
    'deletedBookmarks', deleted_bookmarks
  );
end;
$$;

revoke all on function public.guard_scenario_bookmark_update() from public, anon;
revoke all on function public.lock_scenario_bookmark_write() from public, anon;
revoke all on function public.reset_learning_data() from public, anon;
grant execute on function public.reset_learning_data() to authenticated;
