import { formatAttendanceList } from "./attendance-report.ts";

export const functionNames = [
  "log_attendance_without_break", "log_attendance_with_break",
  "log_sickleave_single_day", "log_sickleave_multiday",
  "log_vacation_single_day", "log_vacation_multiday",
  "log_attendance_clockin",
  "get_my_attendance_list",
] as const;
export type FunctionName = typeof functionNames[number];

class InputError extends Error {}
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
function date(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value || value < "0001-01-01") {
    throw new InputError(`${field} muss ein gültiges Datum (YYYY-MM-DD) sein.`);
  }
  return value;
}
function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))) {
    throw new InputError(`${field} muss ein ISO-Zeitpunkt mit Zeitzone sein.`);
  }
  date(value.slice(0, 10), field);
  return value;
}

export function parameters(name: FunctionName, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("JSON-Objekt erforderlich.");
  const body = input as Record<string, unknown>;
  if (name === "get_my_attendance_list") {
    if (Object.keys(body).some(key => key !== "from" && key !== "to")) throw new InputError("Nur from und to erforderlich.");
    const from = date(body.from, "from");
    const to = date(body.to, "to");
    const days = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (days < 0 || days > 365) throw new InputError("Zeitraum muss 1 bis 366 Kalendertage umfassen.");
    return { p_from: from, p_to: to };
  }
  if (!Number.isInteger(body.user) || (body.user as number) < 1 || (body.user as number) > 2147483647) {
    throw new InputError("user muss eine positive Integer-ID sein.");
  }
  if (name === "log_attendance_clockin") {
    if (Object.keys(body).some(key => key !== "user")) throw new InputError("Nur user erforderlich; die Stempelzeit kommt vom Server.");
    return { p_user: body.user };
  }
  const attendance = name.startsWith("log_attendance_");
  const customBreak = name === "log_attendance_with_break";
  const single = name.endsWith("single_day");
  const allowed = attendance
    ? ["user", "start", "end", ...(customBreak ? ["startBreak", "endBreak"] : [])]
    : ["user", "wholeday", ...(single ? ["date"] : ["from", "to"])];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new InputError("Unbekannte Felder im Request.");
  const result: Record<string, unknown> = { p_user: body.user };
  if (attendance) {
    result.p_start = timestamp(body.start, "start");
    result.p_end = timestamp(body.end, "end");
    if (Date.parse(body.start as string) >= Date.parse(body.end as string)) throw new InputError("end muss nach start liegen.");
    if (customBreak) {
      result.p_start_break = timestamp(body.startBreak, "startBreak");
      result.p_end_break = timestamp(body.endBreak, "endBreak");
      const [start, end, bs, be] = [body.start, body.end, body.startBreak, body.endBreak].map(v => Date.parse(v as string));
      if (!(start <= bs && bs < be && be <= end)) throw new InputError("Die Pause muss innerhalb der Arbeitszeit liegen und eine positive Dauer haben.");
    }
  } else {
    const fraction = body.wholeday === undefined ? 1 : body.wholeday;
    if (fraction !== 0.5 && fraction !== 1) throw new InputError("wholeday muss 0.5 oder 1 sein.");
    result.p_wholeday = fraction;
    if (single) result.p_date = date(body.date, "date");
    else {
      result.p_from = date(body.from, "from");
      result.p_to = date(body.to, "to");
      const days = (Date.parse(body.to as string) - Date.parse(body.from as string)) / 86400000;
      if (days < 0 || days > 365) throw new InputError("Zeitraum muss 1 bis 366 Kalendertage umfassen.");
    }
  }
  return result;
}

type Dependencies = { url: string; key: string; fetch?: typeof fetch };
export function createHandler(name: FunctionName, dependencies: Dependencies) {
  const requestFetch = dependencies.fetch ?? fetch;
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json(405, { error: "POST erforderlich." });
    const authorization = request.headers.get("Authorization");
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) return json(401, { error: "Anmeldung erforderlich." });
    if (!dependencies.url || !dependencies.key) return json(500, { error: "Serverkonfiguration unvollständig." });
    if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return json(415, { error: "Content-Type application/json erforderlich." });
    }
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > 16384) return json(413, { error: "Request zu groß." });
      let body: unknown;
      try { body = JSON.parse(raw); } catch { throw new InputError("Ungültiges JSON."); }
      const args = parameters(name, body);
      const headers = { apikey: dependencies.key, Authorization: authorization, "Content-Type": "application/json" };
      // Check current Auth user, then forward the caller JWT so Postgres enforces RLS.
      const auth = await requestFetch(`${dependencies.url}/auth/v1/user`, { headers });
      if (!auth.ok) return json(auth.status >= 500 ? 502 : 401, { error: "Anmeldung konnte nicht bestätigt werden." });
      const rpcName = name === "get_my_attendance_list" ? "get_my_activity" : name;
      const response = await requestFetch(`${dependencies.url}/rest/v1/rpc/${rpcName}`, {
        method: "POST", headers, body: JSON.stringify(args),
      });
      const data = await response.json();
      if (!response.ok) {
        const code = data?.code;
        if (code === "42501") return json(403, { error: "Kein Zugriff auf diesen Benutzer." });
        if (code === "PT409") return json(409, { error: data.message });
        if (code === "23505" || code === "23P01") return json(409, { error: "Ein Eintrag existiert bereits oder überschneidet sich." });
        if (typeof code === "string" && (code.startsWith("22") || code.startsWith("23"))) {
          return json(400, { error: "Ungültige Daten. Zeiträume und Pause prüfen; die Standardpause muss vollständig innerhalb der Arbeitszeit liegen." });
        }
        if (response.status === 401) return json(401, { error: "Anmeldung abgelaufen." });
        return json(502, { error: "Datenbankanfrage fehlgeschlagen." });
      }
      if (name === "get_my_attendance_list") {
        return json(200, { text: formatAttendanceList(data, args.p_from as string, args.p_to as string) });
      }
      return json(201, { data });
    } catch (error) {
      if (error instanceof InputError) return json(400, { error: error.message });
      return json(502, { error: "Dienst vorübergehend nicht erreichbar." });
    }
  };
}

export function serve(name: FunctionName): void {
  Deno.serve(createHandler(name, {
    url: Deno.env.get("SUPABASE_URL") ?? "",
    key: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
  }));
}
