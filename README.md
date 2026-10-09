# Zonk Relay

Cloudflare Worker + Durable Object. Phones dial out to `/host` over WebSocket; apps call an OpenAI-style API.

## Deploy
1. Push this repo to GitHub, import it in Cloudflare (Workers & Pages -> Create -> Import a repository). Name `zonk-relay`, build command empty, deploy command `npx wrangler deploy`.
2. Worker -> Settings -> Variables and Secrets: add secrets `API_KEY` and `HOST_TOKEN` (16+ characters each). Generate: `head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'`
3. Test: `curl https://zonk-relay.<you>.workers.dev/status -H "Authorization: Bearer <API_KEY>"`

## Endpoints
- `GET /host` (WebSocket; `Authorization: Bearer <HOST_TOKEN>` or `?token=`)
- `POST /v1/chat/completions`, `GET /v1/models`, `GET /status` (`Authorization: Bearer <API_KEY>`)

## Phone protocol
Phone -> relay: `{"type":"hello","model":"...","name":"..."}` first; text `ping` every ~30 s (relay answers `pong`); `{"type":"response","id","content","promptTokens","completionTokens"}`; `{"type":"error","id","message"}`.
Relay -> phone: `{"type":"request","id","messages","options"}`, `{"type":"cancel","id"}`.

## Pretend phone
`node tools/fake-host.mjs wss://zonk-relay.<you>.workers.dev <HOST_TOKEN>`, then curl chat/completions.

## Limits
- One request at a time per phone; extra requests queue (max 20).
- Streaming is emulated: the full answer arrives as one chunk.
- One shared API key, no per-user limits yet.
