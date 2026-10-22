import { createClient, type SupabaseClient, type SupportedStorage } from "@supabase/supabase-js";
import { mkdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Local refresh/access tokens only. Passwords never reach this storage. */
export function fileSessionStorage(directory: string): SupportedStorage {
  const filename = join(directory, "session.json");
  return {
    async getItem(key) {
      try {
        const data = JSON.parse(await readFile(filename, "utf8"));
        return data.key === key && typeof data.value === "string" ? data.value : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error("Lokale Sitzung nicht lesbar. Bitte erneut anmelden.");
      }
    },
    async setItem(key, value) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const temporary = join(directory, `session-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify({ key, value }), { mode: 0o600, flag: "wx" });
        await rename(temporary, filename);
      } finally { await rm(temporary, { force: true }); }
    },
    async removeItem(key) {
      try {
        const data = JSON.parse(await readFile(filename, "utf8"));
        if (data.key === key) await rm(filename, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Lokale Sitzung konnte nicht entfernt werden.");
      }
    },
  };
}

export function userClient(url: string, key: string, storage: SupportedStorage, requestFetch?: typeof fetch) {
  const origin = new URL(url);
  const local = origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname);
  if ((!local && origin.protocol !== "https:") || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw new Error("Ungültige Supabase-Projektadresse.");
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key) || key.includes("REPLACE_ME")) {
    throw new Error("Bitte den öffentlichen Supabase Publishable Key in auth/.env konfigurieren.");
  }
  return createClient(origin.origin, key, { auth: {
    storage, storageKey: `timestone.user.${origin.hostname}`, persistSession: true,
    autoRefreshToken: false, detectSessionInUrl: false,
  }, ...(requestFetch ? { global: { fetch: requestFetch } } : {}) });
}

export async function ownProfile(client: SupabaseClient) {
  // getSession refreshes an expired locally stored session, getUser verifies it remotely.
  const session = await client.auth.getSession();
  if (session.error || !session.data.session) throw new Error("Bitte zuerst npm run user:login ausführen.");
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) throw new Error("Deine Sitzung ist abgelaufen. Bitte erneut anmelden.");
  const profile = await client.from("users").select("id,fullname").eq("auth_user_id", user.id).maybeSingle();
  if (profile.error) throw new Error("Das Mitarbeiterprofil konnte nicht geladen werden.");
  if (!profile.data) throw new Error(`Dein Login ist noch keinem Mitarbeiter zugeordnet. Auth-ID für die Zuordnung: ${user.id}`);
  return profile.data as { id: number; fullname: string };
}

export async function attendanceList(client: SupabaseClient, from: string, to: string) {
  for (const value of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
      throw new Error("Datum bitte als YYYY-MM-DD angeben.");
    }
  }
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (days < 0 || days > 365) throw new Error("Der Zeitraum muss 1 bis 366 Tage umfassen.");
  await ownProfile(client);
  const { data, error } = await client.functions.invoke("get_my_attendance_list", { body: { from, to } });
  if (error || typeof data?.text !== "string") throw new Error("Die Edge Function konnte die Anwesenheiten nicht laden. Anmeldung und Zeitraum prüfen.");
  return data.text as string;
}
