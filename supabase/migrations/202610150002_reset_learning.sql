-- Reset learning records for the caller in one transaction. Authentication and
-- shared curated scenarios deliberately survive a learner reset.
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
begin
  if learner_id is null then
    raise exception 'Authentication is required to reset learning data.'
      using errcode = '28000';
  end if;

  delete from public.learning_sessions where user_id = learner_id;
  get diagnostics deleted_sessions = row_count;

  delete from public.learning_profiles where user_id = learner_id;
  get diagnostics deleted_profiles = row_count;

  return jsonb_build_object(
    'deletedSessions', deleted_sessions,
    'deletedProfiles', deleted_profiles
  );
end;
$$;

revoke all on function public.reset_learning_data() from public, anon;
grant execute on function public.reset_learning_data() to authenticated;
