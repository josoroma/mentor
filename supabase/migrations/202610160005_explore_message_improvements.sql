-- Learner wording improvements are additive metadata. The original message is immutable.
create function public.explore_valid_message_improvement(value jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
begin
  if value is null then return true; end if;
  if jsonb_typeof(value)<>'object' or jsonb_typeof(value->'text') is distinct from 'string'
    or length(btrim(value->>'text')) not between 1 and 6000 or value->>'text' ~ '^[[:space:]]*$'
    or jsonb_typeof(value->'createdAt') is distinct from 'string'
    or value->>'createdAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
  then return false; end if;
  perform (value->>'createdAt')::timestamptz;
  return true;
exception when others then return false;
end;
$$;

alter table public.explore_messages add constraint explore_message_improvement_valid
  check (public.explore_valid_message_improvement(metadata->'improvement') and (
    not (metadata ? 'improvement') or (role='user' and metadata->>'action' is distinct from 'restore')
  ));

create function public.explore_save_message_improvement(p_message_id uuid,p_text text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare learner uuid:=auth.uid(); m public.explore_messages;
begin
  if learner is null then raise exception 'Authentication is required.' using errcode='28000'; end if;
  if p_text is null or length(btrim(p_text)) not between 1 and 6000 or p_text ~ '^[[:space:]]*$' then
    raise exception 'The improved wording is empty or too long.' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(learner::text,0));
  select * into m from public.explore_messages where user_id=learner and id=p_message_id for update;
  if not found then raise exception 'Exploration message not found.' using errcode='P0002'; end if;
  if m.role<>'user' or m.metadata->>'action'='restore' then
    raise exception 'Only your own written prompts can receive improved wording.' using errcode='22023';
  end if;
  -- Concurrent generation and network retries return the first committed rewrite.
  -- No content, sequence, status, prompt trace or session version is changed.
  if m.metadata ? 'improvement' then return public.explore_message_json(m); end if;
  update public.explore_messages set metadata=jsonb_set(metadata,'{improvement}',jsonb_build_object('text',btrim(p_text),'createdAt',now()))
    where user_id=learner and id=m.id returning * into m;
  return public.explore_message_json(m);
end;
$$;

revoke all on function public.explore_valid_message_improvement(jsonb) from public,anon;
revoke all on function public.explore_save_message_improvement(uuid,text) from public,anon;
grant execute on function public.explore_valid_message_improvement(jsonb) to authenticated;
grant execute on function public.explore_save_message_improvement(uuid,text) to authenticated;

-- Old backups can fill a missing rewrite, but never erase or replace a saved rewrite.
create or replace function public.explore_restore_backup(p_backup jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare learner uuid:=auth.uid(); item jsonb; existing jsonb;
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
      if ((existing-'status') #- '{metadata,improvement}') is distinct from ((item-'status') #- '{metadata,improvement}') then
        raise exception 'A backed-up message conflicts with existing history.' using errcode='PT409';
      end if;
      if existing->'metadata' ? 'improvement' and item->'metadata' ? 'improvement'
        and existing#>'{metadata,improvement}' is distinct from item#>'{metadata,improvement}' then
        raise exception 'A backed-up wording improvement conflicts with the saved improvement.' using errcode='PT409';
      end if;
      if not (existing->'metadata' ? 'improvement') and item->'metadata' ? 'improvement' then
        update public.explore_messages set metadata=jsonb_set(metadata,'{improvement}',item#>'{metadata,improvement}')
          where user_id=learner and id=(item->>'id')::uuid;
      end if;
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
