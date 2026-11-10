import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MESSAGES,
  MAX_OUT_TOKENS,
  TooLarge,
  bearer,
  checkChatBody,
  configProblem,
  readTextLimited,
  safeEqual,
} from "../src/guards.js";

const req = (headers = {}) => new Request("https://relay.test/x", { headers });

test("bearer reads the token from the Authorization header only", () => {
  assert.equal(bearer(req({ authorization: "Bearer abc123" })), "abc123");
  assert.equal(bearer(req({ authorization: "bearer abc123" })), "abc123");
  assert.equal(bearer(req({ authorization: "Basic abc123" })), "");
  assert.equal(bearer(req({ authorization: "Bearer " })), "");
  assert.equal(bearer(req()), "");
  assert.equal(bearer(new Request("https://relay.test/host?token=abc123")), "");
});

test("safeEqual", async () => {
  assert.equal(await safeEqual("same-secret-value", "same-secret-value"), true);
  assert.equal(await safeEqual("same-secret-value", "same-secret-valuf"), false);
  assert.equal(await safeEqual("short", "a-much-longer-secret"), false);
  assert.equal(await safeEqual("", ""), false);
  assert.equal(await safeEqual("", "x"), false);
  assert.equal(await safeEqual("x", ""), false);
  assert.equal(await safeEqual(undefined, undefined), false);
  assert.equal(await safeEqual(undefined, "x"), false);
});

test("configProblem", () => {
  const ok = { API_KEY: "A".repeat(20), HOST_TOKEN: "H".repeat(20) };
  assert.equal(configProblem(ok), null);
  assert.match(configProblem({}), /missing/);
  assert.match(configProblem({ API_KEY: ok.API_KEY }), /missing/);
  assert.match(configProblem({ API_KEY: "", HOST_TOKEN: ok.HOST_TOKEN }), /missing/);
  assert.match(configProblem({ API_KEY: "short", HOST_TOKEN: ok.HOST_TOKEN }), /at least 16/);
  assert.match(configProblem({ API_KEY: ok.API_KEY, HOST_TOKEN: "short" }), /at least 16/);
  assert.match(configProblem({ API_KEY: ok.API_KEY, HOST_TOKEN: ok.API_KEY }), /different/);
  // The reason must never contain the secrets themselves.
  assert.ok(!String(configProblem({ API_KEY: "Z".repeat(15), HOST_TOKEN: ok.HOST_TOKEN })).includes("Z".repeat(15)));
});

function streamRequest(chunks, headers = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Request("https://relay.test/x", { method: "POST", body: stream, duplex: "half", headers });
}

test("readTextLimited: small bodies, exact limit, too big", async () => {
  assert.equal(await readTextLimited(new Request("https://relay.test/x", { method: "POST", body: '{"a":1}' }), 100), '{"a":1}');
  assert.equal(await readTextLimited(new Request("https://relay.test/x")), "");
  assert.equal(await readTextLimited(streamRequest(["12345", "67890"]), 10), "1234567890");
  await assert.rejects(() => readTextLimited(streamRequest(["12345", "678901"]), 10), TooLarge);
  // A request that says it is big is refused without reading it.
  await assert.rejects(() => readTextLimited(streamRequest(["x"], { "content-length": "999999" }), 10), TooLarge);
});

const msg = (extra = {}) => ({ messages: [{ role: "user", content: "hi" }], ...extra });

test("checkChatBody: accepts a normal request and keeps only what the phone needs", () => {
  const r = checkChatBody({
    model: "qwen",
    stream: true,
    temperature: 0.7,
    top_p: 0.9,
    max_tokens: 256,
    user: "someone",
    messages: [
      { role: "system", content: "be brief", name: "x" },
      { role: "user", content: "hi", tool_calls: [{}] },
    ],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.messages, [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(r.value.model, "qwen");
  assert.equal(r.value.stream, true);
  assert.deepEqual(r.value.options, { temperature: 0.7, top_p: 0.9, max_tokens: 256 });
});

test("checkChatBody: refuses bad shapes", () => {
  for (const body of [null, undefined, 5, "text", true, [], [msg()], {}, { messages: [] }, { messages: "hi" }, { messages: {} }]) {
    assert.equal(checkChatBody(body).ok, false, JSON.stringify(body));
  }
  for (const m of [null, 5, "hi", [], {}, { role: "user" }, { role: "robot", content: "x" }, { role: "user", content: 5 },
    { role: "user", content: null }, { role: "user", content: {} }, { role: "user", content: [] },
    { role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] },
    { role: "user", content: [{ type: "text" }] }, { role: "user", content: [null] }]) {
    assert.equal(checkChatBody({ messages: [m] }).ok, false, JSON.stringify(m));
  }
  const tooMany = { messages: Array.from({ length: MAX_MESSAGES + 1 }, () => ({ role: "user", content: "x" })) };
  assert.equal(checkChatBody(tooMany).ok, false);
  assert.equal(checkChatBody({ messages: tooMany.messages.slice(0, MAX_MESSAGES) }).ok, true);
});

test("checkChatBody: text parts are joined", () => {
  const r = checkChatBody({ messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] });
  assert.equal(r.ok, true);
  assert.equal(r.value.messages[0].content, "a\nb");
});

test("checkChatBody: options are clamped or dropped, never passed on as they are", () => {
  const o = (extra) => checkChatBody(msg(extra)).value.options;
  assert.deepEqual(o({ temperature: 99, top_p: -4, max_tokens: 1e9 }), { temperature: 2, top_p: 0, max_tokens: MAX_OUT_TOKENS });
  assert.deepEqual(o({ temperature: -1, max_tokens: 0 }), { temperature: 0, top_p: undefined, max_tokens: 1 });
  assert.deepEqual(o({ max_tokens: 12.9 }), { temperature: undefined, top_p: undefined, max_tokens: 12 });
  for (const junk of ["0.5", null, NaN, Infinity, {}, [], true]) {
    assert.deepEqual(o({ temperature: junk, top_p: junk, max_tokens: junk }), { temperature: undefined, top_p: undefined, max_tokens: undefined }, String(junk));
  }
});

test("checkChatBody: model and stream", () => {
  assert.equal(checkChatBody(msg({ model: "x".repeat(500) })).value.model.length, 80);
  assert.equal(checkChatBody(msg({ model: 5 })).value.model, undefined);
  assert.equal(checkChatBody(msg({ model: "" })).value.model, undefined);
  assert.equal(checkChatBody(msg({ stream: "true" })).value.stream, false);
  assert.equal(checkChatBody(msg()).value.stream, false);
});
