import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { SESSION_ID, isEntry, ledgerFile, loadConfig, logHookError, readLedger, readStdin, withLedgerLock, writeJsonAtomic } from "./context.mjs";

export const TITLE_MODEL_TIMEOUT_MS = 12000;
export const TITLE_SYSTEM = "You name coding sessions. Reply with one name of 2 to 5 lowercase English words separated by single spaces, letters and digits only, nothing else.";
export const TITLE_CHILD_ENV = "WF_TITLE_CHILD";
export const CLEAR_TERMINAL_SEQUENCE = "\u001b]0;\u0007";
const NAME_MAX_CHARS = 40;
const NAME_MAX_WORDS = 5;
const FALLBACK_MAX_WORDS = 4;
const PROMPT_MAX_CHARS = 2000;
const TASK_SUMMARY = /[\\/]\.work[\\/]\d{8}-\d{4}-([a-z0-9][a-z0-9-]*)[\\/]summary\.md$/;
const TASK_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const TIER = /^T[1-5]$/;
const SUMMARY_TIER = /^[^\w\n]*\**Tier\**\s*:\s*(T[1-5])\b/m;
const STAGES = ["named", "renamed", "user"];
const STOP_WORDS = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "is", "are", "be", "it", "this", "that", "please", "can", "could", "you", "i", "me", "my", "we"]);
const SESSION_ENV_KEYS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_EXECPATH", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_PROJECT_DIR"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fold(text) {
  return String(text).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function clipAtSpace(text, max = NAME_MAX_CHARS) {
  if (text.length <= max) return text;
  if (text[max] === " ") return text.slice(0, max);
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return space > 0 ? cut.slice(0, space) : cut;
}

export function nameWords(text) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .find((candidate) => candidate.trim() !== "");
  if (line === undefined) return null;
  const words = fold(line)
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
  if (words[0] === "wf") {
    words.shift();
    if (/^t[0-5]$/.test(words[0] ?? "")) words.shift();
  }
  if (words.length < 2) return null;
  return clipAtSpace(words.slice(0, NAME_MAX_WORDS).join(" "));
}

export function fallbackName(prompt) {
  const words = fold(String(prompt ?? "").slice(0, PROMPT_MAX_CHARS))
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "" && !STOP_WORDS.has(word));
  if (words.length === 0) return "session";
  return clipAtSpace(words.slice(0, FALLBACK_MAX_WORDS).join(" "));
}

export function titlePrefix(tier) {
  return typeof tier === "string" && TIER.test(tier) ? `wf(${tier})-` : "";
}

export function summaryTier(content) {
  if (typeof content !== "string") return null;
  return SUMMARY_TIER.exec(content)?.[1] ?? null;
}

export function titleFor(words, tier = null) {
  return `${titlePrefix(tier)}${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export function slugWords(slug) {
  return slug.replaceAll("-", " ");
}

function sameTitle(a, b) {
  return String(a).trim().replace(/\s+/g, " ") === String(b).trim().replace(/\s+/g, " ");
}

function quoteArg(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

export function titleChildEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || SESSION_ENV_KEYS.includes(key) || key.startsWith("CLAUDE_CODE_SESSION_")) continue;
    out[key] = value;
  }
  out[TITLE_CHILD_ENV] = "1";
  return out;
}

export function generateName(prompt, { env = process.env, platform = process.platform, spawn = spawnSync } = {}) {
  const args = ["-p", "--model", "haiku", "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--system-prompt", TITLE_SYSTEM];
  const windows = platform === "win32";
  const result = spawn(windows ? quoteArg("claude") : "claude", windows ? args.map(quoteArg) : args, {
    input: String(prompt).slice(0, PROMPT_MAX_CHARS),
    encoding: "utf8",
    timeout: TITLE_MODEL_TIMEOUT_MS,
    cwd: os.tmpdir(),
    windowsHide: true,
    env: titleChildEnv(env),
    ...(windows ? { shell: true } : {})
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
  return nameWords(result.stdout);
}

function readTitle(ledger) {
  const raw = isObject(ledger?.title) ? ledger.title : {};
  return {
    name: typeof raw.name === "string" && raw.name !== "" ? raw.name : null,
    stage: STAGES.includes(raw.stage) ? raw.stage : null,
    task: typeof raw.task === "string" && TASK_SLUG.test(raw.task) ? raw.task : null,
    tier: typeof raw.tier === "string" && TIER.test(raw.tier) ? raw.tier : null
  };
}

function updateTitle(file, sessionId, change) {
  return withLedgerLock(file, () => {
    const ledger = readLedger(file) ?? { sessionId, updatedAt: new Date().toISOString(), agents: {} };
    const next = change(readTitle(ledger));
    if (next === null) return false;
    writeJsonAtomic(file, { ...ledger, title: next });
    return true;
  });
}

export function handleWrite(input, { config }) {
  if (input.tool_name !== "Write") return false;
  if (typeof input.agent_id === "string" && input.agent_id !== "") return false;
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return false;
  const filePath = input.tool_input?.file_path;
  const match = typeof filePath === "string" ? TASK_SUMMARY.exec(filePath) : null;
  if (match === null) return false;
  return updateTitle(ledgerFile(config.stateDir, sessionId), sessionId, (title) => (title.task === null ? { ...title, task: match[1], tier: summaryTier(input.tool_input?.content) } : null));
}

export function handlePrompt(input, { config, generate = generateName, env = process.env }) {
  if (env[TITLE_CHILD_ENV]) return null;
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  const file = ledgerFile(config.stateDir, sessionId);
  const before = readTitle(readLedger(file));
  if (before.stage === "renamed" || before.stage === "user") return null;
  const current = typeof input.session_title === "string" && input.session_title.trim() !== "" ? input.session_title : null;
  if (current !== null && (before.name === null || !sameTitle(current, before.name))) {
    updateTitle(file, sessionId, (title) => (title.stage === "renamed" || title.stage === "user" ? null : { ...title, stage: "user" }));
    return null;
  }
  let next;
  if (before.name !== null) {
    if (before.task === null) return null;
    next = { name: titleFor(slugWords(before.task), before.tier), stage: "renamed" };
  } else {
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (prompt.trim() === "" || prompt.trimStart().startsWith("/")) return null;
    if (before.task !== null) next = { name: titleFor(slugWords(before.task), before.tier), stage: "renamed" };
    else next = { name: titleFor(generate(prompt) ?? fallbackName(prompt)), stage: "named" };
  }
  const written = updateTitle(file, sessionId, (title) => {
    if (title.name !== before.name || title.stage !== before.stage) return null;
    return { name: next.name, stage: next.stage, task: title.task, tier: title.tier };
  });
  if (!written || (current !== null && sameTitle(next.name, current))) return null;
  return next.name;
}

export function handleClear(input, { config, env = process.env }) {
  if (env[TITLE_CHILD_ENV] || input.source !== "clear") return false;
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return true;
  const file = ledgerFile(config.stateDir, sessionId);
  if (!existsSync(file)) return true;
  withLedgerLock(file, () => {
    const ledger = readLedger(file);
    if (!isObject(ledger) || !Object.hasOwn(ledger, "title")) return;
    const { title: _title, ...rest } = ledger;
    writeJsonAtomic(file, rest);
  });
  return true;
}

export async function main() {
  const config = loadConfig();
  try {
    const raw = await readStdin();
    const input = raw.trim() === "" ? {} : JSON.parse(raw);
    if (!isObject(input)) throw new Error("hook input is not a JSON object");
    if (input.hook_event_name === "PostToolUse") {
      handleWrite(input, { config });
      return;
    }
    if (input.hook_event_name === "SessionStart") {
      if (handleClear(input, { config })) process.stdout.write(`${JSON.stringify({ terminalSequence: CLEAR_TERMINAL_SEQUENCE })}\n`);
      return;
    }
    if (input.hook_event_name !== "UserPromptSubmit") return;
    const title = handlePrompt(input, { config });
    if (title !== null) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: title } })}\n`);
  } catch (error) {
    logHookError(config.stateDir, "title", error);
  }
}

if (isEntry(import.meta.url)) {
  try {
    await main();
  } catch {}
  process.exitCode = 0;
}
