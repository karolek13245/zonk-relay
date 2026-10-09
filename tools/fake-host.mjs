// Pretend phone for testing. Usage:
//   node tools/fake-host.mjs wss://zonk-relay.<you>.workers.dev <HOST_TOKEN>
// Needs Node 22+ (global WebSocket).
const [base, token] = process.argv.slice(2);
if (!base || !token) {
  console.log("usage: node tools/fake-host.mjs <wss://url> <HOST_TOKEN>");
  process.exit(1);
}
const ws = new WebSocket(`${base.replace(/\/$/, "")}/host?token=${encodeURIComponent(token)}`);
ws.onopen = () => {
  console.log("connected");
  ws.send(JSON.stringify({ type: "hello", model: "fake-model", name: "fake-phone" }));
  setInterval(() => ws.send("ping"), 30000);
};
ws.onmessage = (e) => {
  if (e.data === "pong") return;
  const msg = JSON.parse(e.data);
  if (msg.type !== "request") return;
  const last = msg.messages[msg.messages.length - 1]?.content ?? "";
  console.log("request:", last);
  setTimeout(() => ws.send(JSON.stringify({
    type: "response", id: msg.id,
    content: `Fake phone says: you wrote "${last}"`,
    promptTokens: 5, completionTokens: 8,
  })), 800);
};
ws.onclose = () => { console.log("closed"); process.exit(0); };
ws.onerror = () => console.log("error");
