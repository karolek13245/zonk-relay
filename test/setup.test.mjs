import test from "node:test";
import assert from "node:assert/strict";
import { directoryFrom, findWorkerUrl, randomSecret, setPublicMode, setup } from "../tools/setup.mjs";

const CONFIG = `{
  "name": "zonk-relay",
  "vars": {
    "REQUEST_TIMEOUT_SECONDS": "120",
    // comment
    "PUBLIC_MODE": "false",
    "DIRECTORY_URL": "https://zonk-relays.example.workers.dev"
  }
}`;

test("randomSecret: long, hex, different every time", () => {
  const a = randomSecret();
  const b = randomSecret();
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notEqual(a, b);
});

test("findWorkerUrl", () => {
  assert.equal(findWorkerUrl("Deployed zonk-relay triggers (1.2 sec)\n  https://Zonk-Relay.Me.workers.dev\nCurrent Version ID: x"), "https://zonk-relay.me.workers.dev");
  assert.equal(findWorkerUrl("nothing here"), null);
  assert.equal(findWorkerUrl("https://example.com"), null);
});

test("setPublicMode edits only that setting and keeps the comments", () => {
  const on = setPublicMode(CONFIG, true);
  assert.match(on, /"PUBLIC_MODE": "true"/);
  assert.match(on, /\/\/ comment/);
  assert.equal(setPublicMode(on, false), CONFIG);
  assert.throws(() => setPublicMode("{}", true), /PUBLIC_MODE/);
  assert.equal(directoryFrom(CONFIG), "https://zonk-relays.example.workers.dev");
  assert.equal(directoryFrom("{}"), "");
});

/** Pretend everything outside: wrangler, the keyboard, the config file, the internet. */
function pretend({ loggedIn = true, answers = ["n"], deployOutput = "  https://zonk-relay.me.workers.dev\n", failOn = null, health = { service: "zonk-relay", ready: true } } = {}) {
  const calls = [];
  const said = [];
  const files = { config: CONFIG };
  const deps = {
    wrangler: async (args, opts = {}) => {
      calls.push({ args, input: opts.input });
      if (failOn && args.join(" ").startsWith(failOn)) return { ok: false, out: "" };
      if (args[0] === "whoami") return { ok: true, out: loggedIn ? "You are logged in" : "You are not authenticated." };
      if (args[0] === "deploy") return { ok: true, out: deployOutput };
      return { ok: true, out: "" };
    },
    ask: async () => answers.shift() ?? "",
    log: (t = "") => said.push(t),
    readConfig: async () => files.config,
    writeConfig: async (t) => { files.config = t; },
    fetch: async () => ({ json: async () => { if (!health) throw new Error("down"); return health; } }),
  };
  return { deps, calls, said, files };
}

test("setup, private relay: logs in, deploys, makes both secrets, shows them once", async () => {
  const p = pretend({ loggedIn: false, answers: ["n"] });
  await setup(p.deps);
  assert.deepEqual(p.calls.map((c) => c.args.join(" ")), ["whoami", "login", "deploy", "secret put HOST_TOKEN", "secret put API_KEY"]);
  const [host, key] = [p.calls[3].input, p.calls[4].input];
  assert.match(host, /^[0-9a-f]{48}$/);
  assert.match(key, /^[0-9a-f]{48}$/);
  assert.notEqual(host, key);
  // The secrets go in through standard input, never as command-line arguments (those show up in process lists).
  assert.ok(p.calls.every((c) => !c.args.join(" ").includes(host) && !c.args.join(" ").includes(key)));
  const text = p.said.join("\n");
  assert.ok(text.includes(host) && text.includes(key));
  assert.equal(text.split(host).length - 1, 1, "the host token is shown exactly once");
  assert.match(text, /https:\/\/zonk-relay\.me\.workers\.dev/);
  assert.match(text, /Private relay/);
  assert.match(p.files.config, /"PUBLIC_MODE": "false"/);
});

test("setup, public relay: switches public mode on, no API key, mentions the list", async () => {
  const p = pretend({ answers: ["y"] });
  await setup(p.deps);
  assert.deepEqual(p.calls.map((c) => c.args.join(" ")), ["whoami", "deploy", "secret put HOST_TOKEN"]);
  assert.match(p.files.config, /"PUBLIC_MODE": "true"/);
  assert.match(p.said.join("\n"), /listed on the relay page/);
  assert.ok(!p.said.join("\n").includes("API key for people"));
  assert.ok(p.calls.indexOf(p.calls.find((c) => c.args[0] === "deploy")) < p.calls.indexOf(p.calls.find((c) => c.args[0] === "secret")), "deploy first, so the Worker exists when the secrets arrive");
});

test("setup: a failed step stops it with a clear message and no secret is shown", async () => {
  for (const failOn of ["login", "deploy", "secret put HOST_TOKEN"]) {
    const p = pretend({ loggedIn: failOn !== "login", failOn });
    await assert.rejects(setup(p.deps), /./, failOn);
    assert.ok(!p.said.join("\n").match(/[0-9a-f]{48}/), `${failOn}: nothing secret was shown`);
  }
});

test("setup: asks for the address when wrangler did not print one; says so when the relay is not answering yet", async () => {
  const p = pretend({ answers: ["n", "https://zonk-relay.you.workers.dev"], deployOutput: "Uploaded.", health: null });
  await setup(p.deps);
  const text = p.said.join("\n");
  assert.match(text, /https:\/\/zonk-relay\.you\.workers\.dev/);
  assert.match(text, /did not answer yet/);
  const q = pretend({ answers: ["n", "no idea"], deployOutput: "Uploaded." });
  await assert.rejects(setup(q.deps), /No relay address/);
});
