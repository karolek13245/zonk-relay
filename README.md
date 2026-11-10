# Zonk Relay

A tiny server that you put on **your own Cloudflare account** (the free plan is enough). The phone that runs
[Zonk-Core](https://github.com/karolek13245/zonk-core) connects to it and shares its AI model. Other people use the
relay like any OpenAI-style server, and a public relay is listed on the live **Zonk Relays** page, so the app can find a
working relay by itself.

```
 your phone  <──── WebSocket ────  your relay (Cloudflare Worker)  <──── chat requests ────  apps and people
 (the model runs here)                  you own it, you set the rules
```

Nothing runs on a server of ours. The relay only passes messages between the app and the phone.

## Set it up (pick one way)

### A. One click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/karolek13245/zonk-relay)

1. Press the button and log in to Cloudflare. It copies this repo to your GitHub account and deploys it.
2. It asks for two secrets, `HOST_TOKEN` and `API_KEY`. Make each one with `openssl rand -hex 24` (any random text of
   16 or more characters works, and the two must differ). Save them in a password manager. You paste `HOST_TOKEN` into the phone app.
3. When the deploy is done your relay is at `https://zonk-relay.<your-account>.workers.dev`.
4. To make it public, see [Public or private](#public-or-private).

### B. Automatic, from your computer

You need [Node.js](https://nodejs.org) 20 or newer.

```
git clone https://github.com/karolek13245/zonk-relay
cd zonk-relay
npm install
npm run setup
```

The script opens your browser so you can log in to your own Cloudflare account, asks whether the relay should be public,
deploys it, creates both secrets with random values, and prints the relay address and the host token **once**.
The secrets are never written to a file.

### C. By hand

```
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put HOST_TOKEN      # paste a random text of 16+ characters
npx wrangler secret put API_KEY         # a different one
```

If a secret is missing, too short, or the two are equal, the relay refuses every request with "Server is not configured."
(the reason is written to the Worker log, never sent to callers).

## Connect your phone

1. Zonk-Core 1.4 or newer: **Settings → Share this phone**. Paste the relay address and the host token.
2. Open the **Host** tab and tap **Start sharing**. Keep the phone plugged in and on Wi-Fi.
3. Check it: open `https://zonk-relay.<your-account>.workers.dev/health` in a browser. A public relay shows `"hosts":1`.

## Public or private

| | Private (default) | Public |
|---|---|---|
| Who can chat | only people with your `API_KEY` | everyone, no key (limited to 20 requests a minute per address) |
| Listed on the Zonk Relays page | no | yes, automatically |
| Who can share a phone | only you (`HOST_TOKEN`) | only you (`HOST_TOKEN`) |

To go public set `"PUBLIC_MODE": "true"` in `wrangler.jsonc` (in your copy of the repo; Cloudflare redeploys by itself,
or run `npx wrangler deploy`). `npm run setup` asks you. Back to private: set it to `"false"`.

**A public relay means strangers use your phone.** They spend its battery and their messages pass through your phone.
Only switch it on when you are fine with that, and tell people not to send private information.

### The relay list

A public relay on `workers.dev` tells the relay list about itself the first time a phone connects (and then every few hours).
It only sends its own address. The list checks the relay by asking `/health`, shows its subdomain on the Zonk Relays page,
and the Zonk-Core app picks a working relay from it. If a relay stops answering it turns grey and, after three days, is removed.
Not wanted? Set `"DIRECTORY_URL": ""` in `wrangler.jsonc` and the relay never announces itself (it still works, just nobody finds it).

Only `name.account.workers.dev` addresses can be listed.

## Endpoints

- `GET /health` (open to everyone) `{"service":"zonk-relay","version","public","ready","hosts","models"}`. A private relay only says that it exists.
- `GET /host` (WebSocket; `Authorization: Bearer <HOST_TOKEN>` header only. A `?token=` in the address is refused, because addresses end up in logs)
- `POST /v1/chat/completions`, `GET /v1/models` (`Authorization: Bearer <API_KEY>`, or nothing on a public relay)
- `GET /status` (`Authorization: Bearer <API_KEY>` always)

## Phone protocol

Phone → relay: `{"type":"hello","model":"...","name":"..."}` first; text `ping` every ~30 s (the relay answers `pong`); `{"type":"response","id","content","promptTokens","completionTokens"}`; `{"type":"error","id","message"}`.
Relay → phone: `{"type":"request","id","messages","options"}`, `{"type":"cancel","id"}`.

## The relay list Worker (`directory/`)

This is the small second Worker behind the Zonk Relays page. You only need it if you want to run your own list.

```
cd directory
npm install
npx wrangler deploy
```

It serves the page at `/`, the list at `GET /relays` (`?all=1` includes offline ones) and takes announcements at `POST /register`.
Every relay is checked by the list itself before it is shown (`GET <relay>/health` must say it is a ready, public Zonk relay)
and again every couple of minutes. Limits: 300 relays, 30 announcements per address and 120 in total per hour, and nothing
outside `*.workers.dev` is ever contacted. Point relays at your list with `DIRECTORY_URL`, and the app with its "Relay list" setting.

## Pretend phone

`node tools/fake-host.mjs wss://zonk-relay.<you>.workers.dev <HOST_TOKEN>`, then send a chat request to `/v1/chat/completions`.

## Tests

`npm install`, then `npm test` (Node 22+). They check login, public mode, rate limits, the relay list, the setup script and the
phone-to-app flow without needing Cloudflare.

## Limits

- One request at a time per phone; extra requests queue (max 20).
- A chat request may be at most 256 KB and 200 messages. Messages must be text (a list of text parts is joined). `max_tokens` is capped at 4096; `temperature` and `top_p` are kept in range.
- Streaming is emulated: the full answer arrives as one chunk.
- No accounts: one shared `API_KEY` for a private relay, and per-address limits for a public one. For more protection add a Cloudflare rate-limiting rule for `/v1/*` and `/host` (Security → WAF → Rate limiting rules).
- Any website can call the API (`access-control-allow-origin: *`). A private relay still needs the API key, which is sent in a header and never in a cookie.

## Keep secrets out of the repo

`API_KEY` and `HOST_TOKEN` live only in Cloudflare's Variables and Secrets (or in a local `.dev.vars` file, which is git-ignored).
Never commit them or paste them into an issue.
