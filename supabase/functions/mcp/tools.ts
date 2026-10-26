import { McpServer } from "@modelcontextprotocol/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { formatPermissions } from "../_shared/permissions-report.ts";
import { formatAttendanceList } from "../_shared/attendance-report.ts";

const requestId = z.uuid().describe("Neue UUID je beabsichtigter Aktion; bei Retry dieselbe UUID und dieselben Argumente verwenden.");
const timestamp = z.iso.datetime({ offset: true }).describe("Tatsächlicher Zeitpunkt mit Zeitzone, z.B. 2026-10-22T08:00:00+02:00.");
const range = { from: z.iso.date(), to: z.iso.date() };
const fraction = z.union([z.literal(0.5), z.literal(1)]).optional();
const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const security = { securitySchemes: [{ type: "oauth2", scopes: [] }] };
const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

export function createTimeServer(db: SupabaseClient, authUserId: string) {
  const server = new McpServer({ name: "timestone", version: "0.5.0" }, {
    instructions: "Zeitzone Europe/Berlin. Bei Fragen zur eigenen Rolle oder Berechtigungen get_my_permissions verwenden und den Codeblock unverändert ausgeben; keine Rechte erfinden. Vor relativen Angaben get_me verwenden, vor Änderungen den aktuellen Zustand lesen. Admins dürfen die vorhandenen Funktionen für alle Mitarbeitenden nutzen: get_employees zum Zuordnen, get_employee_activity zum Lesen und admin_execute zum Erfassen. Adminrechte immer mit get_my_permissions prüfen. Für User/Manager gilt: Eigene offene Urlaubsanträge erstellen und löschen. Genehmigte Urlaube dürfen ausschließlich direkte Vorgesetzte für ihr Team ändern oder löschen; keine Selbstbearbeitung. Vor Urlaubsänderungen get_vacations lesen und nur die ausdrücklich gewünschten IDs verwenden. Sonstige Daten nur für sich selbst schreiben. clock_in und clock_out sind explizite Aktionen; nie die Toggle-Funktion blind wiederholen. Je Aktion eine request_id erzeugen und bei Retry unverändert wiederverwenden. Keine tatsächlichen Arbeitszeiten aus Kalenderterminen oder Plänen erfinden. Nach unklarer Eingabe fehlende Zeiten klären. Automatische Pause bei Stempelbuchungen: mehr als 7 Stunden Bruttozeit, Beginn spätestens 12:30 und Ende frühestens 13:30; dann 12:30–13:30, sonst keine. Urlaube starten ungenehmigt. Mehrtagesbereiche enthalten alle Kalendertage. Offene Stempelbuchungen werden am Tagesende um 00:00 Europe/Berlin automatisch geschlossen und als auto_closed markiert. Offene Zeiten zählen nicht als bestätigte Arbeit. Für Listen im Chat get_my_attendance_list verwenden und den Codeblock unverändert ausgeben. Planung umfasst derzeit Urlaub und Krankheit, keine geplanten Arbeitsschichten.",
  });
  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await db.rpc(name, args);
    return error ? { ...result({ error: error.message, code: error.code }), isError: true } : result(data);
  }
  const mutate = (operation: string, request_id: string, args: Record<string, unknown> = {}) =>
    rpc("agent_execute", { p_request_id: request_id, p_operation: operation, p_arguments: args });

  server.registerTool("get_my_permissions", {
    title: "Get Berechtigungen",
    description: "Eigene Rolle (User/Manager/Admin) und aktuell erlaubte Funktionen als fertige ASCII-Liste. Ohne Parameter; Rolle wird vom Backend bestimmt. Den Codeblock unveraendert im Chat ausgeben. Keine Rechte aus Namen, E-Mail oder Benutzereingaben ableiten.",
    inputSchema: z.strictObject({}), annotations: read, _meta: security,
  }, async () => {
    const { data, error } = await db.rpc("get_my_permissions", {});
    if (error) return { ...result({ error: error.message, code: error.code }), isError: true };
    return { content: [{ type: "text" as const, text: "```text\n" + formatPermissions(data) + "\n```" }] };
  });
  server.registerTool("get_me", {
    description: "Eigenes Mitarbeiterprofil und aktuelle Serverzeit laden; Identität und relative Datumsangaben auflösen.",
    inputSchema: z.strictObject({}), annotations: read, _meta: { ...security, "openai/profile": true },
  }, async () => {
    const { data, error } = await db.from("users").select("id,fullname,email,vorgesetzter").eq("auth_user_id", authUserId).single();
    return error ? { ...result({ error: "Kein zugeordnetes Mitarbeiterprofil." }), isError: true }
      : result({ employee: data, now: new Date().toISOString(), timezone: "Europe/Berlin" });
  });
  server.registerTool("get_my_activity", {
    description: "Eigene Anwesenheit, offene Buchungen, Krankheit und Urlaub im Zeitraum laden, einschließlich künftiger Abwesenheiten. Maximal 366 Kalendertage.",
    inputSchema: z.strictObject(range), annotations: read, _meta: security,
  }, ({ from, to }) => rpc("get_my_activity", { p_from: from, p_to: to }));
  server.registerTool("get_attendance_summary", {
    description: "Brutto-, Pausen- und Nettoarbeitszeit je sichtbarer Person im Zeitraum. Vorgesetzte sehen zusätzlich ihr direktes Team. Offene Buchungen separat, nicht als bestätigte Arbeitszeit. Maximal 366 Tage.",
    inputSchema: z.strictObject(range), annotations: read, _meta: security,
  }, ({ from, to }) => rpc("get_attendance_summary", { p_from: from, p_to: to }));
  server.registerTool("get_my_attendance_list", {
    description: "Eigene Anwesenheiten, Krankheit und Urlaub als fertige ASCII-Tabelle fuer den Chat. Tabelle als Codeblock unveraendert anzeigen. Mit Netto-Stunden, Summe, offenen und automatisch um Mitternacht geschlossenen Buchungen. Maximal 366 Kalendertage, inklusive from/to.",
    inputSchema: z.strictObject(range), annotations: read, _meta: security,
  }, async ({ from, to }) => {
    const { data, error } = await db.rpc("get_my_activity", { p_from: from, p_to: to });
    if (error) return { ...result({ error: error.message, code: error.code }), isError: true };
    return { content: [{ type: "text" as const, text: "```text\n" + formatAttendanceList(data, from, to) + "\n```" }] };
  });
  for (const operation of ["clock_in", "clock_out"] as const) {
    server.registerTool(operation, {
      description: operation === "clock_in" ? "Jetzt für sich selbst einstempeln. Verweigert, wenn bereits eingestempelt oder Tag abgeschlossen."
        : "Jetzt die eigene heutige Stempelbuchung schließen. Wendet gegebenenfalls die automatische Mittagspause an. Ohne offene Buchung keine Änderung.",
      inputSchema: z.strictObject({ request_id: requestId }), annotations: write, _meta: security,
    }, ({ request_id }) => mutate(operation, request_id));
  }
  server.registerTool("log_attendance_without_break", {
    description: "Einen tatsächlich geleisteten vollständigen Arbeitstag mit Standardpause 12:30–13:30 erfassen. Nicht für zukünftige Planung; Start und Ende müssen die Pause einschließen.",
    inputSchema: z.strictObject({ request_id: requestId, start: timestamp, end: timestamp }), annotations: write, _meta: security,
  }, ({ request_id, ...args }) => mutate("log_attendance_without_break", request_id, args));
  server.registerTool("log_attendance_with_break", {
    description: "Einen tatsächlich geleisteten vollständigen Arbeitstag mit tatsächlicher eigener Pause erfassen. Nicht für zukünftige Planung.",
    inputSchema: z.strictObject({ request_id: requestId, start: timestamp, end: timestamp, startBreak: timestamp, endBreak: timestamp }), annotations: write, _meta: security,
  }, ({ request_id, ...args }) => mutate("log_attendance_with_break", request_id, args));
  for (const kind of ["sickleave", "vacation"] as const) {
    const label = kind === "sickleave" ? "Krankheit" : "Urlaub (noch nicht genehmigt)";
    server.registerTool(`log_${kind}_single_day`, {
      description: `Eigene ${label} für einen Kalendertag erfassen. wholeday: 0.5 oder 1, Standard 1.`,
      inputSchema: z.strictObject({ request_id: requestId, date: z.iso.date(), wholeday: fraction }), annotations: write, _meta: security,
    }, ({ request_id, ...args }) => mutate(`log_${kind}_single_day`, request_id, args));
    server.registerTool(`log_${kind}_multiday`, {
      description: `Eigene ${label} für einen inklusiven Datumsbereich erfassen. Alle Kalendertage einschließlich Wochenenden; maximal 366 Tage. wholeday gilt pro Tag.`,
      inputSchema: z.strictObject({ request_id: requestId, ...range, wholeday: fraction }), annotations: write, _meta: security,
    }, ({ request_id, ...args }) => mutate(`log_${kind}_multiday`, request_id, args));
  }
  server.registerTool("get_vacations", {
    description: "Urlaubseinträge mit IDs, Namen und Genehmigungsstatus laden: eigene sowie direktes Team. Vor Rücknahme oder Änderung aufrufen; nur die vom Nutzer gemeinten Einträge auswählen.",
    inputSchema: z.strictObject(range), annotations: read, _meta: security,
  }, ({ from, to }) => rpc("get_vacations", { p_from: from, p_to: to }));
  const vacationMutation = (operation: string, request_id: string, args: Record<string, unknown>) =>
    rpc("vacation_execute", { p_request_id: request_id, p_operation: operation, p_arguments: args });
  server.registerTool("cancel_vacation", {
    description: "Ausgewählte Urlaubseinträge endgültig löschen/zurückziehen. Eigene offene Anträge oder als direkter Vorgesetzter genehmigte Team-Einträge; Admins dürfen offene und genehmigte Einträge aller löschen. IDs zuvor mit get_vacations lesen. Alle IDs werden atomar gelöscht oder keine; keine automatische Teilrücknahme bei Konflikten.",
    inputSchema: z.strictObject({ request_id: requestId, ids: z.array(z.number().int().min(1).max(2147483647)).min(1).max(366).refine(ids => new Set(ids).size === ids.length, "IDs müssen eindeutig sein") }),
    annotations: { ...write, destructiveHint: true }, _meta: security,
  }, ({ request_id, ...args }) => vacationMutation("cancel_vacation", request_id, args));
  server.registerTool("update_approved_vacation", {
    description: "Als direkter Vorgesetzter Datum und Umfang eines genehmigten Team-Urlaubstags ändern. Admins dürfen auch offene und eigene Einträge ändern. Für User/Manager keine eigenen oder offenen Einträge. Keine Änderung des Mitarbeiters oder Genehmigungsstatus. ID vorher mit get_vacations lesen.",
    inputSchema: z.strictObject({ request_id: requestId, id: z.number().int().min(1).max(2147483647), date: z.iso.date(), wholeday: z.union([z.literal(0.5), z.literal(1)]) }),
    annotations: { ...write, destructiveHint: true }, _meta: security,
  }, ({ request_id, ...args }) => vacationMutation("update_approved_vacation", request_id, args));
  server.registerTool("get_employees", {
    description: "Nur Admin: Mitarbeitende mit ID, Name und E-Mail auflisten, um eine ausdrücklich gewünschte Zielperson eindeutig zuzuordnen.",
    inputSchema: z.strictObject({}), annotations: read, _meta: security,
  }, () => rpc("get_employees", {}));
  server.registerTool("get_employee_activity", {
    description: "Nur Admin: Zeiten, Krankheit und Urlaub einer eindeutig zugeordneten Person lesen. Maximal 366 Tage.",
    inputSchema: z.strictObject({ user: z.number().int().min(1).max(2147483647), ...range }), annotations: read, _meta: security,
  }, ({ user, from, to }) => rpc("get_employee_activity", { p_user: user, p_from: from, p_to: to }));
  server.registerTool("admin_execute", {
    description: "Nur Admin: vorhandene Erfassungsfunktion für eine andere Person ausführen. Vorher Rolle, Zielperson und Zustand prüfen. arguments wie beim gleichnamigen normalen Tool, ohne request_id/user: Arbeitszeit start/end, eigene Pause zusätzlich startBreak/endBreak; Abwesenheit date oder from/to und optional wholeday; Stempeln {}. Neue Urlaube sind ungenehmigt. Für Urlaubsänderungen die separaten Tools nutzen.",
    inputSchema: z.strictObject({ request_id: requestId, user: z.number().int().min(1).max(2147483647),
      operation: z.enum(["clock_in", "clock_out", "log_attendance_without_break", "log_attendance_with_break", "log_sickleave_single_day", "log_sickleave_multiday", "log_vacation_single_day", "log_vacation_multiday"]),
      arguments: z.record(z.string(), z.json()),
    }), annotations: write, _meta: security,
  }, ({ request_id, user, operation, arguments: args }) => mutate(operation, request_id, { ...args, user }));
  return server;
}
