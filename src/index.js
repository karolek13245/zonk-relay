import { DurableObject } from "cloudflare:workers";
import {
  MAX_BODY_BYTES,
  RateLimiter,
  SECURITY_HEADERS,
  TooLarge,
  VERSION,
  announce,
  bearer,
  checkChatBody,
  configProblem,
  isPublic,
  readTextLimited,
  safeEqual,
} from "./guards.js";

// Any website may call the API, but it still needs the API key (sent in a header, never in a cookie).
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...SECURITY_HEADERS, ...CORS },
  });
}

function errorJson(status, message, type = "relay_error") {
  return json({ error: { message, type } }, status);
}

function page(env) {
  const mode = configProblem(env)
    ? "Not set up yet: add the HOST_TOKEN secret (see the README)."
    : isPublic(env)
      ? "Public relay: anyone can chat through it, and it is listed on the relay page."
      : "Private relay: chatting needs the API key.";
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Zonk Relay</title><body style="font-family:system-ui;background:#0b0b0f;color:#eee;padding:2rem;line-height:1.5">
<h1>Zonk Relay <small style="font-weight:400;color:#999">${VERSION}</small></h1>
<p>Online. ${mode}</p>
<p>Phones connect at <code>/host</code>, apps call <code>/v1/chat/completions</code>, and <code>/health</code> says whether a phone is ready.</p>
</body>`;
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  ...SECURITY_HEADERS,
};

// Which method each API path accepts.
const API_METHODS = {
  "/v1/models": "GET",
  "/status": "GET",
  "/v1/chat/completions": "POST",
};

/** What anyone may learn about the relay. A private relay only says that it exists. */
async function health(request, env) {
  const base = { service: "zonk-relay", version: VERSION, public: isPublic(env) };
  if (configProblem(env)) return json({ ...base, public: false, ready: false });
  if (!base.public) return json({ ...base, ready: true });
  let info = { hosts: 0, models: [] };
  try {
    info = await (await env.RELAY.get(env.RELAY.idFromName("main")).fetch(request)).json();
  } catch {
    // The Durable Object is restarting: report that no phone is ready for now.
  }
  return json({ ...base, ready: true, hosts: info.hosts, models: info.models });
}

/** A copy of the request that tells the Durable Object who is asking. Only this Worker sets these headers. */
function withClientInfo(request, anonymous) {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.set("x-zonk-anon", anonymous ? "1" : "0");
  headers.set("x-zonk-ip", request.headers.get("cf-connecting-ip") || "unknown");
  return new Request(request, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (path === "/") {
      if (request.method !== "GET" && request.method !== "HEAD") return errorJson(405, "Use GET.");
      return new Response(page(env), { headers: PAGE_HEADERS });
    }

    if (path === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") return errorJson(405, "Use GET.");
      return health(request, env);
    }

    const problem = configProblem(env);
    if (problem) {
      // The reason goes to the log for the owner; callers only learn that the server is not set up.
      console.error("zonk-relay is not configured: " + problem);
      return errorJson(500, "Server is not configured.", "config_error");
    }
    const stub = env.RELAY.get(env.RELAY.idFromName("main"));

    if (path === "/host") {
      if (request.method !== "GET") return errorJson(405, "Use GET.");
      if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
        return errorJson(426, "Expected a WebSocket connection.");
      }
      // The token travels in the Authorization header only. A token in the address would end up in logs.
      if (!(await safeEqual(bearer(request), env.HOST_TOKEN))) return errorJson(401, "Bad host token.", "auth_error");
      return stub.fetch(request);
    }

    if (Object.hasOwn(API_METHODS, path)) {
      const keyOk = await safeEqual(bearer(request), env.API_KEY);
      // A public relay lets anyone chat without a key (but never read /status). Those callers are rate limited.
      const anonymous = !keyOk && isPublic(env) && path !== "/status";
      if (!keyOk && !anonymous) return errorJson(401, "Bad or missing API key.", "auth_error");
      if (request.method !== API_METHODS[path]) return errorJson(405, `Use ${API_METHODS[path]}.`);
      if (path === "/v1/chat/completions") {
        // Turn away an oversized request before it reaches the Durable Object.
        const declared = Number(request.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          return errorJson(413, "Request is too large.", "invalid_request");
        }
      }
      return stub.fetch(withClientInfo(request, anonymous));
    }

    return errorJson(404, "Not found.", "not_found");
  },
};

const MAX_QUEUE = 20;
const MAX_HOSTS = 20;
/** Without a key, one internet address may send this many chat requests a minute / an hour. */
const ANON_PER_MINUTE = 20;
const ANON_PER_HOUR = 200;
/** A public relay tells the relay list about itself at most this often. */
const ANNOUNCE_EVERY_MS = 6 * 60 * 60 * 1000;

export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.jobs = new Map(); // id -> job (only alive while a request is waiting)
    this.queue = []; // jobs waiting for a free phone
    this.busy = new Set(); // sockets currently working on a job
    this.perMinute = new RateLimiter(ANON_PER_MINUTE, 60 * 1000);
    this.perHour = new RateLimiter(ANON_PER_HOUR, 60 * 60 * 1000);
    this.lastAnnounce = 0;
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** A public relay on workers.dev tells the relay list that it exists. Never blocks or fails the request. */
  maybeAnnounce(origin) {
    const directory = String(this.env.DIRECTORY_URL ?? "").trim();
    if (!isPublic(this.env) || !/^https:\/\//i.test(directory)) return;
    if (!new URL(origin).hostname.endsWith(".workers.dev")) return;
    const now = Date.now();
    if (now - this.lastAnnounce < ANNOUNCE_EVERY_MS) return;
    this.lastAnnounce = now;
    const job = announce(directory, origin);
    if (typeof this.ctx.waitUntil === "function") this.ctx.waitUntil(job);
  }

  timeoutMs() {
    const s = Number(this.env.REQUEST_TIMEOUT_SECONDS) || 120;
    return Math.max(10, s) * 1000;
  }

  hosts() {
    return this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment()?.ready);
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;

    if (path === "/health") {
      this.maybeAnnounce(new URL(request.url).origin);
      const hosts = this.hosts();
      const models = [...new Set(hosts.map((ws) => ws.deserializeAttachment().model))].slice(0, 5);
      return json({ hosts: hosts.length, models });
    }

    if (path === "/host") {
      if (this.ctx.getWebSockets().length >= MAX_HOSTS) return errorJson(503, "Too many phones connected.");
      this.maybeAnnounce(new URL(request.url).origin);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ ready: false });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (path === "/status") {
      const hosts = this.hosts().map((ws) => {
        const a = ws.deserializeAttachment();
        return { name: a.name, model: a.model, busy: this.busy.has(ws) };
      });
      return json({ hosts, queued: this.queue.length });
    }

    if (path === "/v1/models") {
      const seen = new Set(this.hosts().map((ws) => ws.deserializeAttachment().model));
      return json({
        object: "list",
        data: [...seen].map((id) => ({ id, object: "model", owned_by: "zonk" })),
      });
    }

    if (path === "/v1/chat/completions") {
      if (request.method !== "POST") return errorJson(405, "Use POST.");
      return this.chat(request);
    }

    return errorJson(404, "Not found.", "not_found");
  }

  async chat(request) {
    if (request.headers.get("x-zonk-anon") === "1") {
      const ip = request.headers.get("x-zonk-ip") || "unknown";
      if (!this.perMinute.allow(ip) || !this.perHour.allow(ip)) {
        return errorJson(429, "Too many requests from your address. Try again in a minute.", "rate_limited");
      }
    }
    let text;
    try {
      text = await readTextLimited(request);
    } catch (e) {
      if (e instanceof TooLarge) return errorJson(413, "Request is too large.", "invalid_request");
      return errorJson(400, "Could not read the request.", "invalid_request");
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return errorJson(400, "Body must be JSON.", "invalid_request");
    }
    const checked = checkChatBody(parsed);
    if (!checked.ok) return errorJson(400, checked.message, "invalid_request");
    const { messages, options, model: wanted, stream } = checked.value;

    if (this.hosts().length === 0) return errorJson(503, "No phone is online right now.", "no_host");
    if (this.queue.length >= MAX_QUEUE) return errorJson(429, "Too many requests waiting.", "queue_full");

    let result;
    try {
      result = await this.submit({ messages, options, model: wanted });
    } catch (e) {
      const status = e.status || 502;
      return errorJson(status, e.message || "Relay failure.", e.kind || "relay_error");
    }

    const created = Math.floor(Date.now() / 1000);
    const id = "chatcmpl-" + crypto.randomUUID();
    const model = result.model || wanted || "zonk";
    const usage = {
      prompt_tokens: result.promptTokens || 0,
      completion_tokens: result.completionTokens || 0,
      total_tokens: (result.promptTokens || 0) + (result.completionTokens || 0),
    };

    if (stream) {
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      const sse =
        chunk({ role: "assistant", content: result.content }, null) +
        chunk({}, "stop") +
        "data: [DONE]\n\n";
      return new Response(sse, {
        headers: { "content-type": "text/event-stream", ...SECURITY_HEADERS, ...CORS },
      });
    }

    return json({
      id, object: "chat.completion", created, model,
      choices: [{ index: 0, message: { role: "assistant", content: result.content }, finish_reason: "stop" }],
      usage,
    });
  }

  submit(body) {
    return new Promise((resolve, reject) => {
      const job = {
        id: crypto.randomUUID(),
        body,
        resolve,
        reject,
        ws: null,
        attempts: 0,
        timer: null,
      };
      job.timer = setTimeout(() => {
        this.abort(job, Object.assign(new Error("Phone took too long to answer."), { status: 504, kind: "timeout" }));
      }, this.timeoutMs());
      this.jobs.set(job.id, job);
      this.queue.push(job);
      this.drain();
    });
  }

  pickHost(job) {
    const all = this.hosts();
    const wanted = job.body.model;
    const matching = wanted ? all.filter((ws) => ws.deserializeAttachment().model === wanted) : [];
    const pool = matching.length ? matching : all;
    return pool.find((ws) => !this.busy.has(ws)) || null;
  }

  drain() {
    if (this.hosts().length === 0) {
      for (const job of [...this.queue]) {
        this.abort(job, Object.assign(new Error("No phone is online right now."), { status: 503, kind: "no_host" }));
      }
      return;
    }
    for (const job of [...this.queue]) {
      const ws = this.pickHost(job);
      if (!ws) continue;
      this.queue.splice(this.queue.indexOf(job), 1);
      job.ws = ws;
      job.attempts++;
      this.busy.add(ws);
      const { messages, options } = job.body;
      try {
        ws.send(JSON.stringify({
          type: "request",
          id: job.id,
          messages,
          options,
        }));
      } catch {
        this.busy.delete(ws);
        job.ws = null;
        this.queue.unshift(job);
        this.dropHost(ws);
      }
    }
  }

  finish(job) {
    clearTimeout(job.timer);
    this.jobs.delete(job.id);
    const i = this.queue.indexOf(job);
    if (i >= 0) this.queue.splice(i, 1);
    if (job.ws) this.busy.delete(job.ws);
  }

  abort(job, err) {
    if (!this.jobs.has(job.id)) return;
    const ws = job.ws;
    this.finish(job);
    if (ws) {
      try { ws.send(JSON.stringify({ type: "cancel", id: job.id })); } catch {}
    }
    job.reject(err);
    this.drain();
  }

  dropHost(ws) {
    this.busy.delete(ws);
    for (const job of [...this.jobs.values()]) {
      if (job.ws !== ws) continue;
      job.ws = null;
      if (job.attempts < 2) {
        this.queue.unshift(job);
      } else {
        this.abort(job, Object.assign(new Error("Phone disconnected mid-answer."), { status: 502, kind: "host_lost" }));
      }
    }
    try { ws.close(1011, "dropped"); } catch {}
    this.drain();
  }

  webSocketMessage(ws, message) {
    if (typeof message !== "string") return;
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (msg === null || typeof msg !== "object") return;

    if (msg.type === "hello") {
      ws.serializeAttachment({
        ready: true,
        model: String(msg.model || "unknown").slice(0, 80),
        name: String(msg.name || "phone").slice(0, 40),
      });
      this.drain();
      return;
    }

    const job = this.jobs.get(msg.id);
    if (!job || job.ws !== ws) return;

    if (msg.type === "response") {
      const model = ws.deserializeAttachment()?.model;
      this.finish(job);
      job.resolve({
        content: String(msg.content ?? ""),
        promptTokens: Number(msg.promptTokens) || 0,
        completionTokens: Number(msg.completionTokens) || 0,
        model,
      });
      this.drain();
    } else if (msg.type === "error") {
      const why = String(msg.message || "Phone reported an error.").slice(0, 300);
      this.abort(job, Object.assign(new Error(why), { status: 502, kind: "host_error" }));
    }
  }

  webSocketClose(ws) {
    this.dropHost(ws);
  }

  webSocketError(ws) {
    this.dropHost(ws);
  }
}
