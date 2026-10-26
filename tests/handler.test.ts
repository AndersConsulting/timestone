import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, parameters, functionNames } from "../supabase/functions/_shared/handler.ts";

const payload = { user: 1, date: "2026-10-20" };
test("Chat-Liste: Zeitraum validieren, eigenen RPC mit Benutzer-JWT lesen und ASCII liefern", async () => {
  for (const args of [{ from: "2026-10-02", to: "2026-10-01" }, { from: "2026-02-30", to: "2026-03-02" }, { from: "2026-01-01", to: "2027-12-31" }, { from: "2026-10-01", to: "2026-10-31", user: 2 }]) {
    assert.throws(() => parameters("get_my_attendance_list", args));
  }
  const handler = createHandler("get_my_attendance_list", { url: "https://project.test", key: "public-key", fetch: async (url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer user-jwt");
    if (String(url).includes("/auth/")) return Response.json({ id: "auth-user" });
    assert.ok(String(url).endsWith("/rpc/get_my_activity"));
    assert.deepEqual(JSON.parse(init?.body as string), { p_from: "2026-10-01", p_to: "2026-10-31" });
    return Response.json({ attendance: [], sickleave: [{ date: "2026-10-01", wholeday: 1 }], vacation: [] });
  } });
  const response = await handler(request({ from: "2026-10-01", to: "2026-10-31" }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.match(data.text, /KRANK/);
  assert.match(data.text, /Summe netto: 0,00/);
});
function request(body: unknown = payload, token = "user-jwt") {
  return new Request("https://example.test", { method: "POST", headers: {
    "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, body: JSON.stringify(body) });
}
test("Alle Endpunkte bilden ihre dokumentierten Parameter ab", () => {
  for (const name of functionNames) {
    if (name === "get_my_permissions") {
      assert.deepEqual(parameters(name, {}), {});
      continue;
    }
    if (name === "get_my_attendance_list" || name === "get_vacations") {
      assert.deepEqual(parameters(name, { from: "2026-10-01", to: "2026-10-31" }), { p_from: "2026-10-01", p_to: "2026-10-31" });
      continue;
    }
    if (name === "cancel_vacation" || name === "update_approved_vacation") {
      const args = name === "cancel_vacation" ? { ids: [1, 2] } : { id: 1, date: "2027-02-01", wholeday: 0.5 };
      const request_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      assert.deepEqual(parameters(name, { request_id, ...args }), { p_request_id: request_id, p_operation: name, p_arguments: args });
      continue;
    }
    const body = name === "log_attendance_clockin" ? { user: 1 } : name.startsWith("log_attendance")
      ? { user: 1, start: "2026-10-20T08:00:00+02:00", end: "2026-10-20T17:00:00+02:00", ...(name.endsWith("_with_break") ? { startBreak: "2026-10-20T12:00:00+02:00", endBreak: "2026-10-20T12:30:00+02:00" } : {}) }
      : name.endsWith("single_day") ? payload : { user: 1, from: "2026-10-20", to: "2026-10-21" };
    const params = parameters(name, body);
    assert.equal(params.p_user, 1);
    if (!name.startsWith("log_attendance")) assert.equal(params.p_wholeday, 1);
  }
});

test("Stempeln akzeptiert nur die Benutzer-ID und liefert die Aktion zurück", async () => {
  for (const field of ["start", "end", "date", "at", "startBreak"]) {
    assert.throws(() => parameters("log_attendance_clockin", { user: 1, [field]: "2026-10-22" }));
  }
  const handler = createHandler("log_attendance_clockin", { url: "https://project.test", key: "public-key", fetch: async (url, init) => {
    if (String(url).includes("/auth/")) return Response.json({ id: "user" });
    assert.ok(String(url).endsWith("/rpc/log_attendance_clockin"));
    assert.deepEqual(JSON.parse(init?.body as string), { p_user: 1 });
    return Response.json({ action: "clock_in", attendance: { id: 1, end_at: null } });
  } });
  const response = await handler(request({ user: 1 }));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).data.action, "clock_in");
});

test("Abgeschlossener Tag liefert einen verständlichen Konflikt", async () => {
  const handler = createHandler("log_attendance_clockin", { url: "https://project.test", key: "public-key", fetch: async url =>
    String(url).includes("/auth/") ? Response.json({ id: "user" }) : Response.json({ code: "PT409", message: "Für heute ist bereits eine abgeschlossene Anwesenheit vorhanden." }, { status: 409 }) });
  const response = await handler(request({ user: 1 }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /abgeschlossene Anwesenheit/);
});
test("Ungültige Kalenderdaten, IDs, Tagesanteile und Zusatzfelder", () => {
  for (const body of [null, [], { ...payload, user: "1" }, { ...payload, user: 0 }, { ...payload, date: "2026-02-30" }, { ...payload, wholeday: null }, { ...payload, wholeday: 0.51 }, { ...payload, isApproved: true }]) {
    assert.throws(() => parameters("log_vacation_single_day", body));
  }
  for (const start of ["2026-02-30T08:00:00Z", "2026-10-20T08:00:00", "2026-10-20T24:00:00Z"]) {
    assert.throws(() => parameters("log_attendance_without_break", { user: 1, start, end: "2026-10-20T17:00:00Z" }));
  }
});
test("Authentifizierung und Weitergabe des Benutzer-JWT statt privilegiertem Schlüssel", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const handler = createHandler("log_sickleave_single_day", { url: "https://project.test", key: "public-key", fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(String(url).includes("/auth/") ? { id: "auth-user" } : [{ id: 1 }]);
  } });
  const response = await handler(request());
  assert.equal(response.status, 201);
  assert.equal(calls.length, 2);
  assert.equal(new Headers(calls[1].init?.headers).get("Authorization"), "Bearer user-jwt");
  assert.equal(new Headers(calls[1].init?.headers).get("apikey"), "public-key");
  assert.deepEqual(JSON.parse(calls[1].init?.body as string), { p_user: 1, p_date: "2026-10-20", p_wholeday: 1 });
});
test("Fehlende oder abgelaufene Anmeldung schreibt keine Daten", async () => {
  let calls = 0;
  const handler = createHandler("log_sickleave_single_day", { url: "https://project.test", key: "public-key", fetch: async () => { calls++; return Response.json({}, { status: 401 }); } });
  assert.equal((await handler(request(payload, ""))).status, 401);
  assert.equal(calls, 0);
  assert.equal((await handler(request())).status, 401);
  assert.equal(calls, 1);
});
test("Datenbankfehler haben stabile HTTP-Codes und verraten keine internen Details", async () => {
  for (const [code, expected] of [["42501", 403], ["23505", 409], ["23P01", 409], ["23514", 400], ["22023", 400], ["XX000", 502]] as const) {
    const handler = createHandler("log_sickleave_single_day", { url: "https://project.test", key: "public-key", fetch: async url => String(url).includes("/auth/") ? Response.json({ id: "user" }) : Response.json({ code, message: "internal details" }, { status: 400 }) });
    const response = await handler(request());
    assert.equal(response.status, expected);
    assert.ok(!(await response.text()).includes("internal details"));
  }
});
test("CORS, Methoden, Content-Type und ungültiges JSON", async () => {
  const handler = createHandler("log_sickleave_single_day", { url: "https://project.test", key: "public-key", fetch: async () => { throw new Error("unexpected network call"); } });
  assert.equal((await handler(new Request("https://example.test", { method: "OPTIONS" }))).status, 204);
  assert.equal((await handler(new Request("https://example.test"))).status, 405);
  assert.equal((await handler(new Request("https://example.test", { method: "POST", headers: { Authorization: "Bearer jwt" }, body: "{}" }))).status, 415);
  assert.equal((await handler(new Request("https://example.test", { method: "POST", headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" }, body: "{" }))).status, 400);
});

test('Urlaub: Rücknahme validiert IDs, benutzt User-JWT und liefert Konflikte statt Erfolg', async () => {
  const request_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  for (const ids of [[], [1,1], [0], ['1'], [null], Array.from({length:367},(_,i)=>i+1)]) {
    assert.throws(() => parameters('cancel_vacation', { request_id, ids }));
  }
  assert.throws(() => parameters('cancel_vacation', { request_id, ids:[1], user:2 }));
  assert.throws(() => parameters('update_approved_vacation', { request_id, id:1, date:'2027-02-30', wholeday:1 }));
  for (const status of [200,409]) {
    const handler = createHandler('cancel_vacation', { url:'https://project.test',key:'public-key',fetch:async (url,init) => {
      assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer user-jwt');
      if (String(url).includes('/auth/')) return Response.json({id:'auth-user'});
      assert.ok(String(url).endsWith('/rpc/vacation_execute'));
      assert.deepEqual(JSON.parse(init?.body as string), {p_request_id:request_id,p_operation:'cancel_vacation',p_arguments:{ids:[1]}});
      return status === 200 ? Response.json({count:1,deleted:[{id:1}]}) : Response.json({code:'PT409',message:'Keine Änderung vorgenommen.'},{status});
    }});
    assert.equal((await handler(request({request_id,ids:[1]}))).status,status);
    assert.equal((await handler(request({request_id,ids:[1]},''))).status,401);
  }
});

test('Get Berechtigungen: keine fremde Identitaet, Auth erforderlich, strukturierte Daten und ASCII', async () => {
  for (const args of [{user:2},{role:'Admin'}]) assert.throws(() => parameters('get_my_permissions',args));
  const handler = createHandler('get_my_permissions',{url:'https://project.test',key:'public-key',fetch:async (url,init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer user-jwt');
    if(String(url).includes('/auth/')) return Response.json({id:'auth-user'});
    assert.ok(String(url).endsWith('/rpc/get_my_permissions'));
    return Response.json({role:'User',permissions:[{code:'permissions.read_self',label:'Meine Rolle sehen'}],notes:[]});
  }});
  const response = await handler(request({}));
  assert.equal(response.status,200);
  const body = await response.json();
  assert.equal(body.role,'User');
  assert.match(body.text,/Du bist: User/);
  assert.equal((await handler(request({},''))).status,401);
});
