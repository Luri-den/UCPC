/* export-tools.js - three additions to the editor's File menu and Setup:

     Export for GIS   one .zip with the map as shapefiles (ArcGIS, ThinkGIS), GeoJSON (ArcGIS Online, QGIS) and tables
     Back Up Everything   one .zip with every file of the site, the photos, and a copy of the inbox
     Photo Folders    (Setup > Map and Look) where pictures are kept, for when they move off this site

   It only reads the editor's data; it changes nothing except the photo folder settings.
   Load it after shell.js:  <script src="export-tools.js"></script>
*/
(function () {
  "use strict";
  const mk = (tag, props, kids) => { const e = Object.assign(document.createElement(tag), props || {}); (kids || []).forEach(k => e.append(k)); return e; };
  const enc = new TextEncoder();
  const today = () => new Date().toISOString().slice(0, 10);
  const area = () => String(S.idPrefix || S.shortName || "map").toUpperCase();
  const num = v => { const n = parseFloat(v); return String(v == null ? "" : v).trim() !== "" && isFinite(n) ? n : null; };
  const fmtSize = n => n < 1048576 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1048576).toFixed(1) + " MB";

  /* ================= a small .zip writer (files are stored as they are; photos are already compressed) ================= */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function Zip() {
    const parts = [], central = [], seen = new Set(); let offset = 0;
    const d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return {
      count: () => central.length / 2, size: () => offset,
      async add(name, data) {
        name = String(name).replace(/^\/+/, ""); if (seen.has(name)) return; seen.add(name);
        const u8 = data instanceof Uint8Array ? data : typeof data === "string" ? enc.encode(data) : new Uint8Array(await data.arrayBuffer());
        const nm = enc.encode(name), crc = crc32(u8);
        if (central.length / 2 >= 65535 || offset + u8.length + nm.length + 30 > 0xFFFFFF00) throw new Error("This is too big for one .zip file (over 4 GB). Untick the photos or the old map images and back those up separately.");
        const h = new DataView(new ArrayBuffer(30));
        h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
        h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true); h.setUint32(18, u8.length, true); h.setUint32(22, u8.length, true);
        h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
        parts.push(h.buffer, nm, u8.length > 65536 ? new Blob([u8]) : u8);
        const c = new DataView(new ArrayBuffer(46));
        c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
        c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true); c.setUint32(20, u8.length, true); c.setUint32(24, u8.length, true);
        c.setUint16(28, nm.length, true); c.setUint32(42, offset, true);
        central.push(c.buffer, nm); offset += 30 + nm.length + u8.length;
      },
      blob() {
        let csize = 0; central.forEach(p => csize += p.byteLength);
        const e = new DataView(new ArrayBuffer(22)), n = central.length / 2;
        e.setUint32(0, 0x06054b50, true); e.setUint16(8, n, true); e.setUint16(10, n, true); e.setUint32(12, csize, true); e.setUint32(16, offset, true);
        return new Blob(parts.concat(central, [e.buffer]), { type: "application/zip" });
      }
    };
  }
  function download(name, blob) { const a = mk("a", { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }

  /* ================= shapefiles (.shp .shx .dbf .prj .cpg), WGS 84 latitude / longitude ================= */
  const PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
  // dBase column names: 10 characters, capitals, digits and _ only, each one different
  function shortNames(cols) {
    const used = new Set();
    return cols.map(c => {
      let b = ({ CEMETERY_ID: "CEM_ID", CEMETERY_NAME: "CEM_NAME" })[c] || String(c).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "FIELD"; if (/^[0-9]/.test(b)) b = "F" + b;
      let n = b.slice(0, 10), i = 2;
      while (used.has(n)) { const s = String(i++); n = b.slice(0, 10 - s.length) + s; }
      used.add(n); return n;
    });
  }
  function utf8Clip(str, max) { let u = enc.encode(str); if (u.length <= max) return u; let n = max; while (n > 0 && (u[n] & 0xC0) === 0x80) n--; return u.slice(0, n); }
  function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * r[i][1]) - (r[i][0] * r[j][1]); return a / 2; }   // > 0 means counter-clockwise
  // rows: [{ geom: [x, y]  or  [[ring, hole...], ...] (one entry per polygon), props: { column: value } }]
  function shapefile(kind, rows, cols, numeric) {
    const isPt = kind === "point", type = isPt ? 1 : 5;
    const recs = [], box = [Infinity, Infinity, -Infinity, -Infinity], grow = (b, x, y) => { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; };
    rows.forEach(r => {
      if (isPt) { const v = new DataView(new ArrayBuffer(20)); v.setInt32(0, 1, true); v.setFloat64(4, r.geom[0], true); v.setFloat64(12, r.geom[1], true); grow(box, r.geom[0], r.geom[1]); recs.push(v.buffer); return; }
      const rings = [];
      r.geom.forEach(poly => poly.forEach((ring, i) => {
        let g = ring.map(p => [+p[0], +p[1]]); if (g.length < 3) return;
        const a = g[0], z = g[g.length - 1]; if (a[0] !== z[0] || a[1] !== z[1]) g.push([a[0], a[1]]);
        const ccw = ringArea(g) > 0; if (i === 0 ? ccw : !ccw) g.reverse();          // shapefiles: outer rings clockwise, holes counter-clockwise
        rings.push(g);
      }));
      const np = rings.reduce((n, g) => n + g.length, 0), v = new DataView(new ArrayBuffer(44 + 4 * rings.length + 16 * np)), b = [Infinity, Infinity, -Infinity, -Infinity];
      rings.forEach(g => g.forEach(p => { grow(b, p[0], p[1]); grow(box, p[0], p[1]); }));
      v.setInt32(0, 5, true); b.forEach((x, i) => v.setFloat64(4 + 8 * i, x, true)); v.setInt32(36, rings.length, true); v.setInt32(40, np, true);
      let o = 44, start = 0; rings.forEach(g => { v.setInt32(o, start, true); o += 4; start += g.length; });
      rings.forEach(g => g.forEach(p => { v.setFloat64(o, p[0], true); v.setFloat64(o + 8, p[1], true); o += 16; }));
      recs.push(v.buffer);
    });
    if (!recs.length) box.fill(0);
    const head = (lenBytes) => { const v = new DataView(new ArrayBuffer(100)); v.setInt32(0, 9994, false); v.setInt32(24, lenBytes / 2, false); v.setInt32(28, 1000, true); v.setInt32(32, type, true); box.forEach((x, i) => v.setFloat64(36 + 8 * i, x, true)); return v; };
    const total = 100 + recs.reduce((n, r) => n + 8 + r.byteLength, 0);
    const shp = new Uint8Array(total), shx = new Uint8Array(100 + 8 * recs.length);
    shp.set(new Uint8Array(head(total).buffer)); shx.set(new Uint8Array(head(shx.length).buffer));
    const sv = new DataView(shp.buffer), xv = new DataView(shx.buffer); let off = 100;
    recs.forEach((r, i) => {
      sv.setInt32(off, i + 1, false); sv.setInt32(off + 4, r.byteLength / 2, false); shp.set(new Uint8Array(r), off + 8);
      xv.setInt32(100 + 8 * i, off / 2, false); xv.setInt32(104 + 8 * i, r.byteLength / 2, false); off += 8 + r.byteLength;
    });

    /* the table (.dbf) */
    const names = shortNames(cols), isNum = c => (numeric || []).includes(c);
    const cells = rows.map(r => cols.map(c => { const v = r.props[c]; if (isNum(c)) { const n = num(v); return enc.encode(n == null ? "" : n.toFixed(7)); } return utf8Clip(String(v == null ? "" : v).replace(/[\r\n]+/g, " "), 254); }));
    const lens = cols.map((c, i) => isNum(c) ? 14 : Math.max(1, ...cells.map(row => row[i].length)));
    const recLen = 1 + lens.reduce((a, b) => a + b, 0), hdrLen = 32 + 32 * cols.length + 1;
    const dbf = new Uint8Array(hdrLen + recLen * rows.length + 1).fill(32), dv = new DataView(dbf.buffer), now = new Date();
    dbf.fill(0, 0, hdrLen); dbf[0] = 3; dbf[1] = now.getFullYear() - 1900; dbf[2] = now.getMonth() + 1; dbf[3] = now.getDate();
    dv.setUint32(4, rows.length, true); dv.setUint16(8, hdrLen, true); dv.setUint16(10, recLen, true);
    cols.forEach((c, i) => { const o = 32 + 32 * i; dbf.set(enc.encode(names[i]), o); dbf[o + 11] = isNum(c) ? 78 : 67; dbf[o + 16] = lens[i]; dbf[o + 17] = isNum(c) ? 7 : 0; });
    dbf[hdrLen - 1] = 0x0D;
    cells.forEach((row, r) => { let o = hdrLen + recLen * r + 1; row.forEach((u, i) => { dbf.set(u, isNum(cols[i]) ? o + lens[i] - u.length : o); o += lens[i]; }); });
    dbf[dbf.length - 1] = 0x1A;
    return { shp, shx, dbf, names };
  }

  /* ================= the map as GIS layers ================= */
  function layers() {
    const byId = new Map(cems.map(r => [r.ID, r]));
    const cemCols = cemF.slice(), L = [];
    L.push({ name: "cemeteries", title: "Cemeteries (one point each)", kind: "point", cols: cemCols, numeric: ["LAT", "LONG"],
      rows: cems.filter(r => num(r.LAT) != null && num(r.LONG) != null).map(r => ({ geom: [num(r.LONG), num(r.LAT)], props: r })) });
    const join = cemCols.filter(c => !["ID", "NAME", "LAT", "LONG"].includes(c)), bCols = ["CEMETERY_ID", "NAME", "TYPE"].concat(join), bRows = [], eRows = [];
    (bounds.features || []).forEach(f => {
      const p = f.properties || {}, g = f.geometry || {}, c = byId.get(p.CEMETERY_ID) || {};
      const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : null;
      if (polys && polys.length) bRows.push({ geom: polys, props: Object.assign({}, c, { CEMETERY_ID: p.CEMETERY_ID || "", NAME: p.NAME || c.NAME || "", TYPE: p.TYPE || "BOUNDARY" }) });
      (p.ENTRANCES || []).forEach(e => { if (e && e.coords && isFinite(e.coords[0]) && isFinite(e.coords[1])) eRows.push({ geom: [+e.coords[0], +e.coords[1]], props: { CEMETERY_ID: p.CEMETERY_ID || "", NAME: p.NAME || c.NAME || "", LABEL: e.label || "", SIZE: e.size || "", LAT: e.coords[1], LONG: e.coords[0] } }); });
    });
    L.push({ name: "boundaries", title: "Cemetery boundaries (areas)", kind: "polygon", cols: bCols, numeric: [], rows: bRows });
    L.push({ name: "entrances", title: "Entrances (points)", kind: "point", cols: ["CEMETERY_ID", "NAME", "LABEL", "SIZE", "LAT", "LONG"], numeric: ["LAT", "LONG"], rows: eRows });
    const gCols = intF.includes("CEMETERY_NAME") ? intF.slice() : ["CEMETERY_NAME"].concat(intF);
    L.push({ name: "graves", title: "Graves with a mapped spot (one point per person named on a marker)", kind: "point", cols: gCols, numeric: ["LAT", "LONG"],
      rows: ints.filter(r => num(r.LAT) != null && num(r.LONG) != null).map(r => ({ geom: [num(r.LONG), num(r.LAT)], props: Object.assign({ CEMETERY_NAME: (byId.get(r.CEMETERY_ID) || {}).NAME || "" }, r) })) });
    return L;
  }
  function geojson(l) {
    return JSON.stringify({ type: "FeatureCollection", name: l.name, features: l.rows.map(r => {
      const props = {}; l.cols.forEach(c => { const v = r.props[c]; props[c] = l.numeric.includes(c) ? num(v) : (v == null ? "" : v); });
      return { type: "Feature", properties: props, geometry: l.kind === "point" ? { type: "Point", coordinates: r.geom } : r.geom.length === 1 ? { type: "Polygon", coordinates: r.geom[0] } : { type: "MultiPolygon", coordinates: r.geom } };
    }) });
  }
  async function siteText(name) {           // a published file that the editor does not keep open (stories, visit history)
    try { if (/^https?:/.test(location.protocol)) { const r = await fetch(new URL(name, document.baseURI).href, { cache: "no-store" }); if (r.ok) return await r.text(); } } catch (e) {}
    try { if (window.GHPublish && GHPublish.configured() && GHPublish.hasKey()) return await GHPublish.read(name); } catch (e) {}
    return null;
  }

  async function exportGIS() {
    if (!cems.length) return say("Open a map first.");
    say("Building the GIS files…");
    try {
      const zip = Zip(), L = layers(), lines = [];
      for (const l of L) {
        const f = shapefile(l.kind, l.rows, l.cols, l.numeric);
        for (const [ext, data] of [["shp", f.shp], ["shx", f.shx], ["dbf", f.dbf], ["prj", PRJ], ["cpg", "UTF-8"]]) await zip.add("shapefiles/" + l.name + "." + ext, data);
        await zip.add("geojson/" + l.name + ".geojson", geojson(l));
        lines.push("", l.name + "  -  " + l.title + "  -  " + l.rows.length + " record" + (l.rows.length === 1 ? "" : "s"), "  Column in the shapefile = full name");
        l.cols.forEach((c, i) => lines.push("    " + f.names[i].padEnd(11) + "= " + c));
      }
      await zip.add("tables/" + (S.files.cemeteries || "cemlist.csv"), Papa.unparse(cems, { columns: cemF }));
      await zip.add("tables/" + (S.files.interments || "interments.csv"), Papa.unparse(ints, { columns: intF }));
      const extra = [];
      for (const n of [(S.files && S.files.stories) || "stories.csv", "visits.csv"]) { const t = await siteText(n); if (t) { await zip.add("tables/" + n, t); extra.push(n); } }
      const noSpot = ints.length - L[3].rows.length, noPt = cems.length - L[0].rows.length;
      await zip.add("README.txt", [
        (S.name || area()) + " cemetery map: GIS export, " + today(),
        "",
        "COORDINATES: WGS 84 latitude / longitude (EPSG:4326), decimal degrees. Every layer uses it.",
        "",
        "WHAT IS HERE",
        "  shapefiles/   For ArcGIS Pro, ArcMap and ThinkGIS. Each layer is 5 files with the same name; keep them together.",
        "  geojson/      The same layers for ArcGIS Online, QGIS and web maps. Full column names.",
        "  tables/       The complete records as spreadsheets (open in Excel). These include records with no mapped spot.",
        "",
        "HOW TO LOAD",
        "  ArcGIS Pro:     Map tab > Add Data > pick the .shp file.",
        "  ArcGIS Online:  Add > Add layer from file > pick a .geojson file.",
        "  ThinkGIS:       use Import From Shape File, and when asked for the coordinate system choose",
        "                  WGS 84 latitude/longitude (geographic, decimal degrees).",
        "  QGIS:           drag a .shp or .geojson file onto the map.",
        "",
        "GOOD TO KNOW",
        "  - Positions come from phones and from map placement. Phone readings are usually within 10 to 15 feet in the open.",
        "    They are good for finding a stone, not for property lines.",
        "  - Shapefile column names are limited to 10 characters and text to 254. The full names are listed below,",
        "    and the full text is in geojson/ and tables/.",
        "  - CEMETERY_ID (ID in the cemeteries layer) links every layer and table together.",
        "  - " + noPt + " of " + cems.length + " cemeteries and " + noSpot + " of " + ints.length + " grave records have no mapped spot yet; those are only in tables/.",
        (extra.length ? "  - Also in tables/: " + extra.join(", ") + " (as published)." : "  - Stories and visit history were not found on the site, so they are not included."),
        "  - This export includes any changes in the editor that have not been published yet.",
        "",
        "LAYERS"].concat(lines).join("\r\n"));
      const blob = zip.blob(); download(area() + "-gis-" + today() + ".zip", blob);
      say("GIS export saved to your Downloads (" + fmtSize(blob.size) + "): " + L.map(l => l.rows.length + " " + l.name).join(", ") + ".");
    } catch (e) { say("The GIS export failed: " + e.message); }
  }

  /* ================= back up everything ================= */
  const CSS = ".xt-ov{position:fixed;inset:0;z-index:2147483000;background:#0008;display:flex;align-items:center;justify-content:center;padding:14px;font:14px system-ui,-apple-system,Segoe UI,Arial,sans-serif}" +
    ".xt-card{background:#fff;color:#1a202c;border-radius:10px;max-width:520px;width:100%;max-height:92vh;overflow:auto;padding:16px 18px;box-shadow:0 10px 40px #0007}" +
    ".xt-card h3{margin:0 0 6px;font-size:17px}.xt-card p{margin:6px 0;font-size:13px;line-height:1.5;color:#4a5568}" +
    ".xt-card label{display:flex;gap:8px;align-items:flex-start;margin:8px 0;font-size:14px;font-weight:normal;text-transform:none;letter-spacing:0;color:#1a202c}.xt-card label small{display:block;color:#6b7280;font-size:12px}" +
    ".xt-card label input{width:auto;min-height:0;margin:3px 0 0}" +
    ".xt-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}.xt-card button{font:inherit;padding:8px 14px;border:1px solid #cbd2d9;background:#fff;color:#1a202c;border-radius:6px;cursor:pointer;min-height:40px;width:auto}" +
    ".xt-card button.go{background:#238636;border-color:#238636;color:#fff;font-weight:600}.xt-card button:disabled{opacity:.45;cursor:not-allowed}.xt-msg{margin-top:10px;font-size:13px;line-height:1.5}.xt-msg.err{color:#a33}.xt-msg.ok{color:#1a7f37}";
  const PAGE = /\.(html?|js|mjs|css|webmanifest|svg|ico|md|txt)$/i, PIC = /\.(jpe?g|png|webp|gif)$/i;
  const KNOWN = () => ["settings.json", "survey.json", "manifest.json", "survey-manifest.json", "stories.csv", "visits.csv"].concat(Object.values(Object.assign({ motifs: "motifs.json" }, S.files || {})));
  function isOverlay(p) { return /^overlays\//i.test(p) || (S.overlays || []).some(o => o.url === p); }

  async function fetchFile(path) {
    const fromTarget = async () => { try { return await GHPublish.readBlob(path); } catch (e) { return null; } };
    const fromSite = async () => { try { if (!/^https?:/.test(location.protocol)) return null; const r = await fetch(new URL(path.split("/").map(encodeURIComponent).join("/"), document.baseURI).href, { cache: "no-store" }); return r.ok ? await r.blob() : null; } catch (e) { return null; } };
    const canTarget = window.GHPublish && GHPublish.configured() && GHPublish.hasKey();
    if (canTarget && GHPublish.isServer()) return (await fromTarget()) || (await fromSite());
    return (await fromSite()) || (canTarget ? await fromTarget() : null);     // GitHub: the live site is the same files, and faster
  }
  async function inboxCopy(zip, step) {
    const base = String(S.inbox || "").replace(/\/+$/, ""); let key = ""; try { key = localStorage.getItem("leadKey:" + area()) || ""; } catch (e) {}
    if (!base || !key) return "The inbox is not included: sign in on the Review tab first.";
    const get = async p => { const r = await fetch(base + "/" + area() + p, { headers: { "X-Lead-Key": key } }); if (!r.ok) throw new Error(String(r.status)); return r; };
    try {
      let n = 0, pics = 0;
      for (const st of ["new", "held", "approved", "rejected"]) {
        step("Copying the inbox (" + st + ")…");
        const j = await (await get("/inbox?status=" + st)).json(), items = j.items || [];
        await zip.add("inbox/" + st + ".json", JSON.stringify(items, null, 1)); n += items.length;
        if (st === "new" || st === "held") for (const it of items) for (const m of it.media || []) {
          try { const b = await (await get("/media/" + encodeURIComponent(m.id))).blob(); await zip.add("inbox/photos/" + m.id + "." + ((m.mime || "").split("/")[1] || "jpg").replace("jpeg", "jpg"), b); pics++; } catch (e) {}
        }
      }
      try { await zip.add("inbox/surveyors.json", JSON.stringify((await (await get("/invites")).json()).invites || [], null, 1)); } catch (e) {}
      try { await zip.add("inbox/leads.json", JSON.stringify((await (await get("/leads")).json()).leads || [], null, 1)); } catch (e) {}   // managers only; names, never keys
      return "The inbox copy holds " + n + " item" + (n === 1 ? "" : "s") + " and " + pics + " waiting photo" + (pics === 1 ? "" : "s") + ".";
    } catch (e) { return "The inbox could not be copied (" + e.message + "). Check the lead key on the Review tab."; }
  }

  function backupDialog() {
    if (!document.getElementById("xt-css")) document.head.append(mk("style", { id: "xt-css", textContent: CSS }));
    const canList = window.GHPublish && GHPublish.configured() && GHPublish.hasKey();
    const ov = mk("div", { className: "xt-ov" }), card = mk("div", { className: "xt-card" }); ov.append(card);
    const box = (id, label, sub, on) => { const i = mk("input", { type: "checkbox", id, checked: on }); card.append(mk("label", {}, [i, mk("span", {}, [label, mk("small", { textContent: sub })])])); return i; };
    card.append(mk("h3", { textContent: "Back Up Everything" }), mk("p", { textContent: "Saves one .zip file to your Downloads. Keep a copy somewhere other than this computer." }));
    const data = box("xt-d", "Map data", "Cemeteries, graves, boundaries, stories, visit history, survey questions and settings", true); data.disabled = true;
    const pics = box("xt-p", "Photos", canList ? "Every cemetery, grave and story photo" : "Needs the publish settings (the gear next to Publish) so the photos can be listed", canList); pics.disabled = !canList;
    const over = box("xt-o", "Old map images", canList ? "The scanned historic maps. These are large." : "Needs the publish settings too", canList); over.disabled = !canList;
    const code = box("xt-c", "The site's pages", "The map, survey and editor themselves, so the .zip is a complete working copy", true);
    const inb = box("xt-i", "A copy of the inbox", "Surveys and stories waiting or already reviewed, and the list of surveyors", true);
    const msg = mk("div", { className: "xt-msg" }), go = mk("button", { className: "go", type: "button", textContent: "Back Up" }), no = mk("button", { type: "button", textContent: "Cancel" });
    card.append(msg, mk("div", { className: "xt-btns" }, [no, go])); document.body.append(ov);
    let stop = false; no.onclick = () => { stop = true; ov.remove(); };
    const step = t => { msg.className = "xt-msg"; msg.textContent = t; };
    go.onclick = async () => {
      go.disabled = true; [pics, over, code, inb].forEach(i => i.disabled = true);
      try {
        const zip = Zip(), notes = [], missing = [];
        step("Listing the files…");
        let list = null;
        if (canList) { try { list = await GHPublish.listFiles(); } catch (e) { notes.push("The file list could not be read (" + e.message + "), so only the known data files and pages were saved. Photos are NOT in this backup."); } }
        else notes.push("Photos and old map images are NOT in this backup, because the publish settings were not filled in.");
        const listed = !!list;
        if (!list) list = [...new Set(KNOWN().concat(code.checked ? ["index.html", "list.html", "cemetery.html", "editor.html", "survey.html", "sw.js", "stories.js", "media.js", "name-search.js", "data-check.js", "inbox-tab.js", "questions-tab.js", "publish.js", "shell.js", "export-tools.js", "qr.js", "editor-theme.css"] : []))];
        const photoDirs = ["photos/", photoDir("cemeteries"), photoDir("graves"), photoDir("stories")];
        list = list.filter(p => {
          if (/^\.|\/\./.test(p)) return false;                                   // hidden folders (.git, .history)
          if (isOverlay(p)) return over.checked;
          if (PIC.test(p)) return photoDirs.some(d => p.startsWith(d)) ? pics.checked : code.checked;   // other pictures are the site's own icons
          return PAGE.test(p) ? code.checked : true;
        });
        let done = 0, i = 0;
        const worker = async () => { while (i < list.length && !stop) { const p = list[i++]; const b = await fetchFile(p); if (b) await zip.add("site/" + p, b); else if (listed) missing.push(p); step("Copying " + (++done) + " of " + list.length + " files (" + fmtSize(zip.size()) + ")…"); } };
        await Promise.all([worker(), worker(), worker(), worker()]);
        if (stop) return;
        if (dirty.size) { for (const [n, t] of outFiles()) await zip.add("not-yet-published/" + n, t); notes.push("You had changes that were not published. They are in the not-yet-published folder."); }
        if (inb.checked) notes.push(await inboxCopy(zip, step));
        if (missing.length) notes.push("These files could not be read and are missing: " + missing.slice(0, 20).join(", ") + (missing.length > 20 ? " and " + (missing.length - 20) + " more" : "") + ".");
        await zip.add("README.txt", [
          (S.name || area()) + " cemetery map: full backup, " + new Date().toString(),
          "",
          "WHAT IS HERE",
          "  site/                 Every file of the map as it is published. The .csv files open in Excel.",
          "  not-yet-published/    Changes that were open in the editor but not published (only if there were any).",
          "  inbox/                A copy of the survey inbox: items waiting, held, approved and rejected,",
          "                        photos of the waiting ones, and the surveyor list. Lead keys are never included.",
          "",
          "TO RESTORE THE MAP",
          "  Copy everything inside site/ onto any web server, or into a GitHub repository with Pages turned on.",
          "  Nothing needs installing. The data is the .csv, .json and .geojson files; the photos are in the photo folders.",
          "",
          "TO RESTORE THE INBOX",
          "  The inbox folder is a record, not something to copy back. Approved items are already in the map data.",
          "  Waiting items are listed in inbox/new.json with their photos in inbox/photos/, so nothing is lost if the inbox is.",
          "",
          "NOTES"].concat(notes.length ? notes.map(n => "  - " + n) : ["  - Everything was copied."]).join("\r\n"));
        const blob = zip.blob(); download(area() + "-backup-" + today() + ".zip", blob);
        msg.className = "xt-msg " + (missing.length || notes.some(n => /NOT|could not/.test(n)) ? "err" : "ok");
        msg.textContent = "Saved " + (zip.count() - 1) + " files (" + fmtSize(blob.size) + ") to your Downloads. " + notes.join(" ") + " ";
        // a backup takes a while, and some browsers (Safari especially) may block a download that wasn't a direct tap: offer a tap-to-save link too
        msg.append(mk("a", { href: URL.createObjectURL(blob), download: area() + "-backup-" + today() + ".zip", textContent: "Didn't download? Tap here to save it.", style: "font-weight:600" }));
        no.textContent = "Close";
      } catch (e) { msg.className = "xt-msg err"; msg.textContent = "The backup failed: " + e.message; go.disabled = false; }
    };
  }

  /* ================= File menu ================= */
  const fileMenu = document.querySelector(".ed-actions .ed-menu") || document.querySelector(".top") || document.body;
  const item = (label, sub, fn) => { const b = mk("button", { type: "button", textContent: label, onclick: fn }); b.append(mk("small", { textContent: sub })); fileMenu.append(b); return b; };
  item("Export for GIS", "Shapefiles and GeoJSON for ArcGIS or ThinkGIS", exportGIS);
  item("Back Up Everything", "One .zip with all data, photos and the inbox", () => { if (!cems.length) return say("Open a map first."); backupDialog(); });

  /* ================= Setup > Map and Look > Photo Folders ================= */
  const pane = document.getElementById("set");
  if (pane) {
    const wrap = mk("div", { id: "xt-paths" }), ins = {};
    const tidy = v => { v = String(v).trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, ""); return v ? v + "/" : ""; };
    const set = (k, v) => { S.paths = S.paths || {}; if (v && v !== PATHS_DEF[k]) S.paths[k] = v; else delete S.paths[k]; if (!Object.keys(S.paths).length) delete S.paths; touch("settings"); };
    wrap.append(mk("h3", { textContent: "Photo Folders" }), mk("small", { textContent: "Where pictures are kept. Leave these alone unless the photos are moving. Changing a folder does not move photos that are already there: copy them to the new folder first." }));
    [["cemeteries", "Cemetery Photos"], ["graves", "Grave Photos"], ["stories", "Story Photos"]].forEach(([k, label]) => {
      ins[k] = mk("input", { placeholder: PATHS_DEF[k], onchange: e => { const v = tidy(e.target.value); if (v.split("/").includes("..")) { e.target.value = photoDir(k); return say("A folder name can't contain .."); } set(k, v); e.target.value = photoDir(k); } });
      wrap.append(mk("label", { textContent: label + " Folder" }), ins[k]);
    });
    ins.base = mk("input", { placeholder: "Blank = this site", onchange: e => { let v = e.target.value.trim(); if (v && !/^https:\/\//i.test(v)) { e.target.value = (S.paths && S.paths.base) || ""; return say("That address must start with https://"); } v = v.replace(/\/+$/, ""); set("base", v ? v + "/" : ""); e.target.value = (S.paths && S.paths.base) || ""; } });
    wrap.append(mk("label", { textContent: "Photos Are Served From Another Address (Optional)" }), ins.base,
      mk("small", { textContent: "Only for when photos live on a different server or storage, for example https://files.example.gov/cemeteries/. The map then loads pictures from that address plus the folders above. Publish still sends new photos to the publish destination, so that destination must be the same place, or someone must copy them across." }));
    pane.append(wrap);
    const fill = () => { ["cemeteries", "graves", "stories"].forEach(k => ins[k].value = photoDir(k)); ins.base.value = (S.paths && S.paths.base) || ""; };
    const old = window.drawSet;
    if (typeof old === "function") window.drawSet = function () { const r = old.apply(this, arguments); try { fill(); } catch (e) {} return r; };
    fill();
  }
})();
