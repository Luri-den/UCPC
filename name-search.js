/* name-search.js - forgiving search for names on old gravestones.

   What it forgives:
     - capitals, accents and punctuation:   obrien = O'Brien,  muller = Müller,  st john = St. John
     - word order:                          "smith john" = "John Smith" = "Smith, John"
     - old abbreviations and nicknames:     Jno = John,  Wm = William,  Polly = Mary,  Mc = Mac
     - one typing mistake in names of 5+ letters (two in long names), or two swapped letters:  Smyth = Smith,  Jhon = John
     - partly typed words:                  "marg" finds Margaret
   And a 4-digit number matches a birth or death year ("smith 1880"); "1880s" matches the decade.

   Every word typed must match something. NameSearch.score(...) gives 0 for no match, and a higher number for a closer one,
   so results can be sorted best first.

     NameSearch.score(query, { names: "John Smith", other: "Union Township", years: ["Mar 3, 1880", "1931"] })
*/
(function () {
  "use strict";
  const GROUPS = [
    "john jno jack johnny jon", "william wm will bill billy willie", "charles chas charley charlie chs", "george geo", "james jas jim jimmy jno.",
    "thomas thos tom tommy", "samuel saml sam", "benjamin benj ben", "elizabeth eliz elisabeth betsy betsey eliza beth bettie betty lizzie liz",
    "margaret margt marg peggy maggie margret", "robert robt bob bobby", "richard richd dick", "daniel danl dan", "joseph jos joe",
    "edward edw ed ned eddie", "henry hy hen harry", "alexander alex alexr", "mary polly molly mollie mamie mae", "sarah sally sallie sara",
    "ann anna anne nancy annie", "martha patsy mattie", "catherine catharine katherine kathryn kate katie kitty cath", "susan susannah susanna sukey susie",
    "frances fanny frankie", "francis frank", "isaac ike", "nathaniel nathl nath nat", "jonathan jona jno", "andrew andw andy", "abraham abm abe",
    "jacob jake", "matthew matt mathew", "michael mike", "frederick fredk fred", "christopher chris", "zachariah zach zachary", "jeremiah jere jerry",
    "hannah hanna", "rebecca rebekah becky", "deborah debbie", "eleanor elinor ellen nellie nelly", "lucinda lucy cindy", "augustus gus", "solomon sol",
    "lieut lieutenant lt", "capt captain", "col colonel", "sgt sergeant", "pvt private", "rev reverend", "dr doctor", "jr junior", "sr senior", "st saint"
  ];
  const SAME = new Map();
  GROUPS.forEach(g => { const w = g.split(" ").map(x => x.replace(/\./g, "")).filter(Boolean); w.forEach(x => { const s = SAME.get(x) || new Set(); w.forEach(y => s.add(y)); SAME.set(x, s); }); });

  function norm(s) {
    return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/['’‘`´.]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  }
  const words = s => { const t = norm(s); return t ? t.split(" ") : []; };
  const mac = w => w.replace(/^mac(?=[a-z]{3})/, "mc");          // MacDonald = McDonald
  function close(a, b, max) {                                     // Damerau-Levenshtein distance <= max
    if (Math.abs(a.length - b.length) > max) return false;
    const d = []; for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      let rowMin = Infinity;
      for (let j = 1; j <= b.length; j++) {
        const c = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        if (d[i][j] < rowMin) rowMin = d[i][j];
      }
      if (rowMin > max) return false;
    }
    return d[a.length][b.length] <= max;
  }
  function wordScore(t, w) {
    if (w === t) return 5;
    const ts = SAME.get(t); if (ts && ts.has(w)) return 4;
    const mt = mac(t), mw = mac(w);
    if (mw === mt) return 5;
    if (mw.startsWith(mt)) return 3;
    if (t.length >= 3 && mw.includes(mt)) return 2;
    if (t.length >= 5) {                                           // one slip (two in long names); short names would match too much
      const max = t.length >= 8 ? 2 : 1;
      if (close(mt, mw, max) || (mw.length > mt.length && close(mt, mw.slice(0, mt.length), max))) return 1;
    } else if (t.length === 4 && mw.length >= 4) {                 // four letters: only two letters swapped (Jhon = John)
      const p = mw.slice(0, 4); let i = 0; while (i < 4 && p[i] === mt[i]) i++;
      if (i < 3 && p[i] === mt[i + 1] && p[i + 1] === mt[i] && p.slice(i + 2) === mt.slice(i + 2) && (mw.length === 4 || mw.length > 4)) return 1;
    }
    return 0;
  }
  const yearsOf = list => (list || []).map(v => (String(v || "").match(/\b(1[5-9]\d\d|20\d\d)\b/g) || [])).flat();

  // query: what was typed. rec: { names, other, years }   (names = the important words; other = cemetery, township and the like)
  function score(query, rec) {
    const q = words(query); if (!q.length) return 0;
    const nw = words(rec.names), ow = words(rec.other), ys = yearsOf(rec.years);
    let total = 0;
    for (const t of q) {
      let best = 0;
      if (/^\d{4}$/.test(t)) best = ys.includes(t) ? 4 : 0;
      else if (/^\d{3}0s$/.test(t)) best = ys.some(y => y.startsWith(t.slice(0, 3))) ? 3 : 0;
      else if (/^\d+$/.test(t)) best = nw.concat(ow).some(w => w.startsWith(t)) ? 2 : 0;   // IDs and plot numbers
      else {
        for (const w of nw) { const s = wordScore(t, w); if (s > best) best = s; if (best === 5) break; }
        if (best < 3) for (const w of ow) { const s = Math.min(2, wordScore(t, w)); if (s > best) best = s; }
      }
      if (!best) return 0;
      total += best;
    }
    return total;
  }
  window.NameSearch = { score, norm };
})();
