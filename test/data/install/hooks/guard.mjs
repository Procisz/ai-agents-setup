import fs from "node:fs";

if (process.env.NODE_TEST_CONTEXT) process.exit(0);

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}
const command = String(input.tool_input?.command ?? "");
const readOnly = /^git\s+(status|diff|log|show)\b/.test(command);
if (input.agent_id && input.agent_type !== "wf:git" && /\bgit\b/.test(command) && !readOnly) {
  process.stderr.write(`wf guard: subagent ${input.agent_id} may not run "${command}": only wf:git runs git and gh writes.\n`);
  process.exit(2);
}
process.exit(0);
