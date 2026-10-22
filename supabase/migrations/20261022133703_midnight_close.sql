-- Scheduled closures are distinguishable from an explicit clock-out.
alter table public.anwesenheit add column auto_closed boolean not null default false;
alter table public.anwesenheit add constraint anwesenheit_auto_closed_shape
  check (not auto_closed or (is_clock_entry and end_at is not null));

-- Runs before attendance_clock_break (Postgres sorts trigger names).
-- Also caps a clock-out that races the midnight scheduler.
create function timestone_private.cap_clock_at_midnight() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_midnight timestamptz := (((new.start_at at time zone 'Europe/Berlin')::date + 1)::timestamp
    at time zone 'Europe/Berlin');
begin
  if old.end_at is null and new.is_clock_entry and new.end_at >= v_midnight then
    new.end_at := v_midnight;
    new.auto_closed := true;
  end if;
  return new;
end;
$$;
revoke all on function timestone_private.cap_clock_at_midnight() from public, anon, authenticated, service_role;
create trigger attendance_00_midnight before update of end_at on public.anwesenheit
  for each row execute function timestone_private.cap_clock_at_midnight();

create index anwesenheit_open_by_user on public.anwesenheit(user_id) where end_at is null;

-- Invoker privileges: only the database administrator / scheduler may run this.
-- A delayed run closes at the original day's midnight, never at catch-up time.
create function timestone_private.close_open_attendance(p_now timestamptz default clock_timestamp())
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  v_user integer;
  v_count integer := 0;
  v_changed integer;
  v_day date := (p_now at time zone 'Europe/Berlin')::date;
begin
  if p_now is null or not isfinite(p_now) then
    raise exception 'Finite server time required.' using errcode = '22023';
  end if;
  for v_user in select distinct user_id from public.anwesenheit
    where end_at is null and start_at < (v_day::timestamp at time zone 'Europe/Berlin')
    order by user_id
  loop
    -- Same lock as clock-in/out and agent_execute; recheck after acquiring it.
    perform pg_advisory_xact_lock(782316, v_user);
    update public.anwesenheit
      set end_at = (((start_at at time zone 'Europe/Berlin')::date + 1)::timestamp at time zone 'Europe/Berlin')
      where user_id = v_user and end_at is null
        and start_at < (v_day::timestamp at time zone 'Europe/Berlin');
    get diagnostics v_changed = row_count;
    v_count := v_count + v_changed;
  end loop;
  return v_count;
end;
$$;
revoke all on function timestone_private.close_open_attendance(timestamptz) from public, anon, authenticated, service_role;

create or replace function public.log_attendance_clockin(p_user integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz;
  v_day date;
  v_entry public.anwesenheit;
begin
  if not exists (select 1 from public.users where id = p_user and auth_user_id = (select auth.uid())) then
    raise exception 'Kein Zugriff auf diesen Benutzer.' using errcode = '42501';
  end if;

  -- Serialize the decision even when there is no row to lock yet.
  perform pg_advisory_xact_lock(782316, p_user);
  select * into v_entry from public.anwesenheit
    where user_id = p_user and end_at is null for update;
  v_now := clock_timestamp();
  v_day := (v_now at time zone 'Europe/Berlin')::date;

  if found then
    if v_now <= v_entry.start_at then
      raise exception 'Ausstempeln muss nach dem Einstempeln erfolgen.' using errcode = 'PT409';
    end if;
    update public.anwesenheit set end_at = v_now
      where id = v_entry.id and end_at is null returning * into v_entry;
    if not found then
      raise exception 'Buchung wurde bereits geschlossen.' using errcode = 'PT409';
    end if;
    if (v_entry.start_at at time zone 'Europe/Berlin')::date = v_day then
      return jsonb_build_object('action', 'clock_out', 'attendance', to_jsonb(v_entry));
    end if;
    -- If cron has not run yet, the trigger closes yesterday at midnight,
    -- then today's first scan starts a new attendance.
  end if;

  if exists (select 1 from public.anwesenheit where user_id = p_user
    and start_at >= (v_day::timestamp at time zone 'Europe/Berlin')
    and start_at < ((v_day + 1)::timestamp at time zone 'Europe/Berlin')) then
    raise exception 'Für heute ist bereits eine abgeschlossene Anwesenheit vorhanden.' using errcode = 'PT409';
  end if;

  insert into public.anwesenheit(user_id, start_at, is_clock_entry)
    values (p_user, v_now, true) returning * into v_entry;
  return jsonb_build_object('action', 'clock_in', 'attendance', to_jsonb(v_entry));
end;
$$;

