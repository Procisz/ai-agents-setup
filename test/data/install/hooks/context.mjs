import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.NODE_TEST_CONTEXT) process.exit(0);

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}
if (!input.session_id || !input.transcript_path) process.exit(0);
const config = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "config.json"), "utf8"));
const lines = fs.readFileSync(input.transcript_path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const last = lines.filter((line) => line.type === "assistant" && line.message?.usage).at(-1);
const usage = last.message.usage;
const tokens = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
fs.mkdirSync(config.stateDir, { recursive: true });
const ledger = { sessionId: input.session_id, updatedAt: new Date().toISOString(), agents: { main: { type: "main", transcript: input.transcript_path, tokens, percent: tokens / config.window, band: "ok", calls: 1 } } };
fs.writeFileSync(path.join(config.stateDir, `${input.session_id}.json`), JSON.stringify(ledger));
process.exit(0);
