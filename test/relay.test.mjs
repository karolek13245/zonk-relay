import test, { mock } from "node:test";
import assert from "node:assert/strict";
import worker, { Relay } from "../src/index.js";
import { MAX_BODY_BYTES } from "../src/guards.js";

const API_KEY = "A".repeat(24);
const HOST_TOKEN = "H".repeat(24);
const BASE = "https://relay.test";

// ---------- a pretend Durable Object, with pretend phones ----------

function fakeCtx() {
  const sockets = [];
  return {
    sockets,
    setWebSocketAutoResponse() {},
    getWebSockets: () => sockets,
    acceptWebSocket: (ws) => sockets.push(ws),
  };
}

function newRelay(env = {}) {
  const ctx = fakeCtx();
  const relay = new Relay(ctx, { REQUEST_TIMEOUT_SECONDS: "120", ...env });
  return { relay, ctx };
}

function addPhone(relay, ctx, { model = "model-a", name = "phone-a", hello = true } = {}) {
  let attachment = { ready: false };
  const ws = {
    sent: [],
    closed: false,
    send(m) { this.sent.push(JSON.parse(m)); },
    close() { this.closed = true; },
    serializeAttachment(v) { attachment = v; },
    deserializeAttachment() { return attachment; },
  };
  ctx.sockets.push(ws);
  if (hello) relay.webSocketMessage(ws, JSON.stringify({ type: "hello", model, name }));
  return ws;
}

const tick = () => new Promise((r) => setImmediate(r));
async function until(cond) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  assert.ok(cond(), "condition was not reached");
}

const chatRequest = (body, init = {}) =>
  new Request(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });

const hi = (extra = {}) => ({ messages: [{ role: "user", content: "hello" }], ...extra });

// ---------- the Worker in front (login, methods, sizes) ----------

function workerEnv(over = {}) {
  const calls = [];
  const env = {
    API_KEY,
    HOST_TOKEN,
    RELAY: {
      idFromName: () => "main",
      get: () => ({
        fetch: async (request) => {
          calls.push(new URL(request.url).pathname);
          return new Response("from-the-object", { status: 200 });
        },
      }),
    },
    ...over,
  };
  return { env, calls };
}

const call = (path, { key = API_KEY, method = "GET", headers = {}, body } = {}, env) =>
  worker.fetch(
    new Request(BASE + path, {
      method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      body,
    }),
    env,
  );

test("home page: served without a key, with safe headers", async () => {
  const { env } = workerEnv();
  const r = await call("/", { key: null }, env);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Zonk Relay/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal((await call("/", { key: null, method: "POST" }, env)).status, 405);
});

test("options and unknown paths", async () => {
  const { env } = workerEnv();
  const o = await call("/v1/chat/completions", { key: null, method: "OPTIONS" }, env);
  assert.equal(o.status, 204);
  assert.equal(o.headers.get("access-control-allow-origin"), "*");
  assert.equal((await call("/nope", {}, env)).status, 404);
  assert.equal((await call("/v1/chat/completions/extra", {}, env)).status, 404);
  assert.equal((await call("/constructor", {}, env)).status, 404);
  assert.equal((await call("/__proto__", {}, env)).status, 404);
});

test("not configured: callers learn nothing about which secret is missing", async () => {
  for (const over of [{ API_KEY: undefined }, { HOST_TOKEN: undefined }, { API_KEY: "short" }, { HOST_TOKEN: API_KEY }]) {
    const { env, calls } = workerEnv(over);
    const log = mock.method(console, "error", () => {});
    const r = await call("/status", {}, env);
    log.mock.restore();
    assert.equal(r.status, 500);
    const text = await r.text();
    assert.match(text, /not configured/);
    assert.ok(!/API_KEY|HOST_TOKEN/.test(text));
    assert.deepEqual(calls, []);
  }
});

test("API paths: key required, right method required", async () => {
  const { env, calls } = workerEnv();
  for (const [path, method] of [["/status", "GET"], ["/v1/models", "GET"], ["/v1/chat/completions", "POST"]]) {
    assert.equal((await call(path, { key: null, method }, env)).status, 401, `${path} without key`);
    assert.equal((await call(path, { key: "wrong-key-0123456789", method }, env)).status, 401, `${path} wrong key`);
    assert.equal((await call(path, { key: HOST_TOKEN, method }, env)).status, 401, `${path} host token is not an API key`);
    const wrong = method === "GET" ? "POST" : "GET";
    assert.equal((await call(path, { method: wrong }, env)).status, 405, `${path} ${wrong}`);
    assert.equal((await call(path, { key: null, method: wrong }, env)).status, 401, `${path} ${wrong} without key stays 401`);
  }
  assert.deepEqual(calls, [], "nothing reached the Durable Object so far");
  assert.equal((await call("/status", {}, env)).status, 200);
  assert.equal((await call("/v1/chat/completions", { method: "POST", body: "{}" }, env)).status, 200);
  assert.deepEqual(calls, ["/status", "/v1/chat/completions"]);
});

test("API responses are never cached", async () => {
  const { env } = workerEnv();
  const r = await call("/status", { key: null }, env);
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});

test("oversized chat request is refused before it reaches the Durable Object", async () => {
  const { env, calls } = workerEnv();
  const r = await call("/v1/chat/completions", {
    method: "POST",
    headers: { "content-length": String(MAX_BODY_BYTES + 1) },
    body: "{}",
  }, env);
  assert.equal(r.status, 413);
  assert.deepEqual(calls, [], "nothing reached the Durable Object");
});

test("/host: token only from the header, WebSocket upgrade required", async () => {
  const { env, calls } = workerEnv();
  const ws = { upgrade: "websocket" };
  const host = (key, headers = ws) => call("/host", { key, headers }, env);

  assert.equal((await host(HOST_TOKEN, {})).status, 426);
  assert.equal((await host(null)).status, 401);
  assert.equal((await host(API_KEY)).status, 401, "the API key is not a host token");
  assert.equal((await host("wrong-token-0123456789")).status, 401);
  // A token in the address is no longer accepted.
  assert.equal((await call(`/host?token=${HOST_TOKEN}`, { key: null, headers: ws }, env)).status, 401);
  assert.equal((await call("/host", { key: HOST_TOKEN, method: "POST", headers: ws }, env)).status, 405);
  assert.deepEqual(calls, []);

  assert.equal((await host(HOST_TOKEN)).status, 200);
  assert.equal((await host(HOST_TOKEN, { upgrade: "WebSocket" })).status, 200, "Upgrade is case-insensitive");
  assert.deepEqual(calls, ["/host", "/host"]);
});

// ---------- the Durable Object (queue, phones, answers) ----------

test("chat: bad requests get 400, never a crash", async () => {
  const { relay, ctx } = newRelay();
  addPhone(relay, ctx);
  for (const body of ["null", "5", '"text"', "[]", "{}", '{"messages":[]}', '{"messages":[null]}', '{"messages":[{"role":"user","content":5}]}',
    '{"messages":[{"role":"boss","content":"x"}]}', "not json", "", '{"messages":[{"role":"user","content":[{"type":"image_url"}]}]}']) {
    const r = await relay.fetch(chatRequest(body));
    assert.equal(r.status, 400, body);
    assert.equal((await r.json()).error.type, "invalid_request");
  }
});

test("chat: a body bigger than the limit is cut off while it is being read", async () => {
  const { relay, ctx } = newRelay();
  addPhone(relay, ctx);
  const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
  let sent = 0;
  const stream = new ReadableStream({
    pull(controller) {
      sent += chunk.byteLength;
      controller.enqueue(chunk);
      if (sent > 10 * MAX_BODY_BYTES) controller.close();
    },
  });
  const r = await relay.fetch(new Request(`${BASE}/v1/chat/completions`, { method: "POST", body: stream, duplex: "half" }));
  assert.equal(r.status, 413);
  assert.ok(sent < 10 * MAX_BODY_BYTES, "reading stopped early");
});

test("chat: no phone online -> 503", async () => {
  const { relay } = newRelay();
  const r = await relay.fetch(chatRequest(hi()));
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.type, "no_host");
});

test("chat: the phone gets a cleaned request, the caller gets an OpenAI-style answer", async () => {
  const { relay, ctx } = newRelay();
  const phone = addPhone(relay, ctx, { model: "qwen-small", name: "my-phone" });
  const pending = relay.fetch(chatRequest({
    model: "whatever",
    temperature: 9,
    top_p: -3,
    max_tokens: 1e9,
    secret_extra: "should not travel on",
    messages: [{ role: "user", content: [{ type: "text", text: "hel" }, { type: "text", text: "lo" }], name: "x" }],
  }));
  await until(() => phone.sent.length === 1);
  const job = phone.sent[0];
  assert.equal(job.type, "request");
  assert.deepEqual(job.messages, [{ role: "user", content: "hel\nlo" }]);
  assert.deepEqual(job.options, { temperature: 2, top_p: 0, max_tokens: 4096 });
  assert.ok(!JSON.stringify(job).includes("secret_extra"));

  relay.webSocketMessage(phone, JSON.stringify({ type: "response", id: job.id, content: "hi there", promptTokens: 3, completionTokens: 4 }));
  const r = await pending;
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const j = await r.json();
  assert.equal(j.object, "chat.completion");
  assert.equal(j.model, "qwen-small");
  assert.equal(j.choices[0].message.content, "hi there");
  assert.deepEqual(j.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
});

test("chat: streaming answer ends with [DONE]", async () => {
  const { relay, ctx } = newRelay();
  const phone = addPhone(relay, ctx);
  const pending = relay.fetch(chatRequest(hi({ stream: true })));
  await until(() => phone.sent.length === 1);
  relay.webSocketMessage(phone, JSON.stringify({ type: "response", id: phone.sent[0].id, content: "streamed" }));
  const r = await pending;
  assert.equal(r.headers.get("content-type"), "text/event-stream");
  const text = await r.text();
  assert.match(text, /"content":"streamed"/);
  assert.ok(text.trimEnd().endsWith("data: [DONE]"));
});

test("chat: the phone's error text is shortened", async () => {
  const { relay, ctx } = newRelay();
  const phone = addPhone(relay, ctx);
  const pending = relay.fetch(chatRequest(hi()));
  await until(() => phone.sent.length === 1);
  relay.webSocketMessage(phone, JSON.stringify({ type: "error", id: phone.sent[0].id, message: "boom ".repeat(1000) }));
  const r = await pending;
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.error.type, "host_error");
  assert.ok(j.error.message.length <= 300);
});

test("chat: a request for a model goes to the phone that runs it", async () => {
  const { relay, ctx } = newRelay();
  const a = addPhone(relay, ctx, { model: "model-a", name: "a" });
  const b = addPhone(relay, ctx, { model: "model-b", name: "b" });
  const pending = relay.fetch(chatRequest(hi({ model: "model-b" })));
  await until(() => b.sent.length === 1);
  assert.equal(a.sent.length, 0);
  relay.webSocketMessage(b, JSON.stringify({ type: "response", id: b.sent[0].id, content: "from b" }));
  assert.equal((await (await pending).json()).choices[0].message.content, "from b");
});

test("a phone can't answer somebody else's request, and junk messages are ignored", async () => {
  const { relay, ctx } = newRelay();
  const a = addPhone(relay, ctx, { model: "model-a" });
  const b = addPhone(relay, ctx, { model: "model-b" });
  const pending = relay.fetch(chatRequest(hi({ model: "model-a" })));
  await until(() => a.sent.length === 1);
  const id = a.sent[0].id;
  for (const junk of ["null", "5", '"x"', "[]", "not json", JSON.stringify({ type: "response", id })]) {
    relay.webSocketMessage(b, junk);   // b does not own the job
  }
  relay.webSocketMessage(a, "null");
  relay.webSocketMessage(a, new ArrayBuffer(4));
  relay.webSocketMessage(a, JSON.stringify({ type: "response", id, content: "real answer" }));
  assert.equal((await (await pending).json()).choices[0].message.content, "real answer");
});

test("/status and /v1/models list the phones that said hello", async () => {
  const { relay, ctx } = newRelay();
  addPhone(relay, ctx, { model: "m1", name: "p1" });
  addPhone(relay, ctx, { model: "m2", name: "p2" });
  addPhone(relay, ctx, { hello: false });
  const s = await (await relay.fetch(new Request(`${BASE}/status`))).json();
  assert.deepEqual(s.hosts.map((h) => h.model).sort(), ["m1", "m2"]);
  const m = await (await relay.fetch(new Request(`${BASE}/v1/models`))).json();
  assert.deepEqual(m.data.map((x) => x.id).sort(), ["m1", "m2"]);
});

test("chat: a phone that never answers gets a 504 after the timeout", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { relay, ctx } = newRelay({ REQUEST_TIMEOUT_SECONDS: "120" });
    const phone = addPhone(relay, ctx);
    const pending = relay.fetch(chatRequest(hi()));
    await until(() => phone.sent.length === 1);
    mock.timers.tick(120_000);
    const r = await pending;
    assert.equal(r.status, 504);
    assert.ok(phone.sent.some((m) => m.type === "cancel"));
  } finally {
    mock.timers.reset();
  }
});
