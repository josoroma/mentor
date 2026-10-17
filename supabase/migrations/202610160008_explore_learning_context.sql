-- Save the chosen learning focus with the original prompt before inference.
-- A failed first generation has no artifact yet, so retries must not depend on
-- whichever global focus happens to be selected after a reload or restore.
create function public.explore_valid_learning_context(value jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare selection jsonb;
begin
  if value is null then return true; end if;
  if jsonb_typeof(value) is distinct from 'object'
    or jsonb_typeof(value->'selection') is distinct from 'object'
    or value->>'level' is null
    or value->>'level' not in ('A1','A2','B1','B2','C1','C2') then
    return false;
  end if;
  selection:=value->'selection';
  if selection->>'path'='professional' then
    return jsonb_typeof(selection->'roleId')='string'
      and length(selection->>'roleId') between 1 and 128;
  elsif selection->>'path'='life-skills' then
    return jsonb_typeof(selection->'categoryId')='string'
      and length(selection->>'categoryId') between 1 and 128
      and jsonb_typeof(selection->'topicId')='string'
      and length(selection->>'topicId') between 1 and 128;
  end if;
  return false;
end;
$$;

alter table public.explore_messages add constraint explore_message_learning_context_valid
  check (not (metadata ? 'learningContext') or (
    role='user' and public.explore_valid_learning_context(metadata->'learningContext') is true
  ));

-- The optional sixth argument keeps existing clients and restored legacy
-- prompts compatible while making new context capture part of the same commit.
drop function public.explore_begin_turn(uuid,uuid,text,uuid,integer);
create function public.explore_begin_turn(
  p_session_id uuid,
  p_request_id uuid,
  p_prompt text,
  p_artifact_id uuid,
  p_expected_version integer,
  p_learning_context jsonb default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  learner uuid:=auth.uid();
  s public.explore_sessions;
  m public.explore_messages;
  next_sequence integer;
begin
  if learner is null then raise exception 'Authentication is required.' using errcode='28000'; end if;
  if p_prompt is null or length(p_prompt) not between 1 and 4000 then
    raise exception 'Invalid prompt.' using errcode='22023';
  end if;
  if public.explore_valid_learning_context(p_learning_context) is not true then
    raise exception 'Invalid exploration learning focus.' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(learner::text,0));
  select * into s from public.explore_sessions where user_id=learner and id=p_session_id for update;
  if not found then raise exception 'Exploration not found.' using errcode='P0002'; end if;
  if p_artifact_id is not null and not exists(
    select 1 from public.explore_artifacts where user_id=learner and session_id=s.id and id=p_artifact_id
  ) then raise exception 'Artifact not found.' using errcode='P0002'; end if;
  select * into m from public.explore_messages
    where user_id=learner and session_id=s.id and request_id=p_request_id and role='user';
  if found then
    if m.content<>p_prompt or (m.metadata->>'artifactId')::uuid is distinct from p_artifact_id then
      raise exception 'This request ID has already been used for a different prompt.' using errcode='PT409';
    end if;
    if m.metadata ? 'learningContext' and p_learning_context is not null
      and m.metadata->'learningContext' is distinct from p_learning_context then
      raise exception 'This question already has a saved learning focus. Reopen it before retrying.' using errcode='PT409';
    end if;
    if m.status='complete' then return jsonb_build_object('completed',true); end if;
    if exists(
      select 1 from public.explore_messages where user_id=learner and session_id=s.id and sequence>m.sequence
    ) then raise exception 'A newer turn exists. Reopen the exploration before retrying.' using errcode='PT409'; end if;
  elsif s.version<>p_expected_version then
    raise exception 'This exploration changed. Reopen it and try again.' using errcode='PT409';
  end if;
  if s.pending_request_id is not null then
    if s.pending_started_at>now()-interval '3 minutes' then
      raise exception 'A response is already being generated.' using errcode='PT409';
    end if;
    update public.explore_messages set status='failed'
      where user_id=learner and session_id=s.id and request_id=s.pending_request_id and status='pending';
  end if;
  if m.id is null then
    select coalesce(max(sequence),0)+1 into next_sequence from public.explore_messages
      where user_id=learner and session_id=s.id;
    insert into public.explore_messages(user_id,session_id,role,content,sequence,status,request_id,metadata)
      values(learner,s.id,'user',p_prompt,next_sequence,'pending',p_request_id,
        jsonb_build_object('artifactId',p_artifact_id,'expectedVersion',p_expected_version)
        || case when p_learning_context is null then '{}'::jsonb
          else jsonb_build_object('learningContext',p_learning_context) end);
  else
    update public.explore_messages set status='pending',
      metadata=case when not (metadata ? 'learningContext') and p_learning_context is not null
        then metadata || jsonb_build_object('learningContext',p_learning_context) else metadata end
      where user_id=learner and id=m.id;
  end if;
  update public.explore_sessions
    set pending_request_id=p_request_id,pending_started_at=now(),version=version+1,updated_at=now()
    where user_id=learner and id=s.id;
  return jsonb_build_object('completed',false);
end;
$$;

revoke all on function public.explore_valid_learning_context(jsonb) from public,anon,authenticated;
revoke all on function public.explore_begin_turn(uuid,uuid,text,uuid,integer,jsonb) from public,anon;
grant execute on function public.explore_begin_turn(uuid,uuid,text,uuid,integer,jsonb) to authenticated;

-- Learning focus, like wording improvements, is additive historical metadata.
-- Older backups may fill a missing value but cannot erase or change a saved one.
create or replace function public.explore_restore_backup(p_backup jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare learner uuid:=auth.uid(); item jsonb; existing jsonb; metadata_key text;
begin
  if learner is null then raise exception 'Authentication is required.' using errcode='28000'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(learner::text,0));
  if exists(select 1 from public.explore_sessions where user_id=learner and pending_request_id is not null and pending_started_at>now()-interval '3 minutes') then raise exception 'Wait for your exploration response before restoring a backup.' using errcode='PT409'; end if;
  for item in select value from jsonb_array_elements(p_backup->'sessions') loop
    insert into public.explore_sessions(user_id,id,title,created_at,updated_at,version,artifact_kind)
      values(learner,(item->>'id')::uuid,item->>'title',(item->>'createdAt')::timestamptz,(item->>'updatedAt')::timestamptz,(item->>'version')::integer,item->>'artifactKind')
      on conflict(user_id,id) do update set title=excluded.title,updated_at=excluded.updated_at,version=greatest(explore_sessions.version,excluded.version)+1,artifact_kind=excluded.artifact_kind,pending_request_id=null,pending_started_at=null where excluded.updated_at>=explore_sessions.updated_at;
  end loop;
  for item in select value from jsonb_array_elements(p_backup->'messages') loop
    select public.explore_message_json(m) into existing from public.explore_messages m where m.user_id=learner and m.id=(item->>'id')::uuid;
    if found then
      if ((existing-'status') #- '{metadata,improvement}' #- '{metadata,learningContext}')
        is distinct from ((item-'status') #- '{metadata,improvement}' #- '{metadata,learningContext}') then
        raise exception 'A backed-up message conflicts with existing history.' using errcode='PT409';
      end if;
      foreach metadata_key in array array['improvement','learningContext'] loop
        if existing->'metadata' ? metadata_key and item->'metadata' ? metadata_key
          and existing->'metadata'->metadata_key is distinct from item->'metadata'->metadata_key then
          raise exception 'Backed-up learning context or wording conflicts with saved history.' using errcode='PT409';
        end if;
        if not (existing->'metadata' ? metadata_key) and item->'metadata' ? metadata_key then
          update public.explore_messages set metadata=jsonb_set(metadata,array[metadata_key],item->'metadata'->metadata_key)
            where user_id=learner and id=(item->>'id')::uuid;
        end if;
      end loop;
    end if;
    insert into public.explore_messages(user_id,id,session_id,role,content,created_at,sequence,status,request_id,metadata)
      values(learner,(item->>'id')::uuid,(item->>'sessionId')::uuid,item->>'role',item->>'content',(item->>'createdAt')::timestamptz,(item->>'sequence')::integer,case when item->>'status'='pending' then 'failed' else item->>'status' end,(item->>'requestId')::uuid,item->'metadata') on conflict(user_id,id) do nothing;
  end loop;
  for item in select value from jsonb_array_elements(p_backup->'artifacts') loop
    insert into public.explore_artifacts(user_id,id,session_id,source_message_id,created_at,updated_at,revision,revision_id,state)
      values(learner,(item->>'id')::uuid,(item->>'sessionId')::uuid,(item->>'sourceMessageId')::uuid,(item->>'createdAt')::timestamptz,(item->>'updatedAt')::timestamptz,(item->>'revision')::integer,(item->>'revisionId')::uuid,item->'state')
      on conflict(user_id,id) do update set revision=excluded.revision,revision_id=excluded.revision_id,state=excluded.state,updated_at=excluded.updated_at where excluded.revision>=explore_artifacts.revision and excluded.updated_at>=explore_artifacts.updated_at;
  end loop;
  for item in select value from jsonb_array_elements(p_backup->'revisions') loop
    select public.explore_revision_json(r) into existing from public.explore_artifact_revisions r where r.user_id=learner and r.id=(item->>'id')::uuid;
    if found and existing is distinct from item then raise exception 'A backed-up revision conflicts with immutable history.' using errcode='PT409'; end if;
    insert into public.explore_artifact_revisions(user_id,id,artifact_id,session_id,message_id,number,content,created_at,restored_from)
      values(learner,(item->>'id')::uuid,(item->>'artifactId')::uuid,(item->>'sessionId')::uuid,(item->>'messageId')::uuid,(item->>'number')::integer,item->'content',(item->>'createdAt')::timestamptz,(item->>'restoredFrom')::uuid) on conflict(user_id,id) do nothing;
  end loop;
  return public.explore_export_backup();
end;
$$;
