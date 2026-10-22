import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizationId, createAuthFlow, safeRedirect, type View } from "../auth/flow.ts";

const id = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
function fixture(initialUrl = `https://login.example.test/oauth/consent?authorization_id=${id}`) {
  let currentUrl = initialUrl;
  const storage = new Map<string, string>();
  const views: View[] = [];
  const navigations: string[] = [];
  const calls: Array<[string, unknown]> = [];
  const state = { user: { id: userId, email: "alice@example.test" } as { id: string; email: string } | null,
    profile: { fullname: "Alice", id: 1 } as { fullname: string; id: number } | null,
    loginError: false, loginNetworkError: false, exchangeError: false, detailsError: false, alreadyApproved: false, detailsUser: userId,
    redirect: "https://copilot.example.test/callback?code=one-use&state=original" };
  const client = {
    auth: {
      getUser: async () => ({ data: { user: state.user }, error: null }),
      exchangeCodeForSession: async (code: string) => {
        calls.push(["exchange", code]);
        return { error: state.exchangeError ? { message: "invalid code" } : null };
      },
      signInWithPassword: async (options: unknown) => {
        calls.push(["login", options]);
        if (state.loginNetworkError) throw new Error("network");
        if (!state.loginError) state.user = { id: userId, email: "alice@example.test" };
        return { error: state.loginError ? { message: "sensitive provider details" } : null };
      },
      signOut: async (options: unknown) => { calls.push(["signout", options]); state.user = null; return { error: null }; },
      oauth: {
        getAuthorizationDetails: async (authorization: string) => {
          calls.push(["details", authorization]);
          return { error: state.detailsError ? {} : null,
            data: state.alreadyApproved ? { redirect_url: state.redirect } : {
              authorization_id: authorization, user: { id: state.detailsUser },
              client: { name: "Copilot", id: "client" }, scope: "openid email profile",
              redirect_uri: "https://copilot.example.test/callback",
            } };
        },
        approveAuthorization: async (...args: unknown[]) => { calls.push(["approve", args]); return { data: { redirect_url: state.redirect }, error: null }; },
        denyAuthorization: async (...args: unknown[]) => { calls.push(["deny", args]); return { data: { redirect_url: state.redirect.replace("code=one-use", "error=access_denied") }, error: null }; },
      },
    },
    from: (table: string) => {
      assert.equal(table, "users");
      return { select: () => ({ eq: (column: string, value: string) => {
        assert.equal(column, "auth_user_id");
        assert.equal(value, state.user?.id);
        return { maybeSingle: async () => ({ data: state.profile, error: null }) };
      } }) };
    },
  } as unknown as SupabaseClient;
  const flow = createAuthFlow(client, {
    url: () => currentUrl,
    replace: url => { currentUrl = new URL(url, currentUrl).href; },
    navigate: url => navigations.push(url),
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); }, removeItem: key => { storage.delete(key); } },
  }, view => views.push(view));
  return { flow, state, storage, calls, navigations, views, url: () => currentUrl, last: () => views.at(-1) };
}

test("Passwort-Login verwendet E-Mail/Passwort und behält eine optionale Freigabe bei", async () => {
  const f = fixture(); f.state.user = null;
  await f.flow.start();
  assert.equal(f.last()?.kind, "login");
  await f.flow.login(" alice@example.test ", "test password");
  assert.deepEqual(f.calls, [["login", { email: "alice@example.test", password: "test password" }], ["details", id]]);
  assert.equal(f.last()?.kind, "consent");
  assert.equal(f.storage.size, 0);
  assert.equal(f.navigations.length, 0);
  assert.ok(!JSON.stringify(f.views).includes("test password"));
});

test("Passwort-Login funktioniert ohne OAuth-Anfrage und ohne automatische Registrierung", async () => {
  const f = fixture("https://login.example.test/"); f.state.user = null;
  await f.flow.start(); await f.flow.login("alice@example.test", "test password");
  assert.equal(f.last()?.kind, "account");
  assert.deepEqual(f.calls.map(([name]) => name), ["login"]);
});

test("Falsches Passwort, Netzfehler und fehlende Eingaben bleiben erneut versuchbar", async () => {
  const f = fixture("https://login.example.test/"); f.state.user = null;
  await f.flow.start(); await f.flow.login("invalid", "");
  assert.equal(f.calls.length, 0);
  assert.equal(f.last()?.kind, "login");
  f.state.loginError = true;
  await f.flow.login("alice@example.test", "wrong");
  assert.equal(f.last()?.kind, "login");
  assert.ok(!JSON.stringify(f.views).includes("sensitive provider details"));
  f.state.loginError = false; f.state.loginNetworkError = true;
  await f.flow.login("alice@example.test", "wrong");
  assert.equal(f.last()?.kind, "login");
  f.state.loginNetworkError = false;
  await f.flow.login("alice@example.test", "correct");
  assert.equal(f.last()?.kind, "account");
});

test("OAuth: Callback tauscht Code einmal aus, entfernt ihn und lädt dieselbe Freigabe", async () => {
  const f = fixture("https://login.example.test/oauth/callback?code=one-use");
  f.storage.set("timestone.pending-authorization", id);
  await f.flow.start();
  assert.equal(f.last()?.kind, "consent");
  assert.deepEqual(f.calls, [["exchange", "one-use"], ["details", id]]);
  assert.equal(f.url(), `https://login.example.test/oauth/consent?authorization_id=${id}`);
  assert.equal(f.storage.size, 0);
  assert.equal(f.navigations.length, 0);
});

test("OAuth: fehlerhafter PKCE-Code erzeugt keine Freigabe und bleibt nicht in der URL", async () => {
  const f = fixture("https://login.example.test/oauth/callback?code=bad"); f.state.exchangeError = true;
  await f.flow.start();
  assert.equal(f.last()?.kind, "error");
  assert.equal(f.url(), "https://login.example.test/");
  assert.deepEqual(f.calls, [["exchange", "bad"]]);
});

test("OAuth: neue Zustimmung ist ausdrücklich; Doppelklick erzeugt nur eine Freigabe", async () => {
  const f = fixture(); await f.flow.start();
  assert.equal(f.last()?.kind, "consent");
  assert.equal(f.calls.some(([name]) => name === "approve"), false);
  await Promise.all([f.flow.decide(true), f.flow.decide(true)]);
  assert.equal(f.calls.filter(([name]) => name === "approve").length, 1);
  assert.equal(f.navigations[0], f.state.redirect);
  assert.deepEqual(f.calls.at(-1), ["approve", [id, { skipBrowserRedirect: true }]]);
});

test("OAuth: Ablehnen liefert den serverseitigen Fehler-Redirect zurück", async () => {
  const f = fixture(); await f.flow.start(); await f.flow.decide(false);
  assert.equal(f.calls.some(([name]) => name === "approve"), false);
  assert.match(f.navigations[0], /error=access_denied&state=original/);
});

test("OAuth: bereits genehmigte Verbindung darf anhand der Supabase-Antwort zurückkehren", async () => {
  const f = fixture(); f.state.alreadyApproved = true;
  await f.flow.start();
  assert.deepEqual(f.navigations, [f.state.redirect]);
});

test("OAuth: ohne Mitarbeiterzuordnung keine neue oder automatische Freigabe", async () => {
  const f = fixture(); f.state.profile = null; f.state.alreadyApproved = true;
  await f.flow.start();
  assert.equal(f.last()?.kind, "account");
  assert.equal(f.calls.length, 0);
  await f.flow.decide(true);
  assert.equal(f.last()?.kind, "error");
  assert.equal(f.navigations.length, 0);
});

test("OAuth: falscher Benutzer in der Freigabe und Kontowechsel vor Zustimmung werden blockiert", async () => {
  const f = fixture(); f.state.detailsUser = "other-user";
  await f.flow.start();
  assert.equal(f.last()?.kind, "error");
  const g = fixture(); await g.flow.start(); g.state.user = { id: "other-user", email: "bob@example.test" };
  await g.flow.decide(true);
  assert.equal(g.last()?.kind, "error");
  assert.equal(g.calls.some(([name]) => name === "approve"), false);
});

test("Konto wechseln meldet lokal ab und erlaubt erneut E-Mail/Passwort", async () => {
  const f = fixture(); await f.flow.start(); await f.flow.changeAccount();
  assert.equal(f.last()?.kind, "login");
  await f.flow.login("alice@example.test", "another password");
  assert.ok(f.calls.some(([name, args]) => name === "signout" && JSON.stringify(args) === '{"scope":"local"}'));
  assert.deepEqual(f.calls.find(([name]) => name === "login")![1], { email: "alice@example.test", password: "another password" });
  assert.equal(f.last()?.kind, "consent");
});

test("OAuth: ungültige/mehrdeutige Anfragen und Providerfehler scheitern ohne Datenzugriff", async () => {
  for (const suffix of ["?authorization_id=../bad", "?authorization_id=one&authorization_id=two", "?error=access_denied", "#access_token=bad"]) {
    const f = fixture(`https://login.example.test/oauth/consent${suffix}`);
    await f.flow.start();
    assert.equal(f.last()?.kind, "error");
    assert.equal(f.calls.length, 0);
  }
});

test("OAuth: Redirects aus Query-Parametern werden ignoriert; aktive URLs werden abgewiesen", async () => {
  const f = fixture(`https://login.example.test/oauth/consent?authorization_id=${id}&redirect_url=https://evil.test`);
  await f.flow.start(); await f.flow.decide(true);
  assert.deepEqual(f.navigations, [f.state.redirect]);
  for (const url of ["javascript:alert(1)", "data:text/html,hi", "https://user:pass@example.test", "http://example.test"]) {
    assert.throws(() => safeRedirect(url));
  }
  const g = fixture(); g.state.redirect = "javascript:alert(1)"; g.state.alreadyApproved = true;
  await g.flow.start(); assert.equal(g.last()?.kind, "error"); assert.equal(g.navigations.length, 0);
  assert.equal(safeRedirect("http://localhost:3000/callback"), "http://localhost:3000/callback");
  assert.throws(() => authorizationId("a".repeat(201)));
});

test("OAuth: abgelaufene Verbindungsanfrage wird nicht automatisch neu genehmigt", async () => {
  const f = fixture(); f.state.detailsError = true;
  await f.flow.start(); await f.flow.decide(true);
  assert.equal(f.last()?.kind, "error");
  assert.equal(f.calls.some(([name]) => name === "approve"), false);
});
