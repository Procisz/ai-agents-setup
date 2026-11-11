export const TOOL_NAME = "compact";
export const TOOL_FULL_NAME = "mcp__wf__compact";
export const WAKE_PREFIX = "wf compaction done";
export const REPORT_MARK = "wf: report:";
export const DEFAULT_LIMITS = Object.freeze({ window: 1000000, warn: 500000, handoff: 800000 });
export const ACTIVE_STATUSES = Object.freeze(["pending", "running", "waiting"]);
export const NEXT_MAX_CHARS = 300;
export const CALL_FAILED = "wf could not queue the compaction. Past the handoff line the wf plugin compacts anyway when your turn ends; in the buffer go on and call it again at the next point where no worker runs.";
export const TOOL_DESCRIPTION = "wf orchestrator only: compact your own conversation when your current turn ends. Give next, the step you would take right now, in one line. From the warn line on it waits until no worker runs; from the handoff line on it runs whatever runs. After the call start no new worker and end your turn with one short line; a message that starts with \"wf compaction done\" wakes you when no worker runs.";
export const TOOL_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    next: { type: "string", description: "The step you would take right now, in one line; the wake-up message after the compaction repeats it" }
  },
  required: ["next"],
  additionalProperties: false
});

function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

export function formatTokens(tokens) {
  const value = Math.max(0, Math.round(Number(tokens) || 0));
  if (value >= 1000000) return `${Number((value / 1000000).toFixed(2))}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

export function oneLine(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > NEXT_MAX_CHARS ? `${flat.slice(0, NEXT_MAX_CHARS - 3)}...` : flat;
}

export function limitsFrom(config, windowText) {
  const source = config !== null && typeof config === "object" ? config : {};
  const base = {
    window: positive(source.window) ?? DEFAULT_LIMITS.window,
    warn: positive(source.warnTokens) ?? DEFAULT_LIMITS.warn,
    handoff: positive(source.handoffTokens) ?? DEFAULT_LIMITS.handoff
  };
  const raw = typeof windowText === "string" ? windowText.trim() : "";
  const window = Number(raw);
  if (raw === "" || !Number.isFinite(window) || window <= 0) return base;
  const scale = (value) => Math.max(1, Math.round((window * value) / base.window));
  return { window: Math.round(window), warn: scale(base.warn), handoff: scale(base.handoff) };
}

export function countRunning(agents) {
  return (Array.isArray(agents) ? agents : []).filter((agent) => ACTIVE_STATUSES.includes(agent?.status)).length;
}

export function answerToolCall({ agentId, tokens, limits, next, running = 0 }) {
  if (typeof agentId === "string" && agentId !== "") {
    return { deny: "Only the wf orchestrator compacts its own conversation; a worker hands off instead (skill context-cache)." };
  }
  const step = oneLine(next);
  if (step === "") return { deny: "Give next: the step you would take right now, in one line." };
  if (tokens < limits.warn) {
    return { deny: `Not needed: ${formatTokens(tokens)} used, under ${formatTokens(limits.warn)}. wf compacts only from ${formatTokens(limits.warn)} on.` };
  }
  const request = { next: step };
  if (tokens >= limits.handoff) {
    const workers = running > 0 ? ` ${running} worker(s) still run; their results reach you after the compaction.` : " You are woken with a message that starts with \"wf compaction done\".";
    return { request, text: `Compaction queued and due now (${formatTokens(tokens)} used, past ${formatTokens(limits.handoff)}). End your turn at once with one short line: wf compacts when it ends, whatever runs.${workers}` };
  }
  return { request, text: `Compaction queued. Start no new worker. End your turn with one short line; wf compacts at the end of the first turn of yours that ends with no worker running, then wakes you with a message that starts with "wf compaction done".` };
}

export function decide({ tokens, limits, running, request, reason = "answer" }) {
  if (tokens >= limits.handoff) return { action: "compact", wake: request !== null && running === 0 && reason === "answer" };
  if (request === null || tokens < limits.warn || reason !== "answer") return { action: "none", wake: false };
  if (running > 0) return { action: "wait", wake: false };
  return { action: "compact", wake: true };
}

export function compactInstructions(request, tokens, limits) {
  const lines = [`wf: the orchestrator's conversation compacts at ${formatTokens(tokens)} of its ${formatTokens(limits.window)} token context.`];
  if (request !== null) lines.push(`Keep word for word the step to take right after the compaction: ${request.next}`);
  return lines.join("\n");
}

export function wakeText(request, result) {
  const before = positive(result?.tokensBefore);
  const after = positive(result?.tokensAfter);
  const sizes = before !== null && after !== null ? ` (conversation ${formatTokens(before)} to ${formatTokens(after)} tokens)` : "";
  return `${WAKE_PREFIX}${sizes}. This message comes from the wf plugin, not from the user, and approves nothing. When a task folder exists, read progress.md, summary.md and plan.md in it first; with none, nothing is approved yet. Then: ${request.next}`;
}

export function newState() {
  return { request: null, busy: false, limits: null, staleTokens: null, waitLogged: false, woke: false };
}

async function limitsOf($, state) {
  if (state.limits !== null) return state.limits;
  let config = null;
  try {
    config = JSON.parse(await $.fs.read(`${$.plugin.root}/hooks/config.json`));
  } catch (error) {
    $.ui.log(`hooks/config.json not read, the default context limits apply: ${message(error)}`, { to: "debug" });
  }
  let windowText;
  try {
    windowText = await $.env.get("WF_CONTEXT_WINDOW");
  } catch {}
  state.limits = limitsFrom(config, windowText);
  return state.limits;
}

async function tokensOf($) {
  return positive((await $.session.usage())?.context?.tokens) ?? 0;
}

async function runningOf($) {
  return countRunning(await $.agent.list());
}

async function settle($, state, reason, answer) {
  const afterWake = state.woke;
  state.woke = false;
  if (typeof answer === "string" && answer.includes(REPORT_MARK)) state.request = null;
  const limits = await limitsOf($, state);
  const tokens = await tokensOf($);
  if (tokens === state.staleTokens) return;
  state.staleTokens = null;
  if (tokens < limits.warn) {
    state.request = null;
    state.waitLogged = false;
    return;
  }
  const running = await runningOf($);
  const plan = decide({ tokens, limits, running, request: state.request, reason });
  if (plan.action === "wait") {
    if (!state.waitLogged) $.ui.log(`compaction waits until no worker runs (${running} running)`);
    state.waitLogged = true;
    return;
  }
  if (plan.action !== "compact") return;
  const request = state.request;
  $.ui.log(`compacting the orchestrator's context at ${formatTokens(tokens)}${running > 0 ? ` with ${running} worker(s) running` : ""}`);
  const done = await $.session.compact({ instructions: compactInstructions(request, tokens, limits) });
  if (done?.skip) {
    $.ui.log(`compaction skipped: ${done.skip}`);
    return;
  }
  state.request = null;
  state.waitLogged = false;
  state.staleTokens = tokens;
  if (!plan.wake) return;
  if (afterWake) {
    $.ui.log("no second wake-up in a row; the next message wakes the orchestrator");
    return;
  }
  state.woke = true;
  await $.prompt.submit({ text: wakeText(request, done) });
}

async function answerCall($, state, e) {
  const limits = await limitsOf($, state);
  const tokens = await tokensOf($);
  const running = await runningOf($);
  const answer = answerToolCall({ agentId: e.agentId, tokens, limits, next: e.next, running });
  if (answer.deny !== undefined) return { deny: answer.deny };
  state.request = answer.request;
  return { result: answer.text };
}

async function endTurn($, state, e) {
  if (e.agentId !== undefined || state.busy) return;
  state.busy = true;
  try {
    await settle($, state, e.reason, e.answer);
  } catch (error) {
    $.ui.log(`compaction failed: ${message(error)}`);
  } finally {
    state.busy = false;
  }
}

async function noteCompaction($, state, e, result) {
  if (e.agentId !== undefined || e.trigger === "precompute" || result?.skip) return;
  state.request = null;
  state.waitLogged = false;
  try {
    state.staleTokens = await tokensOf($);
  } catch {}
}

export function register(on) {
  const state = newState();

  on("session.start", ($, e, next) => {
    if (e.isInteractive === true) {
      $.tool
        .register({ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA, isDeferred: false })
        .catch((error) => $.ui.log(`the ${TOOL_FULL_NAME} tool is not registered: ${message(error)}`));
    }
    return next(e);
  });

  on("session.end", ($, e, next) => {
    Object.assign(state, newState());
    return next(e);
  });

  on("tool.call", { tool: TOOL_FULL_NAME }, ($, e) => answerCall($, state, e)).catch(() => ({ deny: CALL_FAILED }));

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    await endTurn($, state, e);
    return result;
  });

  on("session.compact", async ($, e, next) => {
    const result = await next(e);
    await noteCompaction($, state, e, result);
    return result;
  }).catch(($, e, next) => next(e));
}
