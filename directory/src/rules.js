// The rules of the relay list. Nothing from Cloudflare is imported here, so plain Node can test them.

/** The list never holds more relays than this. */
export const MAX_RELAYS = 300;
/** A relay counts as online when it answered a check within this time. */
export const ONLINE_WINDOW_MS = 6 * 60 * 1000;
/** A relay that has not answered for this long is removed from the list. */
export const DROP_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// Only <worker>.<account>.workers.dev. This keeps the list from being used to knock on any other address.
const RELAY_HOST = new RegExp(`^${LABEL}\\.${LABEL}\\.workers\\.dev$`);

/** "https://worker.account.workers.dev" (and nothing more), or null if [input] is not such an address. */
export function cleanRelayUrl(input) {
  if (typeof input !== "string" || input.length > 200) return null;
  let u;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (u.pathname !== "/" || u.search || u.hash) return null;
  if (!RELAY_HOST.test(u.hostname)) return null;
  return "https://" + u.hostname;
}

/** The name shown on the page: "worker.account" for worker.account.workers.dev. */
export function subdomainOf(url) {
  return new URL(url).hostname.replace(/\.workers\.dev$/, "");
}

/**
 * Reads what a relay's /health said. Returns a cleaned record, or null if this is not a ready, public Zonk relay.
 * Everything in the record is length-limited and stripped of odd characters, because it comes from someone else's server.
 */
export function readHealth(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  if (data.service !== "zonk-relay" || data.public !== true || data.ready === false) return null;
  const hosts = Number.isInteger(data.hosts) && data.hosts > 0 ? Math.min(data.hosts, 99) : 0;
  const models = (Array.isArray(data.models) ? data.models : [])
    .filter((m) => typeof m === "string")
    .map((m) => m.replace(/[^\p{L}\p{N} ._+:()/-]/gu, "").trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 5);
  const version = typeof data.version === "string" ? data.version.replace(/[^0-9A-Za-z.-]/g, "").slice(0, 20) : "";
  return { hosts, models, version };
}

/** What the list tells the outside world about one stored relay. */
export function relayView(record, now) {
  return {
    url: record.url,
    sub: record.sub,
    online: now - record.lastOk <= ONLINE_WINDOW_MS,
    hosts: record.hosts,
    models: record.models,
    seen: record.lastOk,
  };
}

/** Online relays first, those with a phone ready before those without, then by name. */
export function sortRelays(list) {
  return [...list].sort(
    (a, b) =>
      Number(b.online) - Number(a.online) ||
      Number(b.hosts > 0) - Number(a.hosts > 0) ||
      b.hosts - a.hosts ||
      a.sub.localeCompare(b.sub),
  );
}

export const REPO_URL = "https://github.com/karolek13245/zonk-relay";
export const APP_URL = "https://github.com/karolek13245/zonk-core";

/** The live page. It asks /relays every few seconds, so a new relay shows up by itself. */
export function pageHtml(nonce) {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zonk Relays</title>
<style>
  :root { color-scheme: dark; --bg:#0b0b0f; --card:#16161d; --text:#ececf1; --sub:#a0a0ad; --line:#272732; --green:#34c759; --amber:#ff9f0a; --grey:#6b6b78; --blue:#6ea0ff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font: 500 40px/1.1 Georgia,'Times New Roman',serif; margin: 0 0 8px; }
  h2 { font-size: 15px; font-weight: 600; margin: 32px 0 8px; }
  p { margin: 0 0 12px; }
  .sub { color: var(--sub); }
  .small { font-size: 13px; }
  #list { display:flex; flex-direction:column; gap:8px; margin-top: 16px; }
  .row { display:flex; gap:12px; align-items:flex-start; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:12px 14px; }
  .row.fresh { animation: pop 2.4s ease-out; }
  @keyframes pop { 0% { border-color: var(--blue); background:#1b2232; } 100% { border-color: var(--line); background: var(--card); } }
  .dot { width:10px; height:10px; border-radius:50%; margin-top:7px; flex:none; background:var(--grey); }
  .dot.on { background:var(--green); } .dot.wait { background:var(--amber); }
  .name { font-weight:600; overflow-wrap:anywhere; }
  .name span { font-weight:400; color:var(--sub); }
  .meta { color:var(--sub); font-size:14px; }
  .empty { padding: 20px 4px; color: var(--sub); }
  a { color: var(--blue); }
  code { background:var(--card); border:1px solid var(--line); border-radius:6px; padding:1px 6px; font-size:14px; }
</style>
<body><main>
  <h1>Zonk Relays</h1>
  <p class="sub">Public relays that share the AI model of a phone. This list updates by itself when a relay appears or goes away.</p>
  <p id="summary" class="sub small" aria-live="polite">Loading&hellip;</p>
  <div id="list" role="list"></div>

  <h2>Add your own relay</h2>
  <p class="sub">Deploy a relay to your own Cloudflare account, switch on public mode, and start sharing from the Zonk-Core app. It shows up here within a minute. Step by step: <a href="${REPO_URL}#readme" rel="noopener">the relay README</a>.</p>

  <h2>Please note</h2>
  <p class="sub small">Whatever you send through a shared relay is handled by the phone behind it and by its owner. Don't send passwords or private information. The Zonk-Core app is at <a href="${APP_URL}" rel="noopener">${APP_URL.replace("https://", "")}</a>.</p>
</main>
<script nonce="${nonce}">
(function () {
  var list = document.getElementById("list");
  var summary = document.getElementById("summary");
  var known = null;

  function ago(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return "just now";
    var m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    var h = Math.round(m / 60);
    if (h < 48) return h + " h ago";
    return Math.round(h / 24) + " days ago";
  }

  function status(r) {
    if (!r.online) return { cls: "off", text: "offline" };
    if (r.hosts > 0) return { cls: "on", text: r.hosts + (r.hosts === 1 ? " phone" : " phones") + " online" };
    return { cls: "wait", text: "waiting for a phone" };
  }

  function row(r, fresh) {
    var st = status(r);
    var el = document.createElement("div");
    el.className = "row" + (fresh ? " fresh" : "");
    el.setAttribute("role", "listitem");
    var dot = document.createElement("span");
    dot.className = "dot " + st.cls;
    var box = document.createElement("div");
    var name = document.createElement("div");
    name.className = "name";
    name.appendChild(document.createTextNode(r.sub));
    var tld = document.createElement("span");
    tld.textContent = ".workers.dev";
    name.appendChild(tld);
    var meta = document.createElement("div");
    meta.className = "meta";
    var bits = [st.text];
    if (r.models.length) bits.push(r.models.join(", "));
    bits.push("seen " + ago(Date.now() - r.seen));
    meta.textContent = bits.join(" \\u00b7 ");
    box.appendChild(name);
    box.appendChild(meta);
    el.appendChild(dot);
    el.appendChild(box);
    return el;
  }

  function render(relays) {
    var first = known === null;
    var next = {};
    list.textContent = "";
    relays.forEach(function (r) {
      next[r.url] = true;
      list.appendChild(row(r, !first && !known[r.url]));
    });
    known = next;
    if (relays.length === 0) {
      var e = document.createElement("div");
      e.className = "empty";
      e.textContent = "No relays yet. Be the first: add yours with the steps below.";
      list.appendChild(e);
    }
    var ready = relays.filter(function (r) { return r.online && r.hosts > 0; }).length;
    summary.textContent = relays.length === 0 ? "" :
      ready + " of " + relays.length + (relays.length === 1 ? " relay" : " relays") + " ready right now. Checked just now.";
  }

  function refresh() {
    fetch("/relays?all=1", { cache: "no-store" })
      .then(function (res) { if (!res.ok) throw new Error("bad answer"); return res.json(); })
      .then(function (data) { render(data.relays || []); })
      .catch(function () { summary.textContent = "Could not load the list. Trying again\\u2026"; });
  }

  refresh();
  setInterval(function () { if (!document.hidden) refresh(); }, 10000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
})();
</script>
</html>`;
}
