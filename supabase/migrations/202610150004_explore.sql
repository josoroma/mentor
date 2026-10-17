-- Declarative Explore artifacts and immutable revisions share the learner's authenticated identity.
create table public.explore_sessions (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  title text not null check (length(title) between 1 and 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 0 check (version >= 0),
  artifact_kind text check (artifact_kind in ('walkthrough','diagram','hanoi','fibonacci','sorting','examples','simulation')),
  pending_request_id uuid,
  pending_started_at timestamptz,
  primary key (user_id, id)
);
create table public.explore_messages (
  user_id uuid not null,
  id uuid not null default gen_random_uuid(),
  session_id uuid not null,
  role text not null check (role in ('user','assistant')),
  content text not null check (length(content) between 1 and 16000),
  created_at timestamptz not null default now(),
  sequence integer not null check (sequence >= 0),
  status text not null check (status in ('pending','complete','failed')),
  request_id uuid not null,
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object'),
  primary key (user_id, id),
  unique (user_id, session_id, id),
  unique (user_id, session_id, sequence),
  unique (user_id, session_id, request_id, role),
  foreign key (user_id, session_id) references public.explore_sessions(user_id,id) on delete cascade
);
create table public.explore_artifacts (
  user_id uuid not null,
  id uuid not null default gen_random_uuid(),
  session_id uuid not null,
  source_message_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision integer not null check (revision > 0),
  revision_id uuid not null,
  state jsonb not null default '{}' check (jsonb_typeof(state) = 'object'),
  primary key (user_id, id),
  unique (user_id, session_id, id),
  foreign key (user_id, session_id) references public.explore_sessions(user_id,id) on delete cascade,
  foreign key (user_id, session_id, source_message_id) references public.explore_messages(user_id,session_id,id) deferrable initially deferred
);
create table public.explore_artifact_revisions (
  user_id uuid not null,
  id uuid not null default gen_random_uuid(),
  artifact_id uuid not null,
  session_id uuid not null,
  message_id uuid not null,
  number integer not null check (number > 0),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  created_at timestamptz not null default now(),
  restored_from uuid,
  primary key (user_id, id),
  unique (user_id, session_id, artifact_id, id, number),
  unique (user_id, session_id, artifact_id, id),
  unique (user_id, artifact_id, number),
  foreign key (user_id, session_id, artifact_id) references public.explore_artifacts(user_id,session_id,id) on delete cascade,
  foreign key (user_id, session_id, message_id) references public.explore_messages(user_id,session_id,id) deferrable initially deferred,
  foreign key (user_id, session_id, artifact_id, restored_from) references public.explore_artifact_revisions(user_id,session_id,artifact_id,id) deferrable initially deferred
);
alter table public.explore_artifacts add constraint explore_current_revision_fk
  foreign key (user_id, session_id, id, revision_id, revision)
  references public.explore_artifact_revisions(user_id,session_id,artifact_id,id,number)
  deferrable initially deferred;

create index explore_sessions_library_idx on public.explore_sessions(user_id,updated_at desc,id desc);
create index explore_messages_history_idx on public.explore_messages(user_id,session_id,sequence desc);
create index explore_artifacts_session_idx on public.explore_artifacts(user_id,session_id,created_at,id);
create index explore_revisions_history_idx on public.explore_artifact_revisions(user_id,artifact_id,number desc);

alter table public.explore_sessions enable row level security;
alter table public.explore_messages enable row level security;
alter table public.explore_artifacts enable row level security;
alter table public.explore_artifact_revisions enable row level security;
revoke all on public.explore_sessions,public.explore_messages,public.explore_artifacts,public.explore_artifact_revisions from anon,authenticated;
grant select,delete on public.explore_sessions to authenticated;
grant insert(user_id,id,title),update(title,updated_at) on public.explore_sessions to authenticated;
-- The only write path is the transactional, ownership-checked RPC layer below.
-- Clients cannot rewrite source prompts, revision content or revision pointers.
grant select on public.explore_messages,public.explore_artifacts,public.explore_artifact_revisions to authenticated;
create policy explore_sessions_owner on public.explore_sessions to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create policy explore_messages_owner on public.explore_messages to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create policy explore_artifacts_owner on public.explore_artifacts to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create policy explore_revisions_owner on public.explore_artifact_revisions to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);

create function public.explore_session_json(s public.explore_sessions) returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('id',s.id,'title',s.title,'createdAt',s.created_at,'updatedAt',s.updated_at,'version',s.version,'artifactKind',s.artifact_kind)
$$;
create function public.explore_message_json(m public.explore_messages) returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('id',m.id,'sessionId',m.session_id,'role',m.role,'content',m.content,'createdAt',m.created_at,'sequence',m.sequence,'status',m.status,'requestId',m.request_id,'metadata',m.metadata)
$$;
create function public.explore_revision_json(r public.explore_artifact_revisions) returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('id',r.id,'artifactId',r.artifact_id,'sessionId',r.session_id,'messageId',r.message_id,'number',r.number,'content',r.content,'createdAt',r.created_at,'restoredFrom',r.restored_from)
$$;
create function public.explore_artifact_json(a public.explore_artifacts) returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('id',a.id,'sessionId',a.session_id,'sourceMessageId',a.source_message_id,'createdAt',a.created_at,'updatedAt',a.updated_at,'revision',a.revision,'revisionId',a.revision_id,'content',r.content,'state',a.state)
  from public.explore_artifact_revisions r where r.user_id=a.user_id and r.id=a.revision_id
$$;

create function public.explore_list_sessions(p_page integer default 0,p_page_size integer default 12,p_query text default '',p_kind text default null)
returns jsonb language sql stable security invoker set search_path='' as $$
  with filtered as (
    select s.* from public.explore_sessions s where s.user_id=auth.uid()
      and s.title ilike '%' || replace(replace(replace(p_query,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_') || '%'
      and (p_kind is null or exists (
        select 1 from public.explore_artifacts a join public.explore_artifact_revisions r on r.user_id=a.user_id and r.id=a.revision_id
        where a.user_id=s.user_id and a.session_id=s.id and r.content->>'kind'=p_kind
      ))
  ), page as (select * from filtered order by updated_at desc,id desc limit least(greatest(p_page_size,1),12) offset greatest(p_page,0)*least(greatest(p_page_size,1),12))
  select jsonb_build_object('sessions',coalesce((select jsonb_agg(public.explore_session_json(page) order by updated_at desc,id desc) from page),'[]'::jsonb),'total',(select count(*) from filtered),'page',greatest(p_page,0),'pageSize',least(greatest(p_page_size,1),12))
$$;
create function public.explore_read_messages(p_session_id uuid,p_before integer default null,p_limit integer default 20)
returns jsonb language sql stable security invoker set search_path='' as $$
  with page as (
    select m.* from public.explore_messages m where m.user_id=auth.uid() and m.session_id=p_session_id and (p_before is null or m.sequence<p_before)
    order by m.sequence desc limit least(greatest(p_limit,1),50)
  ) select jsonb_build_object(
    'messages',coalesce((select jsonb_agg(public.explore_message_json(page) order by sequence) from page),'[]'::jsonb),
    'nextCursor',case when exists (select 1 from public.explore_messages m where m.user_id=auth.uid() and m.session_id=p_session_id and m.sequence<(select min(sequence) from page)) then (select min(sequence) from page) else null end
  )
$$;
create function public.explore_read_detail(p_session_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('session',public.explore_session_json(s),'artifacts',coalesce((select jsonb_agg(public.explore_artifact_json(a) order by a.created_at,a.id) from public.explore_artifacts a where a.user_id=s.user_id and a.session_id=s.id),'[]'::jsonb)) || public.explore_read_messages(s.id,null,20)
  from public.explore_sessions s where s.user_id=auth.uid() and s.id=p_session_id
$$;
create function public.explore_read_revisions(p_artifact_id uuid,p_before integer default null,p_limit integer default 20)
returns jsonb language sql stable security invoker set search_path='' as $$
  with page as (select r.* from public.explore_artifact_revisions r where r.user_id=auth.uid() and r.artifact_id=p_artifact_id and (p_before is null or r.number<p_before) order by r.number desc limit least(greatest(p_limit,1),50))
  select jsonb_build_object('revisions',coalesce((select jsonb_agg(public.explore_revision_json(page) order by number desc) from page),'[]'::jsonb),'nextCursor',case when exists (select 1 from public.explore_artifact_revisions r where r.user_id=auth.uid() and r.artifact_id=p_artifact_id and r.number<(select min(number) from page)) then (select min(number) from page) else null end)
$$;

create function public.explore_begin_turn(p_session_id uuid,p_request_id uuid,p_prompt text,p_artifact_id uuid,p_expected_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  learner uuid:=auth.uid(); s public.explore_sessions; m public.explore_messages; next_sequence integer;
begin
  if learner is null then raise exception 'Authentication is required.' using errcode='28000'; end if;
  if length(p_prompt) not between 1 and 4000 then raise exception 'Invalid prompt.' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(learner::text,0));
  select * into s from public.explore_sessions where user_id=learner and id=p_session_id for update;
  if not found then raise exception 'Exploration not found.' using errcode='P0002'; end if;
  if p_artifact_id is not null and not exists(select 1 from public.explore_artifacts where user_id=learner and session_id=s.id and id=p_artifact_id) then raise exception 'Artifact not found.' using errcode='P0002'; end if;
  select * into m from public.explore_messages where user_id=learner and session_id=s.id and request_id=p_request_id and role='user';
  if found then
    if m.content<>p_prompt or (m.metadata->>'artifactId')::uuid is distinct from p_artifact_id then raise exception 'This request ID has already been used for a different prompt.' using errcode='PT409'; end if;
    if m.status='complete' then return jsonb_build_object('completed',true); end if;
    if exists(select 1 from public.explore_messages where user_id=learner and session_id=s.id and sequence>m.sequence) then raise exception 'A newer turn exists. Reopen the exploration before retrying.' using errcode='PT409'; end if;
  elsif s.version<>p_expected_version then
    raise exception 'This exploration changed. Reopen it and try again.' using errcode='PT409';
  end if;
  if s.pending_request_id is not null then
    if s.pending_started_at>now()-interval '3 minutes' then raise exception 'A response is already being generated.' using errcode='PT409'; end if;
    update public.explore_messages set status='failed' where user_id=learner and session_id=s.id and request_id=s.pending_request_id and status='pending';
  end if;
  if m.id is null then
    select coalesce(max(sequence),0)+1 into next_sequence from public.explore_messages where user_id=learner and session_id=s.id;
    insert into public.explore_messages(user_id,session_id,role,content,sequence,status,request_id,metadata)
      values(learner,s.id,'user',p_prompt,next_sequence,'pending',p_request_id,jsonb_build_object('artifactId',p_artifact_id,'expectedVersion',p_expected_version));
  else
    update public.explore_messages set status='pending' where user_id=learner and id=m.id;
  end if;
  update public.explore_sessions set pending_request_id=p_request_id,pending_started_at=now(),version=version+1,updated_at=now() where user_id=learner and id=s.id;
  return jsonb_build_object('completed',false);
end;
$$;

create function public.explore_complete_turn(p_session_id uuid,p_request_id uuid,p_reply text,p_action text,p_content jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare
  learner uuid:=auth.uid(); s public.explore_sessions; m public.explore_messages; a public.explore_artifacts;
  target uuid; new_revision_id uuid:=gen_random_uuid(); next_sequence integer; next_revision integer;
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
  if p_action='revise' then
    target:=(m.metadata->>'artifactId')::uuid;
    select * into a from public.explore_artifacts where user_id=learner and id=target and session_id=s.id for update;
    if not found then raise exception 'Select an artifact to revise.' using errcode='22023'; end if;
    next_revision:=a.revision+1;
    update public.explore_artifacts set revision=next_revision,revision_id=new_revision_id,state='{}',updated_at=now() where user_id=learner and id=target;
  elsif p_action='create' then
    target:=gen_random_uuid(); next_revision:=1;
    if (select count(*) from public.explore_artifacts where user_id=learner and session_id=s.id)>=50 then raise exception 'This exploration has reached 50 artifacts. Start another exploration.' using errcode='22023'; end if;
    insert into public.explore_artifacts(user_id,id,session_id,source_message_id,revision,revision_id) values(learner,target,s.id,m.id,1,new_revision_id);
  end if;
  if p_action<>'explain' then
    insert into public.explore_artifact_revisions(user_id,id,artifact_id,session_id,message_id,number,content) values(learner,new_revision_id,target,s.id,m.id,next_revision,p_content);
  end if;
  select coalesce(max(sequence),0)+1 into next_sequence from public.explore_messages where user_id=learner and session_id=s.id;
  insert into public.explore_messages(user_id,session_id,role,content,sequence,status,request_id,metadata) values(learner,s.id,'assistant',p_reply,next_sequence,'complete',p_request_id,jsonb_build_object('action',p_action,'artifactId',target,'revisionId',case when target is not null then new_revision_id else null end));
  update public.explore_messages set status='complete' where user_id=learner and id=m.id;
  update public.explore_sessions set pending_request_id=null,pending_started_at=null,version=version+1,updated_at=now(),artifact_kind=coalesce(p_content->>'kind',artifact_kind) where user_id=learner and id=s.id;
end;
$$;

create function public.explore_fail_turn(p_session_id uuid,p_request_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare learner uuid:=auth.uid(); s public.explore_sessions;
begin
  if learner is null then raise exception 'Authentication is required.' using errcode='28000'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(learner::text,0));
  select * into s from public.explore_sessions where user_id=learner and id=p_session_id for update;
  if not found or s.pending_request_id is distinct from p_request_id then return; end if;
  update public.explore_messages set status='failed' where user_id=learner and session_id=s.id and request_id=p_request_id and status='pending';
  update public.explore_sessions set pending_request_id=null,pending_started_at=null,version=version+1,updated_at=now() where user_id=learner and id=s.id;
end;
$$;

create function public.explore_save_state(p_artifact_id uuid,p_expected_revision integer,p_state jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare learner uuid:=auth.uid(); a public.explore_artifacts;
begin
  if learner is null then raise exception 'Authentication is required.' using errcode='28000'; end if;
  if jsonb_typeof(p_state)<>'object' then raise exception 'Invalid learning state.' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(learner::text,0));
  select * into a from public.explore_artifacts where user_id=learner and id=p_artifact_id for update;
  if not found then raise exception 'Artifact not found.' using errcode='P0002'; end if;
  if a.revision<>p_expected_revision then raise exception 'The artifact changed. Reopen it before saving.' using errcode='PT409'; end if;
  update public.explore_artifacts set state=p_state,updated_at=now() where user_id=learner and id=a.id returning * into a;
  update public.explore_sessions set updated_at=now() where user_id=learner and id=a.session_id;
  return public.explore_artifact_json(a);
end;
$$;

create function public.explore_restore_revision(p_artifact_id uuid,p_revision_id uuid,p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  learner uuid:=auth.uid(); a public.explore_artifacts; r public.explore_artifact_revisions; s public.explore_sessions;
  message_id uuid:=gen_random_uuid(); request_id uuid:=gen_random_uuid(); new_revision_id uuid:=gen_random_uuid(); next_sequence integer;
begin
  if learner is null then raise exception 'Authentication is required.' using errcode='28000'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(learner::text,0));
  select * into a from public.explore_artifacts where user_id=learner and id=p_artifact_id;
  if not found then raise exception 'Artifact not found.' using errcode='P0002'; end if;
  select * into s from public.explore_sessions where user_id=learner and id=a.session_id for update;
  select * into a from public.explore_artifacts where user_id=learner and id=p_artifact_id for update;
  if s.pending_request_id is not null then raise exception 'Wait for the current response before restoring.' using errcode='PT409'; end if;
  if a.revision<>p_expected_revision then raise exception 'The artifact changed. Refresh its history before restoring.' using errcode='PT409'; end if;
  select * into r from public.explore_artifact_revisions where user_id=learner and artifact_id=a.id and id=p_revision_id;
  if not found then raise exception 'Revision not found.' using errcode='P0002'; end if;
  select coalesce(max(sequence),0)+1 into next_sequence from public.explore_messages where user_id=learner and session_id=s.id;
  insert into public.explore_messages(user_id,id,session_id,role,content,sequence,status,request_id,metadata) values(learner,message_id,s.id,'user','Restore revision '||r.number||' of '||(r.content->>'title')||'.',next_sequence,'complete',request_id,jsonb_build_object('action','restore','artifactId',a.id,'restoredFrom',r.id));
  insert into public.explore_artifact_revisions(user_id,id,artifact_id,session_id,message_id,number,content,restored_from) values(learner,new_revision_id,a.id,s.id,message_id,a.revision+1,r.content,r.id);
  update public.explore_artifacts set revision=revision+1,revision_id=new_revision_id,state='{}',updated_at=now() where user_id=learner and id=a.id returning * into a;
  insert into public.explore_messages(user_id,session_id,role,content,sequence,status,request_id,metadata) values(learner,s.id,'assistant','Restored the earlier artifact as revision '||a.revision||'. Your other artifacts and revision history are preserved.',next_sequence+1,'complete',request_id,jsonb_build_object('action','restore','artifactId',a.id,'revisionId',new_revision_id));
  update public.explore_sessions set version=version+1,updated_at=now(),artifact_kind=r.content->>'kind' where user_id=learner and id=s.id;
  return public.explore_artifact_json(a);
end;
$$;

create function public.explore_export_backup()
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object(
    'sessions',coalesce((select jsonb_agg(public.explore_session_json(s) order by s.id) from public.explore_sessions s where s.user_id=auth.uid()),'[]'::jsonb),
    'messages',coalesce((select jsonb_agg(public.explore_message_json(m) order by m.session_id,m.sequence) from public.explore_messages m where m.user_id=auth.uid()),'[]'::jsonb),
    'artifacts',coalesce((select jsonb_agg(public.explore_artifact_json(a) order by a.id) from public.explore_artifacts a where a.user_id=auth.uid()),'[]'::jsonb),
    'revisions',coalesce((select jsonb_agg(public.explore_revision_json(r) order by r.artifact_id,r.number) from public.explore_artifact_revisions r where r.user_id=auth.uid()),'[]'::jsonb)
  )
$$;

create function public.explore_restore_backup(p_backup jsonb)
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
    if found and (existing-'status') is distinct from (item-'status') then raise exception 'A backed-up message conflicts with existing history.' using errcode='PT409'; end if;
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

create or replace function public.reset_learning_data() returns jsonb language plpgsql security invoker set search_path='' as $$
declare learner_id uuid:=auth.uid(); deleted_sessions integer; deleted_profiles integer; deleted_bookmarks integer; deleted_explorations integer;
begin
  if learner_id is null then raise exception 'Authentication is required to reset learning data.' using errcode='28000'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(learner_id::text,0));
  delete from public.explore_sessions where user_id=learner_id;
  get diagnostics deleted_explorations=row_count;
  delete from public.scenario_bookmarks where user_id=learner_id;
  get diagnostics deleted_bookmarks=row_count;
  delete from public.learning_sessions where user_id=learner_id;
  get diagnostics deleted_sessions=row_count;
  delete from public.learning_profiles where user_id=learner_id;
  get diagnostics deleted_profiles=row_count;
  return jsonb_build_object('deletedSessions',deleted_sessions,'deletedProfiles',deleted_profiles,'deletedBookmarks',deleted_bookmarks,'deletedExplorations',deleted_explorations);
end;
$$;

-- Supabase's default function grants include PUBLIC; explicitly require authentication.
do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'explore_%' loop
    execute format('revoke all on function %s from public, anon',f.signature);
    execute format('grant execute on function %s to authenticated',f.signature);
  end loop;
end $$;
