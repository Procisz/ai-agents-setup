import fs from "node:fs";
import path from "node:path";
import {
  SESSION_ID,
  activeTaskFolders,
  contextLimits,
  findProjectRoot,
  formatTokens,
  isEntry,
  ledgerFile,
  loadConfig,
  newestLedger,
  readLedger,
  taskOwnership,
  transcriptLastRequest
} from "../hooks/context.mjs";

const USAGE = "usage: wf-agents [--session <id>] [--json] | wf-agents --tasks [--project <dir>] [--json]";
const COLUMNS = ["agent", "type", "tokens", "percent", "band", "updated", "last request"];

function parseArgs(argv) {
  const options = { session: null, json: false, tasks: false, project: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--tasks") options.tasks = true;
    else if (arg === "--session" && i + 1 < argv.length) {
      options.session = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--session=")) options.session = arg.slice(10);
    else if (arg === "--project" && i + 1 < argv.length) {
      options.project = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--project=")) options.project = arg.slice(10);
    else return { error: `unknown argument ${arg}` };
  }
  if (options.session !== null && !SESSION_ID.test(options.session)) return { error: `invalid session id ${options.session}` };
  return options;
}

function minutesAgo(time, now) {
  if (!Number.isFinite(time)) return "-";
  return `${Math.max(0, Math.floor((now - time) / 60000))} min ago`;
}

function lastRequestOf(agent) {
  if (typeof agent.transcript !== "string" || agent.transcript === "") return null;
  try {
    return transcriptLastRequest(agent.transcript).time;
  } catch {
    return null;
  }
}

function pad(rows) {
  const widths = COLUMNS.map((_, column) => Math.max(...rows.map((row) => String(row[column]).length)));
  return rows.map((row) => row.map((cell, column) => String(cell).padEnd(widths[column])).join("  ").trimEnd());
}

const TASK_STATES = {
  mine: "this session",
  live: "another session that is still active: leave it alone",
  stale: "interrupted: ask Resume, Discard or Leave it",
  unowned: "no Session line: ask Resume, Discard or Leave it"
};

export function tasksReport({ options, session, env, now, config, cwd = process.cwd() }) {
  const root = findProjectRoot(options.project ?? cwd);
  const tasks = activeTaskFolders(root).map((folder) => {
    const owner = taskOwnership(folder, { stateDir: config.stateDir, sessionId: session, now });
    return { folder, state: owner.state, session: owner.owner, lastActivityAt: owner.activity ? new Date(owner.activity.updatedAt).toISOString() : null };
  });
  if (options.json) return { code: 0, text: JSON.stringify({ project: root, session, tasks }, null, 2) };
  const lines = [`wf tasks: ${path.join(root, ".work")} (this session ${session ?? "unknown"})`];
  if (tasks.length === 0) lines.push("no task folders");
  for (const task of tasks) {
    const when = task.lastActivityAt === null ? "no activity recorded" : `last activity ${minutesAgo(Date.parse(task.lastActivityAt), now)}`;
    lines.push(`${task.folder}  ${task.state}  session ${task.session ?? "none"}, ${when}: ${TASK_STATES[task.state]}`);
  }
  return { code: 0, text: lines.join("\n") };
}

export function agentsReport({ argv = [], env = process.env, now = Date.now(), config = loadConfig({ env }), cwd = process.cwd() } = {}) {
  const options = parseArgs(argv);
  if (options.error) return { code: 2, text: `wf agents: ${options.error}\n${USAGE}` };
  const session = options.session ?? (typeof env.CLAUDE_CODE_SESSION_ID === "string" && SESSION_ID.test(env.CLAUDE_CODE_SESSION_ID) ? env.CLAUDE_CODE_SESSION_ID : null);
  if (options.tasks) return tasksReport({ options, session, env, now, config, cwd });
  let file;
  if (session !== null) {
    file = ledgerFile(config.stateDir, session);
    if (!fs.existsSync(file)) return { code: 1, text: `wf agents: no ledger for session ${session} in ${config.stateDir}` };
  } else {
    const newest = newestLedger(config.stateDir);
    if (newest === null) return { code: 1, text: `wf agents: no ledger in ${config.stateDir}` };
    file = newest.file;
  }
  const ledger = readLedger(file);
  if (ledger === null) return { code: 1, text: `wf agents: the ledger ${file} cannot be read` };
  const names = Object.keys(ledger.agents).sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : 0));
  const agents = names.map((name) => {
    const agent = ledger.agents[name] ?? {};
    const request = lastRequestOf(agent);
    return {
      agent: name,
      type: agent.type ?? "unknown",
      tokens: Number(agent.tokens) || 0,
      percent: Number(agent.percent) || 0,
      band: agent.band ?? "ok",
      updatedAt: agent.updatedAt ?? null,
      lastRequestAt: request === null ? null : new Date(request).toISOString(),
      transcript: agent.transcript ?? null
    };
  });
  if (options.json) return { code: 0, text: JSON.stringify({ sessionId: ledger.sessionId, file, updatedAt: ledger.updatedAt, agents }, null, 2) };
  const limits = contextLimits(config, env);
  const rows = [COLUMNS, ...agents.map((a) => [a.agent, a.type, formatTokens(a.tokens), `${a.percent}%`, a.band, minutesAgo(Date.parse(a.updatedAt), now), minutesAgo(Date.parse(a.lastRequestAt), now)])];
  const lines = [
    `wf agents: session ${ledger.sessionId ?? "unknown"}, ledger updated ${ledger.updatedAt ?? "unknown"}`,
    ...pad(rows),
    `zones: buffer from ${formatTokens(limits.warn)}, handoff from ${formatTokens(limits.handoff)}, compaction at ${formatTokens(limits.compact)} of ${formatTokens(limits.window)}`
  ];
  return { code: 0, text: lines.join("\n") };
}

if (isEntry(import.meta.url)) {
  const result = agentsReport({ argv: process.argv.slice(2) });
  (result.code === 0 ? process.stdout : process.stderr).write(`${result.text}\n`);
  process.exitCode = result.code;
}
