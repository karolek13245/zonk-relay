import { DurableObject } from "cloudflare:workers";
import { RateLimiter, SECURITY_HEADERS, TooLarge, readTextLimited } from "../../src/guards.js";
import {
  DROP_AFTER_MS,
  MAX_RELAYS,
  cleanRelayUrl,
  pageHtml,
  readHealth,
  relayView,
  sortRelays,
  subdomainOf,
} from "./rules.js";

// The relay list. Relays announce themselves at POST /register; the list checks every one of them itself
// (GET <relay>/health) before it is shown, and keeps checking. Apps and the web page read GET /relays.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...SECURITY_HEADERS, ...CORS, ...extra },
  });
}

function errorJson(status, message, type = "list_error") {
  return json({ error: { message, type } }, status);
}

/** How long a Worker keeps the answer to GET /relays before it asks the Durable Object again. */
const LIST_CACHE_MS = 10 * 1000;
const listCache = new Map(); // "all" | "online" -> { at, body }

/** Exported for the tests: forget what the Worker remembers. */
export function clearListCache() {
  listCache.clear();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (path === "/") {
      if (request.method !== "GET" && request.method !== "HEAD") return errorJson(405, "Use GET.");
      const nonce = btoa(crypto.randomUUID());
      return new Response(pageHtml(nonce), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; ` +
            "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          ...SECURITY_HEADERS,
        },
      });
    }

    if (path === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") return errorJson(405, "Use GET.");
      return json({ service: "zonk-relays", ok: true });
    }

    const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName("main"));

    if (path === "/relays") {
      if (request.method !== "GET") return errorJson(405, "Use GET.");
      const key = url.searchParams.get("all") === "1" ? "all" : "online";
      const hit = listCache.get(key);
      if (hit && Date.now() - hit.at < LIST_CACHE_MS) {
        return new Response(hit.body, { headers: relaysHeaders() });
      }
      const res = await stub.fetch(new Request(`${url.origin}/relays?all=${key === "all" ? 1 : 0}`));
      const body = await res.text();
      if (res.ok) listCache.set(key, { at: Date.now(), body });
      return new Response(body, { status: res.status, headers: relaysHeaders() });
    }

    if (path === "/register") {
      if (request.method !== "POST") return errorJson(405, "Use POST.");
      const headers = new Headers(request.headers);
      headers.set("x-zonk-ip", request.headers.get("cf-connecting-ip") || "unknown");
      return stub.fetch(new Request(request, { headers }));
    }

    return errorJson(404, "Not found.", "not_found");
  },
};

function relaysHeaders() {
  return { "content-type": "application/json", ...SECURITY_HEADERS, ...CORS, "cache-control": "public, max-age=10" };
}

/** How often the list checks its relays again. */
const CHECK_EVERY_MS = 2 * 60 * 1000;
/** At most this many relays are checked per round (a Worker may only make 50 outgoing requests per run). */
const CHECK_BATCH = 40;
/** The same relay is not looked at again sooner than this when it announces itself repeatedly. */
const RECHECK_MIN_MS = 30 * 1000;

/**
 * Asks a relay how it is. Returns { ok: true, hosts, models, version } or { ok: false, reason }.
 * Never throws, never follows a redirect, and reads at most a few kilobytes.
 */
export async function checkRelay(origin, fetchFn = fetch) {
  try {
    const res = await fetchFn(origin + "/health", {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
      headers: { accept: "application/json", "user-agent": "zonk-relays/1" },
    });
    if (!res.ok) return { ok: false, reason: "it answered HTTP " + res.status };
    const health = readHealth(JSON.parse(await readTextLimited(res, 4096)));
    if (!health) return { ok: false, reason: "it is not a ready, public Zonk relay" };
    return { ok: true, ...health };
  } catch (e) {
    if (e instanceof TooLarge) return { ok: false, reason: "its answer was too big" };
    return { ok: false, reason: e && e.name === "TimeoutError" ? "it did not answer in time" : "it could not be reached" };
  }
}

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.perAddress = new RateLimiter(30, 60 * 60 * 1000);
    this.everyone = new RateLimiter(120, 60 * 60 * 1000);
    this.recent = new Map(); // relay address -> time of its last check
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/register") return this.register(request);
    if (url.pathname === "/relays") return this.relays(url.searchParams.get("all") === "1");
    return errorJson(404, "Not found.", "not_found");
  }

  async records() {
    return [...(await this.ctx.storage.list({ prefix: "r:" })).values()];
  }

  async register(request) {
    const ip = request.headers.get("x-zonk-ip") || "unknown";
    if (!this.perAddress.allow(ip) || !this.everyone.allow("all")) {
      return errorJson(429, "Too many announcements right now. Try again later.", "rate_limited");
    }

    let wanted;
    try {
      wanted = JSON.parse(await readTextLimited(request, 2048));
    } catch {
      return errorJson(400, "Send JSON like {\"url\":\"https://name.account.workers.dev\"}.", "invalid_request");
    }
    const origin = cleanRelayUrl(wanted && wanted.url);
    if (!origin) return errorJson(400, "That is not a name.account.workers.dev address.", "invalid_request");

    const now = Date.now();
    const key = "r:" + origin;
    const before = await this.ctx.storage.get(key);
    const last = this.recent.get(origin);
    if (before && last && now - last < RECHECK_MIN_MS) return json({ ok: true, url: origin, note: "already checked a moment ago" });

    if (!before && (await this.records()).length >= MAX_RELAYS) {
      return errorJson(503, "The list is full right now.", "list_full");
    }

    this.recent.set(origin, now);
    if (this.recent.size > 1000) this.recent.delete(this.recent.keys().next().value);
    const result = await checkRelay(origin);
    if (!result.ok) {
      return errorJson(400, `That address was checked, but ${result.reason}.`, "not_a_relay");
    }
    await this.ctx.storage.put(key, {
      url: origin,
      sub: subdomainOf(origin),
      firstSeen: before ? before.firstSeen : now,
      lastOk: now,
      lastCheck: now,
      hosts: result.hosts,
      models: result.models,
      version: result.version,
    });
    await this.ensureAlarm();
    return json({ ok: true, url: origin });
  }

  async relays(all) {
    const now = Date.now();
    const views = (await this.records()).map((r) => relayView(r, now));
    const shown = sortRelays(all ? views : views.filter((r) => r.online));
    return json({ updated: now, relays: shown });
  }

  async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + CHECK_EVERY_MS);
  }

  /** Looks at the relays that were checked longest ago, and forgets the ones that have been gone for days. */
  async alarm() {
    const now = Date.now();
    const alive = [];
    for (const r of await this.records()) {
      if (now - r.lastOk > DROP_AFTER_MS) await this.ctx.storage.delete("r:" + r.url);
      else alive.push(r);
    }
    const due = alive.sort((a, b) => a.lastCheck - b.lastCheck).slice(0, CHECK_BATCH);
    await Promise.all(
      due.map(async (r) => {
        const res = await checkRelay(r.url);
        const updated = { ...r, lastCheck: now };
        if (res.ok) Object.assign(updated, { lastOk: now, hosts: res.hosts, models: res.models, version: res.version });
        else updated.hosts = 0;
        await this.ctx.storage.put("r:" + r.url, updated);
      }),
    );
    if (alive.length > 0) await this.ctx.storage.setAlarm(Date.now() + CHECK_EVERY_MS);
  }
}
