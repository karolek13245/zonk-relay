import test, { mock } from "node:test";
import assert from "node:assert/strict";
import worker, { Directory, checkRelay, clearListCache } from "../directory/src/index.js";
import {
  DROP_AFTER_MS,
  MAX_RELAYS,
  ONLINE_WINDOW_MS,
  cleanRelayUrl,
  pageHtml,
  readHealth,
  sortRelays,
  subdomainOf,
} from "../directory/src/rules.js";

const BASE = "https://list.test";
const A = "https://zonk-relay.alice.workers.dev";
const B = "https://relay-b.bob.workers.dev";

// ---------- pretend storage and pretend relays ----------

function fakeStorage() {
  const map = new Map();
  let alarm = null;
  return {
    map,
    get: async (k) => map.get(k),
    put: async (k, v) => void map.set(k, structuredClone(v)),
    delete: async (k) => map.delete(k),
    list: async ({ prefix = "" } = {}) => new Map([...map].filter(([k]) => k.startsWith(prefix))),
    getAlarm: async () => alarm,
    setAlarm: async (t) => void (alarm = t),
    alarmAt: () => alarm,
  };
}

function newDirectory() {
  const storage = fakeStorage();
  return { dir: new Directory({ storage }, {}), storage };
}

const healthBody = (over = {}) => ({ service: "zonk-relay", version: "0.2.0", public: true, ready: true, hosts: 1, models: ["Qwen2.5 1.5B"], ...over });

/** Replaces fetch: `relays` maps an address to what its /health should do (an object, a number for a status, or an Error). */
function pretendRelays(relays) {
  const calls = [];
  const m = mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), init });
    const origin = String(url).replace(/\/health$/, "");
    const what = relays[origin];
    if (what instanceof Error) throw what;
    if (typeof what === "number") return new Response("", { status: what });
    if (what === undefined) throw new TypeError("fetch failed");
    return new Response(typeof what === "string" ? what : JSON.stringify(what), { status: 200 });
  });
  return { calls, restore: () => m.mock.restore() };
}

const register = (dir, body, ip = "203.0.113.1") =>
  dir.fetch(new Request(`${BASE}/register`, {
    method: "POST",
    headers: { "x-zonk-ip": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

const listed = async (dir, all = false) => (await (await dir.fetch(new Request(`${BASE}/relays${all ? "?all=1" : ""}`))).json()).relays;

// ---------- rules ----------

test("cleanRelayUrl: only name.account.workers.dev over https, nothing else", () => {
  assert.equal(cleanRelayUrl("https://zonk-relay.alice.workers.dev"), A);
  assert.equal(cleanRelayUrl("  https://Zonk-Relay.Alice.workers.dev/ "), A);
  for (const bad of [
    "http://zonk-relay.alice.workers.dev",
    "https://zonk-relay.alice.workers.dev:8443",
    "https://zonk-relay.alice.workers.dev/health",
    "https://zonk-relay.alice.workers.dev/?x=1",
    "https://zonk-relay.alice.workers.dev/#x",
    "https://user:pw@zonk-relay.alice.workers.dev",
    "https://zonk-relay.alice.workers.dev@evil.example",
    "https://zonk-relay.alice.workers.dev.evil.example",
    "https://evil.example/zonk-relay.alice.workers.dev",
    "https://alice.workers.dev",
    "https://a.b.c.workers.dev",
    "https://workers.dev",
    "https://-bad.alice.workers.dev",
    "https://zonk-relay.alice.pages.dev",
    "https://127.0.0.1",
    "https://localhost",
    "https://zonk-relay.alice.workers.dev.",
    "ftp://zonk-relay.alice.workers.dev",
    "javascript:alert(1)",
    "not a url",
    "",
    null,
    undefined,
    42,
    {},
    "https://" + "a".repeat(64) + ".alice.workers.dev",
    "https://zonk-relay.alice.workers.dev/" + "x".repeat(300),
  ]) {
    assert.equal(cleanRelayUrl(bad), null, String(bad));
  }
  assert.equal(subdomainOf(A), "zonk-relay.alice");
});

test("readHealth: accepts a ready public relay, cleans what it says, refuses everything else", () => {
  assert.deepEqual(readHealth(healthBody()), { hosts: 1, models: ["Qwen2.5 1.5B"], version: "0.2.0" });
  assert.deepEqual(readHealth(healthBody({ hosts: 0, models: undefined })), { hosts: 0, models: [], version: "0.2.0" });
  assert.equal(readHealth(healthBody({ hosts: -3 })).hosts, 0);
  assert.equal(readHealth(healthBody({ hosts: 1.5 })).hosts, 0);
  assert.equal(readHealth(healthBody({ hosts: 5000 })).hosts, 99);
  // Strings from another server are cleaned: no tags, no quotes, short.
  const dirty = readHealth(healthBody({ models: ['<img src=x onerror=alert(1)>', "ok model", 5, "x".repeat(200), "", "a", "b", "c", "d"], version: "1.0<script>" }));
  assert.ok(dirty.models.every((m) => !/[<>"'=]/.test(m) && m.length <= 60));
  assert.ok(dirty.models.includes("ok model"));
  assert.ok(dirty.models.length <= 5);
  assert.equal(dirty.version, "1.0script");
  for (const bad of [
    null, "x", 5, [], {},
    healthBody({ service: "other" }),
    healthBody({ public: false }),
    healthBody({ public: "true" }),
    healthBody({ ready: false }),
  ]) {
    assert.equal(readHealth(bad), null, JSON.stringify(bad));
  }
});

test("sortRelays: online with a phone first, then online without, then offline", () => {
  const r = (sub, online, hosts) => ({ sub, online, hosts });
  const order = sortRelays([r("d", false, 0), r("c", true, 0), r("b", true, 2), r("a", true, 1), r("e", false, 3)]).map((x) => x.sub);
  assert.deepEqual(order, ["b", "a", "c", "e", "d"]);
});

// ---------- the page ----------

test("page: script carries the nonce, shows other people's text safely", () => {
  const html = pageHtml("NONCE123");
  assert.match(html, /<script nonce="NONCE123">/);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(html), "text from relays is only ever put in with textContent");
  assert.ok(!/ on[a-z]+=/i.test(html), "no inline event handlers");
  assert.match(html, /\/relays\?all=1/);
  assert.match(html, /setInterval/);
});

// ---------- registering ----------

test("register: a public relay that answers is listed", async () => {
  const net = pretendRelays({ [A]: healthBody() });
  try {
    const { dir, storage } = newDirectory();
    const r = await register(dir, { url: A + "/" });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, url: A });
    const [one] = await listed(dir);
    assert.equal(one.url, A);
    assert.equal(one.sub, "zonk-relay.alice");
    assert.equal(one.online, true);
    assert.equal(one.hosts, 1);
    assert.deepEqual(one.models, ["Qwen2.5 1.5B"]);
    assert.ok(storage.alarmAt() > Date.now(), "a check is planned");
    // The list asked the relay itself, once, without following redirects.
    assert.equal(net.calls.length, 1);
    assert.equal(net.calls[0].url, A + "/health");
    assert.equal(net.calls[0].init.redirect, "manual");
  } finally {
    net.restore();
  }
});

test("register: announcing again right away does not check again", async () => {
  const net = pretendRelays({ [A]: healthBody() });
  try {
    const { dir } = newDirectory();
    await register(dir, { url: A });
    const again = await register(dir, { url: A });
    assert.equal(again.status, 200);
    assert.equal(net.calls.length, 1);
    assert.equal((await listed(dir)).length, 1);
  } finally {
    net.restore();
  }
});

test("register: refuses addresses that are not relays, and never calls them", async () => {
  const net = pretendRelays({});
  try {
    const { dir } = newDirectory();
    for (const url of ["https://evil.example", "http://a.b.workers.dev", "https://127.0.0.1", "https://a.b.workers.dev:444", "nope", 5, null]) {
      const r = await register(dir, { url });
      assert.equal(r.status, 400, String(url));
      assert.equal((await r.json()).error.type, "invalid_request");
    }
    for (const body of ["", "not json", "null", "[]", '"x"']) assert.equal((await register(dir, body)).status, 400, body);
    assert.equal(net.calls.length, 0, "nothing outside workers.dev is ever contacted");
    assert.deepEqual(await listed(dir, true), []);
  } finally {
    net.restore();
  }
});

test("register: an address that does not answer like a public relay is not listed", async () => {
  const cases = {
    private: healthBody({ public: false }),
    "not ready": healthBody({ ready: false }),
    "other service": { service: "something-else", public: true },
    "plain page": "<html>hello</html>",
    "http error": 500,
    redirect: 301,
    unreachable: new Error("boom"),
  };
  for (const [name, answer] of Object.entries(cases)) {
    const net = pretendRelays({ [A]: answer });
    try {
      const { dir } = newDirectory();
      const r = await register(dir, { url: A });
      assert.equal(r.status, 400, name);
      assert.equal((await r.json()).error.type, "not_a_relay", name);
      assert.deepEqual(await listed(dir, true), [], name);
    } finally {
      net.restore();
    }
  }
});

test("register: a huge answer from the relay is not read", async () => {
  const net = pretendRelays({ [A]: JSON.stringify({ ...healthBody(), junk: "x".repeat(10_000) }) });
  try {
    const { dir } = newDirectory();
    const r = await register(dir, { url: A });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error.message, /too big/);
  } finally {
    net.restore();
  }
});

test("register: limits per address and for everyone", async () => {
  const net = pretendRelays({ [A]: healthBody() });
  try {
    const { dir } = newDirectory();
    const codes = [];
    for (let i = 0; i < 32; i++) codes.push((await register(dir, { url: "https://nope.example" }, "198.51.100.1")).status);
    assert.equal(codes.filter((c) => c === 400).length, 30);
    assert.deepEqual(codes.slice(30), [429, 429]);
    assert.equal((await register(dir, { url: A }, "198.51.100.2")).status, 200, "another address still gets through");

    const { dir: dir2 } = newDirectory();
    let refused = 0;
    for (let i = 0; i < 125; i++) {
      if ((await register(dir2, { url: "https://nope.example" }, "10.0.0." + i)).status === 429) refused++;
    }
    assert.equal(refused, 5, "120 announcements an hour in total");
  } finally {
    net.restore();
  }
});

test("register: the list is bounded", async () => {
  const net = pretendRelays({ [A]: healthBody(), [B]: healthBody() });
  try {
    const { dir, storage } = newDirectory();
    for (let i = 0; i < MAX_RELAYS - 1; i++) {
      storage.map.set(`r:https://r${i}.x.workers.dev`, { url: `https://r${i}.x.workers.dev`, sub: `r${i}.x`, firstSeen: 1, lastOk: Date.now(), lastCheck: 1, hosts: 0, models: [] });
    }
    assert.equal((await register(dir, { url: A })).status, 200, "the last free place");
    const full = await register(dir, { url: B });
    assert.equal(full.status, 503);
    assert.equal((await full.json()).error.type, "list_full");
    // A relay that is already listed can still refresh itself when the list is full.
    dir.recent.clear();
    assert.equal((await register(dir, { url: A })).status, 200);
  } finally {
    net.restore();
  }
});

// ---------- the list ----------

test("relays: offline ones are only shown when asked for", async () => {
  const { dir, storage } = newDirectory();
  const now = Date.now();
  const rec = (url, lastOk, hosts) => ({ url, sub: subdomainOf(url), firstSeen: now, lastOk, lastCheck: now, hosts, models: ["m"] });
  storage.map.set("r:" + A, rec(A, now - 1000, 1));
  storage.map.set("r:" + B, rec(B, now - ONLINE_WINDOW_MS - 1000, 2));
  assert.deepEqual((await listed(dir)).map((r) => r.url), [A]);
  const all = await listed(dir, true);
  assert.deepEqual(all.map((r) => [r.url, r.online]), [[A, true], [B, false]]);
});

// ---------- the regular check ----------

test("alarm: checks the relays, updates the answers, forgets the long gone", async () => {
  const now = Date.now();
  const net = pretendRelays({
    [A]: healthBody({ hosts: 3, models: ["new model"] }),
    [B]: new Error("down"),
  });
  try {
    const { dir, storage } = newDirectory();
    const rec = (url, over = {}) => ({ url, sub: subdomainOf(url), firstSeen: now - 5000, lastOk: now - 60_000, lastCheck: now - 60_000, hosts: 2, models: ["old"], ...over });
    storage.map.set("r:" + A, rec(A));
    storage.map.set("r:" + B, rec(B));
    const gone = "https://gone.carol.workers.dev";
    storage.map.set("r:" + gone, rec(gone, { lastOk: now - DROP_AFTER_MS - 1000 }));

    await dir.alarm();

    const a = storage.map.get("r:" + A);
    assert.equal(a.hosts, 3);
    assert.deepEqual(a.models, ["new model"]);
    assert.ok(a.lastOk >= now, "seen just now");
    const b = storage.map.get("r:" + B);
    assert.equal(b.hosts, 0, "a relay that does not answer has no phones for us");
    assert.equal(b.lastOk, now - 60_000, "and was not seen just now");
    assert.ok(b.lastCheck >= now);
    assert.equal(storage.map.has("r:" + gone), false);
    assert.equal(net.calls.some((c) => c.url.includes("gone.carol")), false, "no point asking a relay that is being dropped");
    assert.ok(storage.alarmAt() > Date.now(), "the next check is planned");
  } finally {
    net.restore();
  }
});

test("alarm: at most 40 relays per round, the ones checked longest ago first", async () => {
  const net = pretendRelays(new Proxy({}, { get: () => healthBody() }));
  try {
    const { dir, storage } = newDirectory();
    const now = Date.now();
    for (let i = 0; i < 45; i++) {
      const url = `https://r${i}.x.workers.dev`;
      storage.map.set("r:" + url, { url, sub: `r${i}.x`, firstSeen: now, lastOk: now - 1000, lastCheck: now - 100_000 + i, hosts: 0, models: [] });
    }
    await dir.alarm();
    assert.equal(net.calls.length, 40);
    const asked = new Set(net.calls.map((c) => c.url));
    for (let i = 0; i < 40; i++) assert.ok(asked.has(`https://r${i}.x.workers.dev/health`), `r${i}`);
    for (let i = 40; i < 45; i++) assert.ok(!asked.has(`https://r${i}.x.workers.dev/health`), `r${i} has to wait`);
  } finally {
    net.restore();
  }
});

test("alarm: nothing left means no more alarms", async () => {
  const { dir, storage } = newDirectory();
  await dir.alarm();
  assert.equal(storage.alarmAt(), null);
});

test("checkRelay: reasons are short sentences", async () => {
  const net = pretendRelays({ [A]: new DOMException("slow", "TimeoutError") });
  try {
    assert.match((await checkRelay(A)).reason, /in time/);
    assert.match((await checkRelay(B)).reason, /could not be reached/);
  } finally {
    net.restore();
  }
});

// ---------- the Worker in front ----------

function workerEnv(answer = { updated: 1, relays: [] }) {
  const seen = [];
  return {
    seen,
    env: {
      DIRECTORY: {
        idFromName: () => "main",
        get: () => ({
          fetch: async (request) => {
            seen.push({ url: new URL(request.url), headers: Object.fromEntries(request.headers) });
            return new Response(JSON.stringify(answer), { status: 200 });
          },
        }),
      },
    },
  };
}

const callWorker = (path, init, env) => worker.fetch(new Request(BASE + path, init), env);

test("Worker: home page has a nonce and a strict policy, new nonce every time", async () => {
  const { env } = workerEnv();
  const one = await callWorker("/", {}, env);
  const two = await callWorker("/", {}, env);
  assert.equal(one.status, 200);
  const csp = one.headers.get("content-security-policy");
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
  assert.match(await one.text(), new RegExp(`<script nonce="${nonce}">`));
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.notEqual(nonce, /script-src 'nonce-([^']+)'/.exec(two.headers.get("content-security-policy"))[1]);
  assert.equal((await callWorker("/", { method: "POST" }, env)).status, 405);
});

test("Worker: /health, unknown paths and methods", async () => {
  const { env, seen } = workerEnv();
  assert.deepEqual(await (await callWorker("/health", {}, env)).json(), { service: "zonk-relays", ok: true });
  assert.equal((await callWorker("/nope", {}, env)).status, 404);
  assert.equal((await callWorker("/constructor", {}, env)).status, 404);
  assert.equal((await callWorker("/relays", { method: "POST", body: "{}" }, env)).status, 405);
  assert.equal((await callWorker("/register", {}, env)).status, 405);
  assert.equal((await callWorker("/relays", { method: "OPTIONS" }, env)).status, 204);
  assert.deepEqual(seen, []);
});

test("Worker: /relays is answered from memory for a few seconds", async () => {
  clearListCache();
  const { env, seen } = workerEnv({ updated: 5, relays: [{ url: A }] });
  const first = await callWorker("/relays", {}, env);
  assert.equal(first.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await first.json(), { updated: 5, relays: [{ url: A }] });
  await callWorker("/relays", {}, env);
  await callWorker("/relays", {}, env);
  assert.equal(seen.length, 1);
  await callWorker("/relays?all=1", {}, env);
  assert.equal(seen.length, 2, "the full list is cached separately");
  assert.equal(seen[1].url.searchParams.get("all"), "1");
  assert.equal(seen[0].url.searchParams.get("all"), "0");
  clearListCache();
});

test("Worker: /register passes on the caller's address, whatever the caller claims", async () => {
  const { env, seen } = workerEnv({ ok: true });
  await callWorker("/register", {
    method: "POST",
    body: JSON.stringify({ url: A }),
    headers: { "cf-connecting-ip": "203.0.113.50", "x-zonk-ip": "1.2.3.4" },
  }, env);
  assert.equal(seen[0].headers["x-zonk-ip"], "203.0.113.50");
  assert.equal(seen[0].url.pathname, "/register");
});
