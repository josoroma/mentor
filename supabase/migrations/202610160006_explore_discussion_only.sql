-- Follow-up conversation discusses existing artifacts without creating or revising them.
-- Completed request replays return before the new guard, retaining idempotency.
create or replace function public.explore_complete_turn(p_session_id uuid,p_request_id uuid,p_reply text,p_action text,p_content jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare
  learner uuid:=auth.uid(); s public.explore_sessions; m public.explore_messages; a public.explore_artifacts;
  target uuid; target_revision_id uuid; next_sequence integer;
begin
  if learner is null then raise exception 'Authentication is required.' using errcode='28000'; end if;
  if length(p_reply) not between 1 and 6000 or p_action not in ('create','revise','explain') or (p_action='explain')<>(p_content is null) then raise exception 'Invalid generated response.' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(learner::text,0));
  select * into s from public.explore_sessions where user_id=learner and id=p_session_id for update;
  if not found then raise exception 'Exploration not found.' using errcode='P0002'; end if;
  select * into m from public.explore_messages where user_id=learner and session_id=s.id and request_id=p_request_id and role='user';
  if not found then raise exception 'Prompt not found.' using errcode='P0002'; end if;
  if m.status='complete' then return; end if;
  if m.status<>'pending' or s.pending_request_id is distinct from p_request_id then raise exception 'This response is no longer current.' using errcode='PT409'; end if;
  -- Commit the conversation and artifact decision under the same owner/session lock.
  -- Historical revisions survive, but chat never creates another lesson or revision.
  if p_action='revise' or (p_action='create' and exists(select 1 from public.explore_artifacts where user_id=learner and session_id=s.id)) then
    raise exception 'Chat questions discuss the current artifact. Start a new exploration to create another lesson.' using errcode='PT409';
  end if;
  if p_action='create' then
    target:=gen_random_uuid(); target_revision_id:=gen_random_uuid();
    insert into public.explore_artifacts(user_id,id,session_id,source_message_id,revision,revision_id)
      values(learner,target,s.id,m.id,1,target_revision_id);
    insert into public.explore_artifact_revisions(user_id,id,artifact_id,session_id,message_id,number,content)
      values(learner,target_revision_id,target,s.id,m.id,1,p_content);
  else
    target:=(m.metadata->>'artifactId')::uuid;
    if target is not null then
      select * into a from public.explore_artifacts where user_id=learner and session_id=s.id and id=target;
      if not found then raise exception 'Artifact not found.' using errcode='P0002'; end if;
    else
      -- Match the final artifact in the canonical created_at/id ordered detail.
      select * into a from public.explore_artifacts where user_id=learner and session_id=s.id
        order by created_at desc,id desc limit 1;
    end if;
    target:=a.id; target_revision_id:=a.revision_id;
  end if;
  select coalesce(max(sequence),0)+1 into next_sequence from public.explore_messages where user_id=learner and session_id=s.id;
  insert into public.explore_messages(user_id,session_id,role,content,sequence,status,request_id,metadata)
    values(learner,s.id,'assistant',p_reply,next_sequence,'complete',p_request_id,jsonb_build_object('action',p_action,'artifactId',target,'revisionId',target_revision_id));
  update public.explore_messages set status='complete' where user_id=learner and id=m.id;
  update public.explore_sessions set pending_request_id=null,pending_started_at=null,version=version+1,updated_at=now(),artifact_kind=coalesce(p_content->>'kind',artifact_kind) where user_id=learner and id=s.id;
end;
$$;

revoke all on function public.explore_complete_turn(uuid,uuid,text,text,jsonb) from public,anon;
grant execute on function public.explore_complete_turn(uuid,uuid,text,text,jsonb) to authenticated;
