/* worker.js - the survey inbox (Cloudflare Worker + D1). One Worker serves every county.

   Addresses (AREA is the county code from settings.json, e.g. UC):
     POST /AREA/submit            invited surveyors send surveys here          (header X-Invite: their code)
     POST /AREA/story             anyone sends a story here                    (no code; spam-checked if Turnstile is set up)
     GET  /AREA/inbox             the lead reads what's waiting                (header X-Lead-Key)
     GET  /AREA/media/ID          the lead fetches one photo or recording      (header X-Lead-Key)
     POST /AREA/mark              the lead marks items approved/rejected/held  (header X-Lead-Key)
     GET  /AREA/invites           the lead lists surveyor invites              (header X-Lead-Key)
     POST /AREA/invites           the lead makes a new invite {name}           (header X-Lead-Key)
     POST /AREA/invites/revoke    the lead turns one invite off {code}         (header X-Lead-Key)
     GET  /AREA/check             a surveyor's phone checks its invite still works (header X-Invite)
     GET  /AREA/whoami            who this key belongs to: the owner, or a named lead           (header X-Lead-Key)
     GET  /AREA/leads             the OWNER lists the county's leads                           (header X-Lead-Key = owner key)
     POST /AREA/leads             the OWNER adds a lead {name}; the new key is shown once
     POST /AREA/leads/revoke      the OWNER turns one lead's key off {id}
     GET  /AREA/count             how many are waiting, for the editor and map badges (header X-Lead-Key)

   Settings (Worker > Settings > Variables, as SECRETS):
     LEAD_KEYS         JSON, the MANAGER key (or keys) for each county, e.g. {"UC":["my-own-phrase","the-commissioners-phrase"],"FC":"one-phrase"}.
                       A manager can do everything a lead can, and also adds and removes leads. Whoever runs this Cloudflare account
                       (the owner) sets and changes manager keys here.
                       Each lead gets their own key (made in the editor), so one can be removed without touching the others.
                       JSON, one key per county, e.g. {"UC":"a-long-random-phrase","FC":"another-one"}
     TURNSTILE_SECRET  optional; when set, public stories must pass Cloudflare's free spam check
     NTFY_TOPIC        optional; a private topic name on ntfy.sh. The lead gets a phone notification when something new arrives
                       (at most one every 10 minutes per county, and it only says how many, never names or story text)
     EDITOR_URL        optional; tapping the notification opens this address (e.g. https://you.github.io/UCPC/editor.html)
   Binding: a D1 database named DB (Worker > Settings > Bindings).                                             */

const MAX_BODY = 8 * 1024 * 1024;      // 8 MB per submission
const MAX_MEDIA = 6;                   // photos/recordings per submission
const MAX_MEDIA_CHARS = 1900000;       // ~1.4 MB per file once decoded (D1 rows top out at 2 MB)
const ALLOWED_MIME = /^(image\/(jpeg|png|webp)|audio\/(webm|mp4|mpeg|ogg|aac|x-m4a))$/;
const STATUSES = ["new", "approved", "rejected", "held"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Invite, X-Lead-Key",
  "Access-Control-Max-Age": "86400"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (status, message) => json({ ok: false, error: message }, status);
const now = () => new Date().toISOString();
const clip = (v, n) => String(v == null ? "" : v).slice(0, n);

function leadKeys(env) { try { return JSON.parse(env.LEAD_KEYS || "{}"); } catch (e) { return {}; } }
function isLead(env, area, req) {                         // true for a MANAGER key of this county
  const entry = leadKeys(env)[area], got = req.headers.get("X-Lead-Key") || "";
  const wants = (Array.isArray(entry) ? entry : [entry]).filter(k => typeof k === "string" && k);   // one key, or a list: ["yours", "the commissioner's"]
  let match = false;
  for (const want of wants) {
    if (got.length !== want.length) continue;
    let diff = 0; for (let n = 0; n < want.length; n++) diff |= want.charCodeAt(n) ^ got.charCodeAt(n);   // same time whatever the guess
    if (diff === 0) match = true;
  }
  return match;
}
/* Who is asking? The county's owner key (from LEAD_KEYS), or one of the leads the owner added. null = nobody we know. */
async function sha256(text) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)); return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, "0")).join(""); }
async function who(env, area, req) {
  if (isLead(env, area, req)) return { role: "owner", name: "Manager" };
  const key = (req.headers.get("X-Lead-Key") || "").trim();
  if (key.length < 12) return null;
  try {                                                    // if the leads table was never created, there are simply no leads yet
    const row = await env.DB.prepare("SELECT id, name FROM leads WHERE area = ? AND key_hash = ? AND revoked = 0").bind(area, await sha256(area + ":" + key)).first();
    return row ? { role: "lead", name: row.name, id: row.id } : null;
  } catch (e) { return null; }
}
function newLeadKey(area) {                                // e.g. UC-7KQ2-M9XD-4TRB-W8NP (about 80 bits: not guessable)
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = new Uint8Array(16); crypto.getRandomValues(b);
  const t = Array.from(b, x => A[x % A.length]).join(""); return area + "-" + t.slice(0, 4) + "-" + t.slice(4, 8) + "-" + t.slice(8, 12) + "-" + t.slice(12);
}
async function inviteOk(env, area, code) {
  if (!code) return null;
  return await env.DB.prepare("SELECT code, name FROM invites WHERE area = ? AND code = ? AND revoked = 0").bind(area, code).first();
}
async function readBody(req) {
  const len = +(req.headers.get("Content-Length") || 0);
  if (len > MAX_BODY) throw new Error("That submission is too large. Try fewer or smaller photos.");
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Error("That submission is too large. Try fewer or smaller photos.");
  try { return JSON.parse(text); } catch (e) { throw new Error("The submission could not be read."); }
}
function newCode() {   // e.g. K7Q2-M9XD, no 0/O/1/I to misread
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = new Uint8Array(8); crypto.getRandomValues(b);
  const s = Array.from(b, x => A[x % A.length]).join(""); return s.slice(0, 4) + "-" + s.slice(4);
}
async function turnstileOk(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;                 // not set up: allow (fine for a demo, turn it on before going public)
  if (!token) return false;
  const form = new FormData(); form.append("secret", env.TURNSTILE_SECRET); form.append("response", token); if (ip) form.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const out = await r.json().catch(() => ({})); return !!out.success;
}

/* Save one submission and its photos/recordings. Sending the same id twice is harmless: the second is ignored. */
async function store(env, area, channel, sub, inviteCode) {
  const id = clip(sub.id, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new Error("The submission has no valid id.");
  const media = Array.isArray(sub.media) ? sub.media : [];
  if (media.length > MAX_MEDIA) throw new Error("Up to " + MAX_MEDIA + " photos or recordings per submission.");
  const rows = [];
  media.forEach((m, i) => {
    const mime = clip(m && m.mime, 40).toLowerCase(), data = String((m && m.data) || "");
    if (!ALLOWED_MIME.test(mime)) throw new Error("File type not accepted: " + (mime || "unknown"));
    if (!/^[A-Za-z0-9+/=]+$/.test(data)) throw new Error("A photo or recording could not be read.");
    if (data.length > MAX_MEDIA_CHARS) throw new Error("A photo or recording is too large.");
    rows.push({ id: id + "-m" + i, idx: i, mime, data });
  });
  const exists = await env.DB.prepare("SELECT id FROM submissions WHERE id = ?").bind(id).first();
  if (exists) return { id, duplicate: true };
  const t = sub.target || {};
  const stmts = [env.DB.prepare(
    "INSERT INTO submissions (id, area, channel, invite_code, submitter, kind, target_type, target_id, data, created, received, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')"
  ).bind(id, area, channel, inviteCode || null, clip(sub.submitter, 120), clip(sub.kind || "survey", 20), clip(t.type, 20), clip(t.id, 64),
         JSON.stringify(sub.data || {}).slice(0, 200000), clip(sub.created, 40), now())];
  rows.forEach(m => stmts.push(env.DB.prepare("INSERT INTO media (id, submission_id, idx, mime, data) VALUES (?, ?, ?, ?, ?)").bind(m.id, id, m.idx, m.mime, m.data)));
  await env.DB.batch(stmts);                               // all or nothing
  return { id, duplicate: false, media: rows.length };
}

/* phone notification through ntfy.sh. Quiet if one was already sent in the last 10 minutes for this county. */
async function notify(env, area, newId) {
  if (!env.NTFY_TOPIC) return;
  try {
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM submissions WHERE area = ? AND status = 'new' AND received > ? AND id != ?").bind(area, since, newId).first();
    if (recent && recent.n > 0) return;                    // a notification already went out for this batch
    const c = await env.DB.prepare("SELECT channel, COUNT(*) AS n FROM submissions WHERE area = ? AND status = 'new' GROUP BY channel").bind(area).all();
    const by = {}; (c.results || []).forEach(r => by[r.channel] = r.n);
    const parts = []; if (by.member) parts.push(by.member + " survey" + (by.member === 1 ? "" : "s")); if (by.public) parts.push(by.public + " public stor" + (by.public === 1 ? "y" : "ies"));
    const headers = { "Title": area + " cemetery inbox", "Tags": "inbox_tray", "Priority": "default" };
    if (env.EDITOR_URL) headers["Click"] = env.EDITOR_URL;
    await fetch("https://ntfy.sh/" + encodeURIComponent(env.NTFY_TOPIC), { method: "POST", headers, body: (parts.join(" and ") || "New additions") + " waiting for review." });
  } catch (e) { /* a failed notification never blocks a survey */ }
}

export default {
  async fetch(req, env, ctx) {
    const later = p => { if (ctx && ctx.waitUntil) ctx.waitUntil(p); };
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url), parts = url.pathname.split("/").filter(Boolean);
    const area = (parts[0] || "").toUpperCase(), action = parts[1] || "", extra = parts[2] || "";
    if (!area) return json({ ok: true, service: "survey inbox" });
    if (!/^[A-Z0-9]{1,8}$/.test(area) || !leadKeys(env)[area]) return fail(404, "Unknown county.");
    if (!env.DB) return fail(500, "The inbox database is not connected (binding DB).");

    try {
      // ---------- surveyors ----------
      if (action === "check" && req.method === "GET") {
        const inv = await inviteOk(env, area, req.headers.get("X-Invite"));
        return inv ? json({ ok: true, name: inv.name }) : fail(403, "This invite is no longer active. Contact your county lead.");
      }
      if (action === "submit" && req.method === "POST") {
        const code = req.headers.get("X-Invite") || "", inv = await inviteOk(env, area, code);
        if (!inv) return fail(403, "This invite is no longer active. Contact your county lead.");
        const body = await readBody(req), list = Array.isArray(body.submissions) ? body.submissions : [body];
        if (list.length > 25) return fail(400, "Send at most 25 surveys at a time.");
        const results = [];
        for (const s of list) { s.submitter = s.submitter || inv.name; results.push(await store(env, area, "member", s, code)); }
        const fresh = results.find(r => !r.duplicate); if (fresh) later(notify(env, area, fresh.id));
        return json({ ok: true, results });
      }
      // ---------- the public ----------
      if (action === "story" && req.method === "POST") {
        const body = await readBody(req);
        if (!(await turnstileOk(env, body.turnstile, req.headers.get("CF-Connecting-IP")))) return fail(403, "The spam check didn't pass. Please try again.");
        if (!body.data || !String(body.data.text || "").trim()) return fail(400, "Please write the story or memory first.");
        if (!body.data.consent) return fail(400, "Please confirm you have permission to share this.");
        body.kind = "story";
        const res = await store(env, area, "public", body, null);
        if (!res.duplicate) later(notify(env, area, res.id));
        return json({ ok: true, results: [res] });
      }

      // ---------- the county lead ----------
      const me = await who(env, area, req);
      if (!me) return fail(403, "Lead key missing or wrong.");
      if (action === "whoami" && req.method === "GET") return json({ ok: true, role: me.role, name: me.name });
      if (action === "leads") {                              // only the owner manages leads
        if (me.role !== "owner") return fail(403, "Only a manager can add or remove leads.");
        try {
          if (!extra && req.method === "GET") {
            const rows = (await env.DB.prepare("SELECT id, name, created, revoked FROM leads WHERE area = ? ORDER BY created DESC").bind(area).all()).results || [];
            return json({ ok: true, leads: rows });
          }
          if (!extra && req.method === "POST") {
            const body = await readBody(req), name = clip(body.name, 80).trim();
            if (!name) return fail(400, "Give the lead's name.");
            const key = newLeadKey(area), id = crypto.randomUUID();
            await env.DB.prepare("INSERT INTO leads (id, area, name, key_hash, created, revoked) VALUES (?, ?, ?, ?, ?, 0)").bind(id, area, name, await sha256(area + ":" + key), now()).run();
            return json({ ok: true, id, name, key });        // the key itself is never stored, so this is the only time it can be shown
          }
          if (extra === "revoke" && req.method === "POST") {
            const body = await readBody(req);
            await env.DB.prepare("UPDATE leads SET revoked = 1 WHERE area = ? AND id = ?").bind(area, clip(body.id, 64)).run();
            return json({ ok: true });
          }
        } catch (e) {
          if (/no such table/i.test(String(e && e.message))) return fail(400, "The leads table hasn't been created yet. Run the CREATE TABLE leads line from schema.sql in the D1 console.");
          throw e;
        }
      }
      if (action === "count" && req.method === "GET") {
        const c = await env.DB.prepare("SELECT channel, COUNT(*) AS n FROM submissions WHERE area = ? AND status = 'new' GROUP BY channel").bind(area).all();
        const by = { member: 0, public: 0 }; (c.results || []).forEach(r => by[r.channel] = r.n);
        return json({ ok: true, total: by.member + by.public, member: by.member, public: by.public });
      }
      if (action === "inbox" && req.method === "GET") {
        const st = STATUSES.includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "new";
        const subs = (await env.DB.prepare("SELECT * FROM submissions WHERE area = ? AND status = ? ORDER BY received LIMIT 500").bind(area, st).all()).results || [];
        const ids = subs.map(s => s.id), media = {};
        for (let i = 0; i < ids.length; i += 50) {           // list the photos for each, without sending the photos themselves
          const chunk = ids.slice(i, i + 50), q = chunk.map(() => "?").join(",");
          const rows = (await env.DB.prepare("SELECT id, submission_id, idx, mime FROM media WHERE submission_id IN (" + q + ") ORDER BY idx").bind(...chunk).all()).results || [];
          rows.forEach(m => (media[m.submission_id] = media[m.submission_id] || []).push({ id: m.id, mime: m.mime }));
        }
        return json({ ok: true, items: subs.map(s => ({ ...s, data: JSON.parse(s.data || "{}"), media: media[s.id] || [] })) });
      }
      if (action === "media" && req.method === "GET" && extra) {
        const m = await env.DB.prepare("SELECT media.mime, media.data FROM media JOIN submissions ON submissions.id = media.submission_id WHERE media.id = ? AND submissions.area = ?").bind(extra, area).first();
        if (!m) return fail(404, "Not found.");
        const bytes = Uint8Array.from(atob(m.data), c => c.charCodeAt(0));
        return new Response(bytes, { headers: { ...CORS, "Content-Type": m.mime, "Cache-Control": "private, max-age=3600" } });
      }
      if (action === "mark" && req.method === "POST") {
        const body = await readBody(req), ids = (body.ids || []).map(x => clip(x, 64)).slice(0, 200), st = body.status;
        if (!STATUSES.includes(st)) return fail(400, "Unknown status.");
        if (!ids.length) return json({ ok: true, changed: 0 });
        const q = ids.map(() => "?").join(",");
        const r = await env.DB.prepare("UPDATE submissions SET status = ? WHERE area = ? AND id IN (" + q + ")").bind(st, area, ...ids).run();
        if (body.purge && (st === "approved" || st === "rejected"))   // photos already copied into the site: free the space
          await env.DB.prepare("DELETE FROM media WHERE submission_id IN (" + q + ")").bind(...ids).run();
        return json({ ok: true, changed: (r.meta && r.meta.changes) || 0 });
      }
      if (action === "invites" && !extra && req.method === "GET") {
        const rows = (await env.DB.prepare("SELECT i.code, i.name, i.created, i.revoked, (SELECT COUNT(*) FROM submissions s WHERE s.area = i.area AND s.invite_code = i.code) AS sent FROM invites i WHERE i.area = ? ORDER BY i.created DESC").bind(area).all()).results || [];
        return json({ ok: true, invites: rows });
      }
      if (action === "invites" && !extra && req.method === "POST") {
        const body = await readBody(req), name = clip(body.name, 80).trim();
        if (!name) return fail(400, "Give the surveyor's name.");
        const code = newCode();
        await env.DB.prepare("INSERT INTO invites (area, code, name, created) VALUES (?, ?, ?, ?)").bind(area, code, name, now()).run();
        return json({ ok: true, code, name });
      }
      if (action === "invites" && extra === "revoke" && req.method === "POST") {
        const body = await readBody(req);
        await env.DB.prepare("UPDATE invites SET revoked = 1 WHERE area = ? AND code = ?").bind(area, clip(body.code, 20)).run();
        return json({ ok: true });
      }
      return fail(404, "Unknown address.");
    } catch (e) {
      return fail(400, e && e.message ? e.message : "Something went wrong.");
    }
  }
};
