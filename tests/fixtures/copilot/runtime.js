// JSON-RPC runtime substitute. The real SDK communicates over stdio; no model or credentials are used.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = fileURLToPath(new URL(".", import.meta.url));
const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
let sessionId;
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const event = (type, data = {}) => send({ method: "session.event", params: { sessionId, event: { type, data, id: crypto.randomUUID(), timestamp: new Date().toISOString() } } });
const usage = () => event("assistant.usage", { model: "gpt-6-luna", inputTokens: 51, outputTokens: 6, copilotUsage: { totalNanoAiu: 810000 } });
function handle(request) {
  if (request.id == null) return;
  if (scenario.outcome === "unresponsive" && ["session.abort", "session.delete", "session.detach", "runtime.shutdown"].includes(request.method)) return;
  let result = {};
  if (request.method === "connect") result = { protocolVersion: 3 };
  if (request.method === "session.create") {
    sessionId = request.params.sessionId ?? "test-session";
    writeFileSync(join(dir, "session.json"), JSON.stringify(request.params));
    result = { sessionId };
  }
  if (request.method === "session.send") {
    writeFileSync(join(dir, "message.json"), JSON.stringify(request.params));
    if (scenario.outcome !== "send-error") send({ id: request.id, result: { messageId: "test-message" } });
    event("assistant.message_delta", { deltaContent: "Test article" });
    if (scenario.outcome !== "no-usage") usage();
    if (["success", "no-usage"].includes(scenario.outcome)) event("session.idle");
    if (scenario.outcome === "error") event("session.error", { errorType: scenario.errorType ?? "query", message: "model error" });
    if (scenario.outcome === "send-error") send({ id: request.id, error: { code: -32603, message: "send failure" } });
    return;
  }
  if (request.method === "session.abort") {
    // A runtime may signal idle after an abort, despite having produced only a partial Article.
    event("session.idle");
  }
  send({ id: request.id, result });
  if (request.method === "runtime.shutdown") setTimeout(() => process.exit(0), 10);
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) break;
    const length = Number(buffer.subarray(0, end).toString().match(/Content-Length: (\d+)/i)?.[1]);
    if (buffer.length < end + 4 + length) break;
    const request = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    handle(request);
  }
});
