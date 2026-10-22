-- Integer business IDs are separate from Supabase Auth UUIDs.
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

create table public.users (
  id integer generated always as identity primary key,
  card_id uuid not null default gen_random_uuid() unique,
  fullname text not null check (length(trim(fullname)) between 1 and 200),
  email text not null check (email = trim(email) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  vorgesetzter integer references public.users(id) on delete restrict,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  check (vorgesetzter is distinct from id)
);
create unique index users_email_unique on public.users(lower(email));
create index users_vorgesetzter_idx on public.users(vorgesetzter);

create table public.anwesenheit (
  id integer generated always as identity primary key,
  user_id integer not null references public.users(id) on delete restrict,
  start_at timestamptz not null check (isfinite(start_at)),
  end_at timestamptz not null check (isfinite(end_at)),
  start_break timestamptz not null check (isfinite(start_break)),
  end_break timestamptz not null check (isfinite(end_break)),
  check (start_at < end_at),
  check (start_at <= start_break and start_break < end_break and end_break <= end_at)
);
-- Also rejects concurrent duplicates and overlapping work intervals.
set search_path = public, extensions;
alter table public.anwesenheit add constraint anwesenheit_no_overlap
  exclude using gist (user_id with =, tstzrange(start_at, end_at, '[)') with &&);
reset search_path;
create index anwesenheit_user_start_idx on public.anwesenheit(user_id, start_at);

create table public.krankheit (
  id integer generated always as identity primary key,
  user_id integer not null references public.users(id) on delete restrict,
  date date not null check (isfinite(date)),
  wholeday numeric not null default 1 check (wholeday in (0.5, 1)),
  unique(user_id, date)
);

create table public.urlaube (
  id integer generated always as identity primary key,
  user_id integer not null references public.users(id) on delete restrict,
  date date not null check (isfinite(date)),
  wholeday numeric not null default 1 check (wholeday in (0.5, 1)),
  is_approved boolean not null default false,
  unique(user_id, date)
);

alter table public.users enable row level security;
alter table public.anwesenheit enable row level security;
alter table public.krankheit enable row level security;
alter table public.urlaube enable row level security;

create policy users_read_self on public.users for select to authenticated
  using (auth_user_id = (select auth.uid()));
create policy anwesenheit_read_self on public.anwesenheit for select to authenticated
  using (user_id in (select id from public.users where auth_user_id = (select auth.uid())));
create policy anwesenheit_insert_self on public.anwesenheit for insert to authenticated
  with check (user_id in (select id from public.users where auth_user_id = (select auth.uid())));
create policy krankheit_read_self on public.krankheit for select to authenticated
  using (user_id in (select id from public.users where auth_user_id = (select auth.uid())));
create policy krankheit_insert_self on public.krankheit for insert to authenticated
  with check (user_id in (select id from public.users where auth_user_id = (select auth.uid())));
create policy urlaube_read_self on public.urlaube for select to authenticated
  using (user_id in (select id from public.users where auth_user_id = (select auth.uid())));
create policy urlaube_insert_self on public.urlaube for insert to authenticated
  with check (not is_approved and user_id in (select id from public.users where auth_user_id = (select auth.uid())));

revoke all on public.users, public.anwesenheit, public.krankheit, public.urlaube from public, anon, authenticated;
grant select on public.users, public.anwesenheit, public.krankheit, public.urlaube to authenticated;
grant insert (user_id, start_at, end_at, start_break, end_break) on public.anwesenheit to authenticated;
grant insert (user_id, date, wholeday) on public.krankheit, public.urlaube to authenticated;
grant usage on sequence public.anwesenheit_id_seq, public.krankheit_id_seq, public.urlaube_id_seq to authenticated;
grant all on public.users, public.anwesenheit, public.krankheit, public.urlaube to service_role;
grant usage, select on sequence public.users_id_seq, public.anwesenheit_id_seq, public.krankheit_id_seq, public.urlaube_id_seq to service_role;

-- All RPCs use the caller's permissions and RLS, never SECURITY DEFINER.
create function public.log_attendance_with_break(
  p_user integer, p_start timestamptz, p_end timestamptz,
  p_start_break timestamptz, p_end_break timestamptz
) returns public.anwesenheit language sql security invoker set search_path = '' as $$
  insert into public.anwesenheit(user_id, start_at, end_at, start_break, end_break)
  values (p_user, p_start, p_end, p_start_break, p_end_break) returning *;
$$;

create function public.log_attendance_without_break(p_user integer, p_start timestamptz, p_end timestamptz)
returns public.anwesenheit language plpgsql security invoker set search_path = '' as $$
declare
  work_date date := (p_start at time zone 'Europe/Berlin')::date;
  result public.anwesenheit;
begin
  if work_date is distinct from (p_end at time zone 'Europe/Berlin')::date then
    raise exception 'Standardpause erfordert Beginn und Ende am selben Berliner Kalendertag.' using errcode = '22023';
  end if;
  select * into result from public.log_attendance_with_break(
    p_user, p_start, p_end,
    (work_date + time '12:30') at time zone 'Europe/Berlin',
    (work_date + time '13:30') at time zone 'Europe/Berlin'
  );
  return result;
end;
$$;

create function public.log_sickleave_multiday(p_user integer, p_from date, p_to date, p_wholeday numeric default 1)
returns setof public.krankheit language plpgsql security invoker set search_path = '' as $$
begin
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to) then
    raise exception 'Gültiges from und to erforderlich.' using errcode = '22023';
  end if;
  if p_to < p_from or p_to - p_from > 365 then
    raise exception 'Zeitraum muss 1 bis 366 Kalendertage umfassen.' using errcode = '22023';
  end if;
  return query insert into public.krankheit(user_id, date, wholeday)
    select p_user, p_from + day_offset, p_wholeday
    from generate_series(0, p_to - p_from) as day_offset returning *;
end;
$$;

create function public.log_sickleave_single_day(p_user integer, p_date date, p_wholeday numeric default 1)
returns setof public.krankheit language sql security invoker set search_path = '' as $$
  select * from public.log_sickleave_multiday(p_user, p_date, p_date, p_wholeday);
$$;

create function public.log_vacation_multiday(p_user integer, p_from date, p_to date, p_wholeday numeric default 1)
returns setof public.urlaube language plpgsql security invoker set search_path = '' as $$
begin
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to) then
    raise exception 'Gültiges from und to erforderlich.' using errcode = '22023';
  end if;
  if p_to < p_from or p_to - p_from > 365 then
    raise exception 'Zeitraum muss 1 bis 366 Kalendertage umfassen.' using errcode = '22023';
  end if;
  return query insert into public.urlaube(user_id, date, wholeday)
    select p_user, p_from + day_offset, p_wholeday
    from generate_series(0, p_to - p_from) as day_offset returning *;
end;
$$;

create function public.log_vacation_single_day(p_user integer, p_date date, p_wholeday numeric default 1)
returns setof public.urlaube language sql security invoker set search_path = '' as $$
  select * from public.log_vacation_multiday(p_user, p_date, p_date, p_wholeday);
$$;

revoke all on function public.log_attendance_with_break(integer,timestamptz,timestamptz,timestamptz,timestamptz),
  public.log_attendance_without_break(integer,timestamptz,timestamptz),
  public.log_sickleave_single_day(integer,date,numeric), public.log_sickleave_multiday(integer,date,date,numeric),
  public.log_vacation_single_day(integer,date,numeric), public.log_vacation_multiday(integer,date,date,numeric)
  from public, anon, authenticated;
grant execute on function public.log_attendance_with_break(integer,timestamptz,timestamptz,timestamptz,timestamptz),
  public.log_attendance_without_break(integer,timestamptz,timestamptz),
  public.log_sickleave_single_day(integer,date,numeric), public.log_sickleave_multiday(integer,date,date,numeric),
  public.log_vacation_single_day(integer,date,numeric), public.log_vacation_multiday(integer,date,date,numeric)
  to authenticated, service_role;
