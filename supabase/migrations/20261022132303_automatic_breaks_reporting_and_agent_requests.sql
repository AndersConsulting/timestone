create schema if not exists timestone_private;
revoke all on schema timestone_private from public, anon;
grant usage on schema timestone_private to authenticated;

-- A private, tightly scoped identity lookup avoids recursive RLS on users.
create function timestone_private.current_user_id() returns integer
language sql stable security definer set search_path = '' as $$
  select id from public.users where auth.uid() is not null and auth_user_id = (select auth.uid());
$$;
revoke all on function timestone_private.current_user_id() from public, anon, authenticated;
grant execute on function timestone_private.current_user_id() to authenticated;

alter policy users_read_self on public.users using (
  auth_user_id = (select auth.uid()) or vorgesetzter = (select timestone_private.current_user_id())
);
-- Explicitly limited to the signed-in employee and their direct reports, as
-- requested. Do not rely solely on the visibility policy of public.users.
alter policy anwesenheit_read_self on public.anwesenheit using (
  user_id = (select timestone_private.current_user_id())
  or user_id in (select id from public.users
    where vorgesetzter = (select timestone_private.current_user_id()))
);
-- All INSERT/UPDATE policies retain their explicit auth_user_id ownership check.

alter table public.anwesenheit drop constraint anwesenheit_entry_shape;
alter table public.anwesenheit add constraint anwesenheit_entry_shape check (
  (is_clock_entry and (
    (start_break is null and end_break is null)
    or (end_at is not null and start_break is not null and end_break is not null)
  )) or
  (not is_clock_entry and end_at is not null and start_break is not null and end_break is not null)
);

-- Apply at the database boundary, including direct updates and agent calls.
-- This is business logic, not a statutory break calculation.
create function timestone_private.apply_clock_break() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_day date := (new.start_at at time zone 'Europe/Berlin')::date;
  v_break_start timestamptz := (v_day + time '12:30') at time zone 'Europe/Berlin';
  v_break_end timestamptz := (v_day + time '13:30') at time zone 'Europe/Berlin';
begin
  if new.is_clock_entry then
    new.start_break := null;
    new.end_break := null;
    if new.end_at is not null and new.end_at - new.start_at > interval '7 hours'
      and new.start_at <= v_break_start and new.end_at >= v_break_end then
      new.start_break := v_break_start;
      new.end_break := v_break_end;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function timestone_private.apply_clock_break() from public, anon, authenticated;
create trigger attendance_clock_break before insert or update of start_at, end_at, start_break, end_break, is_clock_entry
  on public.anwesenheit for each row execute function timestone_private.apply_clock_break();

create view public.attendance_daily_summary with (security_invoker = true) as
select u.id as user_id, u.fullname,
  (a.start_at at time zone 'Europe/Berlin')::date as work_date,
  count(*) as entry_count,
  count(*) filter (where a.end_at is null) as open_entries,
  coalesce(sum(extract(epoch from (a.end_at - a.start_at))) filter (where a.end_at is not null), 0) as gross_seconds,
  coalesce(sum(extract(epoch from (a.end_break - a.start_break))) filter (where a.end_at is not null), 0) as break_seconds,
  coalesce(sum(extract(epoch from (a.end_at - a.start_at)) - coalesce(extract(epoch from (a.end_break - a.start_break)), 0))
    filter (where a.end_at is not null), 0) as net_seconds,
  round(coalesce(sum(extract(epoch from (a.end_at - a.start_at)) - coalesce(extract(epoch from (a.end_break - a.start_break)), 0))
    filter (where a.end_at is not null), 0) / 3600, 2) as net_hours
from public.users u join public.anwesenheit a on a.user_id = u.id
group by u.id, u.fullname, (a.start_at at time zone 'Europe/Berlin')::date;

create view public.attendance_totals with (security_invoker = true) as
select u.id as user_id, u.fullname,
  coalesce(sum(d.gross_seconds), 0) as gross_seconds,
  coalesce(sum(d.break_seconds), 0) as break_seconds,
  coalesce(sum(d.net_seconds), 0) as net_seconds,
  round(coalesce(sum(d.net_seconds), 0) / 3600, 2) as net_hours,
  coalesce(sum(d.open_entries), 0) as open_entries
from public.users u left join public.attendance_daily_summary d on d.user_id = u.id
group by u.id, u.fullname;
revoke all on public.attendance_daily_summary, public.attendance_totals from public, anon, authenticated;
grant select on public.attendance_daily_summary, public.attendance_totals to authenticated, service_role;

create function public.get_attendance_summary(p_from date, p_to date) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_result jsonb;
begin
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to) then
    raise exception 'Gültiges from und to erforderlich.' using errcode = '22023';
  end if;
  if p_to < p_from or p_to - p_from > 365 then
    raise exception 'Zeitraum muss 1 bis 366 Kalendertage umfassen.' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(to_jsonb(summary) order by summary.user_id), '[]'::jsonb) into v_result
  from (
    select u.id as user_id, u.fullname,
      coalesce(sum(d.gross_seconds), 0) as gross_seconds,
      coalesce(sum(d.break_seconds), 0) as break_seconds,
      coalesce(sum(d.net_seconds), 0) as net_seconds,
      round(coalesce(sum(d.net_seconds), 0) / 3600, 2) as net_hours,
      coalesce(sum(d.open_entries), 0) as open_entries
    from public.users u left join public.attendance_daily_summary d
      on d.user_id = u.id and d.work_date between p_from and p_to
    group by u.id, u.fullname
  ) summary;
  return jsonb_build_object('from', p_from, 'to', p_to, 'timezone', 'Europe/Berlin', 'employees', v_result);
end;
$$;
revoke all on function public.get_attendance_summary(date,date) from public, anon, authenticated;
grant execute on function public.get_attendance_summary(date,date) to authenticated;

create function public.get_my_activity(p_from date, p_to date) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_user integer; v_attendance jsonb; v_sick jsonb; v_vacation jsonb;
begin
  -- Reuse date-range validation. The result itself is deliberately self-only.
  perform public.get_attendance_summary(p_from,p_to);
  select id into v_user from public.users where auth_user_id = (select auth.uid());
  if v_user is null then raise exception 'Kein Mitarbeiterzugang.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.start_at), '[]'::jsonb) into v_attendance
    from public.anwesenheit a where user_id = v_user
      and start_at >= (p_from::timestamp at time zone 'Europe/Berlin')
      and start_at < ((p_to + 1)::timestamp at time zone 'Europe/Berlin');
  select coalesce(jsonb_agg(to_jsonb(k) order by k.date), '[]'::jsonb) into v_sick
    from public.krankheit k where user_id = v_user and date between p_from and p_to;
  select coalesce(jsonb_agg(to_jsonb(u) order by u.date), '[]'::jsonb) into v_vacation
    from public.urlaube u where user_id = v_user and date between p_from and p_to;
  return jsonb_build_object('user_id',v_user,'timezone','Europe/Berlin',
    'attendance',v_attendance,'sickleave',v_sick,'vacation',v_vacation);
end;
$$;
revoke all on function public.get_my_activity(date,date) from public, anon, authenticated;
grant execute on function public.get_my_activity(date,date) to authenticated;

-- A successful agent mutation and its replay receipt commit atomically.
create table timestone_private.agent_requests (
  actor_id uuid not null references auth.users(id),
  request_id uuid not null,
  operation text not null,
  arguments jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(actor_id, request_id)
);
alter table timestone_private.agent_requests enable row level security;
create policy agent_requests_read_self on timestone_private.agent_requests for select to authenticated
  using (actor_id = (select auth.uid()));
create policy agent_requests_insert_self on timestone_private.agent_requests for insert to authenticated
  with check (actor_id = (select auth.uid()));
revoke all on timestone_private.agent_requests from public, anon, authenticated;
grant select, insert on timestone_private.agent_requests to authenticated;

create function public.agent_execute(p_request_id uuid, p_operation text, p_arguments jsonb default '{}'::jsonb)
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
    when 'clock_in' then array[]::text[]
    when 'clock_out' then array[]::text[]
    when 'log_attendance_without_break' then array['start','end']
    when 'log_attendance_with_break' then array['start','end','startBreak','endBreak']
    when 'log_sickleave_single_day' then array['date','wholeday']
    when 'log_sickleave_multiday' then array['from','to','wholeday']
    when 'log_vacation_single_day' then array['date','wholeday']
    when 'log_vacation_multiday' then array['from','to','wholeday']
    else null end;
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
