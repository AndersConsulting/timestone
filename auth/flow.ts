import type { SupabaseClient } from "@supabase/supabase-js";

export type View =
  | { kind: "loading"; message: string }
  | { kind: "login"; email?: string; message?: string }
  | { kind: "account"; email: string; employee: string | null; userId: string }
  | { kind: "consent"; email: string; employee: string; client: string; destination: string; scopes: string[] }
  | { kind: "error"; message: string };

type Browser = {
  url(): string;
  replace(url: string): void;
  navigate(url: string): void;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
};
const pendingKey = "timestone.pending-authorization";

export function authorizationId(value: string | null): string | null {
  if (value === null) return null;
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error("Die Verbindungsanfrage ist ungültig. Bitte in Copilot neu starten.");
  return value;
}

// Only navigate to server-returned OAuth URLs; never use a redirect URL from the page query.
export function safeRedirect(value: string): string {
  const url = new URL(value);
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Die Rücksprungadresse wird nicht unterstützt. Bitte den Administrator kontaktieren.");
  }
  return url.href;
}

export function createAuthFlow(client: SupabaseClient, browser: Browser, render: (view: View) => void) {
  let requestId: string | null = null;
  let consentUser: string | null = null;
  let consentReady = false;
  let busy = false;

  async function run(operation: () => Promise<void>) {
    if (busy) return;
    busy = true;
    try { await operation(); }
    catch (error) {
      consentReady = false;
      render({ kind: "error", message: error instanceof Error ? error.message : "Verbindung fehlgeschlagen. Bitte erneut in Copilot starten." });
    } finally { busy = false; }
  }

  async function loadAccount() {
    consentReady = false;
    const { data: { user }, error } = await client.auth.getUser();
    if (error || !user) { render({ kind: "login" }); return; }
    const profile = await client.from("users").select("id,fullname").eq("auth_user_id", user.id).maybeSingle();
    if (profile.error) throw new Error("Das Mitarbeiterprofil konnte nicht geladen werden. Bitte später erneut versuchen.");
    if (!profile.data || !requestId) {
      render({ kind: "account", email: user.email ?? "Timestone-Konto", employee: profile.data?.fullname ?? null, userId: user.id });
      return;
    }
    const { data, error: detailsError } = await client.auth.oauth.getAuthorizationDetails(requestId);
    if (detailsError || !data) throw new Error("Die Verbindungsanfrage ist abgelaufen oder ungültig. Bitte in Copilot neu starten.");
    if ("redirect_url" in data) {
      browser.navigate(safeRedirect(data.redirect_url));
      return;
    }
    if (data.user.id !== user.id || data.authorization_id !== requestId) {
      throw new Error("Die Verbindungsanfrage passt nicht zu diesem Konto. Bitte in Copilot neu starten.");
    }
    consentUser = user.id;
    consentReady = true;
    render({ kind: "consent", email: user.email ?? "Timestone-Konto", employee: profile.data.fullname,
      client: data.client.name, destination: new URL(safeRedirect(data.redirect_uri)).origin,
      scopes: data.scope.split(/\s+/).filter(Boolean) });
  }

  return {
    start: () => run(async () => {
      render({ kind: "loading", message: "Verbindung wird geprüft …" });
      const url = new URL(browser.url());
      if (!["/", "/oauth/consent", "/oauth/consent/", "/oauth/callback", "/oauth/callback/"].includes(url.pathname)) {
        throw new Error("Seite nicht gefunden. Bitte die Verbindung in Copilot starten.");
      }
      const callback = /^\/oauth\/callback\/?$/.test(url.pathname);
      if (url.searchParams.getAll("authorization_id").length > 1) throw new Error("Ungültige Verbindungsanfrage.");
      requestId = authorizationId(callback ? browser.storage.getItem(pendingKey) : url.searchParams.get("authorization_id"));
      const cleanPath = requestId ? `/oauth/consent?authorization_id=${encodeURIComponent(requestId)}` : "/";
      if (url.searchParams.has("error") || url.hash) {
        browser.replace(cleanPath);
        browser.storage.removeItem(pendingKey);
        throw new Error("Die Anmeldung wurde abgebrochen oder ist fehlgeschlagen. Bitte erneut anmelden.");
      }
      if (callback) {
        const code = url.searchParams.get("code");
        // Remove the one-use code from browser history before any further navigation.
        browser.replace(cleanPath);
        browser.storage.removeItem(pendingKey);
        if (!code || url.searchParams.getAll("code").length !== 1) throw new Error("Die Anmeldeantwort ist unvollständig. Bitte erneut verbinden.");
        const { error } = await client.auth.exchangeCodeForSession(code);
        if (error) throw new Error("Die Anmeldung konnte nicht abgeschlossen werden. Bitte im selben Browserfenster erneut verbinden.");
      } else if (url.searchParams.has("code")) {
        browser.replace(cleanPath);
        throw new Error("Ungültige Anmeldeantwort. Bitte erneut verbinden.");
      }
      await loadAccount();
    }),
    login: (email: string, password: string) => run(async () => {
      const address = email.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || !password) {
        render({ kind: "login", email: address, message: "Bitte E-Mail-Adresse und Passwort eingeben." });
        return;
      }
      render({ kind: "loading", message: "Anmeldung wird geprüft …" });
      try {
        const { error } = await client.auth.signInWithPassword({ email: address, password });
        if (error) {
          render({ kind: "login", email: address, message: "Anmeldung fehlgeschlagen. Prüfe E-Mail und Passwort. Dein Konto muss bereits eingerichtet sein." });
          return;
        }
      } catch {
        render({ kind: "login", email: address, message: "Anmeldung derzeit nicht erreichbar. Bitte erneut versuchen." });
        return;
      }
      // Passwords stay only in this call; Supabase manages the user session.
      await loadAccount();
    }),
    changeAccount: () => run(async () => {
      consentReady = false;
      consentUser = null;
      render({ kind: "loading", message: "Konto wird getrennt …" });
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw new Error("Das Konto konnte nicht getrennt werden. Bitte erneut versuchen.");
      browser.storage.removeItem(pendingKey);
      render({ kind: "login" });
    }),
    decide: (allow: boolean) => run(async () => {
      if (!requestId || !consentReady || !consentUser) throw new Error("Bitte die Verbindungsanfrage erneut öffnen.");
      consentReady = false;
      render({ kind: "loading", message: allow ? "Verbindung wird freigegeben …" : "Anfrage wird abgelehnt …" });
      const { data: { user }, error } = await client.auth.getUser();
      if (error || user?.id !== consentUser) throw new Error("Das angemeldete Konto hat sich geändert. Bitte erneut verbinden.");
      const result = allow
        ? await client.auth.oauth.approveAuthorization(requestId, { skipBrowserRedirect: true })
        : await client.auth.oauth.denyAuthorization(requestId, { skipBrowserRedirect: true });
      if (result.error || !result.data) throw new Error("Die Anfrage konnte nicht abgeschlossen werden. Bitte in Copilot neu starten.");
      browser.storage.removeItem(pendingKey);
      browser.navigate(safeRedirect(result.data.redirect_url));
    }),
  };
}
