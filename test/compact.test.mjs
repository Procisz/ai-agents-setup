import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ACTIVE_STATUSES,
  CALL_FAILED,
  DEFAULT_LIMITS,
  NEXT_MAX_CHARS,
  REPORT_MARK,
  TOOL_FULL_NAME,
  TOOL_NAME,
  TOOL_SCHEMA,
  WAKE_PREFIX,
  answerToolCall,
  compactInstructions,
  countRunning,
  decide,
  formatTokens,
  limitsFrom,
  oneLine,
  register,
  wakeText
} from "../hooks/compact.mjs";

const LIMITS = Object.freeze({ window: 1000000, warn: 500000, handoff: 800000 });
const ROOT = "/wf/plugin";
const CONFIG = JSON.stringify({ window: 1000000, warnTokens: 500000, handoffTokens: 800000, compactTokens: 850000 });

function fakeEngine({ tokens = 0, agents = [], files = { [`${ROOT}/hooks/config.json`]: CONFIG }, env = {}, compact, register: registerTool } = {}) {
  const hooks = {};
  const matchers = {};
  const fallbacks = {};
  const calls = { registered: [], compacts: [], submits: [], logs: [] };
  const world = { tokens, agents };
  const $ = {
    plugin: { name: "wf", root: ROOT },
    fs: {
      read: async (file) => {
        if (Object.hasOwn(files, file)) return files[file];
        throw new Error(`ENOENT: ${file}`);
      }
    },
    env: { get: async (name) => env[name] },
    session: {
      usage: async () => ({ context: { tokens: world.tokens, window: 1000000 } }),
      compact: async (args) => {
        calls.compacts.push(args);
        if (compact) return compact(args, world);
        world.tokens = 0;
        return { messages: [], tokensBefore: 700000, tokensAfter: 40000 };
      }
    },
    agent: { list: async () => world.agents },
    tool: {
      register: async (spec) => {
        calls.registered.push(spec);
        if (registerTool) return registerTool(spec);
        return { tool: `mcp__wf__${spec.name}` };
      }
    },
    prompt: { submit: async (args) => void calls.submits.push(args) },
    ui: { log: (text, options) => void calls.logs.push({ text, options }) }
  };
  register((event, matcher, hook) => {
    hooks[event] = typeof matcher === "function" ? matcher : hook;
    matchers[event] = typeof matcher === "function" ? null : matcher;
    return { catch: (handler) => void (fallbacks[event] = handler) };
  });
  const engine = {
    hooks,
    matchers,
    fallbacks,
    calls,
    world,
    $,
    start: (fields = {}) => hooks["session.start"]($, { cwd: "/project", surface: "terminal", isInteractive: true, ...fields }, async () => "started"),
    endSession: (reason) => hooks["session.end"]($, { reason }, async () => "ended"),
    callTool: (next, agentId) => hooks["tool.call"]($, { tool: TOOL_FULL_NAME, next, ...(agentId ? { agentId } : {}) }),
    endTurn: (fields = {}) => hooks["turn.complete"]($, { reason: "answer", isAborted: false, turnId: "turn", answer: "", durationMs: 1, ...fields }, async () => "completed"),
    externalCompaction: (fields = {}) => hooks["session.compact"]($, { trigger: "auto", messages: [], ...fields }, async () => ({ messages: [] }))
  };
  return engine;
}

describe("compact module: pure parts", () => {
  test("the tool is served as mcp__wf__compact with one required next field", () => {
    assert.equal(TOOL_NAME, "compact");
    assert.equal(TOOL_FULL_NAME, `mcp__wf__${TOOL_NAME}`);
    assert.deepEqual(TOOL_SCHEMA.required, ["next"]);
    assert.deepEqual(Object.keys(TOOL_SCHEMA.properties), ["next"]);
  });

  test("limits come from hooks/config.json, fall back to the defaults and scale with WF_CONTEXT_WINDOW like the context hook", () => {
    assert.deepEqual(limitsFrom(JSON.parse(CONFIG)), LIMITS);
    assert.deepEqual(limitsFrom(null), DEFAULT_LIMITS);
    assert.deepEqual(limitsFrom({ window: "big", warnTokens: -1, handoffTokens: 600000 }), { window: 1000000, warn: 500000, handoff: 600000 });
    assert.deepEqual(limitsFrom(JSON.parse(CONFIG), "100000"), { window: 100000, warn: 50000, handoff: 80000 });
    assert.deepEqual(limitsFrom(JSON.parse(CONFIG), " 0 "), LIMITS);
    assert.deepEqual(limitsFrom(JSON.parse(CONFIG), "lots"), LIMITS);
  });

  test("only pending, running and waiting agents count as running", () => {
    assert.deepEqual(ACTIVE_STATUSES, ["pending", "running", "waiting"]);
    const agents = ["pending", "running", "waiting", "idle", "completed", "failed", "killed"].map((status) => ({ status }));
    assert.equal(countRunning(agents), 3);
    assert.equal(countRunning(undefined), 0);
  });

  test("next is kept on one line and cut to its maximum length", () => {
    assert.equal(oneLine("  start\n the   coder round "), "start the coder round");
    const long = oneLine("x".repeat(NEXT_MAX_CHARS + 50));
    assert.equal(long.length, NEXT_MAX_CHARS);
    assert.ok(long.endsWith("..."));
    assert.equal(formatTokens(812345), "812K");
  });

  test("the tool refuses a worker, an empty next and any call below the warn line", () => {
    assert.match(answerToolCall({ agentId: "a1", tokens: 600000, limits: LIMITS, next: "go" }).deny, /Only the wf orchestrator compacts/);
    assert.match(answerToolCall({ tokens: 600000, limits: LIMITS, next: "  " }).deny, /Give next/);
    assert.match(answerToolCall({ tokens: 499999, limits: LIMITS, next: "go" }).deny, /Not needed: 500K used, under 500K/);
  });

  test("in the buffer the tool queues the request and tells the orchestrator to start no new worker", () => {
    const answer = answerToolCall({ tokens: 600000, limits: LIMITS, next: "start the coder round" });
    assert.deepEqual(answer.request, { next: "start the coder round" });
    assert.match(answer.text, /Start no new worker/);
    assert.match(answer.text, /first turn of yours that ends with no worker running/);
  });

  test("past the handoff line the tool says the compaction is due now, whatever runs", () => {
    const busy = answerToolCall({ tokens: 812000, limits: LIMITS, next: "go", running: 2 });
    assert.match(busy.text, /due now \(812K used, past 800K\)/);
    assert.match(busy.text, /whatever runs/);
    assert.match(busy.text, /2 worker\(s\) still run; their results reach you after the compaction/);
    assert.match(answerToolCall({ tokens: 812000, limits: LIMITS, next: "go" }).text, /You are woken/);
  });

  test("decide: nothing below the warn line or without a request in the buffer", () => {
    assert.deepEqual(decide({ tokens: 100000, limits: LIMITS, running: 0, request: { next: "go" } }), { action: "none", wake: false });
    assert.deepEqual(decide({ tokens: 600000, limits: LIMITS, running: 0, request: null }), { action: "none", wake: false });
  });

  test("decide: a buffer request waits while a worker runs and compacts with a wake-up once none runs", () => {
    assert.deepEqual(decide({ tokens: 600000, limits: LIMITS, running: 1, request: { next: "go" } }), { action: "wait", wake: false });
    assert.deepEqual(decide({ tokens: 600000, limits: LIMITS, running: 0, request: { next: "go" } }), { action: "compact", wake: true });
  });

  test("decide: a buffer request never compacts at the end of an interrupted or failed turn", () => {
    for (const reason of ["aborted", "error", "refusal"]) {
      assert.deepEqual(decide({ tokens: 600000, limits: LIMITS, running: 0, request: { next: "go" }, reason }), { action: "none", wake: false });
    }
  });

  test("decide: past the handoff line it compacts whatever runs, and wakes only a requested, quiet, answered turn", () => {
    assert.deepEqual(decide({ tokens: 800000, limits: LIMITS, running: 3, request: { next: "go" } }), { action: "compact", wake: false });
    assert.deepEqual(decide({ tokens: 900000, limits: LIMITS, running: 0, request: null }), { action: "compact", wake: false });
    assert.deepEqual(decide({ tokens: 900000, limits: LIMITS, running: 0, request: { next: "go" } }), { action: "compact", wake: true });
    assert.deepEqual(decide({ tokens: 900000, limits: LIMITS, running: 0, request: { next: "go" }, reason: "aborted" }), { action: "compact", wake: false });
  });

  test("the compaction instructions keep the next step, and the wake-up text says it is the plugin's and approves nothing", () => {
    assert.equal(compactInstructions(null, 812000, LIMITS), "wf: the orchestrator's conversation compacts at 812K of its 1M token context.");
    assert.match(compactInstructions({ next: "start the tester" }, 600000, LIMITS), /Keep word for word the step to take right after the compaction: start the tester/);
    const text = wakeText({ next: "start the tester" }, { tokensBefore: 640000, tokensAfter: 30000 });
    assert.ok(text.startsWith(`${WAKE_PREFIX} (conversation 640K to 30K tokens). This message comes from the wf plugin, not from the user, and approves nothing.`), text);
    assert.match(text, /read progress.md, summary.md and plan.md in it first; with none, nothing is approved yet/);
    assert.ok(text.endsWith("Then: start the tester"));
    assert.ok(wakeText({ next: "go" }, {}).startsWith(`${WAKE_PREFIX}. This message`));
  });
});

describe("compact module: hooks against a fake engine", () => {
  test("session.start registers the tool without waiting for it and goes on", async () => {
    let release;
    const engine = fakeEngine({ register: () => new Promise((resolve) => (release = resolve)) });
    assert.equal(await engine.start(), "started");
    assert.deepEqual(engine.calls.registered, [{ name: TOOL_NAME, description: engine.calls.registered[0].description, inputSchema: TOOL_SCHEMA, isDeferred: false }]);
    assert.match(engine.calls.registered[0].description, /^wf orchestrator only/);
    release({ tool: TOOL_FULL_NAME });
    assert.deepEqual(engine.matchers["tool.call"], { tool: TOOL_FULL_NAME });
  });

  test("a headless session registers no tool, because the plugin cannot compact there", async () => {
    const engine = fakeEngine();
    assert.equal(await engine.start({ surface: null, isInteractive: false }), "started");
    assert.deepEqual(engine.calls.registered, []);
  });

  test("a /clear or a resume drops a queued request, so it never fires in the next conversation", async () => {
    const engine = fakeEngine({ tokens: 620000, agents: [{ id: "w1", status: "running" }] });
    await engine.callTool("start the tester round for task A");
    await engine.endTurn();
    assert.equal(await engine.endSession("clear"), "ended");
    engine.world.agents = [];
    engine.world.tokens = 530000;
    await engine.endTurn();
    assert.deepEqual(engine.calls.compacts, []);
    assert.deepEqual(engine.calls.submits, []);
  });

  test("a turn end below the warn line drops a queued request", async () => {
    const engine = fakeEngine({ tokens: 620000 });
    await engine.callTool("go");
    engine.world.tokens = 40000;
    await engine.endTurn({ reason: "aborted", isAborted: true });
    engine.world.tokens = 530000;
    await engine.endTurn();
    assert.deepEqual(engine.calls.compacts, []);
  });

  test("the report mark is the status line the final-report skill prints before the report", () => {
    const skill = readFileSync(new URL("../skills/final-report/SKILL.md", import.meta.url), "utf8");
    assert.ok(skill.includes(`\`${REPORT_MARK} done\``), "final-report prints wf: report: done");
  });

  test("the turn that ends with the report drops a queued request, so nothing follows the report", async () => {
    const engine = fakeEngine({ tokens: 620000 });
    await engine.callTool("start the tester");
    await engine.endTurn({ answer: `${REPORT_MARK} stopped early\n\nReport` });
    assert.deepEqual(engine.calls.compacts, []);
    assert.deepEqual(engine.calls.submits, []);
  });

  test("past the handoff line the report turn is still compacted, without a wake-up", async () => {
    const engine = fakeEngine({ tokens: 812000 });
    await engine.callTool("go");
    await engine.endTurn({ answer: `${REPORT_MARK} done\n\nReport` });
    assert.equal(engine.calls.compacts.length, 1);
    assert.deepEqual(engine.calls.submits, []);
  });

  test("a failed registration is logged, not thrown", async () => {
    const engine = fakeEngine({ register: async () => Promise.reject(new Error("no session")) });
    await engine.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(engine.calls.logs.map((entry) => entry.text), ["the mcp__wf__compact tool is not registered: no session"]);
  });

  test("below the warn line a turn end reads no agent list and changes nothing", async () => {
    const engine = fakeEngine({ tokens: 300000 });
    let listed = 0;
    engine.$.agent.list = async () => {
      listed += 1;
      return [];
    };
    assert.equal(await engine.endTurn(), "completed");
    assert.equal(listed, 0);
    assert.deepEqual(engine.calls.compacts, []);
  });

  test("a tool call below the warn line is refused and queues nothing", async () => {
    const engine = fakeEngine({ tokens: 300000 });
    assert.match((await engine.callTool("go")).deny, /Not needed/);
    engine.world.tokens = 600000;
    await engine.endTurn();
    assert.deepEqual(engine.calls.compacts, []);
  });

  test("the tool call and the compaction hook have fallbacks: a failed tool call still answers, a compaction goes on", async () => {
    const engine = fakeEngine({ tokens: 600000 });
    assert.deepEqual(Object.keys(engine.fallbacks).sort(), ["session.compact", "tool.call"]);
    assert.deepEqual(engine.fallbacks["tool.call"](engine.$, { tool: TOOL_FULL_NAME }, async () => ({})), { deny: CALL_FAILED });
    assert.deepEqual(await engine.fallbacks["session.compact"](engine.$, { trigger: "auto" }, async () => ({ messages: ["kept"] })), { messages: ["kept"] });
  });

  test("a worker's tool call is refused", async () => {
    const engine = fakeEngine({ tokens: 600000 });
    assert.match((await engine.callTool("go", "agent-1")).deny, /Only the wf orchestrator/);
  });

  test("in the buffer the request waits for the running worker, then compacts once none runs and wakes the orchestrator", async () => {
    const engine = fakeEngine({ tokens: 600000, agents: [{ id: "w1", status: "running" }] });
    const answer = await engine.callTool("start the tester round");
    assert.match(answer.result, /Compaction queued/);
    await engine.endTurn();
    await engine.endTurn();
    assert.deepEqual(engine.calls.compacts, []);
    assert.deepEqual(engine.calls.logs.map((entry) => entry.text), ["compaction waits until no worker runs (1 running)"]);
    engine.world.agents = [{ id: "w1", status: "completed" }];
    engine.world.tokens = 640000;
    await engine.endTurn();
    assert.equal(engine.calls.compacts.length, 1);
    assert.match(engine.calls.compacts[0].instructions, /compacts at 640K of its 1M token context/);
    assert.match(engine.calls.compacts[0].instructions, /Keep word for word the step to take right after the compaction: start the tester round/);
    assert.equal(engine.calls.submits.length, 1);
    assert.ok(engine.calls.submits[0].text.startsWith(`${WAKE_PREFIX} (conversation 700K to 40K tokens)`));
    assert.ok(engine.calls.submits[0].text.endsWith("Then: start the tester round"));
    assert.equal(engine.calls.submits[0].asUser, undefined);
  });

  test("the request is spent once: the next turn ends do not compact again", async () => {
    const engine = fakeEngine({ tokens: 600000, compact: () => ({ messages: [] }) });
    await engine.callTool("go");
    await engine.endTurn();
    await engine.endTurn();
    engine.world.tokens = 610000;
    await engine.endTurn();
    assert.equal(engine.calls.compacts.length, 1);
  });

  test("past the handoff line it compacts at the turn end whatever runs, without a request and without a wake-up", async () => {
    const engine = fakeEngine({ tokens: 812000, agents: [{ id: "w1", status: "running" }, { id: "w2", status: "waiting" }] });
    await engine.endTurn();
    assert.equal(engine.calls.compacts.length, 1);
    assert.deepEqual(engine.calls.submits, []);
    assert.deepEqual(engine.calls.logs.map((entry) => entry.text), ["compacting the orchestrator's context at 812K with 2 worker(s) running"]);
  });

  test("past the handoff line a requested compaction with no worker running wakes the orchestrator", async () => {
    const engine = fakeEngine({ tokens: 812000 });
    assert.match((await engine.callTool("show the picture again")).result, /due now/);
    await engine.endTurn();
    assert.equal(engine.calls.compacts.length, 1);
    assert.ok(engine.calls.submits[0].text.endsWith("Then: show the picture again"));
  });

  test("a stale reading right after a compaction does not compact twice", async () => {
    const engine = fakeEngine({ tokens: 812000, agents: [{ id: "w1", status: "running" }], compact: () => ({ messages: [] }) });
    await engine.endTurn();
    await engine.endTurn({ reason: "aborted", isAborted: true });
    assert.equal(engine.calls.compacts.length, 1);
    engine.world.tokens = 820000;
    await engine.endTurn();
    assert.equal(engine.calls.compacts.length, 2);
  });

  test("the turn a wake-up started never wakes again, so a context still past the handoff line cannot loop", async () => {
    const engine = fakeEngine({ tokens: 812000, compact: (args, world) => ((world.tokens += 1000), { messages: [] }) });
    await engine.callTool("answer the question");
    await engine.endTurn();
    assert.equal(engine.calls.submits.length, 1);
    await engine.callTool("answer the question");
    await engine.endTurn();
    assert.equal(engine.calls.compacts.length, 2);
    assert.equal(engine.calls.submits.length, 1);
    assert.ok(engine.calls.logs.some((entry) => entry.text === "no second wake-up in a row; the next message wakes the orchestrator"));
    await engine.callTool("answer the question");
    await engine.endTurn();
    assert.equal(engine.calls.submits.length, 2, "a turn the user started may wake again");
  });

  test("a subagent's turn end is ignored", async () => {
    const engine = fakeEngine({ tokens: 900000 });
    await engine.endTurn({ agentId: "w1" });
    assert.deepEqual(engine.calls.compacts, []);
  });

  test("an interrupted turn keeps a buffer request for the next answered turn end", async () => {
    const engine = fakeEngine({ tokens: 600000 });
    await engine.callTool("go");
    await engine.endTurn({ reason: "aborted", isAborted: true });
    assert.deepEqual(engine.calls.compacts, []);
    await engine.endTurn();
    assert.equal(engine.calls.compacts.length, 1);
  });

  test("a compaction that throws is logged and the request stays for the next turn end", async () => {
    let attempts = 0;
    const engine = fakeEngine({
      tokens: 600000,
      compact: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("$.session.compact: a turn is running");
        return { messages: [], tokensBefore: 600000, tokensAfter: 30000 };
      }
    });
    await engine.callTool("go");
    assert.equal(await engine.endTurn(), "completed");
    assert.deepEqual(engine.calls.logs.map((entry) => entry.text).slice(-1), ["compaction failed: $.session.compact: a turn is running"]);
    assert.deepEqual(engine.calls.submits, []);
    await engine.endTurn();
    assert.equal(attempts, 2);
    assert.equal(engine.calls.submits.length, 1);
  });

  test("a vetoed compaction is logged and keeps the request", async () => {
    const engine = fakeEngine({ tokens: 600000, compact: () => ({ skip: "compaction is switched off" }) });
    await engine.callTool("go");
    await engine.endTurn();
    await engine.endTurn();
    assert.equal(engine.calls.compacts.length, 2);
    assert.ok(engine.calls.logs.some((entry) => entry.text === "compaction skipped: compaction is switched off"));
    assert.deepEqual(engine.calls.submits, []);
  });

  test("an engine or manual compaction of the main conversation drops the request; a precompute or a subagent's does not", async () => {
    const engine = fakeEngine({ tokens: 600000 });
    await engine.callTool("go");
    await engine.externalCompaction({ trigger: "precompute" });
    await engine.externalCompaction({ agentId: "w1" });
    engine.world.tokens = 610000;
    await engine.endTurn();
    assert.equal(engine.calls.compacts.length, 1);
    await engine.callTool("again");
    await engine.externalCompaction({ trigger: "auto" });
    engine.world.tokens = 620000;
    await engine.endTurn();
    assert.equal(engine.calls.compacts.length, 1);
  });

  test("the limits are read from the plugin's hooks/config.json once and scale with WF_CONTEXT_WINDOW", async () => {
    const engine = fakeEngine({ tokens: 45000, env: { WF_CONTEXT_WINDOW: "50000" } });
    let reads = 0;
    const read = engine.$.fs.read;
    engine.$.fs.read = async (file) => {
      reads += 1;
      return read(file);
    };
    assert.match((await engine.callTool("go")).result, /due now \(45K used, past 40K\)/);
    await engine.endTurn();
    assert.equal(engine.calls.compacts.length, 1);
    assert.equal(reads, 1);
  });

  test("a missing hooks/config.json falls back to the default limits and says so in the debug log", async () => {
    const engine = fakeEngine({ tokens: 600000, files: {} });
    assert.match((await engine.callTool("go")).result, /Compaction queued\. Start no new worker/);
    assert.deepEqual(engine.calls.logs[0].options, { to: "debug" });
    assert.match(engine.calls.logs[0].text, /hooks\/config.json not read, the default context limits apply/);
  });
});
