-- This is a report of application capabilities, not a source of authorization.
-- Manager status is derived from the same direct-report relation as RLS.
create function public.get_my_permissions() returns jsonb
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
  if v_manager then
    v_permissions := v_permissions || '[
      {"code":"profile.read_team","label":"Profile des direkten Teams ansehen"},
      {"code":"attendance.read_team","label":"Zeiten des direkten Teams ansehen und auswerten"},
      {"code":"vacation.read_team","label":"Urlaubsantraege des direkten Teams ansehen"},
      {"code":"vacation.update_approved_team","label":"Genehmigten Teamurlaub aendern"},
      {"code":"vacation.delete_approved_team","label":"Genehmigten Teamurlaub loeschen"}
    ]'::jsonb;
  end if;
  return jsonb_build_object('role',case when v_manager then 'Manager' else 'User' end,
    'permissions',v_permissions,
    'notes',jsonb_build_array(
      'Eigene genehmigte Urlaube sind nicht selbst aenderbar.',
      'Managerrechte gelten nur fuer das direkte Team.'
    ));
end;
$$;
revoke all on function public.get_my_permissions() from public, anon, authenticated;
grant execute on function public.get_my_permissions() to authenticated;
