-- Forty example drafts and their corrections need eighty keys, plus viewer controls.
-- Match the installed Zod string bounds, which count Unicode code points.
create function public.explore_bounded_state_string(value text,maximum integer)
returns boolean language sql immutable set search_path='' as $$
  select length(value)<=maximum
$$;

create function public.explore_valid_learning_state(value jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare entry record; element jsonb; element_type text;
begin
  if jsonb_typeof(value) is distinct from 'object' then return false; end if;
  if (select count(*) from jsonb_object_keys(value))>120 then return false; end if;
  for entry in select fields.key,fields.value as item from jsonb_each($1) as fields loop
    if length(entry.key)<1 or not public.explore_bounded_state_string(entry.key,80) then return false; end if;
    case jsonb_typeof(entry.item)
      when 'string' then
        if not public.explore_bounded_state_string(entry.item#>>'{}',2000) then return false; end if;
      when 'number' then
        perform (entry.item#>>'{}')::double precision;
      when 'boolean' then null;
      when 'array' then
        if jsonb_array_length(entry.item)>100 then return false; end if;
        element_type:=null;
        for element in select array_item from jsonb_array_elements(entry.item) as items(array_item) loop
          if element_type is null then element_type:=jsonb_typeof(element); end if;
          if jsonb_typeof(element)<>element_type then return false; end if;
          if element_type='string' then
            if not public.explore_bounded_state_string(element#>>'{}',500) then return false; end if;
          elsif element_type='number' then
            perform (element#>>'{}')::double precision;
          else return false;
          end if;
        end loop;
      else return false;
    end case;
  end loop;
  return true;
exception when others then return false;
end;
$$;

-- Existing rows are not rewritten. New saves/imports enforce the current state contract.
alter table public.explore_artifacts add constraint explore_learning_state_valid
  check (public.explore_valid_learning_state(state)) not valid;

create function public.explore_read_artifact(p_artifact_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  select public.explore_artifact_json(a) from public.explore_artifacts a
    where a.user_id=auth.uid() and a.id=p_artifact_id
$$;

create or replace function public.explore_save_state(p_artifact_id uuid,p_expected_revision integer,p_state jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare learner uuid:=auth.uid(); a public.explore_artifacts;
begin
  if learner is null then raise exception 'Authentication is required.' using errcode='28000'; end if;
  if not public.explore_valid_learning_state(p_state) then raise exception 'The saved learning state is invalid or too large.' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(learner::text,0));
  select * into a from public.explore_artifacts where user_id=learner and id=p_artifact_id for update;
  if not found then raise exception 'Artifact not found.' using errcode='P0002'; end if;
  if a.revision<>p_expected_revision then raise exception 'The artifact changed. Reopen it before saving.' using errcode='PT409'; end if;
  update public.explore_artifacts set state=p_state,updated_at=now() where user_id=learner and id=a.id returning * into a;
  update public.explore_sessions set updated_at=now() where user_id=learner and id=a.session_id;
  return public.explore_artifact_json(a);
end;
$$;

revoke all on function public.explore_bounded_state_string(text,integer) from public,anon;
revoke all on function public.explore_valid_learning_state(jsonb) from public,anon;
revoke all on function public.explore_read_artifact(uuid) from public,anon;
revoke all on function public.explore_save_state(uuid,integer,jsonb) from public,anon;
grant execute on function public.explore_bounded_state_string(text,integer) to authenticated;
grant execute on function public.explore_valid_learning_state(jsonb) to authenticated;
grant execute on function public.explore_read_artifact(uuid) to authenticated;
grant execute on function public.explore_save_state(uuid,integer,jsonb) to authenticated;
