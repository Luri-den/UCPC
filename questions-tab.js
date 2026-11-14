/* questions-tab.js - the editor's "Questions" tab: change the survey questions without touching survey.json.
   Add, edit, reorder, remove, choose Always Shown or More Detail, and "only ask when..." rules.
   Changes go out with the editor's normal Save / Publish, as survey.json. Phones pick them up the next time
   the survey page opens with signal. Loaded by editor.html after its own script, before publish.js. */
(function () {
  "use strict";
  if (typeof outFiles === "undefined" || !document.getElementById("qst")) return;
  const pane = document.getElementById("qst");
  const TYPES = [["choice", "Pick one"], ["multi", "Pick any"], ["yesno", "Yes / No"], ["text", "Short text"], ["longtext", "Long text"], ["number", "Number"], ["date", "Date"],
    ["photo", "Photos"], ["gps", "A spot (GPS or map)"], ["points", "Several marked spots"], ["polygon", "An outline (boundary)"], ["people", "People named on a stone"], ["markerRef", "Belongs to a nearby marker"]];
  const HAS_OPTIONS = new Set(["choice", "multi", "points"]);
  const SPECIAL = new Set(["photo", "gps", "points", "polygon", "people", "markerRef"]);   // the survey page draws these with its own tools
  const typeName = t => (TYPES.find(x => x[0] === t) || [t, t])[1];
  let Q = null, loaded = false, loadErr = "", open = null, forTab = "cemetery";

  async function readSurvey() {
    const s = window.GHPublish && GHPublish.settings ? GHPublish.settings() : {};
    if (s.owner && s.repo) { try { const t = await GHPublish.read("survey.json"); if (t != null) return t; } catch (e) {} }
    if (/^https?:/.test(location.protocol)) { const r = await fetch(new URL("survey.json", document.baseURI).href, { cache: "no-store" }); if (r.ok) return r.text(); if (r.status === 404) return null; throw new Error("the site answered " + r.status); }
    throw new Error("open the editor from the website, or set up Publish (⚙)");
  }
  async function load() {
    try { const t = await readSurvey(); Q = t ? JSON.parse(t) : { version: 1, questions: [] }; Q.questions = Q.questions || []; loaded = true; loadErr = ""; }
    catch (e) { loadErr = "Couldn't read survey.json (" + e.message + ")."; }
    draw();
  }
  const changed = () => { Q.version = (Q.version || 1); touch("survey"); };
  const _out = outFiles;
  outFiles = function () { const o = _out(); if (dirty.has("survey") && Q) o.push(["survey.json", JSON.stringify(Q, null, 2) + "\n"]); return o; };

  const optionsOf = q => q.options || (q.optionsFrom && Q[q.optionsFrom]) || [];
  const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "question";
  const uniqueId = base => { let id = base, n = 2; while (Q.questions.some(q => q.id === id)) id = base + "_" + n++; return id; };
  const usedBy = id => Q.questions.filter(q => q.showIf && q.showIf.q === id);

  function draw() {
    pane.textContent = "";
    pane.append(el("h3", { textContent: "Survey Questions" }), el("small", { textContent: "What volunteers are asked in the survey. Changes go out with Save or Publish; phones update the next time they open the survey with signal." }));
    if (!loaded) { pane.append(el("div", { className: "box" }, [el("small", { textContent: loadErr || "Loading…" })]), el("button", { textContent: "Try Again", onclick: load })); return; }
    pane.append(el("div", { className: "row" }, [["cemetery", "Cemetery Questions"], ["marker", "Grave Questions"]].map(([v, t]) =>
      el("button", { textContent: t, style: forTab === v ? "background:#d7ebe8;font-weight:bold" : "", onclick: () => { forTab = v; open = null; draw(); } }))));
    const list = Q.questions.filter(q => q.for === forTab || q.for === "both");
    ["core", "expanded"].forEach(level => {
      pane.append(el("h3", { textContent: level === "core" ? "Always Shown" : "Under “Add More Detail”" }));
      const box = el("div", { className: "list", style: "max-height:none" });
      const these = list.filter(q => (q.level || "core") === level);
      if (!these.length) box.append(el("div", { textContent: "None.", style: "cursor:default;color:#6b6258" }));
      these.forEach(q => {
        const i = Q.questions.indexOf(q);
        box.append(el("div", { className: q === open ? "on" : "", style: "display:flex;gap:6px;align-items:center", onclick: () => { open = open === q ? null : q; draw(); } }, [
          el("span", { style: "flex:1", textContent: q.label + (q.required ? " *" : "") }),
          el("small", { textContent: typeName(q.type) + (q.showIf ? " · only if…" : "") }),
          el("button", { textContent: "↑", title: "Move up", style: "padding:2px 7px", onclick: e => { e.stopPropagation(); move(i, -1, level); } }),
          el("button", { textContent: "↓", title: "Move down", style: "padding:2px 7px", onclick: e => { e.stopPropagation(); move(i, 1, level); } })
        ]));
        if (q === open) box.append(editBox(q));
      });
      pane.append(box);
    });
    pane.append(el("div", { className: "row" }, [el("button", { className: "go", textContent: "+ Add a Question", onclick: addQuestion })]));
    if (Q.hazardTypes) pane.append(listEditor("Hazard Types (used by every hazard question)", Q.hazardTypes, v => { Q.hazardTypes = v; changed(); }));
  }

  function move(i, d, level) {   // swap with the next question of the same kind and level
    const q = Q.questions[i], same = Q.questions.map((x, j) => ({ x, j })).filter(o => (o.x.for === q.for || o.x.for === "both") && (o.x.level || "core") === level);
    const at = same.findIndex(o => o.j === i), to = same[at + d]; if (!to) return;
    [Q.questions[i], Q.questions[to.j]] = [Q.questions[to.j], Q.questions[i]]; changed(); draw();
  }

  function listEditor(label, values, onSave) {
    const t = el("textarea", { style: "height:120px" }); t.value = values.join("\n");
    t.onchange = () => onSave(t.value.split("\n").map(s => s.trim()).filter(Boolean));
    return el("div", { className: "box" }, [el("label", { textContent: label }), t, el("small", { textContent: "One per line. Removing a choice doesn't change answers already collected." })]);
  }

  function editBox(q) {
    const b = el("div", { className: "box", onclick: e => e.stopPropagation(), style: "cursor:default" });
    const label = el("input", { value: q.label || "" }); label.oninput = () => { q.label = label.value; changed(); };
    const help = el("input", { value: q.help || "", placeholder: "Optional hint under the question" }); help.oninput = () => { q.help = help.value || undefined; if (!q.help) delete q.help; changed(); };
    b.append(el("label", { textContent: "Question" }), label, el("label", { textContent: "Hint" }), help);
    const type = el("select", {}, TYPES.map(([v, t]) => el("option", { value: v, textContent: t })));
    type.value = q.type; type.onchange = () => { q.type = type.value; if (!HAS_OPTIONS.has(q.type)) delete q.options; if (HAS_OPTIONS.has(q.type) && !optionsOf(q).length && q.type !== "points") q.options = ["Option 1", "Option 2"]; changed(); draw(); };
    b.append(el("label", { textContent: "Answer Type" }), type);
    if (SPECIAL.has(q.type)) b.append(el("small", { textContent: "The survey draws this one with its own tools (camera, map, outline…)." }));
    if (q.type === "photo") { const mx = el("input", { type: "number", min: 1, max: 6, value: q.max || 3 }); mx.onchange = () => { q.max = Math.max(1, Math.min(6, +mx.value || 3)); changed(); }; b.append(el("label", { textContent: "Most Photos" }), mx); }
    if (HAS_OPTIONS.has(q.type)) {
      if (q.optionsFrom) b.append(el("small", { textContent: "Uses the shared “" + q.optionsFrom + "” list at the bottom of this tab." }));
      else b.append(listEditor("Choices", optionsOf(q), v => { q.options = v; changed(); }));
    }
    const lvl = el("select", {}, [["core", "Always shown"], ["expanded", "Under “Add more detail”"]].map(([v, t]) => el("option", { value: v, textContent: t })));
    lvl.value = q.level || "core"; lvl.onchange = () => { q.level = lvl.value; changed(); draw(); };
    const req = el("input", { type: "checkbox", checked: !!q.required }); req.onchange = () => { if (req.checked) q.required = true; else delete q.required; changed(); };
    b.append(el("label", { textContent: "Where It Appears" }), lvl, el("label", { style: "font-weight:normal" }, [req, " Must be answered before saving"]));

    // "only ask when…"
    const others = Q.questions.filter(o => o !== q && (o.for === q.for || o.for === "both") && (o.type === "yesno" || o.type === "choice" || o.type === "multi"));
    const whenQ = el("select", {}, [el("option", { value: "", textContent: "Always ask it" })].concat(others.map(o => el("option", { value: o.id, textContent: "Only if: " + o.label }))));
    whenQ.value = q.showIf ? q.showIf.q : "";
    const whenBox = el("div");
    const drawWhen = () => {
      whenBox.textContent = ""; const o = others.find(x => x.id === whenQ.value); if (!o) return;
      const opts = o.type === "yesno" ? ["Yes", "No"] : optionsOf(o), cur = new Set(q.showIf ? (q.showIf.in || (q.showIf.is != null ? [q.showIf.is] : [])) : []);
      whenBox.append(el("small", { textContent: "…is answered with any of these:" }));
      opts.forEach(v => { const cb = el("input", { type: "checkbox", checked: cur.has(v) }); cb.onchange = () => { cb.checked ? cur.add(v) : cur.delete(v); const arr = opts.filter(x => cur.has(x)); q.showIf = arr.length === 1 ? { q: o.id, is: arr[0] } : { q: o.id, in: arr }; changed(); }; whenBox.append(el("label", { style: "font-weight:normal" }, [cb, " " + v])); });
    };
    whenQ.onchange = () => { if (!whenQ.value) delete q.showIf; else q.showIf = { q: whenQ.value, in: [] }; changed(); drawWhen(); };
    b.append(el("label", { textContent: "When to Ask" }), whenQ, whenBox); drawWhen();

    if (q.saveTo) b.append(el("small", { textContent: "Approved answers update the “" + q.saveTo + "” column." }));
    b.append(el("div", {}, [el("small", { textContent: "Code: " + q.id + " (fixed, so earlier answers stay linked)" })]));
    b.append(el("div", { className: "row" }, [el("button", { className: "bad", textContent: "Remove This Question", onclick: () => {
      const deps = usedBy(q.id);
      if (!confirm("Remove “" + q.label + "”?" + (deps.length ? "\n\nThese questions are only asked depending on it, and will become always-asked: " + deps.map(d => d.label).join(", ") : "") + "\n\nAnswers already collected are kept.")) return;
      deps.forEach(d => delete d.showIf); Q.questions.splice(Q.questions.indexOf(q), 1); open = null; changed(); draw();
    } })]));
    return b;
  }

  function addQuestion() {
    const label = prompt("Type the new question, as volunteers will see it:"); if (!label || !label.trim()) return;
    const q = { id: uniqueId(slug(label)), for: forTab, level: "core", type: "choice", label: label.trim(), options: ["Option 1", "Option 2"] };
    const lastCore = Q.questions.map((x, j) => ({ x, j })).filter(o => o.x.for === forTab && (o.x.level || "core") === "core").pop();
    Q.questions.splice(lastCore ? lastCore.j + 1 : Q.questions.length, 0, q);
    open = q; changed(); draw();
  }

  const tabBtn = document.querySelector('.tabs button[data-t="qst"]');
  if (tabBtn) tabBtn.addEventListener("click", () => { if (!loaded) load(); else draw(); });
  draw();
})();
