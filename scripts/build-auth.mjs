import { build } from "esbuild";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";

const root = fileURLToPath(new URL("../", import.meta.url));
try { loadEnvFile(resolve(root, "auth/.env")); } catch (error) { if (error.code !== "ENOENT") throw error; }
const url = new URL(process.env.TIMESTONE_SUPABASE_URL ?? "https://wbcdfvkezaqfugtgvgql.supabase.co");
if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
  throw new Error("Supabase URL must use HTTPS (or local HTTP for development).");
}
if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use only the Supabase project origin.");
const key = process.env.TIMESTONE_SUPABASE_PUBLISHABLE_KEY;
if (!key || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key) || key.includes("REPLACE_ME")) {
  throw new Error("Set TIMESTONE_SUPABASE_PUBLISHABLE_KEY in auth/.env to a publishable key; secret and service-role keys are rejected.");
}
const out = resolve(root, "dist/auth");
await mkdir(out, { recursive: true });
await build({ entryPoints: [resolve(root, "auth/main.ts")], outfile: resolve(out, "app.js"), bundle: true,
  format: "esm", platform: "browser", target: "es2022", minify: true, sourcemap: false,
  define: { __SUPABASE_URL__: JSON.stringify(url.origin), __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(key) } });
const csp = `default-src 'none'; script-src 'self'; style-src 'self'; connect-src ${url.origin}; img-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'`;
const html = (await readFile(resolve(root, "auth/index.html"), "utf8")).replace("__CSP__", csp);
await writeFile(resolve(out, "index.html"), html);
for (const route of ["oauth/consent", "oauth/callback"]) {
  await mkdir(resolve(out, route), { recursive: true });
  await writeFile(resolve(out, route, "index.html"), html);
}
await copyFile(resolve(root, "auth/styles.css"), resolve(out, "styles.css"));
// Static hosts that support _headers can apply these in addition to the meta CSP.
await writeFile(resolve(out, "_headers"), `/*\n  Content-Security-Policy: ${csp}; frame-ancestors 'none'\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Cache-Control: no-store\n`);
console.log("Built dist/auth — deploy this directory to your HTTPS login host.");
