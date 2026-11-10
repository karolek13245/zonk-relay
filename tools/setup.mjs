#!/usr/bin/env node
// Sets up your own Zonk Relay on your own Cloudflare account: logs you in, deploys the Worker, creates the secrets.
//
//   npm install
//   npm run setup
//
// Nothing is sent anywhere except to Cloudflare (through the official `wrangler` tool) and, for a public relay,
// to the relay list. The secrets are made on your computer, handed to Cloudflare, and shown to you once.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const WRANGLER_CONFIG = new URL("../wrangler.jsonc", import.meta.url);
const WORKER_URL = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i;

/** A random secret: 48 letters and digits, from the computer's secure random source. */
export function randomSecret(bytes = 24) {
  return randomBytes(bytes).toString("hex");
}

/** The first https://name.account.workers.dev address in [text], or null. */
export function findWorkerUrl(text) {
  const m = WORKER_URL.exec(String(text));
  return m ? m[0].toLowerCase() : null;
}

/** Returns the wrangler.jsonc text with PUBLIC_MODE switched on or off. */
export function setPublicMode(jsonc, on) {
  const line = /("PUBLIC_MODE"\s*:\s*")(true|false)(")/;
  if (!line.test(jsonc)) throw new Error('wrangler.jsonc has no "PUBLIC_MODE" setting.');
  return jsonc.replace(line, `$1${on ? "true" : "false"}$3`);
}

/** The `directory` address written in wrangler.jsonc ("" when there is none). */
export function directoryFrom(jsonc) {
  const m = /"DIRECTORY_URL"\s*:\s*"([^"]*)"/.exec(jsonc);
  return m ? m[1] : "";
}

/** Runs `wrangler` with [args]. Returns { ok, out }. [input] goes to its standard input (used for secrets). */
export function runWrangler(args, { input, echo = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn("npx", ["wrangler", ...args], {
      stdio: [input === undefined ? "inherit" : "pipe", "pipe", "inherit"],
      shell: process.platform === "win32",
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (echo) process.stdout.write(d);
    });
    child.on("error", () => resolve({ ok: false, out }));
    child.on("close", (code) => resolve({ ok: code === 0, out }));
    if (input !== undefined) child.stdin.end(input + "\n");
  });
}

/** Everything the setup needs from the outside world, so tests can replace it. */
function realDeps() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    wrangler: runWrangler,
    ask: (question) => rl.question(question),
    log: (text = "") => console.log(text),
    readConfig: () => readFile(WRANGLER_CONFIG, "utf8"),
    writeConfig: (text) => writeFile(WRANGLER_CONFIG, text),
    fetch: (url) => fetch(url, { signal: AbortSignal.timeout(15000) }),
    close: () => rl.close(),
  };
}

export async function setup(deps) {
  const { wrangler, ask, log } = deps;
  log("Zonk Relay setup");
  log("This puts a relay on YOUR Cloudflare account. It takes about two minutes.\n");

  // 1. Logged in to Cloudflare?
  const who = await wrangler(["whoami"]);
  if (!who.ok || /not authenticated|not logged in/i.test(who.out)) {
    log("Step 1: log in to Cloudflare. Your browser opens; log in and click Allow.");
    const login = await wrangler(["login"]);
    if (!login.ok) throw new Error("The Cloudflare login did not finish. Run the setup again to retry.");
  } else {
    log("Step 1: already logged in to Cloudflare.");
  }

  // 2. Public or private?
  log("\nStep 2: who may chat through your relay?");
  log("  Private: only people with your API key.");
  log("  Public:  everyone, without a key, and your relay is listed on the relay page.");
  log("           Strangers then use your phone's battery and see nothing of yours except what they send.");
  const publicRelay = /^y/i.test((await ask("Make it public? [y/N] ")).trim());
  const config = await deps.readConfig();
  await deps.writeConfig(setPublicMode(config, publicRelay));

  // 3. Deploy
  log("\nStep 3: deploying the relay...");
  const deployed = await wrangler(["deploy"], { echo: true });
  if (!deployed.ok) throw new Error("The deploy did not work. Read the messages above, fix the problem and run the setup again.");
  let url = findWorkerUrl(deployed.out);
  if (!url) {
    url = findWorkerUrl(await ask("Paste the https://...workers.dev address of your relay: "));
    if (!url) throw new Error("No relay address found.");
  }

  // 4. Secrets (made here, never written to a file)
  log("\nStep 4: creating the secrets...");
  const hostToken = randomSecret();
  const apiKey = publicRelay ? null : randomSecret();
  const putHost = await wrangler(["secret", "put", "HOST_TOKEN"], { input: hostToken });
  if (!putHost.ok) throw new Error("Could not save the HOST_TOKEN secret.");
  if (apiKey) {
    const putKey = await wrangler(["secret", "put", "API_KEY"], { input: apiKey });
    if (!putKey.ok) throw new Error("Could not save the API_KEY secret.");
  }

  // 5. Does it answer? (For a public relay this also tells the relay list about it.)
  log("\nStep 5: checking that it answers...");
  let health = null;
  try {
    health = await (await deps.fetch(url + "/health")).json();
  } catch {
    // It can take a few seconds for a new deploy to be reachable everywhere.
  }
  if (health && health.service === "zonk-relay" && health.ready) {
    log("It answers.");
  } else {
    log("It did not answer yet. Wait a minute and open " + url + "/health in a browser.");
  }

  const directory = directoryFrom(config);
  log("\n==================================================================");
  log("Your relay is ready: " + url);
  log("");
  log("Host token (shown only now, keep it private): " + hostToken);
  if (apiKey) log("API key for people you let chat (shown only now):  " + apiKey);
  log("");
  log("On your phone: Zonk-Core -> Settings -> Share this phone.");
  log("Paste the relay address and the host token, then open the Host tab and start sharing.");
  if (publicRelay && directory) log("\nIt is listed on the relay page within a minute: " + directory);
  if (!publicRelay) log("\nPrivate relay: it is not listed anywhere. Others need your API key to chat.");
  log("==================================================================");
}

async function main() {
  if (!existsSync(fileURLToPath(new URL("../node_modules/wrangler", import.meta.url)))) {
    console.error("Run `npm install` first, then `npm run setup`.");
    process.exit(1);
  }
  const deps = realDeps();
  try {
    await setup(deps);
  } catch (e) {
    console.error("\n" + (e && e.message ? e.message : e));
    process.exitCode = 1;
  } finally {
    deps.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
