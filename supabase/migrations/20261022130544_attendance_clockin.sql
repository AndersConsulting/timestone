-- Only clock entries may be open and omit their break. Existing complete-day
-- RPCs still require an end and both break timestamps.
alter table public.anwesenheit
  add column is_clock_entry boolean not null default false,
  alter column end_at drop not null,
  alter column start_break drop not null,
  alter column end_break drop not null;

alter table public.anwesenheit add constraint anwesenheit_entry_shape check (
  (is_clock_entry and start_break is null and end_break is null)
  or
  (not is_clock_entry and end_at is not null and start_break is not null and end_break is not null)
);

create unique index anwesenheit_one_clock_entry_per_day
  on public.anwesenheit(user_id, ((start_at at time zone 'Europe/Berlin')::date))
  where is_clock_entry;

grant insert (is_clock_entry), update (end_at) on public.anwesenheit to authenticated;
create policy anwesenheit_clockout_self on public.anwesenheit for update to authenticated
  using (is_clock_entry and end_at is null
    and user_id in (select id from public.users where auth_user_id = (select auth.uid())))
  with check (is_clock_entry and end_at is not null
    and user_id in (select id from public.users where auth_user_id = (select auth.uid())));

create function public.log_attendance_clockin(p_user integer)
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
    if (v_entry.start_at at time zone 'Europe/Berlin')::date <> v_day then
      raise exception 'Offene Buchung eines anderen Tages zuerst durch einen Administrator korrigieren lassen.' using errcode = 'PT409';
    end if;
    if v_now <= v_entry.start_at then
      raise exception 'Ausstempeln muss nach dem Einstempeln erfolgen.' using errcode = 'PT409';
    end if;
    update public.anwesenheit set end_at = v_now
      where id = v_entry.id and end_at is null returning * into v_entry;
    if not found then
      raise exception 'Buchung wurde bereits geschlossen.' using errcode = 'PT409';
    end if;
    return jsonb_build_object('action', 'clock_out', 'attendance', to_jsonb(v_entry));
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

revoke all on function public.log_attendance_clockin(integer) from public, anon, authenticated;
grant execute on function public.log_attendance_clockin(integer) to authenticated;
