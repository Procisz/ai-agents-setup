import { classifyGh, classifyGit, invocationText, invocations, looksLikeGitWrite, mentionsTool } from "./git.mjs";
import { isEntry, loadConfig, logHookError, readStdin } from "./context.mjs";

export const GIT_AGENT = "wf:git";
const ALLOW = Object.freeze({ allow: true, message: null });
const MAX_SHOWN = 200;
const SUBAGENT_WRITE = `only ${GIT_AGENT} runs git and gh writes; leave the changes in the working tree for the orchestrator`;
const MAIN_WRITE = `only ${GIT_AGENT} runs git and gh writes; delegate them to ${GIT_AGENT} only when it is installed and the approved summary asks for git work, else leave the work uncommitted and list the commands in the report`;

function clip(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > MAX_SHOWN ? `${flat.slice(0, MAX_SHOWN - 3)}...` : flat;
}

function verdictOf(entry, command) {
  if (entry.tool === "git") return classifyGit(entry);
  if (entry.tool === "gh") return classifyGh(entry);
  if (entry.tool === "dynamic") {
    const hidden = (mentionsTool(command, "git") && classifyGit(entry.git).level !== "read") || (mentionsTool(command, "gh") && classifyGh(entry.gh).level !== "read");
    return hidden ? { level: "write", reason: `the variable command word ${entry.command} hides a git or gh write` } : null;
  }
  if (entry.tool === "opaque" && looksLikeGitWrite(entry.scan ?? entry.text)) {
    const where = entry.deep ? "a script nested more than 3 shells deep" : entry.runner;
    return { level: "write", reason: `a git or gh write inside ${where} cannot be checked` };
  }
  return null;
}

function refusalReason(verdict, subagent) {
  if (verdict === null || verdict.level === "read") return null;
  return verdict.reason ?? (subagent ? SUBAGENT_WRITE : MAIN_WRITE);
}

export function unrestricted(agentType) {
  return agentType === GIT_AGENT;
}

export function evaluate({ command, subagent = false, agentType = "", parse = invocations }) {
  if (unrestricted(agentType)) return ALLOW;
  const who = subagent ? `subagent ${agentType || "unknown"}` : "the orchestrator";
  const refuse = (shown, reason) => ({ allow: false, message: `wf guard: ${who} may not run "${clip(shown)}": ${reason}.` });
  let entries;
  try {
    entries = parse(command);
  } catch {
    return looksLikeGitWrite(command) ? refuse(command, "the command could not be parsed and looks like a git or gh write") : ALLOW;
  }
  for (const entry of entries) {
    const reason = refusalReason(verdictOf(entry, command), subagent);
    if (reason) return refuse(entry.tool === "opaque" || entry.tool === "dynamic" ? entry.text : invocationText(entry), reason);
  }
  return ALLOW;
}

const SHELL_TOOLS = new Set(["Bash", "Monitor", "PowerShell"]);

export function decide(input) {
  if (input === null || typeof input !== "object") return ALLOW;
  if (typeof input.tool_name === "string" && !SHELL_TOOLS.has(input.tool_name)) return ALLOW;
  const command = input.tool_input?.command;
  if (typeof command !== "string" || command.trim() === "") return ALLOW;
  return evaluate({
    command,
    subagent: typeof input.agent_id === "string" && input.agent_id !== "",
    agentType: typeof input.agent_type === "string" ? input.agent_type : ""
  });
}

export async function main() {
  const config = loadConfig();
  try {
    const result = decide(JSON.parse(await readStdin()));
    if (!result.allow) {
      process.stderr.write(`${result.message}\n`);
      process.exitCode = 2;
    }
  } catch (error) {
    logHookError(config.stateDir, "guard", error);
    process.exitCode = 0;
  }
}

if (isEntry(import.meta.url)) await main();
