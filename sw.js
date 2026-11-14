/* sw.js - lets the map and the survey open with no signal.

   How it behaves:
     - With signal, every page and data file comes fresh from the site, exactly as before, and a copy is kept.
     - With no signal (or a signal too weak to answer in a few seconds), the kept copy is used.
     - Map tiles that were looked at with signal are kept, so the same area shows again later.
     - Sending to the inbox and publishing are never touched: those always go straight to the network.

   With a working signal nobody is shown an old page; the kept copy is only used when the site does not answer within a few seconds.
   To clear everything it has kept, change VERSION and publish.
*/
const VERSION = "v1";
const SITE = "site-" + VERSION, LIBS = "libs-" + VERSION, TILES = "tiles-" + VERSION;
const MAX_TILES = 2500, WAIT_MS = 4000;
const CORE = ["./", "index.html", "survey.html", "list.html", "cemetery.html", "settings.json", "survey.json", "manifest.json", "survey-manifest.json", "stories.js", "media.js", "qr.js", "stories.csv"];
const LIB_URLS = ["https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js", "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css", "https://unpkg.com/papaparse@5.4.1/papaparse.min.js"];
const LIB_HOSTS = ["unpkg.com", "cdn.jsdelivr.net"];
const isTile = u => /\/\d+\/\d+\/\d+(\.[a-z0-9]+)?$/i.test(u.pathname) || /bbox=/i.test(u.search) || /\/tile\//i.test(u.pathname);
const keyFor = u => u.origin + u.pathname;                    // same-origin copies ignore ?invite=… and similar

const MAX_KEEP = 6 * 1048576;      // bigger files (the scanned old maps) are not kept: they would crowd out everything else
async function keep(cacheName, key, res) { try { if (res && res.ok && res.status === 200 && res.type !== "opaque" && !(+res.headers.get("content-length") > MAX_KEEP)) await (await caches.open(cacheName)).put(key, res.clone()); } catch (e) {} return res; }

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const site = await caches.open(SITE), base = self.registration.scope, names = CORE.slice();
    try {                                                        // the data files this county's settings name
      const s = await (await fetch(new URL("settings.json", base), { cache: "no-store" })).json();
      Object.values(s.files || {}).forEach(n => names.push(n));
    } catch (e) { names.push("cemlist.csv", "interments.csv", "cemetery-boundaries.geojson", "county.geojson"); }
    await Promise.all([...new Set(names)].map(async n => { try { const u = new URL(n, base); await keep(SITE, keyFor(u), await fetch(u, { cache: "no-store" })); } catch (e) {} }));
    await Promise.all(LIB_URLS.map(async u => { try { await keep(LIBS, u, await fetch(u, { mode: "cors", credentials: "omit" })); } catch (e) {} }));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const n of await caches.keys()) if (![SITE, LIBS, TILES].includes(n)) await caches.delete(n);
    await self.clients.claim();
  })());
});

let tileCount = 0;
async function trimTiles() {
  if (++tileCount % 200) return;
  const c = await caches.open(TILES), keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);      // oldest first
}

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  let u; try { u = new URL(req.url); } catch (e) { return; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return;

  if (u.origin === self.location.origin) {
    if (u.pathname.startsWith("/files")) return;                                   // a county server's publish address
    const key = keyFor(u);
    event.respondWith((async () => {
      const cached = await caches.match(key);
      const fresh = fetch(req).then(res => keep(SITE, key, res));
      if (!cached) return fresh;
      fresh.catch(() => {});
      const slow = new Promise(ok => setTimeout(() => ok(null), WAIT_MS));
      try { return (await Promise.race([fresh, slow])) || cached; } catch (e) { return cached; }
    })());
    return;
  }
  if (LIB_HOSTS.includes(u.hostname)) {                                            // the map and spreadsheet libraries: fixed versions, so a kept copy is always right
    event.respondWith((async () => (await caches.match(req.url)) || keep(LIBS, req.url, await fetch(req.url, { mode: "cors", credentials: "omit" })))());
    return;
  }
  if (isTile(u) && (req.destination === "" || req.destination === "image")) {
    event.respondWith((async () => {
      const cached = await caches.match(req.url);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok && res.type !== "opaque") { await keep(TILES, req.url, res); trimTiles(); }
      return res;
    })());
  }
  // everything else (the inbox, GitHub, video sites) goes to the network untouched
});
