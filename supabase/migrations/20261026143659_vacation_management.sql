-- Open requests belong to their employee. Approved entries are managed only
-- by the employee's direct manager, never by the employee themselves.
alter policy urlaube_read_self on public.urlaube using (
  user_id = (select timestone_private.current_user_id())
  or user_id in (select id from public.users
    where vorgesetzter = (select timestone_private.current_user_id()))
);
create policy urlaube_delete_authorized on public.urlaube for delete to authenticated
using (
  (not is_approved and user_id = (select timestone_private.current_user_id()))
  or (is_approved and user_id in (select id from public.users
    where vorgesetzter = (select timestone_private.current_user_id())))
);
create policy urlaube_update_approved_team on public.urlaube for update to authenticated
using (is_approved and user_id in (select id from public.users
  where vorgesetzter = (select timestone_private.current_user_id())))
with check (is_approved and user_id in (select id from public.users
  where vorgesetzter = (select timestone_private.current_user_id())));
grant delete on public.urlaube to authenticated;
-- No ownership changes or self-approval through direct REST updates.
grant update (date, wholeday) on public.urlaube to authenticated;

create function public.get_vacations(p_from date, p_to date) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_result jsonb;
begin
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
    or p_to < p_from or p_to - p_from > 365 then
    raise exception 'Zeitraum muss 1 bis 366 Kalendertage umfassen.' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(to_jsonb(v) order by v.date, v.user_id, v.id), '[]'::jsonb)
    into v_result from (
      select a.*, u.fullname from public.urlaube a join public.users u on u.id = a.user_id
      where a.date between p_from and p_to
    ) v;
  return v_result;
end;
$$;

-- Reuse the existing actor/request receipt and lock namespace. A retry cannot
-- delete a replacement request, and a partially unauthorized batch rolls back.
create function public.vacation_execute(p_request_id uuid, p_operation text, p_arguments jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_user integer := timestone_private.current_user_id();
  v_previous timestone_private.agent_requests;
  v_ids integer[];
  v_result jsonb;
  v_allowed text[];
begin
  if v_user is null then raise exception 'Kein Mitarbeiterzugang.' using errcode = '42501'; end if;
  if p_request_id is null or p_arguments is null or jsonb_typeof(p_arguments) <> 'object'
    or octet_length(p_arguments::text) > 16384 then
    raise exception 'request_id und ein JSON-Objekt erforderlich.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(782316, v_user);
  select * into v_previous from timestone_private.agent_requests
    where actor_id = auth.uid() and request_id = p_request_id;
  if found then
    if v_previous.operation is distinct from p_operation or v_previous.arguments <> p_arguments then
      raise exception 'request_id wurde bereits mit anderen Argumenten verwendet.' using errcode = 'PT409';
    end if;
    return v_previous.result;
  end if;
  v_allowed := case p_operation
    when 'cancel_vacation' then array['ids']
    when 'update_approved_vacation' then array['id','date','wholeday']
    else null end;
  if v_allowed is null or exists(select 1 from jsonb_object_keys(p_arguments) k where not k = any(v_allowed))
    or not (p_arguments ?& v_allowed) then
    raise exception 'Unbekannte Operation oder fehlende/unerlaubte Argumente.' using errcode = '22023';
  end if;
  if p_operation = 'cancel_vacation' then
    if jsonb_typeof(p_arguments->'ids') is distinct from 'array' then
      raise exception 'ids muss eine Liste sein.' using errcode = '22023';
    end if;
    if jsonb_array_length(p_arguments->'ids') not between 1 and 366
      or exists(select 1 from jsonb_array_elements(p_arguments->'ids') x
        where jsonb_typeof(x) <> 'number' or x::text !~ '^[1-9][0-9]*$') then
      raise exception '1 bis 366 positive Integer-IDs erforderlich.' using errcode = '22023';
    end if;
    select array_agg(value::integer order by value::integer) into v_ids
      from jsonb_array_elements_text(p_arguments->'ids');
    if cardinality(v_ids) <> (select count(distinct x) from unnest(v_ids) x) then
      raise exception 'IDs dürfen nicht doppelt vorkommen.' using errcode = '22023';
    end if;
    with deleted as (
      delete from public.urlaube where id = any(v_ids) returning *
    ) select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]'::jsonb) into v_result from deleted d;
    if jsonb_array_length(v_result) <> cardinality(v_ids) then
      raise exception 'Mindestens ein Eintrag fehlt oder darf nicht gelöscht werden. Keine Änderung vorgenommen.' using errcode = 'PT409';
    end if;
    v_result := jsonb_build_object('deleted',v_result,'count',cardinality(v_ids));
  else
    if jsonb_typeof(p_arguments->'id') is distinct from 'number'
      or (p_arguments->>'id') !~ '^[1-9][0-9]*$'
      or jsonb_typeof(p_arguments->'date') is distinct from 'string'
      or (p_arguments->>'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or jsonb_typeof(p_arguments->'wholeday') is distinct from 'number'
      or (p_arguments->>'wholeday')::numeric not in (0.5,1) then
      raise exception 'id, gültiges Datum und wholeday (0.5/1) erforderlich.' using errcode = '22023';
    end if;
    update public.urlaube set date = (p_arguments->>'date')::date,
      wholeday = (p_arguments->>'wholeday')::numeric
      where id = (p_arguments->>'id')::integer returning to_jsonb(urlaube.*) into v_result;
    if not found then
      raise exception 'Kein genehmigter Urlaub im direkten Team mit dieser ID. Keine Änderung vorgenommen.' using errcode = 'PT409';
    end if;
  end if;
  insert into timestone_private.agent_requests(actor_id,request_id,operation,arguments,result)
    values(auth.uid(),p_request_id,p_operation,p_arguments,v_result);
  return v_result;
end;
$$;
revoke all on function public.get_vacations(date,date), public.vacation_execute(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.get_vacations(date,date), public.vacation_execute(uuid,text,jsonb) to authenticated;
