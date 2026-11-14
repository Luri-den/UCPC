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
  #st-modal{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center}
  #st-modal[hidden]{display:none}
  #st-modal .box{background:#fff;color:#1f1b16;width:100%;max-width:560px;max-height:92vh;overflow:auto;border-radius:14px 14px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom))}
  @media(min-width:700px){#st-modal{align-items:center}#st-modal .box{border-radius:14px}}
  #st-modal h2{margin:0 0 4px;font-size:1.2em}
  #st-modal label{display:block;font-weight:600;margin:12px 0 4px}
  #st-modal input[type=text],#st-modal input[type=email],#st-modal textarea,#st-modal select{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #b9b1a3;border-radius:8px}
  #st-modal textarea{min-height:140px;resize:vertical}
  #st-modal .hint{font-size:.85em;color:#5f574c;font-weight:400;margin:2px 0 0}
  #st-modal .chk{display:flex;gap:8px;align-items:flex-start;font-weight:400;margin-top:14px}
  #st-modal .chk input{margin-top:4px;width:20px;height:20px;flex:none}
  #st-modal .row{display:flex;gap:8px;margin-top:16px}
  #st-modal .row button{flex:1;min-height:48px;border-radius:10px;font:inherit;font-weight:600;cursor:pointer;border:1px solid #b9b1a3;background:#fff}
  #st-modal .row button.go{background:var(--accent,#01796F);border-color:var(--accent,#01796F);color:#fff}
  #st-modal .msg{margin-top:10px;font-size:.95em}
  #st-modal .msg.err{color:#9b1c1c}
  #st-modal .thumb{max-width:120px;border-radius:8px;display:block;margin-top:6px}`;
  document.head.append(css);

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
  modal.id = "st-modal"; modal.hidden = true; modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-labelledby", "st-title");
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
