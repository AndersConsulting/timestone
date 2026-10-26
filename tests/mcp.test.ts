import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createClient } from "@supabase/supabase-js";
import { createTimeServer } from "../supabase/functions/mcp/tools.ts";

const authId = "11111111-1111-4111-8111-111111111111";
const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test("MCP liefert eigene Anwesenheitsliste als fertigen Codeblock", async () => {
  const response = await call("tools/call", { name: "get_my_attendance_list", arguments: { from: "2026-10-01", to: "2026-10-31" } }, async (url, init) => {
    assert.ok(String(url).endsWith("/rest/v1/rpc/get_my_activity"));
    assert.deepEqual(JSON.parse(init?.body as string), { p_from: "2026-10-01", p_to: "2026-10-31" });
    return Response.json({ attendance: [], sickleave: [{ date: "2026-10-01", wholeday: 1 }], vacation: [] });
  });
  assert.match(response.result.content[0].text, /^```text\n/);
  assert.match(response.result.content[0].text, /DO\.\s*\| 01\.10\.2026\s*\| KRANK/);
  assert.match(response.result.content[0].text, /\n```$/);
});
async function call(method: string, params: unknown, fetcher: typeof fetch = async () => { throw new Error("Unexpected database request"); }) {
  const db = createClient("https://project.test", "public-key", {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetcher },
  });
  const handler = createMcpHandler(() => createTimeServer(db, authId));
  try {
    const response = await handler.fetch(new Request("https://project.test/functions/v1/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }));
    assert.equal(response.status, 200);
    const raw = await response.text();
    return JSON.parse(raw.startsWith("{") ? raw : raw.split("\n").find(line => line.startsWith("data: "))!.slice(6));
  } finally { await handler.close(); }
}

test("MCP bietet 15 klar annotierte Werkzeuge ohne frei wählbare Benutzer-ID", async () => {
  const response = await call("tools/list", {});
  assert.equal(response.result.tools.length, 15);
  for (const tool of response.result.tools) {
    assert.equal(tool.inputSchema.properties.user, undefined);
    assert.equal(tool.inputSchema.additionalProperties, false);
    if (!tool.name.startsWith("get_")) {
      assert.equal(tool.annotations.idempotentHint, true);
      assert.ok(tool.inputSchema.required.includes("request_id"));
    }
  }
});
test("MCP schreibt über den idempotenten RPC und übergibt den Anfragebezeichner", async () => {
  let count = 0;
  const response = await call("tools/call", { name: "clock_in", arguments: { request_id: requestId } }, async (url, init) => {
    count++;
    assert.ok(String(url).endsWith("/rest/v1/rpc/agent_execute"));
    assert.deepEqual(JSON.parse(init?.body as string), { p_request_id: requestId, p_operation: "clock_in", p_arguments: {} });
    return Response.json({ action: "clock_in", attendance: { user_id: 1 } });
  });
  assert.equal(count, 1);
  assert.equal(JSON.parse(response.result.content[0].text).action, "clock_in");
});
test("MCP lehnt eingeschleuste fremde Benutzer-ID ab", async () => {
  const response = await call("tools/call", { name: "clock_out", arguments: { request_id: requestId, user: 2 } });
  assert.ok(response.error || response.result.isError);
});
test("MCP liest das eigene Profil anhand der verifizierten Auth-ID", async () => {
  const response = await call("tools/call", { name: "get_me", arguments: {} }, async url => {
    assert.equal(new URL(String(url)).searchParams.get("auth_user_id"), `eq.${authId}`);
    return Response.json({ id: 1, fullname: "Alice" });
  });
  const data = JSON.parse(response.result.content[0].text);
  assert.equal(data.employee.id, 1);
  assert.equal(data.timezone, "Europe/Berlin");
});

test('MCP: Urlaubsverwaltung verwendet idempotenten RPC und destruktive Annotationen', async () => {
  const list = await call('tools/list', {});
  for (const name of ['cancel_vacation','update_approved_vacation']) {
    assert.equal(list.result.tools.find((t: any) => t.name === name).annotations.destructiveHint, true);
    const args = name === 'cancel_vacation' ? { ids:[12,13] } : { id:12,date:'2027-02-01',wholeday:0.5 };
    const response = await call('tools/call', {name,arguments:{request_id:requestId,...args}}, async (url,init) => {
      assert.ok(String(url).endsWith('/rpc/vacation_execute'));
      assert.deepEqual(JSON.parse(init?.body as string),{p_request_id:requestId,p_operation:name,p_arguments:args});
      return Response.json({code:'PT409',message:'Keine Änderung vorgenommen.'},{status:409});
    });
    assert.equal(response.result.isError,true);
  }
  for (const ids of [[],[1,1],[-1],['1']]) {
    const response = await call('tools/call',{name:'cancel_vacation',arguments:{request_id:requestId,ids}});
    assert.ok(response.error || response.result.isError);
  }
});
