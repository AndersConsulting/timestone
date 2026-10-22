import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { loadEnvFile } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { mkdir, open, rm } from "node:fs/promises";
import { attendanceList, fileSessionStorage, ownProfile, userClient } from "./user-session.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".timestone");
const usage = "Befehle: login [E-Mail] | attendance YYYY-MM-DD YYYY-MM-DD | logout";

async function promptLogin(email?: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Login bitte direkt in deinem Terminal starten. Das Passwort wird verdeckt abgefragt.");
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done(); } });
  const terminal = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  try {
    const address = (email ?? await terminal.question("E-Mail: ")).trim();
    process.stdout.write("Passwort (verdeckt): ");
    muted = true;
    const password = await terminal.question("");
    process.stdout.write("\n");
    if (!address || !password) throw new Error("E-Mail und Passwort erforderlich.");
    return { email: address, password };
  } finally { muted = false; terminal.close(); }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help") { console.log(usage); return; }
  if (!["login", "attendance", "logout"].includes(command) ||
    (command === "login" && args.length > 1) || (command === "attendance" && args.length !== 2) ||
    (command === "logout" && args.length !== 0)) throw new Error(usage);
  try { loadEnvFile(resolve(root, "auth/.env")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const url = process.env.TIMESTONE_SUPABASE_URL ?? "https://wbcdfvkezaqfugtgvgql.supabase.co";
  const key = process.env.TIMESTONE_SUPABASE_PUBLISHABLE_KEY ?? "";
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Prevent two processes from rotating the same refresh token concurrently.
  const lockFile = join(directory, "session.lock");
  let lock;
  try { lock = await open(lockFile, "wx", 0o600); }
  catch { throw new Error("Ein anderer Timestone-Aufruf läuft bereits. Nach einem abgebrochenen Prozess ggf. .timestone/session.lock entfernen."); }
  let client: ReturnType<typeof userClient> | undefined;
  try {
    client = userClient(url, key, fileSessionStorage(directory));
    if (command === "login") {
      const credentials = await promptLogin(args[0]);
      try {
        const { error } = await client.auth.signInWithPassword(credentials);
        if (error) throw new Error("Anmeldung fehlgeschlagen. E-Mail, Passwort und eingerichtetes Auth-Konto prüfen.");
      } finally { credentials.password = ""; }
      const profile = await ownProfile(client);
      console.log(`Angemeldet als ${profile.fullname}. Die persönliche Sitzung ist lokal gespeichert.`);
    } else if (command === "attendance") {
      console.log(await attendanceList(client, args[0], args[1]));
    } else {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw new Error("Abmeldung konnte nicht bestätigt werden. Bitte erneut versuchen.");
      await rm(join(directory, "session.json"), { force: true });
      console.log("Abgemeldet; lokale Sitzung entfernt.");
    }
  } finally {
    client?.auth.stopAutoRefresh();
    await lock.close();
    await rm(lockFile, { force: true });
  }
}

main().catch(error => {
  // Supabase errors and credentials are never dumped to the terminal.
  console.error(error instanceof Error ? error.message : "Timestone-Aufruf fehlgeschlagen.");
  process.exitCode = 1;
});
