// Small checks used by the relay. Nothing from Cloudflare is imported here, so plain Node can test them.

/** The biggest chat request the relay accepts (bytes). */
export const MAX_BODY_BYTES = 256 * 1024;
/** The most messages one chat request may carry. */
export const MAX_MESSAGES = 200;
/** The most tokens one answer may ask for. */
export const MAX_OUT_TOKENS = 4096;
/** API_KEY and HOST_TOKEN must be at least this long. */
export const MIN_SECRET_LENGTH = 16;
/** The relay's version. Keep it equal to "version" in package.json (a test checks that). */
export const VERSION = "0.2.0";

/** Added to every answer: nothing gets cached or guessed at by the browser. */
export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/** The token from "Authorization: Bearer <token>", or "" if there is none. */
export function bearer(request) {
  const h = request.headers.get("authorization") || "";
  return /^bearer /i.test(h) ? h.slice(7).trim() : "";
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * Compares two secrets. Both are hashed first, so the comparison always takes the same time and does not reveal
 * how long the real secret is. An empty secret never matches.
 */
export async function safeEqual(a, b) {
  const x = await sha256(String(a ?? ""));
  const y = await sha256(String(b ?? ""));
  let diff = !a || !b ? 1 : 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** True when PUBLIC_MODE is switched on: anyone may chat without an API key (hosting still needs HOST_TOKEN). */
export function isPublic(env) {
  return ["1", "true", "yes", "on"].includes(String(env.PUBLIC_MODE ?? "").trim().toLowerCase());
}

/**
 * null when the secrets are fine, otherwise a short reason. The reason is for the log, never for the caller.
 * HOST_TOKEN is always needed. API_KEY is needed too, unless the relay is public.
 */
export function configProblem(env) {
  const host = env.HOST_TOKEN;
  if (typeof host !== "string" || !host) return "the HOST_TOKEN secret is missing";
  if (host.length < MIN_SECRET_LENGTH) return `HOST_TOKEN must be at least ${MIN_SECRET_LENGTH} characters`;
  const key = env.API_KEY;
  if (typeof key !== "string" || !key) {
    return isPublic(env) ? null : "the API_KEY secret is missing (or switch PUBLIC_MODE on)";
  }
  if (key.length < MIN_SECRET_LENGTH) return `API_KEY must be at least ${MIN_SECRET_LENGTH} characters`;
  if (key === host) return "API_KEY and HOST_TOKEN must be different";
  return null;
}

/**
 * Counts requests per key inside a time window (for example per internet address). Memory only: it starts over
 * when the Durable Object restarts. At most [maxKeys] keys are remembered; the one used longest ago is forgotten first.
 */
export class RateLimiter {
  constructor(limit, windowMs, maxKeys = 2000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.hits = new Map();
  }

  /** True if this request is allowed (and counted). */
  allow(key, now = Date.now()) {
    const from = now - this.windowMs;
    const list = (this.hits.get(key) || []).filter((t) => t > from);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.delete(key);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value);
    return true;
  }
}

/**
 * Tells the relay list (the directory) that this relay exists. The list checks the relay itself afterwards,
 * so this only carries the address. Never throws. Returns the HTTP status, or 0 if the list could not be reached.
 */
export async function announce(directoryUrl, origin, fetchFn = fetch) {
  try {
    const res = await fetchFn(String(directoryUrl).replace(/\/+$/, "") + "/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: origin }),
      signal: AbortSignal.timeout(8000),
    });
    console.log("zonk-relay: told the relay list about this relay, answer " + res.status);
    return res.status;
  } catch (e) {
    console.log("zonk-relay: could not reach the relay list: " + (e && e.message ? e.message : e));
    return 0;
  }
}

/** Thrown by [readTextLimited] when the body is bigger than allowed. */
export class TooLarge extends Error {}

/** Reads a request body as text, and gives up as soon as it is bigger than [max] bytes. */
export async function readTextLimited(request, max = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new TooLarge("declared size too large");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw new TooLarge("body too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

const ROLES = new Set(["system", "user", "assistant"]);

function bad(message) {
  return { ok: false, message };
}

/** A number clamped into [lo, hi], or undefined if [v] is not a usable number. */
function clamp(v, lo, hi) {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;
}

/** Message text: either a string, or a list of text parts (some apps send it that way). Anything else is refused. */
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.length > 0) {
    const parts = [];
    for (const p of content) {
      if (p === null || typeof p !== "object" || p.type !== "text" || typeof p.text !== "string") return null;
      parts.push(p.text);
    }
    return parts.join("\n");
  }
  return null;
}

/**
 * Checks the JSON of a chat request. Returns { ok: true, value } with a cleaned copy (only what the phone needs),
 * or { ok: false, message } with a sentence for the caller.
 */
export function checkChatBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return bad("Body must be a JSON object.");
  const list = body.messages;
  if (!Array.isArray(list) || list.length === 0) return bad("'messages' must be a non-empty array.");
  if (list.length > MAX_MESSAGES) return bad(`'messages' can have at most ${MAX_MESSAGES} entries.`);

  const messages = [];
  for (const m of list) {
    if (m === null || typeof m !== "object" || Array.isArray(m)) return bad("Each message must be an object.");
    if (!ROLES.has(m.role)) return bad("Each message needs a role: system, user or assistant.");
    const text = textOf(m.content);
    if (text === null) return bad("Each message needs 'content' as text. Pictures and other parts are not supported.");
    messages.push({ role: m.role, content: text });
  }

  const maxTokens = clamp(body.max_tokens, 1, MAX_OUT_TOKENS);
  return {
    ok: true,
    value: {
      messages,
      model: typeof body.model === "string" && body.model ? body.model.slice(0, 80) : undefined,
      stream: body.stream === true,
      options: {
        temperature: clamp(body.temperature, 0, 2),
        top_p: clamp(body.top_p, 0, 1),
        max_tokens: maxTokens === undefined ? undefined : Math.floor(maxTokens),
      },
    },
  };
}
