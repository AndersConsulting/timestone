import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist/auth/", import.meta.url));
const routes = new Map([["/", "index.html"], ["/oauth/consent", "index.html"], ["/oauth/consent/", "index.html"],
  ["/oauth/callback", "index.html"], ["/oauth/callback/", "index.html"], ["/app.js", "app.js"], ["/styles.css", "styles.css"]]);
createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost:3000").pathname;
  const file = routes.get(path);
  if (!file || !["GET", "HEAD"].includes(req.method ?? "")) { res.writeHead(404); res.end(); return; }
  try {
    const data = await readFile(root + file);
    res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html; charset=utf-8",
      "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch { res.writeHead(503); res.end("Run npm run auth:build first."); }
}).listen(3000, "127.0.0.1", () => console.log("Timestone login preview: http://127.0.0.1:3000 (local only)"));
