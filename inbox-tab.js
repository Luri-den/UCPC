/* inbox-tab.js - the editor's "New" tab: surveys and stories waiting in the county inbox, and surveyor invites.
   Loaded by editor.html after its own script, before publish.js. It uses the editor's data (cems, ints, bounds, photos)
   and its Save / Publish, so approved items go out exactly like any other edit.

   - Inbox address: settings.json "inbox". The lead key is typed once and kept in this browser only.
   - Approve = apply to the map data now; the inbox is told after the next successful Save or Publish.
   - Reject / Hold = the inbox is told straight away.
   - Every approved survey is also added to visits.csv (the condition history). Approved stories go to stories.csv.
   - "Import survey file" reads the file a surveyor saves with "Save to a file", for when the inbox can't be reached. */
(function () {
  "use strict";
  if (typeof cems === "undefined" || !document.getElementById("inb")) return;

  const pane = document.getElementById("inb");
  const tabBtn = document.querySelector('.tabs button[data-t="inb"]');
  const H = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  const area = () => String(S.idPrefix || S.shortName || "").toUpperCase();
  const inbox = () => String(S.inbox || "").replace(/\/+$/, "");
  const keyName = () => "leadKey:" + area();
  const getKey = () => { try { return localStorage.getItem(keyName()) || ""; } catch (e) { return ""; } };
  const setKey = k => { try { k ? localStorage.setItem(keyName(), k) : localStorage.removeItem(keyName()); } catch (e) {} };
  const dist = (a, b) => { const k = Math.cos(a[1] * Math.PI / 180); return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320; };
  const feet = m => m < 160 ? Math.round(m * 3.28084) + " ft" : (m / 1609.344).toFixed(1) + " mi";

  const COND = { "Well kept": "3", "Fair": "2", "Poor": "1", "Overgrown": "1", "Hard to find / lost": "0" };
  const EDITOR_FENCES = ["Stone", "Wire", "Cast Iron", "Aluminum / Vinyl", "Pipe", "Chain Link"];
  const EDITOR_HAZ = ["Unstable / Uneven Ground", "Steep Slope(s)", "Heavy Brush / Roots", "Livestock / Animals", "Poison Ivy / Oak", "Fallen / Broken Stones", "Open / Damaged Vault", "Frequent Flooding / Mud"];
  const STORY_COLS = ["STORY_ID", "TARGET_TYPE", "TARGET_ID", "CEMETERY_ID", "PERSON", "TEXT", "QUOTE", "TOLD_BY", "CONNECTION", "DATE_TOLD", "TAG", "SOURCE", "PHOTO"];
  const VISIT_COLS = ["VISIT_ID", "DATE", "CEMETERY_ID", "TARGET_TYPE", "TARGET_ID", "SURVEYOR", "SUMMARY", "DATA"];

  let items = [], current = null, filter = "all", lastCheck = null, invites = null, lastError = "";
  const queuedApprove = new Set();            // inbox ids to mark approved after the next Save / Publish
  const mediaUrls = new Map();                // media id -> object URL (for showing photos)

  /* ---------- the extra files: stories.csv and visits.csv ---------- */
  const extra = { stories: { name: "stories.csv", rows: [], cols: STORY_COLS.slice(), loaded: false }, visits: { name: "visits.csv", rows: [], cols: VISIT_COLS.slice(), loaded: false } };
  const fileName = k => (S.files && S.files[k]) || extra[k].name;
  const parseCsv = t => Papa.parse(String(t).replace(/^﻿/, ""), { header: true, skipEmptyLines: true, transformHeader: h => h.trim() });
  async function readRepoFile(name) {           // GitHub first (when Publish is set up), then this website. null = file doesn't exist yet
    const s = window.GHPublish && GHPublish.settings ? GHPublish.settings() : {};
    if (s.owner && s.repo) { try { return await GHPublish.read(name); } catch (e) { /* fall back to the site */ } }
    if (/^https?:/.test(location.protocol)) {
      const r = await fetch(new URL(name, document.baseURI).href, { cache: "no-store" });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(name + ": the site answered " + r.status);
      return r.text();
    }
    throw new Error("Can't read " + name + ". Open the editor from the website, or set up Publish (⚙).");
  }
  async function loadExtra(k, force) {
    const x = extra[k]; if (x.loaded && !force) return true;
    try {
      const t = await readRepoFile(fileName(k));
      const fresh = t ? parseCsv(t) : { data: [], meta: { fields: x.cols } };
      const idCol = x.cols[0], mine = x.rows.filter(r => r._new);   // rows added here but not yet published
      x.rows = fresh.data.filter(r => String(r[idCol] || "").trim());
      mine.forEach(r => { if (!x.rows.some(o => o[idCol] === r[idCol])) x.rows.push(r); });
      x.cols = [...new Set([...(fresh.meta.fields || []), ...x.cols])];
      x.loaded = true; return true;
    } catch (e) { say("Couldn't read " + fileName(k) + " (" + e.message + "), so it can't be updated yet."); return false; }
  }

  /* hook into the editor's Save / Publish */
  const _outFiles = outFiles;
  outFiles = function () {
    const o = _outFiles();
    ["stories", "visits"].forEach(k => {
      if (!dirty.has(k)) return;
      const x = extra[k]; o.push([fileName(k), Papa.unparse(x.rows.map(r => { const c = {}; x.cols.forEach(f => c[f] = r[f] == null ? "" : r[f]); return c; }), { columns: x.cols })]);
    });
    return o;
  };
  const _sync = syncFromGitHub;
  syncFromGitHub = async function () {           // before publishing: pick up anyone else's newer stories / visits too
    await _sync();
    for (const k of ["stories", "visits"]) if (dirty.has(k)) { const ok = await loadExtra(k, true); if (!ok) throw new Error("Couldn't read " + fileName(k) + " from GitHub."); }
  };
  const _clean = clean;
  clean = function () {                          // Save or Publish worked: now tell the inbox what was approved
    _clean();
    extra.stories.rows.forEach(r => delete r._new); extra.visits.rows.forEach(r => delete r._new);
    if (queuedApprove.size) mark([...queuedApprove], "approved", true).then(ok => { if (ok) { queuedApprove.clear(); draw(); } });
  };

  /* ---------- talking to the inbox ---------- */
  async function call(path, opts) {
    const k = getKey(); if (!inbox()) throw new Error("No inbox address. Add \"inbox\" to settings.json.");
    if (!k) throw new Error("Enter the lead key first.");
    const r = await fetch(inbox() + "/" + area() + path, Object.assign({}, opts, { headers: Object.assign({ "X-Lead-Key": k }, (opts && opts.headers) || {}) }));
    if (r.status === 403) throw new Error("The inbox refused the lead key for " + area() + ". Use Forget Lead Key below and type it again (just the phrase, no braces or quotes).");
    if (r.status === 404) { const j = await r.clone().json().catch(() => ({})); if (j.error === "Unknown county.") throw new Error("The inbox doesn't know the county code \"" + area() + "\". The editor's Cemetery ID Letters (Map tab) must match the code in LEAD_KEYS in Cloudflare, e.g. {\"" + area() + "\":\"your-phrase\"}."); }
    return r;
  }
  async function checkInbox(quiet) {
    if (!getKey() || !inbox()) { if (!quiet) draw(); return; }
    try {
      const r = await call("/inbox"), j = await r.json();
      if (!j.ok) throw new Error(j.error || "The inbox didn't answer.");
      const local = items.filter(i => i.local);
      items = j.items.filter(i => !queuedApprove.has(i.id)).map(i => Object.assign(i, { local: false })).concat(local);
      lastCheck = new Date(); lastError = ""; if (current && !items.includes(current)) current = items.find(i => i.id === current.id) || null;
      badge(); if (!quiet) say(items.length ? items.length + " new addition" + (items.length === 1 ? "" : "s") + " waiting." : "Nothing new in the inbox.");
    } catch (e) { lastError = (e && e.message === "Failed to fetch") ? "Couldn't reach the inbox at " + inbox() + ". Check the \"inbox\" address in settings.json and your internet connection." : String(e && e.message || e); if (!quiet) say(lastError); }
    draw();
  }
  async function mark(ids, status, purge) {
    const remote = ids.filter(id => { const it = items.find(i => i.id === id); return !it || !it.local; });
    if (!remote.length) return true;
    try { const r = await call("/mark", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: remote, status, purge: !!purge }) }); const j = await r.json(); if (!j.ok) throw new Error(j.error); return true; }
    catch (e) { say("Couldn't update the inbox: " + e.message); return false; }
  }
  async function mediaBlob(it, ref) {            // "media:N" -> Blob
    const n = +String(ref).split(":")[1], m = (it.media || [])[n]; if (!m) return null;
    if (m.blob) return m.blob;
    if (m.data) { const b = await (await fetch("data:" + m.mime + ";base64," + m.data)).blob(); m.blob = b; return b; }
    const r = await call("/media/" + encodeURIComponent(m.id)); if (!r.ok) return null;
    m.blob = await r.blob(); return m.blob;
  }
  async function mediaUrl(it, ref) {
    const key = it.id + "|" + ref; if (mediaUrls.has(key)) return mediaUrls.get(key);
    const b = await mediaBlob(it, ref); if (!b) return null;
    const u = URL.createObjectURL(b); mediaUrls.set(key, u); return u;
  }
  /* the alerts: a red count on the New tab, a banner at the top of the sidebar, and the count in the browser tab's title */
  const baseTitle = document.title;
  const banner = el("div", { id: "inbBanner", hidden: true, style: "margin-top:6px;background:#fff;color:#7a1f1f;border-radius:6px;padding:6px 8px;font-weight:bold;display:flex;gap:8px;align-items:center" });
  const topBox = document.querySelector(".top"); if (topBox) topBox.append(banner);
  const pillCss = document.createElement("style");
  pillCss.textContent = ".inb-pill{display:inline-block;min-width:18px;padding:1px 6px;margin-left:4px;border-radius:999px;background:#c62828;color:#fff;font-size:11px;line-height:16px;vertical-align:1px}#inbBanner[hidden]{display:none!important}";
  document.head.append(pillCss);
  let waiting = 0;
  function showCount(n) {
    waiting = Math.max(0, n);
    if (tabBtn) { tabBtn.textContent = "New"; if (waiting) tabBtn.append(el("span", { className: "inb-pill", textContent: String(waiting) })); }
    document.title = (waiting ? "(" + waiting + ") " : "") + baseTitle;
    banner.textContent = "";
    banner.hidden = !waiting || curTab === "inb";
    if (waiting) banner.append(el("span", { textContent: "● " + waiting + " new addition" + (waiting === 1 ? "" : "s") + " waiting", style: "flex:1" }),
      el("button", { textContent: "Review", onclick: () => { tab("inb"); draw(); checkInbox(true); } }));
  }
  function badge() { showCount(items.length); }
  async function poll() {                          // a light check every 2 minutes while the editor is open
    if (!getKey() || !inbox() || document.hidden) return;
    try { const r = await call("/count"), j = await r.json(); if (j.ok) { const n = j.total - queuedApprove.size; if (n !== items.length && curTab === "inb") checkInbox(true); else showCount(n); } } catch (e) {}
  }

  /* ---------- reading an item ---------- */
  const D = it => it.data || {};
  const kindOf = it => it.kind === "story" ? "story" : (D(it)._kind || it.target_type || "survey");
  const cemOf = it => { const id = D(it)._cemetery || D(it).cemetery || (it.target_type === "cemetery" ? it.target_id : ""); return cems.find(r => r.ID === id) || { ID: id, NAME: id || "(no cemetery)" }; };
  const whereOf = it => D(it)._where && D(it)._where.ll;
  function title(it) {
    const d = D(it), k = kindOf(it);
    if (k === "story") return "Story" + (d.person ? " about " + d.person : d.label ? " · " + d.label : "");
    if (k === "cemetery") return "Cemetery details";
    const p = (d.people || [])[0], who = p ? [p.first, p.last].filter(Boolean).join(" ") : "";
    return (d.feature_type || "Marker") + (who ? " · " + who : "") + (it.target_type === "marker" ? " (existing " + it.target_id + ")" : " (new)");
  }
  function flags(it) {                           // repeat visits, moves, possible duplicates
    const out = [], d = D(it), k = kindOf(it);
    if (k === "story") return out;
    const same = items.filter(o => o !== it && kindOf(o) === k && (k === "cemetery" ? cemOf(o).ID === cemOf(it).ID : it.target_type === "marker" && o.target_type === "marker" && o.target_id === it.target_id));
    same.forEach(o => {
      const sameDay = String(o.created || o.received).slice(0, 10) === String(it.created || it.received).slice(0, 10);
      out.push(o.submitter === it.submitter && sameDay ? "Probable accidental duplicate (same surveyor, same day)" : sameDay ? "Cross-check: " + (o.submitter || "another surveyor") + " surveyed it the same day" : "Repeat visit: also surveyed by " + (o.submitter || "someone") + " on " + String(o.created || o.received).slice(0, 10));
    });
    if (d._moved) out.push("Moved " + feet(dist(d._moved.from, d._moved.to)) + " from where the map had it");
    if (k === "marker" && it.target_type === "new" && whereOf(it)) {
      const here = whereOf(it);
      const near = ints.filter(r => r.CEMETERY_ID === cemOf(it).ID && ll(r)).map(r => ({ r, d: dist(here, ll(r)) })).sort((a, b) => a.d - b.d)[0];
      if (near && near.d < 3) out.push("Possibly the same grave as " + (near.r.MARKER_ID || "an existing marker") + " (" + feet(near.d) + " away)");
      items.filter(o => o !== it && o.target_type === "new" && whereOf(o) && dist(here, whereOf(o)) < 3).forEach(o => out.push("Within 10 ft of another new find by " + (o.submitter || "someone")));
    }
    return out;
  }

  /* ---------- the map ---------- */
  function drawOnMap(it) {
    if (!ready) return;
    if (!map.getSource("inbx")) {
      map.addSource("inbx", { type: "geojson", data: EMPTY });
      map.addLayer({ id: "inbx-fill", type: "fill", source: "inbx", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#facc15", "fill-opacity": 0.25 } });
      map.addLayer({ id: "inbx-line", type: "line", source: "inbx", filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": "#d97706", "line-width": 3, "line-dasharray": [2, 1] } });
      map.addLayer({ id: "inbx-pt", type: "circle", source: "inbx", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 9, "circle-color": ["coalesce", ["get", "c"], "#f97316"], "circle-stroke-color": "#000", "circle-stroke-width": 2 } });
    }
    const f = [], pt = (c, color) => f.push({ type: "Feature", properties: { c: color }, geometry: { type: "Point", coordinates: c } });
    if (it) {
      const d = D(it);
      if (d.boundary && d.boundary.length >= 3) { const ring = d.boundary.map(p => p.ll); f.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring.concat([ring[0]])] } }); }
      if (d.entrance_point) pt(d.entrance_point.ll, "#16a34a");
      (d.hazard_spots || []).forEach(h => h.where && pt(h.where.ll, "#dc2626"));
      if (d._moved) { pt(d._moved.from, "#9ca3af"); f.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [d._moved.from, d._moved.to] } }); }
      if (whereOf(it)) pt(whereOf(it), "#f97316");
      const all = f.flatMap(x => x.geometry.type === "Point" ? [x.geometry.coordinates] : x.geometry.type === "LineString" ? x.geometry.coordinates : x.geometry.coordinates[0]);
      const c = cemOf(it);
      if (all.length) { const b = new maplibregl.LngLatBounds(); all.forEach(p => b.extend(p)); map.fitBounds(b, { padding: 80, maxZoom: 20 }); }
      else if (ll(c)) map.flyTo({ center: ll(c), zoom: 16 });
    }
    map.getSource("inbx").setData(fc(f));
  }

  /* ---------- drawing the tab ---------- */
  function draw() {
    pane.textContent = "";
    const k = getKey();
    pane.append(el("h3", { textContent: "New additions" }));
    if (!inbox()) { pane.append(el("p", {}, [el("small", { textContent: "This map has no inbox address yet. Add \"inbox\" to settings.json (for example https://survey-inbox.yourname.workers.dev)." })])); return importRow(); }
    if (!k) {
      const i = el("input", { type: "password", placeholder: "Lead key", autocomplete: "off" });
      pane.append(el("small", { textContent: "Type this county's lead key once. It stays in this browser only." }), i,
        el("div", { className: "row" }, [el("button", { className: "go", textContent: "Unlock", onclick: () => { if (i.value.trim()) { setKey(i.value.trim()); checkInbox(false); } } })]));
      return importRow();
    }
    const counts = { all: items.length, member: items.filter(i => i.channel === "member").length, public: items.filter(i => i.channel === "public").length };
    pane.append(el("small", { textContent: "Inbox: " + inbox() + " · County code: " + (area() || "(none)") }));
    if (lastError) pane.append(el("div", { className: "box", style: "background:#fdecea;border-color:#e5b4b4;color:#7a1f1f" }, [el("b", { textContent: "Couldn't check the inbox" }), el("div", { textContent: lastError })]));
    pane.append(el("div", { className: "row" }, [
      el("button", { className: "go", textContent: "Check Inbox", onclick: () => checkInbox(false) }),
      el("small", { textContent: lastCheck ? "Checked " + lastCheck.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "" })
    ]));
    pane.append(el("div", { className: "row" }, [["all", "All"], ["member", "Surveyors"], ["public", "Public"]].map(([v, t]) =>
      el("button", { textContent: t + " (" + counts[v] + ")", style: filter === v ? "background:#d7ebe8;font-weight:bold" : "", onclick: () => { filter = v; draw(); } }))));
    if (queuedApprove.size) pane.append(el("div", { className: "box", style: "background:#fff7d6" }, [el("small", { textContent: queuedApprove.size + " approved item(s) are in your data. Save or Publish to finish; the inbox is updated after that." })]));
    const shown = items.filter(i => filter === "all" || i.channel === filter);
    const list = el("div", { className: "list", style: "max-height:240px" });
    if (!shown.length) list.append(el("div", { textContent: "Nothing waiting.", style: "cursor:default;color:#6b6258" }));
    shown.forEach(it => {
      const f = flags(it);
      list.append(el("div", { className: it === current ? "on" : "", onclick: () => { current = it; draw(); drawOnMap(it); } }, [
        el("span", { textContent: it.channel === "public" ? "PUBLIC " : it.local ? "FILE " : "SURVEYOR ", style: "font-size:10px;font-weight:bold;color:" + (it.channel === "public" ? "#7a3e9d" : "#01796F") }),
        el("span", { textContent: title(it) }), el("br"),
        el("small", { textContent: cemOf(it).NAME + " · " + (it.submitter || "anonymous") + " · " + String(it.received || it.created || "").slice(0, 10) + (f.length ? " · ⚑ " + f.length : "") })
      ]));
    });
    pane.append(list);
    if (current) detail(current);
    surveyorsBox();
    importRow();
    pane.append(el("div", { className: "row" }, [el("button", { textContent: "Forget Lead Key", onclick: () => { if (confirm("Remove the lead key from this browser?")) { setKey(""); items = items.filter(i => i.local); current = null; badge(); draw(); } } })]));
  }

  function answersHtml(it) {
    const d = D(it), skip = new Set(["_cemetery", "_where", "_kind", "_form", "_moved", "boundary", "entrance_point", "hazard_spots", "people", "photos", "entrance_photo", "cem_photos", "photo", "consent", "page", "label", "cemetery", "person", "boundary_source"]);
    let h = "";
    Object.keys(d).forEach(k => { if (skip.has(k) || d[k] === "" || d[k] == null) return; h += "<div><b>" + H(k.replace(/_/g, " ")) + ":</b> " + H(Array.isArray(d[k]) ? d[k].join(", ") : typeof d[k] === "object" ? JSON.stringify(d[k]) : d[k]) + "</div>"; });
    (d.people || []).forEach((p, i) => { h += "<div><b>Person " + (i + 1) + ":</b> " + H([p.first, p.last].filter(Boolean).join(" ") || "(name not read)") + (p.birth ? " · b. " + H(p.birth) : "") + (p.death ? " · d. " + H(p.death) : "") + (p.sex ? " · " + H(p.sex) : "") + "</div>"; });
    if (d.boundary) h += "<div><b>Boundary:</b> " + d.boundary.length + " corners (" + H(d.boundary_source === "edited" ? "fixed from the existing outline" : "drawn new") + ")</div>";
    if (d.entrance_point) h += "<div><b>Entrance:</b> marked (green dot)</div>";
    if ((d.hazard_spots || []).length) h += "<div><b>Hazard spots:</b> " + d.hazard_spots.map(s => H(s.type || "?") + (s.note ? " (" + H(s.note) + ")" : "")).join("; ") + " (red dots)</div>";
    return h || "<small>No answers.</small>";
  }
  function photoRefs(it) { const d = D(it); return ["entrance_photo", "cem_photos", "photos"].flatMap(k => (d[k] || []).map(ref => ({ ref, from: k }))).concat(d.photo ? [{ ref: d.photo, from: "photo" }] : []); }

  function detail(it) {
    const d = D(it), k = kindOf(it), box = el("div", { className: "box" }), c = cemOf(it);
    box.append(el("b", { textContent: title(it) }), el("div", {}, [el("small", { textContent: c.NAME + " · " + (it.channel === "public" ? "Public submission" : "Surveyor: " + (it.submitter || "?")) + " · sent " + String(it.received || it.created).slice(0, 16).replace("T", " ") })]));
    const fl = flags(it); if (fl.length) box.append(el("div", { style: "background:#fff7d6;border:1px solid #C9A227;border-radius:4px;padding:6px;margin:6px 0;font-size:12px" }, fl.map(t => el("div", { textContent: "⚑ " + t }))));
    const ans = el("div", { style: "font-size:13px;margin:6px 0" }); ans.innerHTML = k === "story" ? "" : answersHtml(it); box.append(ans);
    const pics = el("div", { style: "display:flex;gap:6px;flex-wrap:wrap" }), refs = photoRefs(it), keepPhoto = new Map();
    refs.forEach(p => {
      const cb = el("input", { type: "checkbox", checked: true }), img = el("img", { style: "width:90px;height:90px;object-fit:cover;border-radius:4px;display:block", alt: "" });
      keepPhoto.set(p.ref, cb);
      mediaUrl(it, p.ref).then(u => { if (u) img.src = u; else img.alt = "photo unavailable"; }).catch(() => { img.alt = "photo unavailable"; });
      pics.append(el("label", { style: "font-weight:normal;font-size:11px" }, [img, cb, " keep"]));
    });
    if (refs.length) box.append(el("small", { textContent: "Photos (ticked ones are saved with the record):" }), pics);

    const apply = {};                             // what Approve will do, each one a tick box the lead can untick
    const opt = (key, text, on) => { const cb = el("input", { type: "checkbox", checked: on !== false }); apply[key] = cb; box.append(el("label", { style: "font-weight:normal" }, [cb, " " + text])); };
    let storyEdit = null;
    if (k === "cemetery") {
      box.append(el("h3", { textContent: "Approve will…" }));
      if (d.overall_condition && COND[d.overall_condition] != null) opt("cond", "Set Condition to " + d.overall_condition);
      if (d.fence) opt("fence", "Set Fence: " + d.fence + (d.fence_types ? " (" + d.fence_types.join(", ") + ")" : ""));
      if (d.hazards) opt("haz", "Set Hazards: " + d.hazards + (d.hazard_types ? " (" + d.hazard_types.join(", ") + ")" : ""));
      if (d.boundary && d.boundary.length >= 3) opt("bnd", (holderOf(c.ID) ? "Replace" : "Add") + " the boundary (" + d.boundary.length + " corners)");
      if (d.entrance_point) opt("ent", "Set the main entrance to the green dot");
      if (refs.length) opt("pics", "Save ticked photos as cemetery photos");
      opt("date", "Set Survey Date to today");
    } else if (k === "marker") {
      box.append(el("h3", { textContent: "Approve will…" }));
      if (it.target_type === "marker") {
        if (d._moved) opt("move", "Move marker " + it.target_id + " to the surveyed spot (" + feet(dist(d._moved.from, d._moved.to)) + ")");
        if (d.veteran === "Yes") opt("vet", "Mark everyone on this stone as Veteran", false);
        if (refs.length) opt("pics", "Save the first ticked photo as this grave's photo (replaces the old one)");
        box.append(el("small", { textContent: "Names and dates on existing stones aren't changed automatically. Use Open in Graves to edit them by hand." }));
      } else {
        const n = Math.max(1, (d.people || []).length);
        opt("add", "Add as a new marker with " + n + " " + (n === 1 ? "person" : "people") + (d.feature_type ? " (" + d.feature_type + ")" : ""));
        if (refs.length) opt("pics", "Save the first ticked photo as its grave photo");
      }
    } else if (k === "story") {
      const t = el("textarea", { style: "height:140px" }); t.value = d.text || "";
      const q = el("input", { placeholder: "Featured quote (optional, a short line from the story)" });
      const tag = el("select", {}, ["Family account", "Personal memory", "Documented"].map(v => el("option", { value: v, textContent: v })));
      tag.value = /^Documented/.test(d.type) ? "Documented" : d.type === "Personal memory" ? "Personal memory" : "Family account";
      const who = el("input", { value: d.teller || d.name || "" }), conn = el("input", { value: d.connection || "" }), src = el("input", { value: d.source || "" });
      box.append(el("label", { textContent: "Story (edit before publishing if needed)" }), t, el("label", { textContent: "Featured quote" }), q, el("label", { textContent: "Tag" }), tag,
        el("label", { textContent: "Shared by" }), who, el("label", { textContent: "Connection" }), conn, el("label", { textContent: "Source" }), src);
      if (d.teller && d.name) box.append(el("small", { textContent: "Told by " + d.teller + ", sent in by " + d.name + "." }));
      if (d.contact) box.append(el("div", { className: "box", style: "background:#f3f0e8" }, [el("small", { textContent: "Private contact (never published): " + d.contact })]));
      storyEdit = { t, q, tag, who, conn, src };
      if (refs.length) opt("pics", "Publish the ticked photo with the story");
    }

    const actions = el("div", { className: "row", style: "flex-wrap:wrap" }, [
      el("button", { className: "go", textContent: "Approve", onclick: () => approve(it, apply, keepPhoto, storyEdit) }),
      el("button", { textContent: "Hold", title: "Keep it in the inbox's archive without publishing", onclick: () => decide(it, "held") }),
      el("button", { className: "bad", textContent: "Reject", onclick: () => { if (confirm("Reject this " + (k === "story" ? "story" : "survey") + "? It won't be published.")) decide(it, "rejected"); } })
    ]);
    if (k === "marker" && it.target_type === "marker") actions.append(el("button", { textContent: "Open in Graves", onclick: () => { const r = ints.find(x => x.CEMETERY_ID === c.ID && x.MARKER_ID === it.target_id); if (r) { sel = c.ID; selG = r; refresh(); tab("grv"); } else say("That marker isn't in the graves list."); } }));
    box.append(actions);
    pane.append(box);
  }
  const holderOf = id => bounds.features.find(x => (x.properties || {}).CEMETERY_ID === id && !(x.properties.TYPE && x.properties.TYPE !== "BOUNDARY"));
  const need = (F, cols) => cols.forEach(f => { if (!F.includes(f)) F.push(f); });

  async function decide(it, status) {
    if (it.local) { items = items.filter(i => i !== it); current = null; badge(); draw(); drawOnMap(null); return; }
    if (await mark([it.id], status, status === "rejected")) { items = items.filter(i => i !== it); current = null; badge(); draw(); drawOnMap(null); say(status === "held" ? "Held. It stays in the inbox archive." : "Rejected."); }
  }

  async function approve(it, apply, keepPhoto, storyEdit) {
    const d = D(it), k = kindOf(it), c = cemOf(it), on = key => apply[key] && apply[key].checked;
    const kept = photoRefs(it).filter(p => keepPhoto.get(p.ref) && keepPhoto.get(p.ref).checked);
    try {
      if (k === "story") {
        if (!(await loadExtra("stories"))) return;
        let photoPath = "";
        if (on("pics") && kept.length) { const b = await mediaBlob(it, kept[0].ref); if (b) { photoPath = "photos/stories/" + it.id + ".jpg"; photos.set(photoPath, b); touch("photos"); } }
        extra.stories.rows.push({ _new: true, STORY_ID: it.id, TARGET_TYPE: it.target_type || "marker", TARGET_ID: it.target_id || "", CEMETERY_ID: d.cemetery || "", PERSON: d.person || "",
          TEXT: storyEdit.t.value.trim(), QUOTE: storyEdit.q.value.trim(), TOLD_BY: storyEdit.who.value.trim(), CONNECTION: storyEdit.conn.value.trim(),
          DATE_TOLD: String(it.received || it.created || "").slice(0, 10), TAG: storyEdit.tag.value, SOURCE: storyEdit.src.value.trim(), PHOTO: photoPath });
        touch("stories");
      } else {
        if (!(await loadExtra("visits"))) return;
        const r = cems.find(x => x.ID === c.ID);
        if (k === "cemetery" && r) {
          if (on("cond")) { r.CONDITION = COND[d.overall_condition]; need(cemF, ["CONDITION"]); }
          if (on("fence")) { r.FENCE = d.fence === "Yes" ? "1" : "0"; r.FENCE_TYPES = d.fence === "Yes" ? (d.fence_types || []).filter(t => EDITOR_FENCES.includes(t)).join("; ") : ""; need(cemF, ["FENCE", "FENCE_TYPES"]); }
          if (on("haz")) { r.HAZARDS = d.hazards === "Yes" ? "1" : ""; r.HAZARD_DETAILS = d.hazards === "Yes" ? (d.hazard_types || []).filter(t => EDITOR_HAZ.includes(t)).join("; ") : ""; need(cemF, ["HAZARDS", "HAZARD_DETAILS"]); }
          if (on("date")) { r.SURVEY_DATE = today(); r.LAST_UPDATED = today(); need(cemF, ["SURVEY_DATE", "LAST_UPDATED"]); }
          touch("cem");
          if (on("bnd") || on("ent")) {
            sel = c.ID; const f = holder(c.ID, true);
            if (on("bnd")) { const ring = d.boundary.map(p => fix(p.ll)); f.geometry = { type: "Polygon", coordinates: [ring.concat([ring[0]])] }; }
            if (on("ent")) { const list = f.properties.ENTRANCES = f.properties.ENTRANCES || [], main = list.find(e => (e.size || "primary") === "primary"); if (main) main.coords = fix(d.entrance_point.ll); else list.unshift({ label: "Entrance", size: "primary", coords: fix(d.entrance_point.ll) }); }
            touch("bounds");
          }
          if (on("pics") && kept.length) {
            let n = 0; const taken = p => photos.has(p);
            for (const p of kept) { const b = await mediaBlob(it, p.ref); if (!b) continue; let path; do { path = "photos/" + c.ID + (n ? "-" + (n + 1) : "") + ".jpg"; n++; } while (taken(path)); photos.set(path, b); }
            touch("photos");
          }
        }
        if (k === "marker") {
          if (it.target_type === "marker") {
            const stone = ints.find(x => x.CEMETERY_ID === c.ID && x.MARKER_ID === it.target_id);
            if (stone && on("move") && d._moved) { const p = fix(d._moved.to); moveStone(stone, p[1], p[0]); touch("ints"); }
            if (stone && on("vet")) { sameStone(stone).forEach(x => x.VETERAN = "1"); touch("ints"); }
            if (on("pics") && kept.length) { const b = await mediaBlob(it, kept[0].ref); if (b) { photos.set("photos/gravepics/" + it.target_id + "-1.jpg", b); touch("photos"); } }
          } else if (on("add")) {
            const p = fix(whereOf(it)), digits = (c.ID.replace(/\D/g, "") || "0").slice(-3).padStart(3, "0");
            let n = ints.filter(x => x.CEMETERY_ID === c.ID).length + 1, id;
            do { id = "M-" + digits + "-" + String(n++).padStart(3, "0"); } while (ints.some(x => x.MARKER_ID === id));
            const people = (d.people && d.people.length ? d.people : [{}]), above = /Above-ground/.test(d.feature_type || "");
            const note = [d.feature_type && !/^Headstone$/.test(d.feature_type) ? "[" + d.feature_type + (d.belongs_to ? ", belongs with " + d.belongs_to : "") + "]" : "", d.inscription || ""].filter(Boolean).join(" ");
            need(intF, ["STONE_TYPE", "SEX"]);
            people.forEach((pp, i) => {
              const row = {}; intF.forEach(f => row[f] = "");
              Object.assign(row, { CEMETERY_ID: c.ID, MARKER_ID: id, PERSON_ID: people.length > 1 ? id + String.fromCharCode(65 + i) : id, "FIRST NAME": pp.first || "", "LAST NAME": pp.last || "Unknown",
                BIRTH: pp.birth || "", DEATH: pp.death || "", SEX: pp.sex || "", VETERAN: d.veteran === "Yes" ? "1" : "0", PIONEER: "0", MAUS: above ? "1" : "0",
                STONE_TYPE: above ? "Above Ground Structure (Mausoleum, etc.)" : "", ROW: d.row_plot || "", "ADDITIONAL INFORMATION ON STONE": note, LAT: p[1], LONG: p[0] });
              ints.push(row);
            });
            touch("ints");
            if (on("pics") && kept.length) { const b = await mediaBlob(it, kept[0].ref); if (b) { photos.set("photos/gravepics/" + id + "-1.jpg", b); touch("photos"); } }
            d._newMarker = id;
          }
        }
        const summary = k === "cemetery" ? ["condition " + (d.overall_condition || "?"), d.hazards === "Yes" ? "hazards" : "", d.boundary ? "boundary" : ""].filter(Boolean).join(", ")
          : [d.feature_type, (d.condition || []).join("/"), d._moved ? "moved" : ""].filter(Boolean).join(", ");
        const lean = Object.assign({}, d); ["entrance_photo", "cem_photos", "photos"].forEach(x => { if (lean[x]) lean[x] = lean[x].length + " photo(s)"; });
        extra.visits.rows.push({ _new: true, VISIT_ID: it.id, DATE: String(it.created || it.received || "").slice(0, 10), CEMETERY_ID: c.ID, TARGET_TYPE: k, TARGET_ID: k === "cemetery" ? c.ID : (d._newMarker || it.target_id || ""), SURVEYOR: it.submitter || "", SUMMARY: summary, DATA: JSON.stringify(lean) });
        touch("visits");
      }
      if (!it.local) queuedApprove.add(it.id);
      items = items.filter(i => i !== it); current = null; badge(); refresh(); drawOnMap(null); draw();
      say("Approved. Save or Publish to put it on the site" + (it.local ? "." : "; the inbox is updated after that."));
    } catch (e) { say("Couldn't approve: " + e.message); }
  }

  /* ---------- surveyors ---------- */
  function surveyorsBox() {
    const box = el("div", { className: "box" }, [el("b", { textContent: "Surveyors" })]);
    const name = el("input", { placeholder: "Name of the new surveyor" }), out = el("div");
    box.append(el("small", { textContent: "Each surveyor gets their own invite link. Revoke one if a phone is lost or someone stops volunteering." }), name,
      el("div", { className: "row" }, [el("button", { className: "go", textContent: "Invite Surveyor", onclick: async () => {
        if (!name.value.trim()) return say("Type the surveyor's name first.");
        try { const r = await call("/invites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.value.trim() }) }), j = await r.json(); if (!j.ok) throw new Error(j.error);
          const link = surveyLink(j.code); out.textContent = "";
          const inp = el("input", { value: link, readOnly: true });
          out.append(el("small", { textContent: "Send this link to " + j.name + ". It unlocks the survey on their phone:" }), inp,
            el("div", { className: "row" }, [el("button", { textContent: "Copy Link", onclick: () => { inp.select(); navigator.clipboard ? navigator.clipboard.writeText(link).then(() => say("Copied.")) : document.execCommand("copy"); } })]));
          name.value = ""; invites = null; loadInvites(list);
        } catch (e) { say(e.message); } } }), el("button", { textContent: "Show Surveyors", onclick: () => loadInvites(list) })]), out);
    const list = el("div"); box.append(list);
    if (invites) showInvites(list);
    pane.append(box);
  }
  function surveyLink(code) {
    const base = S.siteUrl || (/^https?:/.test(location.protocol) ? new URL("survey.html", document.baseURI).href : "survey.html");
    return (S.siteUrl ? String(S.siteUrl).replace(/\/+$/, "") + "/survey.html" : base) + "?invite=" + encodeURIComponent(code);
  }
  async function loadInvites(list) {
    try { const r = await call("/invites"), j = await r.json(); if (!j.ok) throw new Error(j.error); invites = j.invites; showInvites(list); } catch (e) { say(e.message); }
  }
  function showInvites(list) {
    list.textContent = "";
    if (!invites.length) { list.append(el("small", { textContent: "No surveyors yet." })); return; }
    invites.forEach(v => list.append(el("div", { className: "row", style: "font-size:12px" }, [
      el("span", { textContent: v.name + (v.revoked ? " (revoked)" : "") + " · " + v.sent + " sent", style: "flex:1;" + (v.revoked ? "color:#999;text-decoration:line-through" : "") }),
      v.revoked ? el("span") : el("button", { textContent: "Link", onclick: () => { prompt("Invite link for " + v.name + ":", surveyLink(v.code)); } }),
      v.revoked ? el("span") : el("button", { className: "bad", textContent: "Revoke", onclick: async () => {
        if (!confirm("Revoke " + v.name + "'s invite? Their phone can't send surveys after this.")) return;
        try { await call("/invites/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: v.code }) }); v.revoked = 1; showInvites(list); } catch (e) { say(e.message); } } })
    ])));
  }

  /* ---------- the safety net: a file saved by a surveyor's phone ---------- */
  function importRow() {
    const f = el("input", { type: "file", accept: ".json,application/json", hidden: true, onchange: async e => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const j = JSON.parse(await file.text()); if (j.type !== "cemetery-survey-export" || !Array.isArray(j.submissions)) throw new Error("That isn't a survey file.");
        let n = 0;
        j.submissions.forEach(s => { if (items.some(i => i.id === s.id)) return; items.push({ id: s.id, local: true, channel: "member", submitter: s.submitter || j.surveyor || "", kind: s.kind, target_type: (s.target || {}).type, target_id: (s.target || {}).id, data: s.data || {}, media: s.media || [], created: s.created, received: j.exported }); n++; });
        badge(); draw(); say("Imported " + n + " survey(s) from the file.");
      } catch (err) { say("Couldn't read that file: " + err.message); }
    } });
    pane.append(f, el("div", { className: "row" }, [el("button", { textContent: "Import Survey File…", onclick: () => f.click() })]),
      el("small", { textContent: "For surveys a phone saved with \"Save to a file\" instead of sending." }));
  }

  /* ---------- start ---------- */
  if (tabBtn) tabBtn.addEventListener("click", () => { draw(); if (getKey() && !lastCheck) checkInbox(true); });
  const _tab = tab;
  tab = function (t) { _tab(t); if (t !== "inb" && map.getSource("inbx")) map.getSource("inbx").setData(EMPTY); showCount(waiting); };
  setTimeout(() => { if (getKey() && inbox()) checkInbox(true); }, 2500);
  setInterval(poll, 120000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  draw();
})();
