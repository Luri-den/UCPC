/* qr.js - makes QR codes in the browser, with no outside service. Used for surveyor invites.
   QR.svg(text, sizePx) returns an <svg> string. QR.matrix(text) returns rows of true/false.
   Byte mode, error correction level M (about 15% of the code can be damaged or covered), versions 1-10 (up to 213 bytes). */
(function () {
  "use strict";
  // per version, level M: [data codewords per block for each group..., ec codewords per block]
  const BLOCKS = [null, [[1, 16]], 10, [[1, 28]], 16, [[1, 44]], 26, [[2, 32]], 18, [[2, 43]], 24, [[4, 27]], 16, [[4, 31]], 18, [[2, 38], [2, 39]], 22, [[3, 36], [2, 37]], 22, [[4, 43], [1, 44]], 26];
  const groups = v => BLOCKS[(v - 1) * 2 + 1], ecLen = v => BLOCKS[(v - 1) * 2 + 2];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const dataCap = v => groups(v).reduce((n, g) => n + g[0] * g[1], 0);

  // Galois field arithmetic for Reed-Solomon
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => a && b ? EXP[LOG[a] + LOG[b]] : 0;
  function rsGen(n) { let g = [1]; for (let i = 0; i < n; i++) { const ng = new Array(g.length + 1).fill(0); g.forEach((c, j) => { ng[j] ^= c; ng[j + 1] ^= mul(c, EXP[i]); }); g = ng; } return g; }
  function rsEncode(data, n) {
    const g = rsGen(n), res = data.concat(new Array(n).fill(0));
    for (let i = 0; i < data.length; i++) { const c = res[i]; if (c) for (let j = 0; j < g.length; j++) res[i + j] ^= mul(g[j], c); }
    return res.slice(data.length);
  }
  const utf8 = s => Array.from(new TextEncoder().encode(s));

  function codewords(bytes) {
    let v = 1; while (v <= 10 && dataCap(v) < bytes.length + (v < 10 ? 2 : 3)) v++;
    if (v > 10) throw new Error("Text too long for a QR code here.");
    const bits = [], put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    put(4, 4); put(bytes.length, v < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
    const cap = dataCap(v) * 8;
    put(0, Math.min(4, cap - bits.length)); while (bits.length % 8) bits.push(0);
    const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
    for (let p = 0; data.length < dataCap(v); p++) data.push(p % 2 ? 0x11 : 0xec);
    const blocks = [], ecs = []; let at = 0;
    groups(v).forEach(([count, size]) => { for (let i = 0; i < count; i++) { const b = data.slice(at, at + size); at += size; blocks.push(b); ecs.push(rsEncode(b, ecLen(v))); } });
    const out = [], maxLen = Math.max(...blocks.map(b => b.length));
    for (let i = 0; i < maxLen; i++) blocks.forEach(b => { if (i < b.length) out.push(b[i]); });
    for (let i = 0; i < ecLen(v); i++) ecs.forEach(e => out.push(e[i]));
    return { v, out };
  }

  function bch(value, poly, polyBits) { let v = value << (polyBits - 1); for (let i = 31; i >= polyBits - 1; i--) if (v & (1 << i)) v ^= poly << (i - (polyBits - 1)); return v; }

  function build(v, cw, mask) {
    const n = v * 4 + 17, M = Array.from({ length: n }, () => new Array(n).fill(false)), F = Array.from({ length: n }, () => new Array(n).fill(false));
    const set = (r, c, on) => { if (r >= 0 && c >= 0 && r < n && c < n) { M[r][c] = on; F[r][c] = true; } };
    const finder = (r, c) => { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) { const ring = Math.max(Math.abs(i - 3), Math.abs(j - 3)); set(r + i, c + j, i >= 0 && i <= 6 && j >= 0 && j <= 6 && ring !== 2); } };
    finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
    for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const A = ALIGN[v];
    A.forEach(r => A.forEach(c => { if ((r < 9 && c < 9) || (r < 9 && c > n - 10) || (r > n - 10 && c < 9)) return; /* not on the three corner squares */ for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) set(r + i, c + j, Math.max(Math.abs(i), Math.abs(j)) !== 1); }));
    set(n - 8, 8, true);                                     // the dark module
    for (let i = 0; i < 9; i++) { if (!F[8][i]) F[8][i] = true; if (!F[i][8]) F[i][8] = true; }
    for (let i = 0; i < 8; i++) { F[8][n - 1 - i] = true; F[n - 1 - i][8] = true; }
    if (v >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { F[i][n - 11 + j] = true; F[n - 11 + j][i] = true; }
    // data, in the zigzag order
    const bits = []; cw.forEach(b => { for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1); });
    let k = 0, up = true;
    for (let c = n - 1; c > 0; c -= 2) {
      if (c === 6) c--;
      for (let t = 0; t < n; t++) {
        const r = up ? n - 1 - t : t;
        for (let d = 0; d < 2; d++) { const cc = c - d; if (F[r][cc]) continue; M[r][cc] = k < bits.length ? bits[k] === 1 : false; k++; }
      }
      up = !up;
    }
    const MASKS = [(r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
      (r, c) => (r * c) % 2 + (r * c) % 3 === 0, (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0, (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (!F[r][c] && MASKS[mask](r, c)) M[r][c] = !M[r][c];
    // format information (level M = 00)
    const fmt = (bch(mask, 0x537, 11) | (mask << 10)) ^ 0x5412;
    const fb = i => ((fmt >> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) M[8][i] = fb(14 - i);
    M[8][7] = fb(8); M[8][8] = fb(7); M[7][8] = fb(6);
    for (let i = 9; i <= 14; i++) M[14 - i][8] = fb(14 - i);
    for (let i = 0; i <= 7; i++) M[n - 1 - i][8] = fb(14 - i);
    for (let i = 8; i <= 14; i++) M[8][n - 15 + i] = fb(14 - i);
    if (v >= 7) {
      const vi = (bch(v, 0x1f25, 13)) | (v << 12);
      for (let i = 0; i < 18; i++) { const on = ((vi >> i) & 1) === 1, a = Math.floor(i / 3), b = i % 3 + n - 11; M[a][b] = on; M[b][a] = on; }
    }
    return M;
  }

  function penalty(M) {
    const n = M.length; let p = 0;
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j < n; j++) { const a = pass ? M[j][i] : M[i][j], b = pass ? M[j - 1][i] : M[i][j - 1]; if (a === b) run++; else { if (run >= 5) p += run - 2; run = 1; } }
      if (run >= 5) p += run - 2;
    }
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++) { const c = M[i][j]; if (c === M[i + 1][j] && c === M[i][j + 1] && c === M[i + 1][j + 1]) p += 3; }
    const pat = [true, false, true, true, true, false, true, false, false, false, false], pat2 = pat.slice().reverse();
    for (let i = 0; i < n; i++) for (let j = 0; j + 11 <= n; j++) {
      let h1 = true, h2 = true, v1 = true, v2 = true;
      for (let k = 0; k < 11; k++) { if (M[i][j + k] !== pat[k]) h1 = false; if (M[i][j + k] !== pat2[k]) h2 = false; if (M[j + k][i] !== pat[k]) v1 = false; if (M[j + k][i] !== pat2[k]) v2 = false; }
      p += 40 * (h1 + h2 + v1 + v2);
    }
    let dark = 0; M.forEach(r => r.forEach(x => { if (x) dark++; }));
    p += Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10;
    return p;
  }

  function matrix(text) {
    const { v, out } = codewords(utf8(String(text)));
    let best = null;
    for (let m = 0; m < 8; m++) { const M = build(v, out, m), p = penalty(M); if (!best || p < best.p) best = { M, p }; }
    return best.M;
  }
  function svg(text, size) {
    const M = matrix(text), n = M.length, q = 4, total = n + q * 2;
    let d = "";
    M.forEach((row, r) => row.forEach((on, c) => { if (on) d += "M" + (c + q) + " " + (r + q) + "h1v1h-1z"; }));
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + " " + total + '" width="' + (size || 256) + '" height="' + (size || 256) + '" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }
  /* Full-screen invite card: big code to hold up for someone to scan. opts: { title, sub, link, onNext } */
  function show(opts) {
    const old = document.getElementById("qr-full"); if (old) old.remove();
    const esc = t => String(t == null ? "" : t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const box = document.createElement("div"); box.id = "qr-full"; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-label", "Invite QR code");
    box.style.cssText = "position:fixed;inset:0;z-index:100000;background:#fff;color:#111;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:16px;text-align:center;font:16px system-ui,sans-serif;overflow:auto";
    const size = Math.max(200, Math.min(window.innerWidth - 40, window.innerHeight - 260, 560));
    const btn = "min-height:48px;padding:10px 18px;border-radius:10px;font:600 16px system-ui,sans-serif;cursor:pointer;";
    box.innerHTML = '<div style="font:700 22px system-ui,sans-serif">' + esc(opts.title || "Scan to join") + '</div>' +
      '<div style="color:#444">' + esc(opts.sub || "Point your phone's camera at this code") + "</div>" + svg(opts.link, size) +
      '<div style="font-size:12px;color:#666;word-break:break-all;max-width:' + size + 'px">' + esc(opts.link) + "</div>" +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">' +
      (opts.onNext ? '<button type="button" id="qr-next" style="' + btn + 'background:#01796F;color:#fff;border:1px solid #01796F">Next person</button>' : "") +
      '<button type="button" id="qr-copy" style="' + btn + 'background:#fff;color:#111;border:1px solid #888">Copy link</button>' +
      '<button type="button" id="qr-done" style="' + btn + 'background:#fff;color:#111;border:1px solid #888">Done</button></div>';
    document.body.append(box);
    const close = () => { box.remove(); document.removeEventListener("keydown", key); };
    const key = e => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", key);
    box.querySelector("#qr-done").onclick = close;
    box.querySelector("#qr-copy").onclick = () => { if (navigator.clipboard) navigator.clipboard.writeText(opts.link).then(() => { box.querySelector("#qr-copy").textContent = "Copied"; }); };
    if (opts.onNext) box.querySelector("#qr-next").onclick = () => { close(); opts.onNext(); };
    box.querySelector("#qr-done").focus();
  }
  window.QR = { matrix, svg, show };
})();
