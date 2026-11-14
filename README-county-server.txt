RUNNING THE CEMETERY MAP ON A COUNTY SERVER
===========================================

What this is
  county-server.mjs is one small program. It serves the map, survey and editor from a folder,
  and lets the editor's Publish button save data into that folder. It replaces GitHub.
  It needs Node.js 18 or newer and nothing else. No database, no installs.

Set it up
  1. In the editor: File > Back Up Everything. Unzip it. The "site" folder inside is the whole map.
  2. Put that "site" folder and county-server.mjs on the server.
  3. Pick a publish key: a long secret of your own, 16 characters or more.
  4. Start it:
       Linux:    PUBLISH_KEY="your-long-secret" node county-server.mjs --dir ./site --port 8080
       Windows:  $env:PUBLISH_KEY="your-long-secret"; node county-server.mjs --dir .\site --port 8080
  5. Put HTTPS in front of it (IIS, nginx, Caddy or Cloudflare) and give it an address,
     for example https://cemeteries.example.gov
  6. In the editor at that address: the gear next to Publish > "A county server" >
     type the address and the key > Test > tick "Make this the destination for everyone" > Save > Publish.

What Publish may do
  - It needs the key. Reading the map never does.
  - It can only save data files: .csv .json .geojson and pictures. It cannot replace a page or a script.
  - Each file it replaces is first copied to site/.history/<date and time>/, which is never served to the public.
  - Largest single file: 30 MB (set MAX_MB to change it).
  - To allow publishing only from one site, set ALLOW_ORIGIN to that site's address.

Back it up
  Copy the site folder (including .history). That is everything.

The survey inbox
  The inbox (surveys and stories waiting for review) is separate and stays on Cloudflare.
  Its address is the "inbox" line in site/settings.json and does not change when the map moves.

Using a different server instead
  Anything that answers these three requests works with the editor (each carries
  "Authorization: Bearer <publish key>"):
    GET  /files          -> { "ok": true, "files": ["cemlist.csv", "photos/UC001.jpg", ...] }
    GET  /files/<path>   -> that file, or 404
    PUT  /files/<path>   -> save the request body as that file
