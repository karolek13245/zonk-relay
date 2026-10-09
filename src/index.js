import { DurableObject } from "cloudflare:workers";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

function errorJson(status, message, type = "relay_error") {
  return json({ error: { message, type } }, status);
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a || "");
  const y = enc.encode(b || "");
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

function bearer(request) {
  const h = request.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

const PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Zonk Relay</title><body style="font-family:system-ui;background:#0b0b0f;color:#eee;padding:2rem">
<h1>Zonk Relay</h1><p>Online. Phones connect at <code>/host</code>, apps call <code>/v1/chat/completions</code>.</p></body>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (path === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });

    if (!env.API_KEY || !env.HOST_TOKEN) {
      return errorJson(500, "Server is missing API_KEY / HOST_TOKEN secrets.", "config_error");
    }
    const stub = env.RELAY.get(env.RELAY.idFromName("main"));

    if (path === "/host") {
      if (request.headers.get("upgrade") !== "websocket") {
        return errorJson(426, "Expected a WebSocket connection.");
      }
      const token = bearer(request) || url.searchParams.get("token") || "";
      if (!(await safeEqual(token, env.HOST_TOKEN))) return errorJson(401, "Bad host token.", "auth_error");
      return stub.fetch(request);
    }

    if (path === "/v1/models" || path === "/v1/chat/completions" || path === "/status") {
      if (!(await safeEqual(bearer(request), env.API_KEY))) {
        return errorJson(401, "Bad or missing API key.", "auth_error");
      }
      return stub.fetch(request);
    }

    return errorJson(404, "Not found.", "not_found");
  },
};

const MAX_QUEUE = 20;
const MAX_HOSTS = 20;

export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.jobs = new Map(); // id -> job (only alive while a request is waiting)
    this.queue = []; // jobs waiting for a free phone
    this.busy = new Set(); // sockets currently working on a job
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
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

    if (path === "/host") {
      if (this.ctx.getWebSockets().length >= MAX_HOSTS) return errorJson(503, "Too many phones connected.");
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
    let body;
    try {
      body = await request.json();
    } catch {
      return errorJson(400, "Body must be JSON.", "invalid_request");
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return errorJson(400, "'messages' must be a non-empty array.", "invalid_request");
    }
    if (this.hosts().length === 0) return errorJson(503, "No phone is online right now.", "no_host");
    if (this.queue.length >= MAX_QUEUE) return errorJson(429, "Too many requests waiting.", "queue_full");

    let result;
    try {
      result = await this.submit(body);
    } catch (e) {
      const status = e.status || 502;
      return errorJson(status, e.message || "Relay failure.", e.kind || "relay_error");
    }

    const created = Math.floor(Date.now() / 1000);
    const id = "chatcmpl-" + crypto.randomUUID();
    const model = result.model || body.model || "zonk";
    const usage = {
      prompt_tokens: result.promptTokens || 0,
      completion_tokens: result.completionTokens || 0,
      total_tokens: (result.promptTokens || 0) + (result.completionTokens || 0),
    };

    if (body.stream) {
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
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...CORS },
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
      const { messages, temperature, max_tokens, top_p } = job.body;
      try {
        ws.send(JSON.stringify({
          type: "request",
          id: job.id,
          messages,
          options: { temperature, max_tokens, top_p },
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
      this.abort(job, Object.assign(new Error(String(msg.message || "Phone reported an error.")), { status: 502, kind: "host_error" }));
    }
  }

  webSocketClose(ws) {
    this.dropHost(ws);
  }

  webSocketError(ws) {
    this.dropHost(ws);
  }
}
