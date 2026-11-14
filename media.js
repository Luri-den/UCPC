/* media.js - shows the video and audio that go with a story.

   A story's MEDIA column (stories.csv) holds one or more entries separated by " | ". Each is either
     - a link:  YouTube or Vimeo (played in place, after a tap), an audio or video file, or any other https page
     - a file in this site, for example photos/stories/abc-audio.m4a  (a recording someone sent in)
   Nothing is loaded from another site until the visitor taps Play.

   Used by the map (stories.js) and the editor's Review tab (inbox-tab.js):
     StoryMedia.html("https://youtu.be/…  |  photos/stories/x-audio.m4a")  ->  HTML for a card
     StoryMedia.check("…")  ->  { ok: [...], bad: [...] }   for telling a reviewer what a link will do
*/
(function () {
  "use strict";
  const H = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const AUDIO = /\.(mp3|m4a|aac|ogg|oga|wav)$/i, VIDEO = /\.(mp4|m4v|mov|webm)$/i;

  function one(raw) {
    const v = String(raw || "").trim(); if (!v) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v) && !v.startsWith("//")) {                       // a file in this site
      if (v.split("/").includes("..") || /[<>"'\\\s]/.test(v)) return { bad: v };
      const src = typeof photoUrl === "function" ? photoUrl(v) : v;
      if (AUDIO.test(v) || /-audio\.[a-z0-9]+$/i.test(v)) return { kind: "audio", src, label: "Recording" };
      if (VIDEO.test(v)) return { kind: "video", src, label: "Video" };
      return { bad: v };
    }
    let u; try { u = new URL(v); } catch (e) { return { bad: v }; }
    if (u.protocol !== "https:") return { bad: v };
    const host = u.hostname.replace(/^(www|m|music)\./, ""), path = u.pathname;
    let m;
    if (host === "youtu.be" && (m = /^\/([\w-]{11})$/.exec(path))) return yt(m[1], u);
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      if (path === "/watch" && /^[\w-]{11}$/.test(u.searchParams.get("v") || "")) return yt(u.searchParams.get("v"), u);
      if ((m = /^\/(?:shorts|embed|live)\/([\w-]{11})$/.exec(path))) return yt(m[1], u);
    }
    if (host === "vimeo.com" && (m = /^\/(\d{6,12})$/.exec(path))) return { kind: "frame", site: "Vimeo", src: "https://player.vimeo.com/video/" + m[1] + "?autoplay=1", href: "https://vimeo.com/" + m[1], label: "Video" };
    if (host === "player.vimeo.com" && (m = /^\/video\/(\d{6,12})$/.exec(path))) return { kind: "frame", site: "Vimeo", src: "https://player.vimeo.com/video/" + m[1] + "?autoplay=1", href: "https://vimeo.com/" + m[1], label: "Video" };
    if (AUDIO.test(path)) return { kind: "audio", src: u.href, label: "Recording" };
    if (VIDEO.test(path)) return { kind: "video", src: u.href, label: "Video" };
    return { kind: "link", href: u.href, site: host };
  }
  function yt(id, u) {
    const t = parseInt(u.searchParams.get("t") || u.searchParams.get("start") || "", 10);
    return { kind: "frame", site: "YouTube", src: "https://www.youtube-nocookie.com/embed/" + id + "?autoplay=1&rel=0" + (t > 0 ? "&start=" + t : ""), href: "https://www.youtube.com/watch?v=" + id + (t > 0 ? "&t=" + t : ""), label: "Video" };
  }
  function parse(str) { return String(str || "").split("|").map(one).filter(Boolean); }
  function check(str) { const all = parse(str); return { ok: all.filter(x => !x.bad), bad: all.filter(x => x.bad).map(x => x.bad) }; }

  function html(str) {
    return parse(str).filter(x => !x.bad).map(x => {
      if (x.kind === "audio") return '<div class="sm"><audio controls preload="none" src="' + H(x.src) + '"></audio></div>';
      if (x.kind === "video") return '<div class="sm"><video controls preload="none" playsinline src="' + H(x.src) + '"></video></div>';
      if (x.kind === "frame") return '<div class="sm"><button type="button" class="sm-play" data-sm-src="' + H(x.src) + '" data-sm-site="' + H(x.site) + '"><span aria-hidden="true">&#9654;</span> Play video <small>from ' + H(x.site) + '</small></button>' +
        '<a class="sm-out" href="' + H(x.href) + '" target="_blank" rel="noopener noreferrer">Open on ' + H(x.site) + "</a></div>";
      return '<div class="sm"><a class="sm-out" href="' + H(x.href) + '" target="_blank" rel="noopener noreferrer">Watch or listen on ' + H(x.site) + " &#8599;</a></div>";
    }).join("");
  }

  if (!document.getElementById("sm-css")) {
    const st = document.createElement("style"); st.id = "sm-css";
    st.textContent = ".sm{margin:6px 0}.sm audio{width:100%;display:block}.sm video,.sm iframe{width:100%;aspect-ratio:16/9;border:0;border-radius:8px;display:block;background:#000}" +
      ".sm-play{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:48px;padding:10px 12px;border:1px solid #cbd2d9;border-radius:8px;background:#f4f1e8;color:#1a202c;font:inherit;font-weight:600;cursor:pointer}" +
      ".sm-play small{font-weight:normal;color:#5b6470}.sm-out{display:inline-block;font-size:13px;margin-top:4px}";
    document.head.appendChild(st);
  }
  // Tap "Play video": only now is anything loaded from the video site
  document.addEventListener("click", function (e) {
    const b = e.target.closest && e.target.closest(".sm-play"); if (!b) return;
    const f = document.createElement("iframe");
    f.src = b.dataset.smSrc; f.title = "Video from " + b.dataset.smSite; f.loading = "lazy"; f.allowFullscreen = true;
    f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen"; f.referrerPolicy = "strict-origin-when-cross-origin";
    f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation allow-popups");
    b.replaceWith(f);
  });

  window.StoryMedia = { parse, check, html };
})();
