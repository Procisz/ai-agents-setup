import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SESSION = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
export const CWD = "/work/demo-project";

function base({ session, agentId, timestamp, type }) {
  return {
    parentUuid: crypto.randomUUID(),
    isSidechain: agentId !== undefined,
    ...(agentId === undefined ? {} : { agentId }),
    type,
    uuid: crypto.randomUUID(),
    timestamp,
    userType: "external",
    entrypoint: "cli",
    cwd: CWD,
    sessionId: session,
    version: "2.1.312",
    gitBranch: "main"
  };
}

export function assistantLine({ session = SESSION, agentId, timestamp, input = 2, creation = 0, read = 0, model = "claude-sonnet-5-5", kind = "text" }) {
  const content = kind === "tool_use" ? [{ type: "tool_use", id: `toolu_${crypto.randomBytes(8).toString("hex")}`, name: "Read", input: { file_path: `${CWD}/src/index.js` } }] : [{ type: "text", text: "Working on it." }];
  return {
    ...base({ session, agentId, timestamp, type: "assistant" }),
    message: {
      model,
      id: `msg_${crypto.randomBytes(8).toString("hex")}`,
      type: "message",
      role: "assistant",
      content,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: creation,
        cache_read_input_tokens: read,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: creation },
        output_tokens: 8,
        service_tier: "standard"
      }
    },
    requestId: `req_${crypto.randomBytes(8).toString("hex")}`
  };
}

export function userLine({ session = SESSION, agentId, timestamp, toolResult = false, isMeta = false, text = "Continue with the plan." }) {
  const content = toolResult ? [{ tool_use_id: `toolu_${crypto.randomBytes(8).toString("hex")}`, type: "tool_result", content: "file contents" }] : text;
  return {
    ...base({ session, agentId, timestamp, type: "user" }),
    ...(isMeta ? { isMeta: true } : {}),
    message: { role: "user", content }
  };
}

export function systemLine({ session = SESSION, timestamp }) {
  return { ...base({ session, timestamp, type: "system" }), subtype: "local_command", content: "local command output", level: "info" };
}

export function writeTranscript(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
  return file;
}

export function sessionLayout(root, session = SESSION) {
  const projectDir = path.join(root, "projects", "-work-demo-project");
  return {
    projectDir,
    mainTranscript: path.join(projectDir, `${session}.jsonl`),
    subagentsDir: path.join(projectDir, session, "subagents"),
    agentTranscript: (agentId, ...nested) => path.join(projectDir, session, "subagents", ...nested, `agent-${agentId}.jsonl`)
  };
}
