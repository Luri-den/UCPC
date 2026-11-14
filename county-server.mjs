/* county-server.mjs - runs the cemetery map on a county's own server, with no GitHub.

   It does two jobs:
     1. Serves the site (the map, the survey, the editor) from a folder.
     2. Lets the editor's Publish button save data files into that folder.

   Needs Node.js 18 or newer, and nothing else. Start it with:

     PUBLISH_KEY="a-long-secret-of-your-own"  node county-server.mjs --dir ./site --port 8080

   On Windows (PowerShell):
     $env:PUBLISH_KEY="a-long-secret-of-your-own"; node county-server.mjs --dir .\site --port 8080

   Then in the editor: the gear next to Publish -> "A county server" -> this server's address and the key.

   Safety:
     - Publishing needs the key. Reading the map does not.
     - Publish can only write data: .csv .json .geojson, pictures and short recordings. It can never replace a page or a script.
     - Every file that gets replaced is first copied into .history/<date>/, so nothing is lost.
     - Put it behind HTTPS (IIS, nginx, Caddy or Cloudflare in front). Browsers refuse to send from an
       https page to a plain http server.
*/
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ROOT = path.resolve(arg("dir", "./site"));
const PORT = +arg("port", process.env.PORT || 8080);
const KEY = process.env.PUBLISH_KEY || "";
const ORIGIN = process.env.ALLOW_ORIGIN || "*";          // set to the editor's address to allow only that site to publish
const MAX = (+process.env.MAX_MB || 30) * 1048576;       // biggest single file
const WRITABLE = new Set(["csv", "json", "geojson", "jpg", "jpeg", "png", "webp", "gif", "mp3", "m4a", "aac", "ogg", "webm"]);   // data, pictures, and short recordings sent with stories
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8", geojson: "application/geo+json; charset=utf-8", csv: "text/csv; charset=utf-8", txt: "text/plain; charset=utf-8",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", webm: "audio/webm",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", ico: "image/x-icon", webmanifest: "application/manifest+json" };

if (KEY.length < 16) { console.error("Set PUBLISH_KEY to a secret at least 16 characters long before starting."); process.exit(1); }
if (!fs.existsSync(ROOT)) { console.error("The folder " + ROOT + " does not exist. Use --dir to point at the site folder."); process.exit(1); }

const CORS = { "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Methods": "GET, PUT, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400" };
const send = (res, status, body, headers) => { res.writeHead(status, Object.assign({}, CORS, headers)); res.end(body); };
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { "Content-Type": TYPES.json, "Cache-Control": "no-store" });
const ext = p => (p.split(".").pop() || "").toLowerCase();

function keyOk(req) {
  const h = String(req.headers.authorization || ""), got = h.startsWith("Bearer ") ? h.slice(7) : "";
  const a = crypto.createHash("sha256").update(got).digest(), b = crypto.createHash("sha256").update(KEY).digest();
  return crypto.timingSafeEqual(a, b);
}
// A request path -> a real path inside ROOT, or null if it tries to leave the folder or touch a hidden file
function inside(rel) {
  let p; try { p = decodeURIComponent(rel); } catch (e) { return null; }
  p = p.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p || p.includes("\0") || p.split("/").some(s => !s || s === "." || s === ".." || s.startsWith("."))) return null;
  const full = path.join(ROOT, p);
  return full.startsWith(ROOT + path.sep) ? { rel: p, full } : null;
}
async function listAll(dir, base, out) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const rel = base ? base + "/" + e.name : e.name;
    if (e.isDirectory()) await listAll(path.join(dir, e.name), rel, out); else if (e.isFile()) out.push(rel);
  }
  return out;
}
async function body(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX) throw Object.assign(new Error("That file is too big."), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function sendFile(res, full, noStore) {
  const st = await fsp.stat(full).catch(() => null);
  if (!st || !st.isFile()) return false;
  res.writeHead(200, Object.assign({}, CORS, { "Content-Type": TYPES[ext(full)] || "application/octet-stream", "Content-Length": st.size, "Cache-Control": noStore ? "no-store" : "no-cache" }));
  fs.createReadStream(full).pipe(res); return true;
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x"), p = url.pathname;
    if (req.method === "OPTIONS") return send(res, 204, "");

    /* ----- the publish address ----- */
    if (p === "/files" || p.startsWith("/files/")) {
      if (!keyOk(req)) return json(res, 401, { ok: false, error: "Wrong or missing publish key." });
      if (p === "/files" || p === "/files/") {
        if (req.method !== "GET") return json(res, 405, { ok: false, error: "Use GET." });
        return json(res, 200, { ok: true, files: (await listAll(ROOT, "", [])).sort() });
      }
      const f = inside(p.slice(7));
      if (!f) return json(res, 400, { ok: false, error: "That path is not allowed." });
      if (req.method === "GET") return (await sendFile(res, f.full, true)) || json(res, 404, { ok: false, error: "No such file." });
      if (req.method === "PUT") {
        if (!WRITABLE.has(ext(f.rel))) return json(res, 400, { ok: false, error: "Only data files and pictures can be published (" + [...WRITABLE].join(", ") + ")." });
        const data = await body(req);
        if (fs.existsSync(f.full)) {                                  // keep what is being replaced
          const keep = path.join(ROOT, ".history", new Date().toISOString().replace(/[:.]/g, "-"), f.rel);
          await fsp.mkdir(path.dirname(keep), { recursive: true }); await fsp.copyFile(f.full, keep);
        }
        await fsp.mkdir(path.dirname(f.full), { recursive: true });
        const tmp = f.full + ".part-" + crypto.randomBytes(4).toString("hex");
        await fsp.writeFile(tmp, data); await fsp.rename(tmp, f.full);  // never leaves a half-written file
        console.log(new Date().toISOString(), "saved", f.rel, data.length, "bytes");
        return json(res, 200, { ok: true, path: f.rel, bytes: data.length });
      }
      return json(res, 405, { ok: false, error: "Use GET or PUT." });
    }

    /* ----- the site itself ----- */
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    const f = inside(p === "/" ? "index.html" : p.endsWith("/") ? p + "index.html" : p);
    if (f && await sendFile(res, f.full)) return;
    send(res, 404, "Not found", { "Content-Type": TYPES.txt });
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { ok: false, error: e.status ? e.message : "The server had a problem." });
    if (!e.status) console.error(e);
  }
}).listen(PORT, () => console.log("Cemetery map running at http://localhost:" + PORT + "  (folder: " + ROOT + ")"));
