-- Application admins are provisioned by migrations/DB operators, never profile
-- metadata or the public API. Auth UUIDs avoid granting a recreated email account.
create table timestone_private.app_admins (
  auth_user_id uuid primary key references auth.users(id) on delete cascade
);
alter table timestone_private.app_admins enable row level security;
revoke all on timestone_private.app_admins from public, anon, authenticated, service_role;

create function timestone_private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from timestone_private.app_admins where auth_user_id = (select auth.uid())
  );
$$;
revoke all on function timestone_private.is_admin() from public, anon, authenticated, service_role;
grant execute on function timestone_private.is_admin() to authenticated;

-- Explicitly authorized accounts only, with matching employee AND Auth identity.
-- Missing/unmapped accounts receive no role and must be provisioned separately.
insert into timestone_private.app_admins(auth_user_id)
select a.id from auth.users a join public.users u on u.auth_user_id = a.id
where lower(a.email) = lower(u.email)
  and lower(a.email) in ('lh@andersconsulting.com','fa@andersconsulting.com','sh@andersconsulting.com')
on conflict do nothing;

create policy users_read_admin on public.users for select to authenticated
  using ((select timestone_private.is_admin()));
create policy attendance_admin on public.anwesenheit for all to authenticated
  using ((select timestone_private.is_admin())) with check ((select timestone_private.is_admin()));
create policy sickleave_admin on public.krankheit for all to authenticated
  using ((select timestone_private.is_admin())) with check ((select timestone_private.is_admin()));
create policy vacation_admin on public.urlaube for all to authenticated
  using ((select timestone_private.is_admin())) with check ((select timestone_private.is_admin()));
-- The policies above broaden existing application operations, not Auth or role administration.

create function public.get_employees() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_result jsonb;
begin
  if not timestone_private.is_admin() then raise exception 'Admin erforderlich.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'fullname',fullname,'email',email)
    order by fullname,id), '[]'::jsonb) into v_result from public.users;
  return v_result;
end;
$$;

create function public.get_employee_activity(p_user integer, p_from date, p_to date) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
begin
  if not timestone_private.is_admin() then raise exception 'Admin erforderlich.' using errcode = '42501'; end if;
  if p_user is null or not exists(select 1 from public.users where id=p_user)
    or p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
    or p_to < p_from or p_to-p_from > 365 then
    raise exception 'Gueltige Person und Zeitraum (1 bis 366 Tage) erforderlich.' using errcode = '22023';
  end if;
  return jsonb_build_object('user_id',p_user,'timezone','Europe/Berlin',
    'attendance',(select coalesce(jsonb_agg(to_jsonb(a) order by start_at),'[]'::jsonb) from public.anwesenheit a
      where user_id=p_user and (start_at at time zone 'Europe/Berlin')::date between p_from and p_to),
    'sickleave',(select coalesce(jsonb_agg(to_jsonb(k) order by date),'[]'::jsonb) from public.krankheit k where user_id=p_user and date between p_from and p_to),
    'vacation',(select coalesce(jsonb_agg(to_jsonb(v) order by date),'[]'::jsonb) from public.urlaube v where user_id=p_user and date between p_from and p_to));
end;
$$;
revoke all on function public.get_employees(), public.get_employee_activity(integer,date,date) from public,anon,authenticated;
grant execute on function public.get_employees(), public.get_employee_activity(integer,date,date) to authenticated;

create or replace function public.agent_execute(p_request_id uuid, p_operation text, p_arguments jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_user integer;
  v_previous timestone_private.agent_requests;
  v_result jsonb;
  v_allowed text[];
begin
  select id into v_user from public.users where auth_user_id = (select auth.uid());
  if v_user is null then raise exception 'Kein Mitarbeiterzugang.' using errcode = '42501'; end if;
  if p_request_id is null or p_arguments is null or jsonb_typeof(p_arguments) <> 'object'
    or octet_length(p_arguments::text) > 16384 then
    raise exception 'request_id und ein JSON-Objekt erforderlich.' using errcode = '22023';
  end if;
  -- Lock on the actor, not on the chosen target, to serialize receipt reuse.
  perform pg_advisory_xact_lock(782316, v_user);
  if p_arguments ? 'user' then
    if not timestone_private.is_admin() then
      raise exception 'Nur Admins duerfen fuer andere Mitarbeitende schreiben.' using errcode = '42501';
    end if;
    if jsonb_typeof(p_arguments->'user') is distinct from 'number'
      or (p_arguments->>'user') !~ '^[1-9][0-9]*$' then
      raise exception 'Gueltige Mitarbeiter-ID erforderlich.' using errcode = '22023';
    end if;
    v_user := (p_arguments->>'user')::integer;
    if not exists(select 1 from public.users where id=v_user) then
      raise exception 'Mitarbeiter nicht gefunden.' using errcode = '22023';
    end if;
  end if;
  select * into v_previous from timestone_private.agent_requests
    where actor_id = auth.uid() and request_id = p_request_id;
  if found then
    if v_previous.operation is distinct from p_operation or v_previous.arguments <> p_arguments then
      raise exception 'request_id wurde bereits mit anderen Argumenten verwendet.' using errcode = 'PT409';
    end if;
    return v_previous.result;
  end if;

  v_allowed := case p_operation
    when 'clock_in' then array[]::text[]
    when 'clock_out' then array[]::text[]
    when 'log_attendance_without_break' then array['start','end']
    when 'log_attendance_with_break' then array['start','end','startBreak','endBreak']
    when 'log_sickleave_single_day' then array['date','wholeday']
    when 'log_sickleave_multiday' then array['from','to','wholeday']
    when 'log_vacation_single_day' then array['date','wholeday']
    when 'log_vacation_multiday' then array['from','to','wholeday']
    else null end;
  if v_allowed is not null and timestone_private.is_admin() then v_allowed := v_allowed || array['user']; end if;
  if v_allowed is null or exists(select 1 from jsonb_object_keys(p_arguments) as k where not k = any(v_allowed)) then
    raise exception 'Unbekannte Operation oder Argumente.' using errcode = '22023';
  end if;

  if p_operation in ('log_attendance_without_break','log_attendance_with_break') and
    ((p_arguments->>'start')::timestamptz > clock_timestamp() or (p_arguments->>'end')::timestamptz > clock_timestamp()) then
    raise exception 'Zukünftige Arbeitszeiten sind keine geleistete Anwesenheit.' using errcode = '22023';
  end if;

  case p_operation
    when 'clock_in', 'clock_out' then
      v_result := public.log_attendance_clockin(v_user);
      if v_result->>'action' <> p_operation then
        raise exception 'Stempelstatus passt nicht zur gewünschten Aktion; aktuellen Status laden.' using errcode = 'PT409';
      end if;
    when 'log_attendance_without_break' then
      select to_jsonb(a) into v_result from public.log_attendance_without_break(v_user,
        (p_arguments->>'start')::timestamptz, (p_arguments->>'end')::timestamptz) a;
    when 'log_attendance_with_break' then
      select to_jsonb(a) into v_result from public.log_attendance_with_break(v_user,
        (p_arguments->>'start')::timestamptz, (p_arguments->>'end')::timestamptz,
        (p_arguments->>'startBreak')::timestamptz, (p_arguments->>'endBreak')::timestamptz) a;
    when 'log_sickleave_single_day' then
      select jsonb_agg(to_jsonb(a)) into v_result from public.log_sickleave_single_day(v_user,
        (p_arguments->>'date')::date, case when p_arguments ? 'wholeday' then (p_arguments->>'wholeday')::numeric else 1 end) a;
    when 'log_sickleave_multiday' then
      select jsonb_agg(to_jsonb(a)) into v_result from public.log_sickleave_multiday(v_user,
        (p_arguments->>'from')::date, (p_arguments->>'to')::date,
        case when p_arguments ? 'wholeday' then (p_arguments->>'wholeday')::numeric else 1 end) a;
    when 'log_vacation_single_day' then
      select jsonb_agg(to_jsonb(a)) into v_result from public.log_vacation_single_day(v_user,
        (p_arguments->>'date')::date, case when p_arguments ? 'wholeday' then (p_arguments->>'wholeday')::numeric else 1 end) a;
    when 'log_vacation_multiday' then
      select jsonb_agg(to_jsonb(a)) into v_result from public.log_vacation_multiday(v_user,
        (p_arguments->>'from')::date, (p_arguments->>'to')::date,
        case when p_arguments ? 'wholeday' then (p_arguments->>'wholeday')::numeric else 1 end) a;
  end case;
  insert into timestone_private.agent_requests(actor_id,request_id,operation,arguments,result)
    values(auth.uid(),p_request_id,p_operation,p_arguments,v_result);
  return v_result;
end;
$$;
revoke all on function public.agent_execute(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.agent_execute(uuid,text,jsonb) to authenticated;

create or replace function public.get_my_permissions() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_user integer := timestone_private.current_user_id();
  v_manager boolean;
  v_permissions jsonb := '[
    {"code":"attendance.create_self","label":"Eigene Zeiten anlegen"},
    {"code":"attendance.clock_self","label":"Ein- und ausstempeln"},
    {"code":"sickleave.create_self","label":"Eigene Krankheitstage melden"},
    {"code":"vacation.create_self","label":"Eigene Urlaubstage anfragen"},
    {"code":"vacation.delete_pending_self","label":"Eigene offene Urlaubsantraege zurueckziehen"},
    {"code":"activity.read_self","label":"Eigene Zeiten und Abwesenheiten ansehen"},
    {"code":"attendance.summary_self","label":"Eigene Arbeitszeit auswerten"},
    {"code":"profile.read_self","label":"Eigenes Profil ansehen"},
    {"code":"permissions.read_self","label":"Meine Rolle und Berechtigungen sehen"}
  ]'::jsonb;
begin
  if v_user is null then raise exception 'Kein Mitarbeiterzugang.' using errcode = '42501'; end if;
  select exists(select 1 from public.users where vorgesetzter = v_user) into v_manager;
  if v_manager or timestone_private.is_admin() then
    v_permissions := v_permissions || '[
      {"code":"profile.read_team","label":"Profile des direkten Teams ansehen"},
      {"code":"attendance.read_team","label":"Zeiten des direkten Teams ansehen und auswerten"},
      {"code":"vacation.read_team","label":"Urlaubsantraege des direkten Teams ansehen"},
      {"code":"vacation.update_approved_team","label":"Genehmigten Teamurlaub aendern"},
      {"code":"vacation.delete_approved_team","label":"Genehmigten Teamurlaub loeschen"}
    ]'::jsonb;
  end if;
  if timestone_private.is_admin() then
    v_permissions := v_permissions || '[
      {"code":"employees.read_all","label":"Alle Mitarbeitenden finden"},
      {"code":"activity.read_all","label":"Zeiten, Krankheit und Urlaub aller ansehen"},
      {"code":"activity.create_all","label":"Zeiten, Krankheit und Urlaub fuer alle anlegen"},
      {"code":"attendance.clock_all","label":"Fuer Mitarbeitende ein- und ausstempeln"},
      {"code":"attendance.summary_all","label":"Arbeitszeit aller Mitarbeitenden auswerten"},
      {"code":"vacation.update_all","label":"Offene und genehmigte Urlaubstage aller aendern"},
      {"code":"vacation.delete_all","label":"Offene und genehmigte Urlaubstage aller loeschen"}
    ]'::jsonb;
  end if;
  return jsonb_build_object('role',case when timestone_private.is_admin() then 'Admin' when v_manager then 'Manager' else 'User' end,
    'permissions',v_permissions,
    'notes',case when timestone_private.is_admin() then jsonb_build_array('Adminrechte gelten fuer alle Mitarbeitenden.', 'Neue Urlaubsantraege starten weiterhin ungenehmigt.', 'Rollenverwaltung und Urlaubsgenehmigung sind noch keine Agentenfunktionen.') else jsonb_build_array(
      'Eigene genehmigte Urlaube sind nicht selbst aenderbar.',
      'Managerrechte gelten nur fuer das direkte Team.'
    ) end);
end;
$$;
revoke all on function public.get_my_permissions() from public, anon, authenticated;
grant execute on function public.get_my_permissions() to authenticated;
