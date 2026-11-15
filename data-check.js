/* data-check.js - finds likely mistakes in the map data, for the editor.

   File > Check Data lists every record with a problem, worst first; each line has an Open button.
   It only reads and reports: it never changes anything.
   The Review tab uses DataCheck.person() and DataCheck.place() to flag the same problems in a survey before it's approved.

   What it looks for
     Needs fixing    impossible years, death before birth, coordinates that can't be right, graves whose cemetery
                     doesn't exist, two records with the same ID
     Worth a look    ages over 110, dates with no readable year, places far from their cemetery or from the rest of the map,
                     possible duplicate people, cemeteries with no name or no location
     For information graves with no dates, no name, or no map spot (normal for worn stones; listed so they can be found)
   Load it after inbox-tab.js:  <script src="data-check.js"></script>
*/
(function () {
  "use strict";
  const THIS_YEAR = new Date().getFullYear(), FAR_M = 800, CLUSTER_KM = 60;
  const num = v => { const n = parseFloat(v); return String(v == null ? "" : v).trim() !== "" && isFinite(n) ? n : null; };
  const yearOf = v => { const m = String(v || "").match(/\b(\d{4})\b/); return m ? +m[1] : null; };
  const metres = (a, b) => { const k = Math.cos(a[1] * Math.PI / 180); return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320; };
  const dist = m => m < 1609 ? Math.round(m * 3.28084).toLocaleString() + " ft" : (m / 1609.344).toFixed(1) + " mi";
  function inside(pt, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
  const polysOf = g => !g ? [] : g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];

  /* ---------- shared checks ---------- */
  // { birth, death } -> problems: [{ level: "fix" | "look" | "info", text }]
  function person(p) {
    const out = [], b = yearOf(p.birth), d = yearOf(p.death);
    [["Birth", p.birth, b], ["Death", p.death, d]].forEach(([label, raw, y]) => {
      const s = String(raw || "").trim();
      if (y !== null && (y < 1600 || y > THIS_YEAR)) out.push({ level: "fix", text: label + " year " + y + " isn't possible" });
      else if (s && y === null && /\d/.test(s)) out.push({ level: "look", text: label + " “" + s + "” has no full year (four digits)" });
    });
    if (b !== null && d !== null && b >= 1600 && d <= THIS_YEAR) {
      if (d < b) out.push({ level: "fix", text: "Died (" + d + ") before born (" + b + ")" });
      else if (d - b > 110) out.push({ level: "look", text: "Age " + (d - b) + " (born " + b + ", died " + d + ")" });
    }
    return out;
  }
  // Where a point sits relative to its cemetery: null if fine, else a problem
  function place(cid, lon, lat) {
    if (lon === null || lat === null) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return { level: "fix", text: "Coordinates can't be right (" + lat + ", " + lon + ")" };
    const c = (typeof cems !== "undefined" ? cems : []).find(r => r.ID === cid);
    const f = (typeof bounds !== "undefined" ? bounds.features || [] : []).find(x => (x.properties || {}).CEMETERY_ID === cid && !(x.properties.TYPE && x.properties.TYPE !== "BOUNDARY"));
    if (f && polysOf(f.geometry).some(poly => inside([lon, lat], poly[0] || []))) return null;
    const cl = c && num(c.LONG), ca = c && num(c.LAT);
    if (cl === null || ca === null) return null;
    const m = metres([lon, lat], [cl, ca]);
    if (m > FAR_M) return { level: "look", text: dist(m) + " from its cemetery" + (f ? ", outside the boundary" : "") };
    return null;
  }

  /* ---------- the full check ---------- */
  function run() {
    const out = [];                                   // { level, kind: "cem" | "grv", ref, title, text }
    const add = (level, kind, ref, title, text) => out.push({ level, kind, ref, title, text });
    const cemIds = new Map(); cems.forEach(r => { const id = String(r.ID || "").trim(); if (id) cemIds.set(id, (cemIds.get(id) || 0) + 1); });
    const cemTitle = r => (r.NAME || "(no name)") + (r.ID ? " · " + r.ID : "");

    // where most cemeteries are, to spot one placed in the wrong state
    const pts = cems.map(r => [num(r.LONG), num(r.LAT)]).filter(p => p[0] !== null && p[1] !== null && Math.abs(p[1]) <= 90 && Math.abs(p[0]) <= 180);
    const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const centre = pts.length >= 4 ? [med(pts.map(p => p[0])), med(pts.map(p => p[1]))] : null;
    const box = Array.isArray(S && S.maxBounds) ? S.maxBounds : null;

    cems.forEach(r => {
      const id = String(r.ID || "").trim(), t = cemTitle(r);
      if (!id) add("fix", "cem", r, t, "No cemetery ID");
      else if (cemIds.get(id) > 1) add("fix", "cem", r, t, "Another cemetery has the same ID (" + id + ")");
      if (!String(r.NAME || "").trim()) add("look", "cem", r, t, "No name");
      const lon = num(r.LONG), lat = num(r.LAT);
      if (lon === null || lat === null) { add("look", "cem", r, t, "No map location"); return; }
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) { add("fix", "cem", r, t, "Coordinates can't be right (" + lat + ", " + lon + ")"); return; }
      if (box && (lon < box[0][0] || lat < box[0][1] || lon > box[1][0] || lat > box[1][1])) add("look", "cem", r, t, "Outside the map's limits (Setup, Map and Look)");
      else if (centre && metres([lon, lat], centre) > CLUSTER_KM * 1000) add("look", "cem", r, t, dist(metres([lon, lat], centre)) + " from the rest of the cemeteries; latitude and longitude may be swapped or mistyped");
    });

    const seenPid = new Map(), seenPerson = new Map(), noDates = [], noName = [], noSpot = [];
    ints.forEach(r => {
      const cid = String(r.CEMETERY_ID || "").trim(), name = [r["FIRST NAME"], r["LAST NAME"]].map(x => String(x || "").trim()).filter(Boolean).join(" ");
      const t = (name || "(no name)") + (r.MARKER_ID ? " · " + r.MARKER_ID : "") + (cid ? " · " + cid : "");
      if (!cid || !cemIds.has(cid)) add("fix", "grv", r, t, cid ? "Its cemetery (" + cid + ") isn't in the cemetery list" : "Not linked to any cemetery");
      const pid = String(r.PERSON_ID || "").trim();
      if (pid) { const k = cid + "|" + pid; if (seenPid.has(k)) add("fix", "grv", r, t, "Same person ID as another record (" + pid + ")"); else seenPid.set(k, r); }
      person({ birth: r.BIRTH, death: r.DEATH }).forEach(p => add(p.level, "grv", r, t, p.text));
      const last = String(r["LAST NAME"] || "").trim().toLowerCase();
      if (name && last !== "unknown" && (yearOf(r.BIRTH) || yearOf(r.DEATH))) {
        const k = cid + "|" + name.toLowerCase().replace(/[^a-z]/g, "") + "|" + yearOf(r.BIRTH) + "|" + yearOf(r.DEATH);
        const o = seenPerson.get(k);
        if (o && o.MARKER_ID !== r.MARKER_ID) add("look", "grv", r, t, "Possibly the same person as marker " + (o.MARKER_ID || "?") + " (same name and years)");
        else if (!o) seenPerson.set(k, r);
      }
      const lon = num(r.LONG), lat = num(r.LAT);
      if (lon === null || lat === null) noSpot.push(r); else { const p = place(cid, lon, lat); if (p) add(p.level, "grv", r, t, p.text); }
      if (!String(r.BIRTH || "").trim() && !String(r.DEATH || "").trim()) noDates.push(r);
      if (!name || last === "unknown") noName.push(r);
    });
    const info = (list, text) => list.forEach(r => add("info", "grv", r, ([r["FIRST NAME"], r["LAST NAME"]].filter(Boolean).join(" ") || "(no name)") + (r.MARKER_ID ? " · " + r.MARKER_ID : "") + " · " + (r.CEMETERY_ID || ""), text));
    info(noDates, "No birth or death date"); info(noName, "No name, or Unknown"); info(noSpot, "No map spot");

    (bounds.features || []).forEach(f => {
      const p = f.properties || {}; if (p.TYPE && p.TYPE !== "BOUNDARY") return;
      const c = cems.find(r => r.ID === p.CEMETERY_ID);
      if (!c) { add("look", "cem", null, (p.NAME || "Boundary") + " · " + (p.CEMETERY_ID || "no ID"), "A boundary with no matching cemetery"); return; }
      const ring = (polysOf(f.geometry)[0] || [])[0] || [], lon = num(c.LONG), lat = num(c.LAT);
      if (ring.length >= 3 && lon !== null && lat !== null && !inside([lon, lat], ring)) {
        const mid = [ring.reduce((s, q) => s + q[0], 0) / ring.length, ring.reduce((s, q) => s + q[1], 0) / ring.length];
        if (metres(mid, [lon, lat]) > FAR_M) add("look", "cem", c, cemTitle(c), "Its boundary is " + dist(metres(mid, [lon, lat])) + " from its map pin");
      }
    });
    return out;
  }

  /* ---------- the window ---------- */
  const mk = (tag, props, kids) => { const e = Object.assign(document.createElement(tag), props || {}); (kids || []).forEach(k => e.append(k)); return e; };
  const CSS = ".dc-ov{position:fixed;inset:0;z-index:2147483000;background:#0008;display:flex;align-items:center;justify-content:center;padding:12px;font:14px system-ui,-apple-system,Segoe UI,Arial,sans-serif}" +
    ".dc-card{background:#fff;color:#1a202c;border-radius:10px;max-width:640px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 10px 40px #0007}" +
    ".dc-head{padding:14px 16px 8px;border-bottom:1px solid #e2e8f0}.dc-head h3{margin:0 0 4px;font-size:17px}.dc-head p{margin:0;font-size:13px;color:#4a5568}" +
    ".dc-body{overflow:auto;padding:4px 16px 12px}.dc-body details{margin:10px 0;border:1px solid #e2e8f0;border-radius:8px}.dc-body summary{cursor:pointer;padding:9px 12px;font-weight:600;list-style-position:inside}" +
    ".dc-fix summary{background:#fdecec;color:#8a1f1f}.dc-look summary{background:#fff7d6;color:#7a5b00}.dc-info summary{background:#f1f3f5;color:#4a5568}" +
    ".dc-row{display:flex;gap:8px;align-items:center;padding:7px 12px;border-top:1px solid #edf0f3}.dc-row div{flex:1;min-width:0}.dc-row b{display:block;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dc-row small{font-size:12.5px;color:#4a5568}" +
    ".dc-card button{font:inherit;padding:6px 12px;border:1px solid #cbd2d9;background:#fff;color:#1a202c;border-radius:6px;cursor:pointer;min-height:36px;width:auto;flex:0 0 auto}" +
    ".dc-foot{display:flex;gap:8px;justify-content:space-between;padding:10px 16px;border-top:1px solid #e2e8f0}.dc-more{padding:8px 12px;font-size:12.5px;color:#6b7280}.dc-ok{padding:24px 4px;text-align:center;color:#1a7f37;font-size:15px}";
  const LEVELS = [["fix", "Needs fixing"], ["look", "Worth a look"], ["info", "For your information"]];

  function open(item) {
    if (!item.ref) return;
    if (item.kind === "cem") { sel = item.ref.ID; selG = null; refresh(); tab("cem"); }
    else { sel = item.ref.CEMETERY_ID; selG = item.ref; refresh(); tab("grv"); }
  }
  function show() {
    if (!cems.length) return say("Open a map first.");
    if (!document.getElementById("dc-css")) document.head.append(mk("style", { id: "dc-css", textContent: CSS }));
    document.querySelectorAll(".dc-ov").forEach(x => x.remove());
    const found = run(), ov = mk("div", { className: "dc-ov" }), body = mk("div", { className: "dc-body" });
    const n = l => found.filter(f => f.level === l).length;
    ov.append(mk("div", { className: "dc-card" }, [
      mk("div", { className: "dc-head" }, [mk("h3", { textContent: "Check Data" }),
        mk("p", { textContent: n("fix") + " to fix, " + n("look") + " worth a look, " + n("info") + " for information. Nothing is changed until you open a record and edit it." })]),
      body,
      mk("div", { className: "dc-foot" }, [
        mk("button", { type: "button", textContent: "Download This List", onclick: () => {
          const csv = Papa.unparse(found.map(f => ({ LEVEL: LEVELS.find(l => l[0] === f.level)[1], RECORD: f.title, PROBLEM: f.text })));
          const a = mk("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: "data-check-" + new Date().toISOString().slice(0, 10) + ".csv" }); document.body.append(a); a.click(); a.remove();
        } }),
        mk("button", { type: "button", textContent: "Close", onclick: () => ov.remove() })])
    ]));
    if (!n("fix") && !n("look")) body.append(mk("div", { className: "dc-ok", textContent: "✔ No problems found." }));
    LEVELS.forEach(([lv, label]) => {
      const list = found.filter(f => f.level === lv); if (!list.length) return;
      const d = mk("details", { className: "dc-" + lv, open: lv !== "info" && list.length <= 60 }, [mk("summary", { textContent: label + " (" + list.length + ")" })]);
      list.slice(0, 300).forEach(f => d.append(mk("div", { className: "dc-row" }, [
        mk("div", {}, [mk("b", { textContent: f.title }), mk("small", { textContent: f.text })]),
        f.ref ? mk("button", { type: "button", textContent: "Open", onclick: () => { ov.remove(); open(f); } }) : ""])));
      if (list.length > 300) d.append(mk("div", { className: "dc-more", textContent: "and " + (list.length - 300) + " more. Use Download This List to see them all." }));
      body.append(d);
    });
    ov.addEventListener("click", e => { if (e.target === ov) ov.remove(); });
    document.body.append(ov);
  }

  window.DataCheck = { person, place, run, show };
  const menu = document.querySelector(".ed-actions .ed-menu");
  if (menu) { const b = mk("button", { type: "button", textContent: "Check Data", onclick: show }); b.append(mk("small", { textContent: "List likely mistakes: impossible dates, misplaced points" })); menu.append(b); }
})();
