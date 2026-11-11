import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS = Object.freeze({
  window: 1000000,
  warnTokens: 500000,
  handoffTokens: 800000,
  compactTokens: 850000,
  bufferStepTokens: 50000,
  overEveryCalls: 5,
  keepwarmMinutes: 58,
  keepwarmPollSeconds: 20,
  keepwarmShortMinutes: 4,
  keepwarmShortMaxMinutes: 30
});
const ROLE_NAME = /^[a-z]+$/;
const CACHE_TTLS = Object.freeze(["5m", "1h"]);
export const TAIL_BYTES = 512 * 1024;
export const LEDGER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SEARCH_DIRS = 2000;
const LOCAL_COMMAND = /^\s*<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/;
const INTERRUPTED = /^\s*\[Request interrupted by user/;
export const LOCK_WAIT_MS = 400;
export const LOCK_STALE_MS = 2000;
const LOCK_STEP_MS = 10;
const LOCK_PRUNE_MS = 60000;
export const LIVE_SESSION_MS = 75 * 60000;
export const COMPACT_TOOL = "mcp__wf__compact";
const SESSION_LINE = /^Session:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s*$/m;
const KEEPWARM_PING = "wf keep-warm ping:";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isEntry(moduleUrl, argv = process.argv) {
  try {
    return typeof argv[1] === "string" && fs.realpathSync(argv[1]) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

export async function readStdin(stream = process.stdin) {
  let raw = "";
  for await (const chunk of stream) raw += chunk;
  return raw;
}

export function defaultStateDir(env = process.env, homedir = os.homedir()) {
  const configHome = typeof env.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR.trim() !== "" ? env.CLAUDE_CONFIG_DIR : path.join(homedir, ".claude");
  return path.join(configHome, "ai-agents-setup", "state");
}

export function loadConfig({ file = path.join(HOOK_DIR, "config.json"), env = process.env, homedir } = {}) {
  const config = { ...DEFAULTS, stateDir: defaultStateDir(env, homedir ?? os.homedir()), cacheTtl: {} };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return config;
  }
  if (!isObject(parsed)) return config;
  for (const key of Object.keys(DEFAULTS)) {
    if (typeof parsed[key] === "number" && Number.isFinite(parsed[key]) && parsed[key] > 0) config[key] = parsed[key];
  }
  if (typeof parsed.stateDir === "string" && path.isAbsolute(parsed.stateDir)) config.stateDir = parsed.stateDir;
  if (isObject(parsed.cacheTtl)) {
    for (const [role, ttl] of Object.entries(parsed.cacheTtl)) {
      if (ROLE_NAME.test(role) && CACHE_TTLS.includes(ttl)) config.cacheTtl[role] = ttl;
    }
  }
  return config;
}

export function cacheTtlOf(config, agentType) {
  return config.cacheTtl?.[roleOf(agentType)] === "5m" ? "5m" : "1h";
}

export function contextLimits(config, env = process.env) {
  const base = {
    window: config.window,
    warn: config.warnTokens,
    handoff: config.handoffTokens,
    compact: config.compactTokens,
    step: config.bufferStepTokens,
    overEvery: config.overEveryCalls
  };
  const raw = typeof env.WF_CONTEXT_WINDOW === "string" ? env.WF_CONTEXT_WINDOW.trim() : "";
  const window = Number(raw);
  if (raw === "" || !Number.isFinite(window) || window <= 0) return base;
  const scale = (value) => Math.max(1, Math.round((window * value) / config.window));
  return { ...base, window: Math.round(window), warn: scale(config.warnTokens), handoff: scale(config.handoffTokens), compact: scale(config.compactTokens), step: scale(config.bufferStepTokens) };
}

export function formatTokens(tokens) {
  const value = Math.max(0, Math.round(Number(tokens) || 0));
  if (value >= 1000000) return `${Number((value / 1000000).toFixed(2))}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

export function percentOf(tokens, window) {
  return window > 0 ? Math.round((tokens / window) * 1000) / 10 : 0;
}

export function bandOf(tokens, limits) {
  if (tokens >= limits.handoff) return "over";
  if (tokens >= limits.warn) return "buffer";
  return "ok";
}

export function logHookError(stateDir, hook, error) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const line = `${new Date().toISOString()} ${hook}: ${detail.replace(/\s+/g, " ").slice(0, 500)}\n`;
    fs.appendFileSync(path.join(stateDir, "hook-errors.log"), line);
  } catch {}
}

export function readTailLines(file, bytes = TAIL_BYTES) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const count = fs.readSync(fd, buffer, done, length - done, start + done);
      if (count === 0) break;
      done += count;
    }
    const lines = buffer.subarray(0, done).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter((line) => line.trim() !== "");
  } finally {
    fs.closeSync(fd);
  }
}

function parseLine(line) {
  try {
    const value = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function usageTokens(usage) {
  if (!isObject(usage)) return 0;
  return count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens);
}

export function lastUsage(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const entry = parseLine(lines[i]);
    if (!entry || entry.type !== "assistant" || !isObject(entry.message)) continue;
    if (entry.message.model === "<synthetic>") continue;
    const tokens = usageTokens(entry.message.usage);
    if (tokens > 0) return { tokens, timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null };
  }
  return null;
}

function messageText(entry) {
  const content = entry?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const first = content.find((block) => isObject(block));
  return first?.type === "text" && typeof first.text === "string" ? first.text : "";
}

export function isRequestLine(entry) {
  if (!isObject(entry) || entry.type !== "user") return false;
  if (isObject(entry.origin) && entry.origin.kind === "coordinator") return true;
  if (entry.isMeta === true) return false;
  const text = messageText(entry);
  return !LOCAL_COMMAND.test(text) && !INTERRUPTED.test(text);
}

function isRealAssistant(entry) {
  return entry.type === "assistant" && isObject(entry.message) && entry.message.model !== "<synthetic>" && usageTokens(entry.message.usage) > 0;
}

export function lastRequest(lines) {
  let fallback = null;
  let afterAssistant = false;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const entry = parseLine(lines[i]);
    if (!entry) continue;
    const time = Date.parse(entry.timestamp);
    if (!Number.isFinite(time)) continue;
    if (fallback === null) fallback = time;
    if (isRequestLine(entry)) return { time, source: "user" };
    if (afterAssistant && entry.type !== "assistant") return { time, source: "request" };
    if (isRealAssistant(entry)) afterAssistant = true;
  }
  return fallback === null ? null : { time: fallback, source: "last" };
}

export function transcriptLastRequest(file) {
  const found = lastRequest(readTailLines(file));
  if (found) return found;
  return { time: fs.statSync(file).mtimeMs, source: "mtime" };
}

function isKeepwarmPing(line) {
  const entry = parseLine(line);
  return entry?.type === "user" && messageText(entry).includes(KEEPWARM_PING);
}

export function lastWorkRequestTime(file) {
  const found = lastRequest(readTailLines(file).filter((line) => !isKeepwarmPing(line)));
  if (found !== null && found.source !== "last") return found.time;
  return transcriptLastRequest(file).time;
}

export function findSubagentTranscript(transcriptPath, sessionId, agentId) {
  if (typeof transcriptPath !== "string" || transcriptPath === "" || !SESSION_ID.test(String(sessionId)) || !AGENT_ID.test(String(agentId))) return null;
  const target = `agent-${agentId}.jsonl`;
  if (path.basename(transcriptPath) === target && fs.existsSync(transcriptPath)) return transcriptPath;
  const stack = [path.join(path.dirname(transcriptPath), sessionId, "subagents")];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_SEARCH_DIRS) {
    const dir = stack.pop();
    visited += 1;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === target) return path.join(dir, entry.name);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
    }
  }
  return null;
}

export function ledgerFile(stateDir, sessionId) {
  return path.join(stateDir, `${sessionId}.json`);
}

export function readLedger(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isObject(value) && isObject(value.agents)) return value;
  } catch {}
  return null;
}

export function newestLedger(stateDir) {
  let best = null;
  let entries = [];
  try {
    entries = fs.readdirSync(stateDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || !SESSION_ID.test(entry.name.slice(0, -5))) continue;
    const file = path.join(stateDir, entry.name);
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (best === null || mtime > best.mtime) best = { file, mtime, sessionId: entry.name.slice(0, -5) };
    } catch {}
  }
  return best;
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {}
    throw error;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withLedgerLock(file, fn, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  let held = false;
  while (!held) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      held = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") break;
    }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
        fs.unlinkSync(lock);
        continue;
      }
    } catch {}
    if (Date.now() >= deadline) break;
    sleepSync(LOCK_STEP_MS);
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.unlinkSync(lock);
      } catch {}
    }
  }
}

export function pruneLedgers(stateDir, now = Date.now(), keep = null) {
  const removed = [];
  let entries = [];
  try {
    entries = fs.readdirSync(stateDir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ledger = entry.name.endsWith(".json") && SESSION_ID.test(entry.name.slice(0, -5));
    const temp = entry.name.endsWith(".tmp") && entry.name.includes(".json.");
    const lock = entry.name.endsWith(".json.lock") && SESSION_ID.test(entry.name.slice(0, -10));
    if (!ledger && !temp && !lock) continue;
    const file = path.join(stateDir, entry.name);
    if (file === keep || (keep !== null && file === `${keep}.lock`)) continue;
    try {
      if (now - fs.statSync(file).mtimeMs > (lock ? LOCK_PRUNE_MS : LEDGER_MAX_AGE_MS)) {
        fs.unlinkSync(file);
        removed.push(file);
      }
    } catch {}
  }
  return removed;
}

export function roleOf(agentType) {
  const match = /^wf:([a-z]+)(?:-t[0-9])?$/.exec(String(agentType ?? ""));
  return match ? match[1] : "<role>";
}

function workerStop(role) {
  if (role === "debugger") return "put your analysis so far (root cause or best hypothesis, evidence, what is left) under Open issues and end with Status: blocked; you write no handoff note and no other debugger takes over";
  const sections = "sections Done, Remaining, Key facts, Files touched, Checks state";
  const write = role === "reviewer" ? `put the handoff ${sections} at the end of Open issues (you write no file; the orchestrator saves the note)` : `write your handoff note .work/<task>/handoff-${role}-<n>.md (${sections})`;
  return `${write} and end with Status: handoff`;
}

function workerNotice(band, tokens, limits, agentType) {
  const used = formatTokens(tokens);
  const window = formatTokens(limits.window);
  const percent = percentOf(tokens, limits.window);
  const handoff = formatTokens(limits.handoff);
  const stop = workerStop(roleOf(agentType));
  if (band === "over") {
    return `wf context: you have used ${used} of your ${window} token context (${percent}%), past the ${handoff} handoff line. Stop now: ${stop}.`;
  }
  return `wf context: you have used ${used} of your ${window} token context (${percent}%). Estimate the tokens you still need. If used plus still needed exceeds ${handoff}, finish the current step, ${stop}. Otherwise continue and do not re-read files.`;
}

function orchestratorNotice(band, tokens, limits) {
  const used = formatTokens(tokens);
  const window = formatTokens(limits.window);
  const percent = percentOf(tokens, limits.window);
  const handoff = formatTokens(limits.handoff);
  const compact = formatTokens(limits.compact);
  if (band === "over") {
    return `wf context: the orchestrator has used ${used} of its ${window} token context (${percent}%), past ${handoff}: compaction is due now, whatever runs. Finish a report or a T0 answer first. Right after an approval, write the task folder, summary.md and progress.md first; with a task folder, update progress.md in one edit (phase, workers with states and changed files, check results, assumptions, open issues). Then call ${COMPACT_TOOL} with next and end your turn at once, in the discussion too; the wf plugin compacts when the turn ends. The engine compacts on its own at ${compact}.`;
  }
  return `wf context: the orchestrator has used ${used} of its ${window} token context (${percent}%). Estimate what the rest of the task still brings into your context. When used plus needed stays under ${handoff}, go on without compacting: delegate reading, do not re-read files, keep progress.md current. Otherwise compact at the next point where no worker runs: start no new worker; once none runs, update progress.md, call ${COMPACT_TOOL} with next and end your turn (skill context-cache).`;
}

export function contextNotice({ band, tokens, limits, subagent, agentType }) {
  return subagent ? workerNotice(band, tokens, limits, agentType) : orchestratorNotice(band, tokens, limits);
}

function resolveTranscript(input, previous, subagent) {
  if (!subagent) return typeof input.transcript_path === "string" && input.transcript_path !== "" ? input.transcript_path : null;
  if (typeof previous?.transcript === "string" && fs.existsSync(previous.transcript)) return previous.transcript;
  return findSubagentTranscript(input.transcript_path, input.session_id, input.agent_id);
}

export function recordToolCall(input, { config, env = process.env, now = Date.now() }) {
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new Error(`invalid session_id ${JSON.stringify(sessionId)}`);
  const subagent = typeof input.agent_id === "string" && input.agent_id !== "";
  if (subagent && !AGENT_ID.test(input.agent_id)) throw new Error(`invalid agent_id ${JSON.stringify(input.agent_id)}`);
  const key = subagent ? input.agent_id : "main";
  const agentType = typeof input.agent_type === "string" && input.agent_type !== "" ? input.agent_type : subagent ? "unknown" : "main";
  const file = ledgerFile(config.stateDir, sessionId);
  const earlier = readLedger(file);
  const transcript = resolveTranscript(input, isObject(earlier?.agents?.[key]) ? earlier.agents[key] : null, subagent);
  const measured = transcript && fs.existsSync(transcript) ? lastUsage(readTailLines(transcript)) : null;
  const limits = contextLimits(config, env);
  return withLedgerLock(file, () => updateLedger({ file, key, sessionId, agentType, subagent, transcript, measured, limits, config, now }));
}

function updateLedger({ file, key, sessionId, agentType, subagent, transcript, measured, limits, config, now }) {
  const existing = readLedger(file);
  const previous = isObject(existing?.agents?.[key]) ? existing.agents[key] : null;
  const tokens = measured ? measured.tokens : count(previous?.tokens);
  const band = bandOf(tokens, limits);
  const calls = count(previous?.calls) + 1;
  const previousBand = typeof previous?.band === "string" ? previous.band : "ok";
  let lastNotifiedTokens = count(previous?.lastNotifiedTokens);
  let lastNotifiedCall = count(previous?.lastNotifiedCall);
  let due = false;
  if (band === "buffer") due = previousBand !== "buffer" || tokens - lastNotifiedTokens >= limits.step;
  else if (band === "over") due = previousBand !== "over" || calls - lastNotifiedCall >= limits.overEvery;
  else {
    lastNotifiedTokens = 0;
    lastNotifiedCall = 0;
  }
  const nudges = !subagent || agentType.startsWith("wf:");
  const notice = due && nudges ? contextNotice({ band, tokens, limits, subagent, agentType }) : null;
  if (notice) {
    lastNotifiedTokens = tokens;
    lastNotifiedCall = calls;
  }
  const stamp = new Date(now).toISOString();
  const entry = {
    type: agentType,
    transcript: transcript ?? (typeof previous?.transcript === "string" ? previous.transcript : null),
    tokens,
    percent: percentOf(tokens, limits.window),
    band,
    calls,
    lastNotifiedTokens,
    lastNotifiedCall,
    updatedAt: stamp
  };
  if (existing === null) pruneLedgers(config.stateDir, now, file);
  const latest = existing ?? { sessionId, updatedAt: stamp, agents: {} };
  latest.sessionId = sessionId;
  latest.updatedAt = stamp;
  latest.agents[key] = entry;
  writeJsonAtomic(file, latest);
  return { key, entry, notice, file };
}

export function findProjectRoot(cwd) {
  const start = path.resolve(typeof cwd === "string" && cwd !== "" ? cwd : process.cwd());
  let firstWork = null;
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (firstWork === null && fs.existsSync(path.join(dir, ".work"))) firstWork = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return firstWork ?? start;
}

export function taskSession(folder) {
  try {
    return SESSION_LINE.exec(fs.readFileSync(path.join(folder, "progress.md"), "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}

export function sessionActivity(stateDir, sessionId, now = Date.now()) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  const file = ledgerFile(stateDir, sessionId);
  let time = Date.parse(readLedger(file)?.updatedAt ?? "");
  if (!Number.isFinite(time)) {
    try {
      time = fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  }
  return { file, updatedAt: time, ageMs: Math.max(0, now - time), live: now - time < LIVE_SESSION_MS };
}

export function taskOwnership(folder, { stateDir, sessionId = null, now = Date.now() } = {}) {
  const owner = taskSession(folder);
  if (owner === null) return { folder, owner: null, state: "unowned", activity: null };
  if (sessionId !== null && owner === sessionId) return { folder, owner, state: "mine", activity: sessionActivity(stateDir, owner, now) };
  const activity = sessionActivity(stateDir, owner, now);
  return { folder, owner, state: activity?.live ? "live" : "stale", activity };
}

export function activeTaskFolders(cwd) {
  const work = path.join(findProjectRoot(cwd), ".work");
  let entries = [];
  try {
    entries = fs.readdirSync(work, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(work, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "summary.md")) || fs.existsSync(path.join(dir, "progress.md")))
    .sort();
}

export function precompactText(input = {}) {
  const subagent = typeof input.agent_id === "string" && input.agent_id !== "";
  let folders = [];
  try {
    folders = activeTaskFolders(input.cwd);
    const session = typeof input.session_id === "string" ? input.session_id : null;
    if (session !== null) folders = folders.filter((folder) => [null, session].includes(taskSession(folder)));
  } catch {}
  const where = folders.length > 0 ? folders.join(", ") : "the .work/<task> folder named in progress.md or in your delegation message";
  if (subagent) {
    return [
      "wf compaction: the summary must keep, word for word where it matters:",
      `- the task folder: ${where}`,
      "- the delegation header: role, agent name, package, goal, and every note it names in Read first or the free text (handoff, fix or debug note)",
      "- the steps done and the steps remaining, in order",
      "- key facts: paths, decisions, gotchas",
      "- every file touched so far",
      "- the state of the checks (command and pass or fail)",
      "- assumptions and open issues for the final result",
      "After compaction re-read summary.md and plan.md in the task folder and every note your delegation names (for example notes/debug-<n>.md or a fix file), then continue with the next remaining step."
    ].join("\n");
  }
  return [
    "wf compaction: the summary must keep, word for word where it matters:",
    `- the task folder path: ${where}`,
    "- the approved summary (summary.md), in full, once a task folder holds summary.md (the user approved it: Approve, a typed approval or an advance approval in the request); before that: the last summary shown, marked NOT APPROVED, every open point and each user answer word for word",
    "- the current phase and its last status line",
    "- every worker: agent id, role, agent name, state (running, done, handoff, blocked), its changed files and its handoff note",
    "- the last result of each check, and whether it ran after the last code change",
    "- the keep-warm watcher: its task id, the agents it watches and the keep-warm pings in a row",
    "- the assumptions made so far",
    "- the open issues",
    "After compaction, when a task folder exists, read progress.md, summary.md and plan.md in it before anything else; with none, nothing is approved yet."
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const config = loadConfig();
  const precompact = argv[0] === "precompact";
  try {
    const raw = await readStdin();
    const input = raw.trim() === "" ? {} : JSON.parse(raw);
    if (!isObject(input)) throw new Error("hook input is not a JSON object");
    if (precompact) {
      process.stdout.write(`${precompactText(input)}\n`);
      return;
    }
    const { notice } = recordToolCall(input, { config });
    if (notice) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: notice } })}\n`);
  } catch (error) {
    logHookError(config.stateDir, precompact ? "context precompact" : "context", error);
    if (precompact) process.stdout.write(`${precompactText({})}\n`);
  }
}

if (isEntry(import.meta.url)) {
  try {
    await main();
  } catch {}
  process.exitCode = 0;
}
