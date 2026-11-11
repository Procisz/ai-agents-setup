import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  SESSION_ID,
  cacheTtlOf,
  findSubagentTranscript,
  isEntry,
  ledgerFile,
  loadConfig,
  lastWorkRequestTime,
  readLedger,
  transcriptLastRequest
} from "../hooks/context.mjs";

const USAGE = "usage: wf-keepwarm [--agents <optional extra ids,...>] [--task <absolute task folder>] [--session <id>]";
const MIN_SLEEP_MS = 1000;
const MINUTE_MS = 60000;
export const GRACE_POLLS = 3;

export function parseArgs(argv) {
  const options = { agents: [], task: null, session: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    let value = arg.startsWith("--") && eq > 0 ? arg.slice(eq + 1) : null;
    if (!["--agents", "--task", "--session"].includes(name)) return { error: `unknown argument ${arg}` };
    if (value === null) {
      if (i + 1 >= argv.length) return { error: `${name} needs a value` };
      value = argv[i + 1];
      i += 1;
    }
    if (name === "--agents") options.agents.push(...value.split(",").map((id) => id.trim()).filter((id) => id !== ""));
    else if (name === "--task") options.task = value;
    else options.session = value;
  }
  if (options.task !== null && !path.isAbsolute(options.task)) return { error: `--task needs an absolute path, got ${options.task}` };
  if (options.session !== null && !SESSION_ID.test(options.session)) return { error: `invalid session id ${options.session}` };
  const badAgent = options.agents.find((id) => id === "main" || !SESSION_ID.test(id));
  if (badAgent !== undefined) return { error: `invalid agent id ${badAgent}` };
  options.agents = [...new Set(options.agents)];
  return options;
}

export function keepwarmMinutes(config, env = process.env) {
  const raw = typeof env.WF_KEEPWARM_MINUTES === "string" ? env.WF_KEEPWARM_MINUTES.trim() : "";
  const value = Number(raw);
  return raw !== "" && Number.isFinite(value) && value > 0 ? value : config.keepwarmMinutes;
}

function targetTranscript(target, ledger, sessionId) {
  const agents = ledger?.agents ?? {};
  const recorded = agents[target]?.transcript;
  if (typeof recorded === "string" && recorded !== "" && fs.existsSync(recorded)) return recorded;
  if (target === "main") return null;
  return findSubagentTranscript(agents.main?.transcript, sessionId, target);
}

export function limitFor({ type, config, env = process.env }) {
  return cacheTtlOf(config, type) === "1h" ? keepwarmMinutes(config, env) : config.keepwarmShortMinutes;
}

export function idleTargets({ targets, ledger, sessionId, now, missing = [], explicit = [] }) {
  const found = [];
  const agents = ledger?.agents ?? {};
  for (const target of targets) {
    const transcript = targetTranscript(target, ledger, sessionId);
    if (transcript === null) {
      if (target === "main" || explicit.includes(target)) missing.push(target);
      continue;
    }
    let request;
    let work;
    try {
      request = transcriptLastRequest(transcript);
      work = lastWorkRequestTime(transcript);
    } catch {
      continue;
    }
    const type = target === "main" ? "main" : agents[target]?.type;
    found.push({ target, type, idleMs: Math.max(0, now - request.time), quietMs: Math.max(0, now - work) });
  }
  return found;
}

function watchedTargets(idle, config, env) {
  const maxQuietMs = config.keepwarmShortMaxMinutes * MINUTE_MS;
  return idle.flatMap((item) => {
    const short = cacheTtlOf(config, item.type) === "5m";
    if (short && item.quietMs > maxQuietMs) return [];
    return [{ ...item, limitMs: limitFor({ type: item.type, config, env }) * MINUTE_MS }];
  });
}

export async function keepWarm({ argv = [], env = process.env, config = loadConfig({ env }), now = () => Date.now(), sleep = (ms) => delay(ms), out = (line) => process.stdout.write(`${line}\n`), err = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const options = parseArgs(argv);
  if (options.error) {
    err(`wf keep-warm: ${options.error}\n${USAGE}`);
    return 2;
  }
  const sessionId = options.session ?? (typeof env.CLAUDE_CODE_SESSION_ID === "string" && SESSION_ID.test(env.CLAUDE_CODE_SESSION_ID) ? env.CLAUDE_CODE_SESSION_ID : null);
  if (sessionId === null) {
    err(`wf keep-warm: no session: set CLAUDE_CODE_SESSION_ID or pass --session <id>\n${USAGE}`);
    return 2;
  }
  const pollMs = Math.max(MIN_SLEEP_MS, config.keepwarmPollSeconds * 1000);
  const file = ledgerFile(config.stateDir, sessionId);
  let polls = 0;
  for (;;) {
    if (options.task !== null && !fs.existsSync(options.task)) {
      out("wf keep-warm: task folder gone, stopped");
      return 0;
    }
    const missing = [];
    const ledger = readLedger(file);
    const targets = [...new Set(["main", ...Object.keys(ledger?.agents ?? {}).filter((id) => id !== "main"), ...options.agents])];
    const idle = idleTargets({ targets, ledger, sessionId, now: now(), missing, explicit: options.agents });
    const watched = watchedTargets(idle, config, env);
    const due = watched.filter((item) => item.idleMs >= item.limitMs);
    if (due.length > 0) {
      for (const item of due) out(`wf keep-warm: ping ${item.target} (idle ${Math.floor(item.idleMs / MINUTE_MS)} min)`);
      return 0;
    }
    if (missing.length > 0 && polls >= GRACE_POLLS) {
      if (missing.includes("main")) out(`wf keep-warm: cannot find main for session ${sessionId} (ledger ${file})`);
      for (const target of missing.filter((item) => item !== "main")) out(`wf keep-warm: cannot find agent ${target}`);
      return 1;
    }
    polls += 1;
    const soonest = watched.reduce((min, item) => Math.min(min, item.limitMs - item.idleMs), pollMs);
    await sleep(Math.max(MIN_SLEEP_MS, Math.min(pollMs, soonest)));
  }
}

if (isEntry(import.meta.url)) {
  try {
    process.exitCode = await keepWarm({ argv: process.argv.slice(2) });
  } catch (error) {
    process.stderr.write(`wf keep-warm: error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
