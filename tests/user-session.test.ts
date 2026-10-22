import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attendanceList, fileSessionStorage, userClient } from "../scripts/user-session.ts";

const user = { id: "11111111-1111-4111-8111-111111111111", email: "alice@example.test", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const token = (expires: number) => [Buffer.from('{"alg":"HS256"}').toString("base64url"), Buffer.from(JSON.stringify({ sub: user.id, exp: expires })).toString("base64url"), "test"].join(".");

test("Lokaler Passwort-Login speichert nur die Sitzung; Auswertung verwendet die Edge Function mit User-JWT", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timestone-session-"));
  const calls: string[] = [];
  const accessToken = token(Math.floor(Date.now() / 1000) + 3600);
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path === "/auth/v1/token") {
      assert.deepEqual(JSON.parse(init?.body as string).email, "alice@example.test");
      return Response.json({ access_token: accessToken, refresh_token: "test-refresh", token_type: "bearer", expires_in: 3600, user });
    }
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${accessToken}`);
    if (path === "/auth/v1/user") return Response.json(user);
    if (path === "/rest/v1/users") {
      assert.equal(new URL(String(url)).searchParams.get("auth_user_id"), `eq.${user.id}`);
      return Response.json({ id: 1, fullname: "Alice" });
    }
    if (path === "/functions/v1/get_my_attendance_list") {
      assert.deepEqual(JSON.parse(init?.body as string), { from: "2026-10-01", to: "2026-10-31" });
      return Response.json({ text: "Summe netto: 56,25 Stunden" });
    }
    throw new Error(`Unexpected path ${path}`);
  };
  try {
    const client = userClient("https://project.test", "sb_publishable_test", fileSessionStorage(directory), fetcher);
    const { error } = await client.auth.signInWithPassword({ email: "alice@example.test", password: "never-save-this-password" });
    assert.equal(error, null);
    const stored = await readFile(join(directory, "session.json"), "utf8");
    assert.ok(stored.includes("test-refresh"));
    assert.ok(!stored.includes("never-save-this-password"));
    assert.equal((await stat(join(directory, "session.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    // A new client/process can resume the stored session without asking for a password.
    const restored = userClient("https://project.test", "sb_publishable_test", fileSessionStorage(directory), fetcher);
    assert.equal(await attendanceList(restored, "2026-10-01", "2026-10-31"), "Summe netto: 56,25 Stunden");
    assert.equal(calls.filter(path => path === "/auth/v1/token").length, 1);
    assert.ok(!calls.some(path => path.includes("/rpc/")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Abgelaufene lokale Sitzung wird erneuert und der rotierte Refresh-Token gespeichert", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timestone-refresh-"));
  const storage = fileSessionStorage(directory);
  const expires = Math.floor(Date.now() / 1000) - 60;
  const freshToken = token(expires + 7200);
  await storage.setItem("timestone.user.project.test", JSON.stringify({ access_token: token(expires), refresh_token: "old-refresh", expires_at: expires, user }));
  let refreshed = 0;
  try {
    const client = userClient("https://project.test", "sb_publishable_test", storage, async (url, init) => {
      const endpoint = new URL(String(url));
      if (endpoint.pathname === "/auth/v1/token") {
        assert.equal(endpoint.searchParams.get("grant_type"), "refresh_token");
        assert.equal(JSON.parse(init?.body as string).refresh_token, "old-refresh");
        refreshed++;
        return Response.json({ access_token: freshToken, refresh_token: "new-refresh", expires_in: 3600, token_type: "bearer", user });
      }
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${freshToken}`);
      if (endpoint.pathname === "/auth/v1/user") return Response.json(user);
      if (endpoint.pathname === "/rest/v1/users") return Response.json({ id: 1, fullname: "Alice" });
      return Response.json({ text: "OK" });
    });
    assert.equal(await attendanceList(client, "2026-10-01", "2026-10-31"), "OK");
    assert.equal(refreshed, 1);
    assert.match(await readFile(join(directory, "session.json"), "utf8"), /new-refresh/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Ohne Sitzung, mit ungültigem Zeitraum oder Admin-Key keine Anwesenheitsabfrage", async () => {
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  assert.throws(() => userClient("https://project.test", "sb_secret_forbidden", storage));
  assert.throws(() => userClient("http://remote.test", "sb_publishable_test", storage));
  const client = userClient("https://project.test", "sb_publishable_test", storage, async () => { throw new Error("Unexpected network request"); });
  await assert.rejects(attendanceList(client, "2026-02-30", "2026-03-01"), /Datum/);
  await assert.rejects(attendanceList(client, "2026-10-31", "2026-10-01"), /Zeitraum/);
  await assert.rejects(attendanceList(client, "2026-10-01", "2026-10-31"), /user:login/);
});
