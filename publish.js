/* publish.js - adds a "Publish" button next to an editor's Download button.

   WHERE IT PUBLISHES (the "target") can be switched in the gear dialog, or for everyone in settings.json:
     "publish": { "target": "github", "owner": "...", "repo": "...", "branch": "" }
     "publish": { "target": "server", "url": "https://cemeteries.example.gov" }
   A "server" is anything that answers three requests (county-server.mjs is a ready-made one):
     GET  <url>/files          -> { "ok": true, "files": ["cemlist.csv", "photos/UC001.jpg", ...] }
     GET  <url>/files/<path>   -> that file (404 if it does not exist)
     PUT  <url>/files/<path>   -> saves the request body as that file
   Every request carries  Authorization: Bearer <publish key>.

   How it works: when you click Publish, the editor's own Download button(s) are "pressed" for you,
   but the files are caught instead of downloaded. You review the list (and can fix any folder),
   then everything goes to the repo as ONE commit. Your token lives only in this browser.

   Add to an editor, just before </body>:
     <script src="publish.js"></script>
     <script>GHPublish.attach({ buttons: ["idOfTheDownloadButton"] });</script>
*/
(function () {
  "use strict";

  const DEFAULTS = { target: "github", owner: "", repo: "", branch: "", serverUrl: "" };   // blank branch = the repo's default
  const SKEY = "ghpublish.cemetery.settings.v1", TKEY = "ghpublish.cemetery.token.v1";

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- settings + token ---------- */
  // settings.json may carry a "publish" block: the destination everyone's editor uses unless this browser was told otherwise
  function siteDefault() {
    try {
      const p = (typeof S !== "undefined" && S && S.publish) || null; if (!p) return {};
      const o = {};
      if (p.target === "server" || p.target === "github") o.target = p.target;
      if (p.url) o.serverUrl = String(p.url);
      ["owner", "repo", "branch"].forEach(k => { if (p[k]) o[k] = String(p[k]); });
      return o;
    } catch (e) { return {}; }
  }
  function settings() {
    try { return Object.assign({}, DEFAULTS, siteDefault(), JSON.parse(localStorage.getItem(SKEY) || "{}")); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  const isServer = () => settings().target === "server";
  const targetName = () => isServer() ? "the county server" : "GitHub";
  const configured = () => { const s = settings(); return isServer() ? /^https?:\/\//.test(s.serverUrl) : !!(s.owner && s.repo); };
  function saveSettings(s) { try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch (e) {} }
  // the GitHub token and the server's publish key are kept apart, so switching back and forth loses neither
  const tkey = () => isServer() ? TKEY + ".server" : TKEY;
  function getToken() {
    try { return sessionStorage.getItem(tkey()) || localStorage.getItem(tkey()) || ""; } catch (e) { return ""; }
  }
  function setToken(t, remember) {
    try {
      sessionStorage.removeItem(tkey()); localStorage.removeItem(tkey());
      if (t) (remember ? localStorage : sessionStorage).setItem(tkey(), t);
    } catch (e) {}
  }

  /* ---------- county server (see the top of this file for what it must answer) ---------- */
  const encPath = p => String(p).split("/").map(encodeURIComponent).join("/");
  async function sv(path, method, body) {
    const s = settings(), t = getToken(), headers = {};
    if (t) headers.Authorization = "Bearer " + t;
    let res;
    try { res = await fetch(s.serverUrl.replace(/\/+$/, "") + path, { method: method || "GET", headers, body, cache: "no-store" }); }
    catch (e) { throw new Error("Couldn't reach the server at " + s.serverUrl + ". Check the address, and that it starts with https://"); }
    if (!res.ok && res.status !== 404) {
      let m = ""; try { m = (await res.json()).error || ""; } catch (e) {}
      const err = new Error(res.status + (m ? " " + m : "")); err.status = res.status; throw err;
    }
    return res;
  }

  /* ---------- GitHub API ---------- */
  async function api(path, method, body) {
    const s = settings(), t = getToken();
    const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (t) headers.Authorization = "Bearer " + t;
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch("https://api.github.com/repos/" + s.owner + "/" + s.repo + path, {
      method: method || "GET", headers, body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      let m = ""; try { m = (await res.json()).message || ""; } catch (e) {}
      const err = new Error(res.status + (m ? " " + m : "")); err.status = res.status; throw err;
    }
    return res.json();
  }
  let defaultBranchCache = "";
  async function branchName() {
    const s = settings();
    if (s.branch) return s.branch;
    if (!defaultBranchCache) defaultBranchCache = (await api("")).default_branch;
    return defaultBranchCache;
  }

  // The branch tip as of when this editor page opened, so we can tell if someone else changed files since
  let baseSha = null;
  const baseReady = (async () => {
    if (isServer() || !configured()) return;
    try { baseSha = (await api("/git/ref/heads/" + await branchName())).object.sha; } catch (e) {}
  })();

  const toB64 = blob => new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] || "");
    r.onerror = () => no(r.error);
    r.readAsDataURL(blob);
  });

  async function findConflicts(files, headSha) {
    if (!baseSha || baseSha === headSha) return [];
    const out = [];
    for (const f of files) {
      const at = async sha => {
        try { return (await api("/contents/" + f.path.split("/").map(encodeURIComponent).join("/") + "?ref=" + sha)).sha; }
        catch (e) { if (e.status === 404) return null; throw e; }
      };
      const [a, b] = await Promise.all([at(baseSha), at(headSha)]);
      if (a !== b) out.push(f.path);
    }
    return out;
  }

  async function publish(files, message, say) {
    say = say || function () {};
    if (!getToken()) throw new Error("No token saved yet. Click the \u2699 button and add one.");
    if (isServer()) {     // one file at a time; the server keeps the copy it replaces
      for (let i = 0; i < files.length; i++) {
        say("Sending " + (i + 1) + " of " + files.length + ": " + files[i].path);
        const r = await sv("/files/" + encPath(files[i].path), "PUT", files[i].blob);
        if (!r.ok) throw new Error("The server has no publish address (" + r.status + "). Check the server address in the \u2699 settings.");
      }
      return { sha: "", server: true };
    }
    const branch = await branchName();
    say("Checking the repository\u2026");
    await baseReady;
    const head = (await api("/git/ref/heads/" + branch)).object.sha;

    const conflicts = await findConflicts(files, head);
    if (conflicts.length && !confirm(
      "These files changed in GitHub since you opened this editor:\n\n  " + conflicts.join("\n  ") +
      "\n\nPublishing will overwrite those changes. Overwrite anyway?")) {
      throw new Error("Cancelled. Reload this editor to pick up the newer files.");
    }

    const base = (await api("/git/commits/" + head)).tree.sha;
    const tree = [];
    for (let i = 0; i < files.length; i++) {
      say("Uploading " + (i + 1) + " of " + files.length + ": " + files[i].path);
      const b = await api("/git/blobs", "POST", { content: await toB64(files[i].blob), encoding: "base64" });
      tree.push({ path: files[i].path, mode: "100644", type: "blob", sha: b.sha });
    }
    if (WS()) { say("Updating the event\u2019s file list\u2026"); tree.push(await eventInfoUpdate(base, files)); }
    say("Saving\u2026");
    const newTree = await api("/git/trees", "POST", { base_tree: base, tree });
    const commit = await api("/git/commits", "POST", { message, tree: newTree.sha, parents: [head] });
    await api("/git/refs/heads/" + branch, "PATCH", { sha: commit.sha });   // refused if someone committed meanwhile
    baseSha = commit.sha;
    return commit;
  }

  /* ---------- catching the editor's downloads ---------- */
  let armed = null;
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (armed && this.hasAttribute("download") && this.href) {
      const name = this.getAttribute("download");
      armed.push(fetch(this.href).then(r => r.blob()).then(blob => ({ name, blob })));
      return;                                   // swallow: no real download while capturing
    }
    return origClick.apply(this, arguments);
  };
  async function capture(ids) {
    let list;
    armed = [];
    try {
      for (const id of ids) {
        const b = document.getElementById(id);
        if (b && !b.disabled) b.click();
        await sleep(150);
      }
      await sleep(500);
    } finally { list = armed; armed = null; }
    const got = (await Promise.all(list)).filter(Boolean), seen = {};
    got.forEach(f => seen[f.name] = f);         // same name twice: keep the last
    return Object.values(seen);
  }

  /* ---------- Design Event mode: everything goes into events/<name>/ ---------- */
  const WS = () => (window.Workspace && Workspace.current && Workspace.current()) ? { slug: Workspace.current(), dir: "events/" + Workspace.current() + "/" } : null;
  const prefixPath = pth => { const w = WS(); if (!w) return pth; pth = String(pth || "").replace(/^\/+/, ""); return pth.startsWith(w.dir) ? pth : w.dir + pth; };
  const DATA_FILES = ["site.csv","locations.csv","childmarkers.csv","categories.csv","spots.csv","tours.csv","tourstops.csv","stamps.csv","tasks.csv","photos.csv","shapes.csv","overlays.json","border.geojson"];
  // keep the event's event.json in step: which data files and photo folders it really holds (the map reads only what is listed)
  async function eventInfoUpdate(baseTree, chosen) {
    const w = WS(), path = w.dir + "event.json";
    const entries = (await api("/git/trees/" + baseTree + "?recursive=1")).tree.filter(x => x.type === "blob");
    const have = new Set(entries.map(x => x.path));
    chosen.forEach(f => have.add(f.path));
    let info = {};
    const old = entries.find(x => x.path === path);
    if (old) { try { const b = await api("/git/blobs/" + old.sha); info = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b.content.replace(/\s/g, "")), c => c.charCodeAt(0)))); } catch (e) { info = {}; } }
    info.data = DATA_FILES.filter(f => have.has(w.dir + f));
    info.folders = ["photos", "spots", "stories", "anims"].filter(f => [...have].some(q => q.startsWith(w.dir + f + "/")));
    info.files = [...have].filter(q => q.startsWith(w.dir) && q !== path).length;
    info.updated = new Date().toISOString();
    if (!info.name) info.name = w.slug;
    const b = await api("/git/blobs", "POST", { content: JSON.stringify(info, null, 2), encoding: "utf-8" });
    return { path, mode: "100644", type: "blob", sha: b.sha };
  }

  function defaultRoute(name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return "photos/" + name;
    if (["mp4", "webm", "mov"].includes(ext)) return "anims/" + name;
    return name;                                // csv, json, geojson: top folder
  }

  /* ---------- dialogs ---------- */
  const CSS = `
.ghp-ov{position:fixed;inset:0;z-index:2147483000;background:#0008;display:flex;align-items:center;justify-content:center;padding:14px;font:14px system-ui,-apple-system,Segoe UI,Arial,sans-serif}
.ghp-card{background:#fff;color:#1a202c;border-radius:10px;max-width:640px;width:100%;max-height:92vh;overflow:auto;padding:16px 18px;box-shadow:0 10px 40px #0007}
.ghp-card h3{margin:0 0 4px;font-size:17px}
.ghp-card .sub{color:#6b7280;font-size:12px;margin-bottom:10px}
.ghp-card label{display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin:10px 0 3px}
.ghp-card input[type=text],.ghp-card input[type=password]{width:100%;padding:7px 9px;border:1px solid #cbd2d9;border-radius:6px;font:inherit}
.ghp-card button{font:inherit;padding:7px 12px;border:1px solid #cbd2d9;background:#fff;border-radius:6px;cursor:pointer}
.ghp-card button.go{background:#238636;border-color:#238636;color:#fff;font-weight:600}
.ghp-card button:disabled{opacity:.45;cursor:not-allowed}
.ghp-row{display:flex;gap:8px;align-items:center;margin:4px 0}
.ghp-row input[type=text]{flex:1}
.ghp-row .sz{font-size:11px;color:#6b7280;white-space:nowrap}
.ghp-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap}
.ghp-msg{margin-top:10px;font-size:13px;line-height:1.5}
.ghp-msg.err{color:#a33}.ghp-msg.ok{color:#1a7f37}
.ghp-warn{font-size:12px;color:#8a5a00;margin:2px 0 4px 24px}
.ghp-card ol{margin:6px 0 0 18px;padding:0;font-size:13px;line-height:1.5}
`;
  function ensureCss() {
    if (document.getElementById("ghp-css")) return;
    const st = document.createElement("style"); st.id = "ghp-css"; st.textContent = CSS; document.head.appendChild(st);
  }
  function overlay(html) {
    ensureCss();
    const ov = document.createElement("div");
    ov.className = "ghp-ov";
    ov.innerHTML = '<div class="ghp-card">' + html + "</div>";
    document.body.appendChild(ov);
    ov.addEventListener("mousedown", e => { if (e.target === ov) ov.remove(); });
    return ov;
  }

  function settingsDialog(onSaved) {
    const s = settings();
    const canShare = typeof S !== "undefined" && S && typeof touch === "function";
    const ov = overlay(`
      <h3>Publish settings</h3>
      <div class="sub">Where the Publish button sends the map's files. The token or key is saved in this browser only; never put it in any page's code.</div>
      <label>Publish to</label>
      <div class="ghp-row" style="gap:16px"><label style="text-transform:none;letter-spacing:0;font-weight:normal;margin:0;display:flex;gap:6px;align-items:center;font-size:14px;color:inherit;white-space:nowrap"><input type="radio" name="ghp-tg" value="github" ${s.target === "server" ? "" : "checked"}> GitHub</label>
        <label style="text-transform:none;letter-spacing:0;font-weight:normal;margin:0;display:flex;gap:6px;align-items:center;font-size:14px;color:inherit;white-space:nowrap"><input type="radio" name="ghp-tg" value="server" ${s.target === "server" ? "checked" : ""}> A county server</label></div>
      <div id="ghp-sv">
        <label>Server address</label><input type="text" id="ghp-u" value="${esc(s.serverUrl)}" placeholder="https://cemeteries.example.gov">
        <label>Publish key <span id="ghp-skh"></span></label><input type="password" id="ghp-k" autocomplete="off">
        <div class="sub" style="margin-top:10px">The county's IT staff give you the address and the key. The server keeps a dated copy of every file it replaces.</div>
      </div>
      <div id="ghp-gh">
      <div class="ghp-row"><div style="flex:1"><label>Owner</label><input type="text" id="ghp-o" value="${esc(s.owner)}"></div>
        <div style="flex:1"><label>Repository</label><input type="text" id="ghp-r" value="${esc(s.repo)}"></div>
        <div style="flex:1"><label>Branch (blank = default)</label><input type="text" id="ghp-b" value="${esc(s.branch)}"></div></div>
      <label>Access token <span id="ghp-gth"></span></label>
      <input type="password" id="ghp-t" placeholder="github_pat_\u2026" autocomplete="off">
      <div class="sub" style="margin-top:10px">Make a token at github.com \u2192 Settings \u2192 Developer settings \u2192 Fine-grained tokens:
        <ol><li>Repository access: <b>Only select repositories</b> \u2192 the repository that holds this map</li>
        <li>Permissions \u2192 Repository \u2192 <b>Contents: Read and write</b></li>
        <li>Pick an expiry date, create it, copy it here</li></ol></div>
      </div>
      <label style="text-transform:none;letter-spacing:0;font-weight:normal;display:flex;gap:6px;align-items:center;margin-top:8px">
        <input type="checkbox" id="ghp-rem"> Remember the token or key on this device (otherwise it is forgotten when you close the tab)</label>
      ${canShare ? `<label style="text-transform:none;letter-spacing:0;font-weight:normal;display:flex;gap:6px;align-items:center;margin-top:8px">
        <input type="checkbox" id="ghp-all"> Make this the destination for everyone who uses this editor (written to settings.json at the next Publish; the token or key is never included)</label>` : ""}
      <div class="ghp-msg" id="ghp-m"></div>
      <div class="ghp-btns">
        <button id="ghp-forget">Forget token or key</button><button id="ghp-test">Test</button>
        <button id="ghp-x">Close</button><button class="go" id="ghp-save">Save</button></div>`);
    const $ = id => ov.querySelector("#" + id), msg = (t, c) => { $("ghp-m").className = "ghp-msg " + (c || ""); $("ghp-m").textContent = t; };
    const tg = () => ov.querySelector("input[name=ghp-tg]:checked").value;
    const show = () => {
      const sv2 = tg() === "server"; $("ghp-sv").hidden = !sv2; $("ghp-gh").hidden = sv2;
      let has = false; try { const k = sv2 ? TKEY + ".server" : TKEY; has = !!(sessionStorage.getItem(k) || localStorage.getItem(k)); } catch (e) {}
      $("ghp-skh").textContent = has && sv2 ? "(one is saved; leave blank to keep it)" : "";
      $("ghp-gth").textContent = has && !sv2 ? "(one is saved; leave blank to keep it)" : "";
    };
    ov.querySelectorAll("input[name=ghp-tg]").forEach(r => r.onchange = show); show();
    const store = () => {
      const n = { target: tg(), owner: $("ghp-o").value.trim(), repo: $("ghp-r").value.trim(), branch: $("ghp-b").value.trim(), serverUrl: $("ghp-u").value.trim().replace(/\/+$/, "") };
      saveSettings(n);
      defaultBranchCache = "";
      const t = (n.target === "server" ? $("ghp-k") : $("ghp-t")).value.trim();
      if (t) setToken(t, $("ghp-rem").checked);
      if ($("ghp-all") && $("ghp-all").checked) {
        S.publish = n.target === "server" ? { target: "server", url: n.serverUrl } : { target: "github", owner: n.owner, repo: n.repo, branch: n.branch };
        touch("settings");
      }
      document.dispatchEvent(new CustomEvent("publish-target", { detail: n.target }));
    };
    $("ghp-x").onclick = () => ov.remove();
    $("ghp-forget").onclick = () => { saveSettings(Object.assign(settings(), { target: tg() })); setToken("", false); show(); msg("Removed from this browser.", "ok"); };
    $("ghp-save").onclick = () => { store(); ov.remove(); if (onSaved && getToken()) onSaved(); };
    $("ghp-test").onclick = async () => {
      store(); msg("Testing\u2026");
      if (isServer()) {
        try {
          if (!configured()) return msg("Type the server address, starting with https://", "err");
          const r = await sv("/files");
          if (!r.ok) return msg("Something answered at that address, but it has no publish address (/files). Ask the county's IT staff to check the server.", "err");
          const j = await r.json();
          msg("Connected. This key can publish. The server holds " + (j.files || []).length + " files.", "ok");
        } catch (e) { msg(/^40[13]/.test(e.message) ? "The server refused that key." : "Could not connect: " + e.message, "err"); }
        return;
      }
      try {
        const r = await api("");
        msg(r.permissions && r.permissions.push
          ? "Connected to " + r.full_name + ". This token can publish."
          : "Connected to " + r.full_name + ", but this token cannot write. Check Contents: Read and write.", r.permissions && r.permissions.push ? "ok" : "err");
      } catch (e) { msg("Could not connect: " + e.message, "err"); }
    };
  }

  const fmtSize = n => n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB";

  function reviewDialog(initial, opts) {
    const route = opts.route || defaultRoute;
    const rows = initial.map(f => ({ name: f.name, blob: f.blob, path: prefixPath(route(f.name) || defaultRoute(f.name)), on: true }));
    const s = settings();
    const ov = overlay(`
      <h3>Publish to ${isServer() ? "the county server" : "GitHub"}</h3>
      <div class="sub">${isServer() ? esc(s.serverUrl) + " \u00b7 the server keeps a copy of each file it replaces" : esc(s.owner) + "/" + esc(s.repo) + " \u00b7 " + esc(s.branch || "default branch") + " \u00b7 one commit for everything below"}</div>
      ${WS() ? '<div class="ghp-msg" style="color:#d4351c;font-weight:600;margin:0 0 8px">Designing event: ' + esc(WS().slug) + '. These files go into ' + esc(WS().dir) + ' and the live map is not changed.</div>' : ""}
      <div id="ghp-list"></div>
      <div class="ghp-row" style="margin-top:8px"><button id="ghp-add">\uff0b Add files\u2026</button><input type="file" id="ghp-file" multiple hidden></div>
      <div ${isServer() ? "hidden" : ""}><label>Commit message</label><input type="text" id="ghp-msgin"></div>
      <div class="ghp-msg" id="ghp-m"></div>
      <div class="ghp-btns"><button id="ghp-cancel">Cancel</button><button class="go" id="ghp-go">Publish</button></div>`);
    const $ = id => ov.querySelector("#" + id), msg = (t, c) => { $("ghp-m").className = "ghp-msg " + (c || ""); $("ghp-m").textContent = t; };

    function draw() {
      $("ghp-list").innerHTML = rows.length ? "" : '<div class="sub">Nothing caught from the editor. Use \u201cAdd files\u2026\u201d to choose files.</div>';
      rows.forEach((r, i) => {
        const d = document.createElement("div");
        const warn = /^anims\/.*\.webm$/i.test(r.path) ? '<div class="ghp-warn">The map page looks for .mp4 animations. A .webm file will not play there unless it is converted to .mp4.</div>' : "";
        d.innerHTML = `<div class="ghp-row"><input type="checkbox" ${r.on ? "checked" : ""}><input type="text" value="${esc(r.path)}"><span class="sz">${fmtSize(r.blob.size)}</span></div>${warn}`;
        d.querySelector("input[type=checkbox]").onchange = e => { r.on = e.target.checked; upd(); };
        d.querySelector("input[type=text]").oninput = e => { r.path = e.target.value; };
        d.querySelector("input[type=text]").onchange = draw;
        $("ghp-list").appendChild(d);
      });
      upd();
    }
    function upd() {
      const n = rows.filter(r => r.on).length;
      $("ghp-go").textContent = "Publish " + n + " file" + (n === 1 ? "" : "s");
      $("ghp-go").disabled = !n;
      const names = rows.filter(r => r.on).slice(0, 3).map(r => r.path.split("/").pop()).join(", ");
      if (!$("ghp-msgin").dataset.edited) $("ghp-msgin").value = n ? (WS() ? "[" + WS().slug + "] " : "") + "Update " + names + (n > 3 ? " and " + (n - 3) + " more" : "") + " from the editor" : "";
    }
    $("ghp-msgin").oninput = e => { e.target.dataset.edited = "1"; };
    $("ghp-add").onclick = () => $("ghp-file").click();
    $("ghp-file").onchange = e => {
      [...e.target.files].forEach(f => rows.push({ name: f.name, blob: f, path: prefixPath(route(f.name) || defaultRoute(f.name)), on: true }));
      e.target.value = ""; draw();
    };
    $("ghp-cancel").onclick = () => ov.remove();

    $("ghp-go").onclick = async () => {
      const chosen = rows.filter(r => r.on).map(r => ({ path: prefixPath(r.path.trim().replace(/^\/+/, "")), blob: r.blob }));
      const bad = chosen.find(f => !f.path || f.path.split("/").includes("..") || f.path.endsWith("/"));
      if (bad) return msg("That path isn't valid: \u201c" + bad.path + "\u201d", "err");
      if (new Set(chosen.map(f => f.path)).size !== chosen.length) return msg("Two files have the same destination.", "err");
      $("ghp-go").disabled = true; $("ghp-cancel").disabled = true; $("ghp-add").disabled = true;
      try {
        const c = await publish(chosen, $("ghp-msgin").value.trim() || "Update from the editor", t => msg(t));
        const s2 = settings();
        $("ghp-m").className = "ghp-msg ok";
        $("ghp-m").innerHTML = "\u2714 Published " + chosen.length + " file" + (chosen.length === 1 ? "" : "s") + (c.server ? ".<br>The map shows the changes right away." :
          '. <a href="https://github.com/' + esc(s2.owner) + "/" + esc(s2.repo) + "/commit/" + c.sha + '" target="_blank" rel="noopener">View commit</a>' +
          (WS() ? '<br>Saved into the event. The live map is unchanged. <a href="' + esc(new URL(((window.ETS_CONFIG&&window.ETS_CONFIG.LIVE_PAGE)||"Demo2a.html") + "?event=" + WS().slug, location.href).href) + '" target="_blank" rel="noopener">Preview the event</a> (it can take a minute to appear).' : "<br>The live site updates in about a minute."));
        $("ghp-cancel").textContent = "Close"; $("ghp-cancel").disabled = false;
        if (opts.onPublished) { try { opts.onPublished(chosen); } catch (e) {} }
      } catch (e) {
        msg(/^Cancelled/.test(e.message) ? e.message : /401|403/.test(e.message) ? (isServer() ? "The server refused the publish key (" : "GitHub refused the token (") + e.message + "). Check the \u2699 settings." : "Failed: " + e.message, "err");
        $("ghp-go").disabled = false; $("ghp-cancel").disabled = false; $("ghp-add").disabled = false;
      }
    };
    draw();
  }

  /* ---------- public: add the buttons to an editor ---------- */
  function attach(opts) {
    opts = opts || {};
    const ids = opts.buttons || [];
    const anchor = ids.length ? document.getElementById(ids[0]) : null;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = opts.label || "Publish to GitHub";
    btn.className = anchor ? anchor.className.replace(/\bprimary\b/, "").trim() : "";
    btn.style.cssText = "background:#238636;border-color:#238636;color:#fff;margin-left:6px;cursor:pointer";
    const gear = document.createElement("button");
    gear.type = "button"; gear.textContent = "\u2699"; gear.title = "Publish settings";
    gear.className = btn.className; gear.style.cssText = "margin-left:4px;cursor:pointer";
    if (anchor) { anchor.after(btn); btn.after(gear); }
    else (document.getElementById(opts.into) || document.body).append(btn, gear);

    gear.onclick = () => settingsDialog();
    btn.onclick = async () => {
      if (!getToken() || !configured()) { settingsDialog(() => btn.click()); return; }
      btn.disabled = true;
      try {
        if (opts.prepare) {   // e.g. merge other people's changes first
          try { await opts.prepare(); }
          catch (e) { alert("Couldn't check " + targetName() + " for newer changes, so nothing was published.\n\n" + e.message); return; }
        }
        reviewDialog(ids.length ? await capture(ids) : [], opts);
      } finally { btn.disabled = false; }
    };
  }

  async function listFiles() {              // every file path at the publish destination
    if (isServer()) { const r = await sv("/files"); if (!r.ok) throw new Error("The server has no file list (/files)."); return (await r.json()).files || []; }
    const head = (await api("/git/ref/heads/" + await branchName())).object.sha;
    const base = (await api("/git/commits/" + head)).tree.sha;
    return (await api("/git/trees/" + base + "?recursive=1")).tree.filter(x => x.type === "blob").map(x => x.path);
  }

  async function rebase() { if (isServer()) return ""; baseSha = (await api("/git/ref/heads/" + await branchName())).object.sha; return baseSha; }
  async function readText(path, ref) {   // latest text of one published file, or null if it doesn't exist
    if (isServer()) { const r = await sv("/files/" + encPath(path)); return r.ok ? r.text() : null; }
    const s = settings(), res = await fetch("https://api.github.com/repos/" + s.owner + "/" + s.repo + "/contents/" +
      path.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(ref || await branchName()),
      { cache: "no-store", headers: { Accept: "application/vnd.github.raw+json", Authorization: "Bearer " + getToken() } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("GitHub answered " + res.status);
    return res.text();
  }

  async function readBlob(path) {        // one published file as it is (photos too), or null
    if (isServer()) { const r = await sv("/files/" + encPath(path)); return r.ok ? r.blob() : null; }
    const s = settings(), res = await fetch("https://api.github.com/repos/" + s.owner + "/" + s.repo + "/contents/" + encPath(path) + "?ref=" + encodeURIComponent(await branchName()),
      { cache: "no-store", headers: { Accept: "application/vnd.github.raw+json", Authorization: "Bearer " + getToken() } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("GitHub answered " + res.status);
    return res.blob();
  }

  window.GHPublish = { attach, publish, settingsDialog, listFiles, settings, rebase, read: readText, readBlob, isServer, configured, hasKey: () => !!getToken(), targetName };
})();
