import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { Relay } from "../src/index.js";
import { RateLimiter, VERSION, announce, configProblem, isPublic } from "../src/guards.js";

const API_KEY = "A".repeat(24);
const HOST_TOKEN = "H".repeat(24);
const BASE = "https://relay.test";
const DIRECTORY = "https://zonk-relays.example.workers.dev";

// ---------- small helpers (a pretend Durable Object with pretend phones) ----------

function newRelay(env = {}) {
  const sockets = [];
  const ctx = {
    sockets,
    setWebSocketAutoResponse() {},
    getWebSockets: () => sockets,
    acceptWebSocket: (ws) => sockets.push(ws),
    waitUntil() {},
  };
  return { relay: new Relay(ctx, { REQUEST_TIMEOUT_SECONDS: "120", ...env }), ctx };
}

function addPhone(relay, ctx, model = "model-a") {
  let attachment = { ready: false };
  const ws = {
    sent: [],
    send(m) { this.sent.push(JSON.parse(m)); },
    close() {},
    serializeAttachment(v) { attachment = v; },
    deserializeAttachment() { return attachment; },
  };
  ctx.sockets.push(ws);
  relay.webSocketMessage(ws, JSON.stringify({ type: "hello", model, name: "phone" }));
  return ws;
}

/** A Worker environment whose Durable Object records every request it receives. */
function workerEnv(over = {}, objectAnswer = { hosts: 2, models: ["m1"] }) {
  const seen = [];
  const env = {
    API_KEY,
    HOST_TOKEN,
    RELAY: {
      idFromName: () => "main",
      get: () => ({
        fetch: async (request) => {
          seen.push({ path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers) });
          if (objectAnswer instanceof Error) throw objectAnswer;
          return new Response(JSON.stringify(objectAnswer), { status: 200 });
        },
      }),
    },
    ...over,
  };
  return { env, seen };
}

const call = (path, { key, method = "GET", headers = {}, body } = {}, env) =>
  worker.fetch(
    new Request(BASE + path, {
      method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      body,
    }),
    env,
  );

const chat = (over = {}) => ({ messages: [{ role: "user", content: "hello" }], ...over });
const post = (ip) => new Request(`${BASE}/v1/chat/completions`, {
  method: "POST",
  headers: { "x-zonk-anon": "1", "x-zonk-ip": ip },
  body: JSON.stringify(chat()),
});

// ---------- version, settings ----------

test("the version in the code matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, pkg.version);
});

test("isPublic and configProblem for a public relay", () => {
  for (const v of ["1", "true", "TRUE", " yes ", "on"]) assert.equal(isPublic({ PUBLIC_MODE: v }), true, v);
  for (const v of [undefined, "", "0", "false", "no", "off", "maybe"]) assert.equal(isPublic({ PUBLIC_MODE: v }), false, String(v));

  const host = { HOST_TOKEN };
  assert.match(configProblem(host), /API_KEY/, "a private relay needs the API key");
  assert.equal(configProblem({ ...host, PUBLIC_MODE: "true" }), null, "a public relay does not");
  assert.match(configProblem({ PUBLIC_MODE: "true" }), /HOST_TOKEN/, "but always needs the host token");
  assert.match(configProblem({ HOST_TOKEN: "short", PUBLIC_MODE: "true" }), /at least 16/);
  // An API key that is given still has to be sound, even on a public relay.
  assert.match(configProblem({ ...host, API_KEY: "short", PUBLIC_MODE: "true" }), /at least 16/);
  assert.match(configProblem({ ...host, API_KEY: HOST_TOKEN, PUBLIC_MODE: "true" }), /different/);
});

// ---------- /health ----------

test("/health: a private relay only says that it exists", async () => {
  const { env, seen } = workerEnv();
  const r = await call("/health", {}, env);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { service: "zonk-relay", version: VERSION, public: false, ready: true });
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(seen, [], "a private relay does not even ask the Durable Object");
});

test("/health: a public relay tells how many phones are ready, with no key", async () => {
  const { env, seen } = workerEnv({ PUBLIC_MODE: "true" });
  const r = await call("/health", {}, env);
  assert.deepEqual(await r.json(), { service: "zonk-relay", version: VERSION, public: true, ready: true, hosts: 2, models: ["m1"] });
  assert.deepEqual(seen.map((s) => s.path), ["/health"]);
});

test("/health: public relay whose Durable Object fails reports no phones", async () => {
  const { env } = workerEnv({ PUBLIC_MODE: "true" }, new Error("restarting"));
  const body = await (await call("/health", {}, env)).json();
  assert.equal(body.ready, true);
  assert.equal(body.hosts, 0);
  assert.deepEqual(body.models, []);
});

test("/health: not set up -> not ready, never public, and no secrets named", async () => {
  const { env } = workerEnv({ HOST_TOKEN: undefined, PUBLIC_MODE: "true" });
  const r = await call("/health", {}, env);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.deepEqual(JSON.parse(text), { service: "zonk-relay", version: VERSION, public: false, ready: false });
  assert.ok(!/HOST_TOKEN|API_KEY/.test(text));
});

test("/health: GET only", async () => {
  const { env } = workerEnv();
  assert.equal((await call("/health", { method: "POST", body: "{}" }, env)).status, 405);
});

// ---------- anonymous use of a public relay ----------

test("public relay: chat and models work without a key, status does not", async () => {
  const { env, seen } = workerEnv({ PUBLIC_MODE: "true" });
  assert.equal((await call("/v1/chat/completions", { method: "POST", body: "{}" }, env)).status, 200);
  assert.equal((await call("/v1/models", {}, env)).status, 200);
  assert.equal((await call("/status", {}, env)).status, 401);
  assert.equal((await call("/status", { key: "wrong-key-0123456789" }, env)).status, 401);
  assert.deepEqual(seen.map((s) => s.path), ["/v1/chat/completions", "/v1/models"]);
});

test("public relay: the object is told who is anonymous, and the key is not passed on", async () => {
  const { env, seen } = workerEnv({ PUBLIC_MODE: "true" });
  await call("/v1/chat/completions", { method: "POST", body: "{}", headers: { "cf-connecting-ip": "203.0.113.7" } }, env);
  await call("/v1/chat/completions", { key: API_KEY, method: "POST", body: "{}", headers: { "cf-connecting-ip": "203.0.113.8" } }, env);
  assert.equal(seen[0].headers["x-zonk-anon"], "1");
  assert.equal(seen[0].headers["x-zonk-ip"], "203.0.113.7");
  assert.equal(seen[1].headers["x-zonk-anon"], "0", "someone with the real key is not anonymous");
  assert.equal(seen[1].headers.authorization, undefined, "the API key stops at the Worker");
});

test("public relay: a caller cannot pretend to have a key by sending the internal headers", async () => {
  const { env, seen } = workerEnv({ PUBLIC_MODE: "true" });
  await call("/v1/chat/completions", {
    method: "POST", body: "{}",
    headers: { "x-zonk-anon": "0", "x-zonk-ip": "1.1.1.1", "cf-connecting-ip": "203.0.113.9" },
  }, env);
  assert.equal(seen[0].headers["x-zonk-anon"], "1");
  assert.equal(seen[0].headers["x-zonk-ip"], "203.0.113.9");
});

test("public relay without any API key set still works", async () => {
  const { env } = workerEnv({ PUBLIC_MODE: "true", API_KEY: undefined });
  assert.equal((await call("/v1/chat/completions", { method: "POST", body: "{}" }, env)).status, 200);
  assert.equal((await call("/status", {}, env)).status, 401);
});

test("private relay: anonymous callers are still refused", async () => {
  const { env, seen } = workerEnv({ PUBLIC_MODE: "false" });
  assert.equal((await call("/v1/chat/completions", { method: "POST", body: "{}" }, env)).status, 401);
  assert.equal((await call("/v1/models", {}, env)).status, 401);
  assert.deepEqual(seen, []);
});

// ---------- the object: rate limit for anonymous callers ----------

test("anonymous callers: 20 requests a minute per address, then 429", async () => {
  const { relay } = newRelay({ PUBLIC_MODE: "true" });
  // No phone is online, so every allowed request ends in 503. A refused one ends in 429.
  const codes = [];
  for (let i = 0; i < 22; i++) codes.push((await relay.fetch(post("198.51.100.1"))).status);
  assert.equal(codes.filter((c) => c === 503).length, 20);
  assert.deepEqual(codes.slice(20), [429, 429]);
  const limited = await relay.fetch(post("198.51.100.1"));
  assert.equal((await limited.json()).error.type, "rate_limited");
  assert.equal((await relay.fetch(post("198.51.100.2"))).status, 503, "another address is not affected");
});

test("callers with the key are never rate limited", async () => {
  const { relay } = newRelay({ PUBLIC_MODE: "true" });
  for (let i = 0; i < 30; i++) {
    const r = await relay.fetch(new Request(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-zonk-anon": "0", "x-zonk-ip": "198.51.100.1" },
      body: JSON.stringify(chat()),
    }));
    assert.equal(r.status, 503);
  }
});

test("RateLimiter: sliding window and bounded memory", () => {
  const rl = new RateLimiter(2, 1000, 3);
  assert.equal(rl.allow("a", 0), true);
  assert.equal(rl.allow("a", 10), true);
  assert.equal(rl.allow("a", 20), false);
  assert.equal(rl.allow("b", 20), true);
  assert.equal(rl.allow("a", 1001), true, "the first hit has left the window");
  assert.equal(rl.allow("a", 1005), false, "the second hit and the new one are both inside the window");
  assert.equal(rl.allow("a", 1011), true, "the second hit has left the window too");
  for (const k of ["c", "d", "e"]) rl.allow(k, 2000);
  assert.ok(rl.hits.size <= 3, "no more than maxKeys addresses are remembered");
});

// ---------- the object: /health and announcing to the relay list ----------

const healthRequest = (host = "zonk-relay.me.workers.dev") => new Request(`https://${host}/health`);

test("object /health: phones and their models", async () => {
  const { relay, ctx } = newRelay();
  assert.deepEqual(await (await relay.fetch(healthRequest())).json(), { hosts: 0, models: [] });
  addPhone(relay, ctx, "model-a");
  addPhone(relay, ctx, "model-a");
  addPhone(relay, ctx, "model-b");
  assert.deepEqual(await (await relay.fetch(healthRequest())).json(), { hosts: 3, models: ["model-a", "model-b"] });
});

function withFetchMock(fn) {
  const m = mock.method(globalThis, "fetch", fn);
  return m;
}

test("announce: a public relay on workers.dev tells the list once, not on every visit", async () => {
  const m = withFetchMock(async () => new Response("{}", { status: 200 }));
  const log = mock.method(console, "log", () => {});
  try {
    const { relay } = newRelay({ PUBLIC_MODE: "true", DIRECTORY_URL: DIRECTORY + "/" });
    await relay.fetch(healthRequest());
    await relay.fetch(healthRequest());
    await relay.fetch(new Request("https://zonk-relay.me.workers.dev/host", { headers: { upgrade: "websocket" } })).catch(() => {});
    assert.equal(m.mock.callCount(), 1);
    const [url, init] = m.mock.calls[0].arguments;
    assert.equal(url, DIRECTORY + "/register");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), { url: "https://zonk-relay.me.workers.dev" });
  } finally {
    m.mock.restore();
    log.mock.restore();
  }
});

test("announce: never for a private relay, another host, an empty or insecure list address", async () => {
  const m = withFetchMock(async () => new Response("{}"));
  try {
    const cases = [
      [{ PUBLIC_MODE: "false", DIRECTORY_URL: DIRECTORY }, "zonk-relay.me.workers.dev"],
      [{ PUBLIC_MODE: "true", DIRECTORY_URL: DIRECTORY }, "relay.example.com"],
      [{ PUBLIC_MODE: "true", DIRECTORY_URL: "" }, "zonk-relay.me.workers.dev"],
      [{ PUBLIC_MODE: "true" }, "zonk-relay.me.workers.dev"],
      [{ PUBLIC_MODE: "true", DIRECTORY_URL: "http://insecure.example.workers.dev" }, "zonk-relay.me.workers.dev"],
    ];
    for (const [env, host] of cases) {
      const { relay } = newRelay(env);
      assert.equal((await relay.fetch(healthRequest(host))).status, 200);
    }
    assert.equal(m.mock.callCount(), 0);
  } finally {
    m.mock.restore();
  }
});

test("announce: a list that is down does not break /health", async () => {
  const m = withFetchMock(async () => { throw new Error("network down"); });
  const log = mock.method(console, "log", () => {});
  try {
    const { relay } = newRelay({ PUBLIC_MODE: "true", DIRECTORY_URL: DIRECTORY });
    assert.equal((await relay.fetch(healthRequest())).status, 200);
    assert.equal(await announce(DIRECTORY, "https://a.b.workers.dev"), 0);
  } finally {
    m.mock.restore();
    log.mock.restore();
  }
});
