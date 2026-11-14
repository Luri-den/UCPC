/* stories.js - "Stories and memories" on the grave and cemetery cards, and the "Share a story" form.
   Loaded by test3.html after its own script. It does not change the map; it only adds to the cards.

   - Approved stories come from stories.csv (or settings.json files.stories). Columns:
       STORY_ID, TARGET_TYPE (marker | cemetery), TARGET_ID, CEMETERY_ID, PERSON, TEXT, QUOTE, TOLD_BY, CONNECTION,
       DATE_TOLD, TAG (Family account | Personal memory | Documented), SOURCE, PHOTO
     The editor writes this file when the lead approves a story. A missing file just means no stories yet.
   - Shared stories go to the county inbox (settings.json "inbox") and wait there for the lead.
   - test3.html tells this file what a card shows by setting infoContent.dataset.storyFor just before it draws the card. */
(function () {
  "use strict";
  if (typeof infoContent === "undefined") return;
  const SETTINGS = (typeof SET !== "undefined" && SET) || {};
  const AREA = String(SETTINGS.idPrefix || SETTINGS.shortName || "").toUpperCase();
  const INBOX = String(SETTINGS.inbox || "").replace(/\/+$/, "");
  const FILE = (SETTINGS.files && SETTINGS.files.stories) || "stories.csv";
  const H = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const key = s => String(s == null ? "" : s).trim().toLowerCase();

  /* ---------- styles ---------- */
  const css = document.createElement("style");
  css.textContent = `
  .st-sec{margin:14px 0 6px;padding-top:10px;border-top:1px solid #d8d2c6}
  .st-sec h3{margin:0 0 8px}
  .st-quote{font:italic 1.15em/1.45 Georgia,"Times New Roman",serif;margin:4px 0 12px;padding-left:12px;border-left:3px solid var(--accent,#01796F)}
  .st-item{margin:0 0 12px}
  .st-item p{margin:0 0 4px;white-space:pre-wrap}
  .st-meta{font-size:.85em;color:#5f574c}
  .st-tag{display:inline-block;font-size:.75em;padding:1px 8px;border-radius:999px;background:#eee7da;color:#5f574c;margin-left:4px}
  .st-item img{max-width:100%;border-radius:8px;margin:4px 0}
  .st-share{min-height:44px;padding:8px 14px;border-radius:8px;border:1px solid var(--accent,#01796F);background:#fff;color:var(--accent,#01796F);font:inherit;font-weight:600;cursor:pointer}
  .stm{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center}
  .stm[hidden]{display:none}
  .stm .box{background:#fff;color:#1f1b16;width:100%;max-width:560px;max-height:92vh;overflow:auto;border-radius:14px 14px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom))}
  @media(min-width:700px){.stm{align-items:center}.stm .box{border-radius:14px}}
  .stm h2{margin:0 0 4px;font-size:1.2em}
  .stm label{display:block;font-weight:600;margin:12px 0 4px}
  .stm input[type=text],.stm input[type=email],.stm textarea,.stm select{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #b9b1a3;border-radius:8px}
  .stm textarea{min-height:140px;resize:vertical}
  .stm .hint{font-size:.85em;color:#5f574c;font-weight:400;margin:2px 0 0}
  .stm .chk{display:flex;gap:8px;align-items:flex-start;font-weight:400;margin-top:14px}
  .stm .chk input{margin-top:4px;width:20px;height:20px;flex:none}
  .stm .row{display:flex;gap:8px;margin-top:16px}
  .stm .box,.stm .box *{text-shadow:none}
  .stm input,.stm textarea,.stm select{color:#1f1b16!important;background:#fff!important}
  .stm .row button{flex:1;min-height:48px;border-radius:10px;font:inherit;font-weight:600;cursor:pointer;border:1px solid #8a8174!important;background:#fff!important;color:#1f1b16!important;box-shadow:none!important;text-transform:none;letter-spacing:normal}
  .stm .row button.go{background:var(--accent,#01796F)!important;border-color:var(--accent,#01796F)!important;color:#fff!important}
  .stm .row button:disabled{opacity:.55}
  #lead-badge[hidden]{display:none!important}
  .stm .ok{color:#1d6b3a}.stm hr{border:0;border-top:1px solid #e5dfd3;margin:16px 0}
  .st-share{background:#fff!important;color:var(--accent,#01796F)!important;border:1px solid var(--accent,#01796F)!important}
  .stm .msg{margin-top:10px;font-size:.95em}
  .stm .msg.err{color:#9b1c1c}
  .stm .thumb{max-width:120px;border-radius:8px;display:block;margin-top:6px}`;
  document.head.append(css);

  /* ---------- signing in on the map: volunteers type their invite code, leads type the lead key ---------- */
  const store = { get: k => { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }, set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {} } };
  const inviteKey = "invite:" + AREA, leadKeyName = "leadKey:" + AREA;
  const invite = () => { try { return JSON.parse(store.get(inviteKey) || "null"); } catch (e) { return null; } };
  const nav = document.querySelector("#menu-panel .menu-links");
  const surveyLink = document.createElement("a"), editorLink = document.createElement("a"), signLink = document.createElement("a");
  surveyLink.href = "survey.html"; editorLink.href = "editor.html"; signLink.href = "#";
  signLink.addEventListener("click", function (e) { e.preventDefault(); openSignIn(); });
  function menu() {
    if (!nav) return;
    const inv = invite(), lead = store.get(leadKeyName);
    surveyLink.textContent = inv ? "Survey (signed in" + (inv.name ? " as " + inv.name : "") + ")" : "Help Survey (Volunteers)";
    editorLink.textContent = "Review New Additions (Editor)"; editorLink.style.display = lead ? "" : "none";
    signLink.textContent = inv || lead ? "Volunteer & Lead Sign-In (signed in)" : "Volunteer & Lead Sign-In";
    [surveyLink, editorLink, signLink].forEach(a => { if (!a.parentNode) nav.append(a); });
  }
  if (INBOX && AREA) menu();

  /* the lead's red badge: only in a browser where the lead key is saved */
  const badge = document.createElement("a");
  badge.href = "editor.html"; badge.id = "lead-badge"; badge.hidden = true;
  badge.style.cssText = "position:fixed;z-index:9998;left:10px;top:calc(70px + env(safe-area-inset-top));background:#c62828;color:#fff;padding:8px 12px;border-radius:999px;font:600 14px system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.3)";
  badge.title = "Only you see this, because your lead key is saved in this browser.";
  document.body.append(badge);
  function checkBadge() {
    const key = store.get(leadKeyName); if (!key || !INBOX || !AREA) { badge.hidden = true; return; }
    fetch(INBOX + "/" + AREA + "/count", { headers: { "X-Lead-Key": key } }).then(r => r.ok ? r.json() : null).then(j => {
      if (!j || !j.ok) { badge.hidden = true; return; }
      badge.textContent = "\u25CF " + j.total + " new for review"; badge.hidden = !j.total;
    }).catch(() => {});
  }
  checkBadge(); setInterval(() => { if (!document.hidden) checkBadge(); }, 300000);

  const si = document.createElement("div");
  si.id = "si-modal"; si.className = "stm"; si.hidden = true; si.setAttribute("role", "dialog"); si.setAttribute("aria-modal", "true"); si.setAttribute("aria-labelledby", "si-title");
  si.innerHTML = `<div class="box"><h2 id="si-title">Volunteer & Lead Sign-In</h2>
    <p class="hint">For people helping record the cemeteries. Visitors don't need to sign in.</p>
    <div id="si-vol"></div><hr><div id="si-lead"></div>
    <div class="row"><button type="button" id="si-close">Close</button></div></div>`;
  document.body.append(si);
  si.addEventListener("click", e => { if (e.target === si) si.hidden = true; });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !si.hidden) si.hidden = true; });
  si.querySelector("#si-close").addEventListener("click", () => { si.hidden = true; });
  function section(box, html) { box.innerHTML = html; return id => box.querySelector("#" + id); }
  function drawSignIn() {
    const inv = invite(), lead = store.get(leadKeyName);
    const v = section(si.querySelector("#si-vol"), inv
      ? '<h3>Surveyor</h3><p class="ok">Signed in' + (inv.name ? " as " + H(inv.name) : "") + ' on this device.</p><div class="row"><button type="button" class="go" id="si-go">Open the survey</button><button type="button" id="si-out">Sign out</button></div>'
      : '<h3>Surveyor</h3><label for="si-code">Invite code</label><input type="text" id="si-code" autocomplete="off" autocapitalize="characters" placeholder="K7Q2-M9XD"><p class="hint">It\'s in the invite link your county lead sent you (after invite=).</p><div class="row"><button type="button" class="go" id="si-in">Sign in</button></div><div class="msg" id="si-vmsg" role="status"></div>');
    if (inv) { v("si-go").onclick = () => { location.href = "survey.html"; }; v("si-out").onclick = () => { if (confirm("Sign out of surveying on this device? Surveys not yet sent stay saved on it.")) { store.set(inviteKey, ""); drawSignIn(); menu(); } }; }
    else v("si-in").onclick = async () => {
      const code = v("si-code").value.trim().toUpperCase().replace(/^.*INVITE=/, ""), m = v("si-vmsg");
      if (!code) { m.textContent = "Type your invite code."; m.className = "msg err"; return; }
      m.textContent = "Checking…"; m.className = "msg";
      try { const r = await fetch(INBOX + "/" + AREA + "/check", { headers: { "X-Invite": code } }), j = await r.json();
        if (!j.ok) { m.textContent = j.error || "That code didn't work."; m.className = "msg err"; return; }
        store.set(inviteKey, JSON.stringify({ code, name: j.name })); drawSignIn(); menu();
      } catch (e) { m.textContent = "Couldn't reach the inbox. Check your connection."; m.className = "msg err"; }
    };
    const l = section(si.querySelector("#si-lead"), lead
      ? '<h3>County lead</h3><p class="ok">Lead key saved on this device. New additions show as a red badge on the map.</p><div class="row"><button type="button" class="go" id="si-ed">Open the editor</button><button type="button" id="si-lout">Sign out</button></div>'
      : '<h3>County lead</h3><label for="si-key">Lead key</label><input type="password" id="si-key" autocomplete="off"><div class="row"><button type="button" class="go" id="si-lin">Sign in</button></div><div class="msg" id="si-lmsg" role="status"></div>');
    if (lead) { l("si-ed").onclick = () => { location.href = "editor.html"; }; l("si-lout").onclick = () => { store.set(leadKeyName, ""); drawSignIn(); menu(); checkBadge(); }; }
    else l("si-lin").onclick = async () => {
      const key = l("si-key").value.trim(), m = l("si-lmsg");
      if (!key) { m.textContent = "Type the lead key."; m.className = "msg err"; return; }
      m.textContent = "Checking…"; m.className = "msg";
      try { const r = await fetch(INBOX + "/" + AREA + "/count", { headers: { "X-Lead-Key": key } });
        if (r.status === 403) { m.textContent = "That lead key isn't right."; m.className = "msg err"; return; }
        const j = await r.json(); if (!j.ok) { m.textContent = j.error || "That didn't work."; m.className = "msg err"; return; }
        store.set(leadKeyName, key); drawSignIn(); menu(); checkBadge();
      } catch (e) { m.textContent = "Couldn't reach the inbox. Check your connection."; m.className = "msg err"; }
    };
  }
  function openSignIn() { drawSignIn(); si.hidden = false; const f = si.querySelector("input"); if (f) f.focus(); }

  /* ---------- approved stories ---------- */
  let STORIES = [];
  function parseCsv(text) {
    if (window.Papa) return Papa.parse(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy" }).data;
    return [];
  }
  const ready = fetch(new URL(FILE, document.baseURI).href, { cache: "no-cache" })
    .then(r => r.ok ? r.text() : "").then(t => { STORIES = t ? parseCsv(t) : []; }).catch(() => { STORIES = []; });

  function storiesFor(t) {
    return STORIES.filter(s => key(s.TARGET_TYPE) === key(t.type) && key(s.TARGET_ID) === key(t.id) && String(s.TEXT || "").trim());
  }
  function sectionHtml(t, list) {
    const featured = list.find(s => String(s.QUOTE || "").trim());
    let h = '<div class="st-sec" data-st="1"><h3>Stories and memories' + (list.length ? " (" + list.length + ")" : "") + "</h3>";
    if (featured) h += '<blockquote class="st-quote">“' + H(featured.QUOTE) + "”</blockquote>";
    list.forEach(s => {
      const who = [s.TOLD_BY, s.CONNECTION].filter(x => String(x || "").trim()).join(", ");
      h += '<div class="st-item">' + (s.PERSON && t.type === "marker" ? '<div class="st-meta"><b>About ' + H(s.PERSON) + "</b></div>" : "") +
        "<p>" + H(s.TEXT) + "</p>" +
        (s.PHOTO ? '<img src="' + H(s.PHOTO) + '" alt="Photo shared with this story" loading="lazy">' : "") +
        '<div class="st-meta">' + (who ? "Shared by " + H(who) : "Shared anonymously") + (s.DATE_TOLD ? " · " + H(s.DATE_TOLD) : "") +
        (s.TAG ? '<span class="st-tag">' + H(s.TAG) + "</span>" : "") + (s.SOURCE ? "<br>Source: " + H(s.SOURCE) : "") + "</div></div>";
    });
    if (!list.length) h += '<p class="st-meta">No stories yet. Do you know something about ' + (t.type === "cemetery" ? "this place" : "this person") + "?</p>";
    if (INBOX && AREA) h += '<button type="button" class="st-share">Share a story or memory</button>';
    return h + "</div>";
  }

  /* add the section whenever a card that asked for it is drawn */
  let adding = false, lastTarget = null;
  new MutationObserver(function () {
    if (adding) return;
    const raw = infoContent.dataset.storyFor;
    if (!raw) { lastTarget = null; return; }
    delete infoContent.dataset.storyFor;                 // one card, one section
    let t; try { t = JSON.parse(raw); } catch (e) { return; }
    if (!t || !t.id) return;
    lastTarget = t;
    ready.then(function () {
      if (lastTarget !== t || infoContent.querySelector('[data-st="1"]')) return;
      adding = true;
      infoContent.insertAdjacentHTML("beforeend", sectionHtml(t, storiesFor(t)));
      const b = infoContent.querySelector(".st-share"); if (b) b.addEventListener("click", function () { openForm(t); });
      setTimeout(function () { adding = false; }, 0);
    });
  }).observe(infoContent, { childList: true });

  /* ---------- the Share a Story form ---------- */
  const modal = document.createElement("div");
  modal.id = "st-modal"; modal.className = "stm"; modal.hidden = true; modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-labelledby", "st-title");
  modal.innerHTML = `<div class="box">
    <h2 id="st-title">Share a story or memory</h2><p class="hint" id="st-about"></p>
    <label for="st-text">Your story, memory or information <span aria-hidden="true">*</span></label>
    <textarea id="st-text" maxlength="8000" placeholder="She kept bees behind the house on the old Liberty road..."></textarea>
    <label for="st-type">What kind is it?</label>
    <select id="st-type"><option>Family story</option><option>Personal memory</option><option>Documented (from a record or newspaper)</option></select>
    <div id="st-srcwrap" hidden><label for="st-src">Where is it from?</label><input type="text" id="st-src" maxlength="300" placeholder="Liberty Herald, June 3, 1901"></div>
    <label for="st-name">Your name</label><input type="text" id="st-name" maxlength="120" autocomplete="name"><p class="hint">Shown with the story. Leave blank to share anonymously.</p>
    <label for="st-conn">Your connection</label><input type="text" id="st-conn" maxlength="120" placeholder="Great-granddaughter, neighbor, historian…">
    <label for="st-teller">Who told it, if not you</label><input type="text" id="st-teller" maxlength="120">
    <label for="st-photo">A photo (optional)</label><input type="file" id="st-photo" accept="image/*"><img id="st-thumb" class="thumb" alt="" hidden>
    <label for="st-contact">Email or phone (optional)</label><input type="text" id="st-contact" maxlength="160" autocomplete="email"><p class="hint">Only the county's reviewer sees this, in case they have a question. It is never shown.</p>
    <label class="chk"><input type="checkbox" id="st-consent"><span>I have the right to share this, including permission from anyone recorded or quoted, and I agree it may be shown on this site and kept in the county archive.</span></label>
    <p class="hint">A volunteer reviews every story before it appears. Stories about living people, or with private details, may be kept in the archive without being shown.</p>
    <div class="row"><button type="button" id="st-cancel">Cancel</button><button type="button" class="go" id="st-send">Send</button></div>
    <div class="msg" id="st-msg" role="status" aria-live="polite"></div></div>`;
  document.body.append(modal);
  const $ = id => document.getElementById(id);
  let target = null, photoData = null, lastFocus = null;

  $("st-type").addEventListener("change", function () { $("st-srcwrap").hidden = !/^Documented/.test(this.value); });
  $("st-cancel").addEventListener("click", closeForm);
  modal.addEventListener("click", function (e) { if (e.target === modal) closeForm(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !modal.hidden) closeForm(); });
  $("st-photo").addEventListener("change", async function () {
    const f = this.files && this.files[0]; photoData = null; $("st-thumb").hidden = true;
    if (!f) return;
    try { photoData = await shrink(f, 1600); $("st-thumb").src = photoData; $("st-thumb").hidden = false; } catch (e) { say(e.message, true); }
  });

  function shrink(file, max) {
    return new Promise(function (ok, bad) {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        let q = 0.82, out = c.toDataURL("image/jpeg", q); while (out.length > 1800000 && q > 0.4) { q -= 0.12; out = c.toDataURL("image/jpeg", q); }
        ok(out);
      };
      img.onerror = function () { URL.revokeObjectURL(url); bad(new Error("That photo couldn't be read.")); };
      img.src = url;
    });
  }
  function say(t, err) { const m = $("st-msg"); m.textContent = t; m.className = "msg" + (err ? " err" : ""); }
  function draftKey() { return "story-draft:" + AREA + ":" + (target ? target.type + ":" + target.id : ""); }
  function openForm(t) {
    target = t; lastFocus = document.activeElement; photoData = null;
    $("st-about").textContent = "About: " + (t.label || t.id);
    let d = {}; try { d = JSON.parse(localStorage.getItem(draftKey()) || "{}"); } catch (e) {}
    $("st-text").value = d.text || ""; $("st-name").value = d.name || ""; $("st-conn").value = d.connection || ""; $("st-teller").value = d.teller || "";
    $("st-contact").value = d.contact || ""; $("st-src").value = d.source || ""; $("st-consent").checked = false; $("st-photo").value = ""; $("st-thumb").hidden = true;
    $("st-type").value = d.type || "Family story"; $("st-srcwrap").hidden = !/^Documented/.test($("st-type").value);
    $("st-send").disabled = false; say("");
    modal.hidden = false; $("st-text").focus();
  }
  function closeForm() { saveDraft(); modal.hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  function fields() { return { text: $("st-text").value.trim(), type: $("st-type").value, source: $("st-src").value.trim(), name: $("st-name").value.trim(), connection: $("st-conn").value.trim(), teller: $("st-teller").value.trim(), contact: $("st-contact").value.trim() }; }
  function saveDraft() { try { const f = fields(); if (f.text) localStorage.setItem(draftKey(), JSON.stringify(f)); } catch (e) {} }
  ["st-text", "st-name", "st-conn", "st-teller", "st-contact", "st-src"].forEach(id => $(id).addEventListener("input", saveDraft));

  $("st-send").addEventListener("click", async function () {
    const f = fields();
    if (!f.text) { say("Please write the story or memory first.", true); $("st-text").focus(); return; }
    if (!$("st-consent").checked) { say("Please tick the permission box.", true); $("st-consent").focus(); return; }
    if (!navigator.onLine) { saveDraft(); say("You're offline. Your story is saved on this device. Open this form again when you have signal and press Send.", true); return; }
    const id = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
    const media = [], data = Object.assign({}, f, { consent: true, cemetery: target.cemetery || (target.type === "cemetery" ? target.id : ""), person: target.person || "", label: target.label || "", page: location.href.split("?")[0] });
    if (photoData) { const m = /^data:([^;]+);base64,(.*)$/.exec(photoData); if (m) { media.push({ mime: m[1], data: m[2] }); data.photo = "media:0"; } }
    $("st-send").disabled = true; say("Sending…");
    try {
      const r = await fetch(INBOX + "/" + AREA + "/story", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, kind: "story", target: { type: target.type, id: target.id }, data, media, created: new Date().toISOString(), submitter: f.name }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) { try { localStorage.removeItem(draftKey()); } catch (e) {} say("Thank you! A volunteer will review your story before it appears."); setTimeout(function () { modal.hidden = true; }, 2600); }
      else { $("st-send").disabled = false; say(j.error || "The story couldn't be sent. Please try again.", true); }
    } catch (e) { $("st-send").disabled = false; saveDraft(); say("No connection to the inbox. Your story is saved on this device; try again in a moment.", true); }
  });
})();
