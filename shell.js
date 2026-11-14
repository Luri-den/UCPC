/* shell.js - reorganises the editor's frame without changing how any tool inside it works.
   Loaded last in editor.html (after publish.js has added its buttons), together with editor-theme.css.

   - Top bar: the map's name, one Publish button, and a File menu holding Open / New / Save.
   - Navigation by task: Review, Cemeteries, Graves, and a Setup menu (map and look, visitor guide, survey questions).
   - Long forms: the everyday fields stay open; rarely used ones fold into "More details", and each
     section (hazards, fence, photos, boundary, entrances) folds, remembering whether you left it open.
   Remove this script and the stylesheet and the editor goes back to its plain six-tab layout. */
(function () {
  "use strict";
  const top = document.querySelector(".top"), tabs = document.querySelector(".tabs");
  if (!top || !tabs || typeof tab !== "function") return;
  document.body.classList.add("ed");
  const mk = (t, props, kids) => { const e = document.createElement(t); Object.assign(e, props || {}); (kids || []).forEach(k => e.append(k)); return e; };

  /* ---------- menus ---------- */
  const menus = [];
  function menu(button, panel) {
    menus.push(panel);
    button.setAttribute("aria-haspopup", "true"); button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", e => { e.stopPropagation(); const open = !panel.classList.contains("open"); closeMenus(); panel.classList.toggle("open", open); button.setAttribute("aria-expanded", String(open)); if (open) { const f = panel.querySelector("button:not(:disabled):not([hidden])"); if (f) f.focus(); } });
    panel.addEventListener("click", e => { if (e.target.closest("button")) closeMenus(); });
    panel._btn = button;
  }
  function closeMenus() { menus.forEach(m => { m.classList.remove("open"); m._btn.setAttribute("aria-expanded", "false"); }); }
  document.addEventListener("click", closeMenus);
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenus(); });

  /* ---------- top bar ---------- */
  const msg = document.getElementById("msg");
  const nameEl = mk("span", { className: "name" });
  const brand = mk("div", { className: "ed-brand" }, [mk("span", { className: "dot" }), mk("b", { textContent: "Map Editor" }), nameEl]);
  const actions = mk("div", { className: "ed-actions" });
  const dl = document.getElementById("dlBtn");
  const publish = dl && dl.nextElementSibling && dl.nextElementSibling.tagName === "BUTTON" ? dl.nextElementSibling : null;   // added by publish.js
  const gear = publish && publish.nextElementSibling && publish.nextElementSibling.tagName === "BUTTON" ? publish.nextElementSibling : null;
  const fileBtn = mk("button", { type: "button", textContent: "File ▾" });
  const fileMenu = mk("div", { className: "ed-menu" });
  [["open", "Open My Map Files", "Pick the map folder on this computer"], ["gopen", "Open From GitHub", "Load the published map"], ["new", "New County", "Start an empty map"], ["save", "Save to Folder", "Write changes to the open folder"], ["dlBtn", "Download", ""]].forEach(([id, label, sub]) => {
    const b = document.getElementById(id); if (!b) return;
    b.removeAttribute("style"); b.className = ""; b.textContent = label; if (sub) b.append(mk("small", { textContent: sub })); fileMenu.append(b);
  });
  if (publish) { publish.classList.add("ed-publish"); publish.textContent = "Publish"; publish.title = "Publish to GitHub"; actions.append(publish); }
  if (gear) { gear.classList.add("ed-gear"); gear.setAttribute("aria-label", "GitHub publish settings"); actions.append(gear); }
  actions.append(fileBtn, fileMenu); menu(fileBtn, fileMenu);
  top.prepend(brand, actions);
  if (msg) actions.after(msg);

  /* ---------- navigation ---------- */
  const btn = t => tabs.querySelector('button[data-t="' + t + '"]');
  const order = ["inb", "cem", "grv"], setup = [["set", "Map and Look", "Name, colors, outline, old-map overlays"], ["gui", "Visitor Guide", "Symbols and notes visitors see"], ["qst", "Survey Questions", "What volunteers are asked"]];
  order.forEach(t => { const b = btn(t); if (b) tabs.append(b); });
  const setupWrap = mk("div", { className: "ed-setup" }), setupBtn = mk("button", { type: "button", className: "ed-setup-btn", textContent: "Setup ▾" }), setupMenu = mk("div", { className: "ed-menu" });
  setup.forEach(([t, label, sub]) => { const b = btn(t); if (!b) return; b.textContent = label; b.append(mk("small", { textContent: sub })); setupMenu.append(b); });
  setupWrap.append(setupBtn, setupMenu); tabs.append(setupWrap); menu(setupBtn, setupMenu);

  function sync() {
    const inSetup = setup.find(s => s[0] === curTab);
    setupBtn.classList.toggle("on", !!inSetup);
    setupBtn.title = inSetup ? "Setup: " + inSetup[1] : "Setup";
    nameEl.textContent = (typeof S !== "undefined" && S && S.name) ? S.name : "";
    const a = typeof S !== "undefined" && S && S.colors && S.colors.accent; if (a) document.documentElement.style.setProperty("--accent", a);
  }
  const _tab = tab; tab = function (t) { _tab(t); sync(); };
  const _refresh = refresh; refresh = function () { _refresh.apply(this, arguments); sync(); };

  /* ---------- folding long forms ---------- */
  const openState = {};                               // section title -> left open?
  try { Object.assign(openState, JSON.parse(localStorage.getItem("edSections") || "{}")); } catch (e) {}
  const remember = () => { try { localStorage.setItem("edSections", JSON.stringify(openState)); } catch (e) {} };
  function section(title, nodes, summary, defaultOpen, before) {
    const d = mk("details", { className: "ed-sec" }), s = mk("summary", {}, [mk("span", { textContent: title })]), inner = mk("div", { className: "in" });
    if (summary) s.append(mk("span", { className: "sum", textContent: summary }));
    d.open = title in openState ? openState[title] : !!defaultOpen;
    d.addEventListener("toggle", () => { openState[title] = d.open; remember(); });
    (before || nodes[0]).before(d); nodes.forEach(n => inner.append(n)); d.append(s, inner);
    return d;
  }
  function fold(root, moreLabels, moreTitle) {
    if (!root || !root.children.length) return;
    // 1. boxes that start with a bold title become folding sections
    Array.from(root.children).forEach(b => {
      if (!b.classList || !b.classList.contains("box")) return;
      const t = b.firstElementChild; if (!t || t.tagName !== "B") return;
      const title = t.textContent.trim(), kids = Array.from(b.childNodes).filter(n => n !== t);
      if (!kids.length) return;
      let sum = "";
      if (/^Hazards/.test(title)) { const n = b.querySelectorAll("input[type=checkbox]:checked").length; sum = n > 1 ? (n - 1) + " noted" : "none noted"; }
      else if (/^Entrances/.test(title)) { const n = b.querySelectorAll("select").length; sum = n ? n + " placed" : "none yet"; }
      section(title, [b], sum, false);
      t.remove(); b.classList.remove("box"); b.style.cssText = "border:0;padding:0;margin:0;background:none";
    });
    // 2. rarely used fields move into "More details"
    const moved = [];
    Array.from(root.children).forEach(n => {
      if (n.tagName === "LABEL" && moreLabels.some(m => n.textContent.trim().startsWith(m))) { const input = n.nextElementSibling; if (input && /^(INPUT|SELECT|TEXTAREA)$/.test(input.tagName)) moved.push(n, input); }
    });
    if (moved.length) {
      const filled = moved.filter(n => n.tagName !== "LABEL" && String(n.value || "").trim()).length;
      const firstSec = Array.from(root.children).find(n => n.classList && n.classList.contains("ed-sec"));   // sit after the everyday fields, above the other sections
      if (firstSec) section(moreTitle, moved, filled ? filled + " filled in" : "", false, firstSec);
      else { const d = section(moreTitle, moved, filled ? filled + " filled in" : "", false); const last = Array.from(root.children).filter(n => /^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName)).pop(); if (last) last.after(d); }
    }
  }
  const CEM_MORE = ["Section, Township, Range", "Still in use?", "Veterans buried here?", "Pioneers buried here?", "Estimated grave count", "Official grave count", "SHAARD ID", "Size"];
  const GRV_MORE = ["War", "Veteran details", "Row", "Plot"];
  if (typeof drawCem === "function") { const d = drawCem; drawCem = function () { d.apply(this, arguments); try { fold(document.getElementById("cdet"), CEM_MORE, "More details"); } catch (e) { console.warn("fold cem", e); } }; }
  if (typeof drawGrv === "function") { const d = drawGrv; drawGrv = function () { d.apply(this, arguments); try { fold(document.getElementById("gdet"), GRV_MORE, "More grave details"); } catch (e) { console.warn("fold grv", e); } }; }

  /* ---------- phones: one button swaps between a bigger map and a bigger form ---------- */
  const mapBox = document.getElementById("map");
  if (mapBox) {
    const sz = mk("button", { type: "button", className: "ed-size", textContent: "Bigger form ▾" });
    sz.addEventListener("click", () => {
      const big = document.body.classList.toggle("form-big");
      sz.textContent = big ? "Bigger map ▴" : "Bigger form ▾";
      setTimeout(() => { try { map.resize(); } catch (e) {} }, 60);
    });
    mapBox.append(sz);
  }

  /* ---------- start on the work, not the settings ---------- */
  if (curTab === "set") tab("cem"); else sync();
  if (typeof ready !== "undefined" && ready) refresh();
})();
