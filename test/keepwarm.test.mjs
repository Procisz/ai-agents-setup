import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../hooks/context.mjs";
import { idleTargets, keepWarm, keepwarmMinutes, limitFor, parseArgs } from "../scripts/wf-keepwarm.mjs";
import { SESSION, assistantLine, sessionLayout, userLine, writeTranscript } from "./data/hooks/transcript.mjs";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(REPO, "scripts", "wf-keepwarm.mjs");
const T0 = Date.parse("2026-10-28T10:00:00.000Z");
const MINUTE = 60000;

let tmp;
let counter = 0;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-keepwarm-"));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function iso(ms) {
  return new Date(ms).toISOString();
}

function transcriptIdleSince(file, requestAt, agentId) {
  writeTranscript(file, [
    userLine({ agentId, timestamp: iso(requestAt - 5000) }),
    assistantLine({ agentId, timestamp: iso(requestAt - 4000), kind: "tool_use", read: 40000 }),
    userLine({ agentId, timestamp: iso(requestAt), toolResult: true }),
    assistantLine({ agentId, timestamp: iso(requestAt + 3000), read: 42000 })
  ]);
  return file;
}

function sandbox({ mainAt = T0, agents = {}, ledgerAgents = Object.keys(agents), types = {}, overrides = {} } = {}) {
  counter += 1;
  const root = path.join(tmp, `case-${counter}`);
  const layout = sessionLayout(root);
  const config = { ...DEFAULTS, stateDir: path.join(root, "state"), cacheTtl: { coder: "1h", tester: "5m" }, ...overrides };
  transcriptIdleSince(layout.mainTranscript, mainAt);
  const ledger = { sessionId: SESSION, updatedAt: iso(mainAt), agents: { main: { type: "wf:orchestrator", transcript: layout.mainTranscript } } };
  for (const [id, requestAt] of Object.entries(agents)) {
    const file = transcriptIdleSince(layout.agentTranscript(id), requestAt, id);
    if (ledgerAgents.includes(id)) ledger.agents[id] = { type: types[id] ?? "wf:coder-t2", transcript: file };
  }
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(ledgerPath(config), JSON.stringify(ledger));
  return { root, layout, config };
}

function ledgerPath(config) {
  return path.join(config.stateDir, `${SESSION}.json`);
}

function registerAgent(config, id, type, transcript) {
  const ledger = JSON.parse(fs.readFileSync(ledgerPath(config), "utf8"));
  ledger.agents[id] = { type, transcript };
  fs.writeFileSync(ledgerPath(config), JSON.stringify(ledger));
}

function ledgerObject(config) {
  return JSON.parse(fs.readFileSync(ledgerPath(config), "utf8"));
}

const STOP = "stop after the first poll";

async function firstPoll({ config, argv = [], start }) {
  const clock = fakeClock(start);
  const lines = [];
  const sleeps = [];
  await assert.rejects(
    keepWarm({
      argv,
      env: { CLAUDE_CODE_SESSION_ID: SESSION },
      config,
      now: clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        throw new Error(STOP);
      },
      out: (line) => lines.push(line),
      err: () => {}
    }),
    { message: STOP }
  );
  return { lines, sleeps };
}

function fakeClock(start) {
  let time = start;
  const sleeps = [];
  return {
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    sleeps,
    advance: (ms) => {
      time += ms;
    }
  };
}

async function watch({ config, argv = [], env = {}, clock }) {
  const lines = [];
  const errors = [];
  const code = await keepWarm({ argv, env: { CLAUDE_CODE_SESSION_ID: SESSION, ...env }, config, now: clock.now, sleep: clock.sleep, out: (line) => lines.push(line), err: (line) => errors.push(line) });
  return { code, lines, errors };
}

describe("parseArgs", () => {
  test("reads --agents, --task and --session in both forms", () => {
    assert.deepEqual(parseArgs(["--agents", "a1,b2", "--task", "/p/.work/t", "--session=s-1"]), { agents: ["a1", "b2"], task: "/p/.work/t", session: "s-1" });
    assert.deepEqual(parseArgs(["--agents=a1", "--agents", "a1,c3,"]), { agents: ["a1", "c3"], task: null, session: null });
    assert.deepEqual(parseArgs([]), { agents: [], task: null, session: null });
  });

  test("rejects unknown arguments, missing values, relative tasks and bad ids", () => {
    for (const argv of [["--bogus"], ["--task"], ["--task", "rel/.work/t"], ["--agents", "../x"], ["--agents", "main"], ["--session", "a/b"]]) {
      assert.ok(parseArgs(argv).error, JSON.stringify(argv));
    }
  });

  test("WF_KEEPWARM_MINUTES overrides the 58 minutes", () => {
    assert.equal(keepwarmMinutes(DEFAULTS, {}), 58);
    assert.equal(keepwarmMinutes(DEFAULTS, { WF_KEEPWARM_MINUTES: "1" }), 1);
    assert.equal(keepwarmMinutes(DEFAULTS, { WF_KEEPWARM_MINUTES: "0.5" }), 0.5);
    assert.equal(keepwarmMinutes(DEFAULTS, { WF_KEEPWARM_MINUTES: "zero" }), 58);
  });
});

describe("keep-warm watcher", () => {
  test("pings main at exactly 58 minutes since its last request, polling every 20 seconds", async () => {
    const { config } = sandbox({ mainAt: T0 });
    const clock = fakeClock(T0 + 50 * MINUTE);
    const result = await watch({ config, clock });
    assert.equal(result.code, 0);
    assert.deepEqual(result.lines, ["wf keep-warm: ping main (idle 58 min)"]);
    assert.equal(clock.now(), T0 + 58 * MINUTE);
    assert.equal(clock.sleeps.length, 24);
    assert.ok(clock.sleeps.every((ms) => ms === 20000));
  });

  test("sleeps only until the soonest target is due", async () => {
    const { config } = sandbox({ mainAt: T0 });
    const clock = fakeClock(T0 + 58 * MINUTE - 7000);
    const result = await watch({ config, clock });
    assert.deepEqual(clock.sleeps, [7000]);
    assert.deepEqual(result.lines, ["wf keep-warm: ping main (idle 58 min)"]);
  });

  test("pings a listed finished worker that reaches 58 minutes first", async () => {
    const { config } = sandbox({ mainAt: T0 + 30 * MINUTE, agents: { a1: T0 } });
    const result = await watch({ config, argv: ["--agents", "a1"], clock: fakeClock(T0 + 57 * MINUTE) });
    assert.deepEqual(result.lines, ["wf keep-warm: ping a1 (idle 58 min)"]);
  });

  test("ignores workers that are neither in the ledger nor listed", async () => {
    const { config } = sandbox({ mainAt: T0, agents: { a1: T0 + 20 * MINUTE, run1: T0 - 120 * MINUTE }, ledgerAgents: ["a1"] });
    const result = await watch({ config, argv: ["--agents", "a1"], clock: fakeClock(T0 + 10 * MINUTE) });
    assert.deepEqual(result.lines, ["wf keep-warm: ping main (idle 58 min)"]);
  });

  test("prints one line per target that is due at the same poll", async () => {
    const { config } = sandbox({ mainAt: T0, agents: { a1: T0 - 3 * MINUTE } });
    const result = await watch({ config, argv: ["--agents", "a1"], clock: fakeClock(T0 + 70 * MINUTE) });
    assert.deepEqual(result.lines, ["wf keep-warm: ping main (idle 70 min)", "wf keep-warm: ping a1 (idle 73 min)"]);
  });

  test("finds a listed worker that the ledger does not hold in the session subagents folder", async () => {
    const { config } = sandbox({ mainAt: T0 + 30 * MINUTE, agents: { b2: T0 }, ledgerAgents: [] });
    const result = await watch({ config, argv: ["--agents", "b2"], clock: fakeClock(T0 + 58 * MINUTE) });
    assert.deepEqual(result.lines, ["wf keep-warm: ping b2 (idle 58 min)"]);
  });

  test("counts idleness from the last user line, not from the assistant reply after it", () => {
    const { layout, config } = sandbox({ mainAt: T0 });
    const ledger = JSON.parse(fs.readFileSync(path.join(config.stateDir, `${SESSION}.json`), "utf8"));
    const [main] = idleTargets({ targets: ["main"], ledger, sessionId: SESSION, now: T0 + 10 * MINUTE });
    assert.equal(main.idleMs, 10 * MINUTE);
    assert.ok(fs.existsSync(layout.mainTranscript));
  });

  test("WF_KEEPWARM_MINUTES=1 pings after one idle minute", async () => {
    const { config } = sandbox({ mainAt: T0 });
    const result = await watch({ config, env: { WF_KEEPWARM_MINUTES: "1" }, clock: fakeClock(T0 + 30000) });
    assert.deepEqual(result.lines, ["wf keep-warm: ping main (idle 1 min)"]);
  });

  test("stops quietly when the task folder is gone", async () => {
    const { root, config } = sandbox({ mainAt: T0 });
    const task = path.join(root, "project", ".work", "20261028-1000-x");
    fs.mkdirSync(task, { recursive: true });
    const clock = fakeClock(T0 + MINUTE);
    const sleep = async (ms) => {
      await clock.sleep(ms);
      fs.rmSync(task, { recursive: true, force: true });
    };
    const lines = [];
    const code = await keepWarm({ argv: ["--task", task], env: { CLAUDE_CODE_SESSION_ID: SESSION }, config, now: clock.now, sleep, out: (line) => lines.push(line), err: () => {} });
    assert.equal(code, 0);
    assert.deepEqual(lines, ["wf keep-warm: task folder gone, stopped"]);
    assert.equal(clock.sleeps.length, 1);
  });

  test("stops at once when the task folder is missing at the start", async () => {
    const { root, config } = sandbox({ mainAt: T0 });
    const result = await watch({ config, argv: ["--task", path.join(root, "nope")], clock: fakeClock(T0 + 90 * MINUTE) });
    assert.deepEqual(result.lines, ["wf keep-warm: task folder gone, stopped"]);
  });

  test("keeps polling while the ledger does not exist yet, within a grace of three polls", async () => {
    const { root, config } = sandbox({ mainAt: T0 });
    fs.rmSync(path.join(config.stateDir, `${SESSION}.json`));
    const task = path.join(root, "task");
    fs.mkdirSync(task);
    const clock = fakeClock(T0 + 90 * MINUTE);
    let polls = 0;
    const sleep = async (ms) => {
      polls += 1;
      await clock.sleep(ms);
      if (polls === 3) fs.rmSync(task, { recursive: true, force: true });
    };
    const lines = [];
    const code = await keepWarm({ argv: ["--task", task], env: { CLAUDE_CODE_SESSION_ID: SESSION }, config, now: clock.now, sleep, out: (line) => lines.push(line), err: () => {} });
    assert.equal(code, 0);
    assert.equal(polls, 3);
    assert.deepEqual(lines, ["wf keep-warm: task folder gone, stopped"]);
  });

  test("exits 1 naming the session and ledger when main stays unknown after the grace", async () => {
    const { config } = sandbox({ mainAt: T0 });
    fs.rmSync(path.join(config.stateDir, `${SESSION}.json`));
    const clock = fakeClock(T0 + 10 * MINUTE);
    const result = await watch({ config, clock });
    assert.equal(result.code, 1);
    assert.deepEqual(result.lines, [`wf keep-warm: cannot find main for session ${SESSION} (ledger ${path.join(config.stateDir, `${SESSION}.json`)})`]);
    assert.equal(clock.sleeps.length, 3, "three polls of grace");
  });

  test("exits 1 naming a wrong agent id after the grace instead of polling forever", async () => {
    const { config } = sandbox({ mainAt: T0 });
    const clock = fakeClock(T0 + 10 * MINUTE);
    const result = await watch({ config, argv: ["--agents", "nope1"], clock });
    assert.equal(result.code, 1);
    assert.deepEqual(result.lines, ["wf keep-warm: cannot find agent nope1"]);
  });

  test("a worker that just answered a SendMessage ping is not pinged again at once", async () => {
    const { layout, config } = sandbox({ mainAt: T0 - 10 * MINUTE });
    const id = "a61ed9b907c9a9b35";
    const file = layout.agentTranscript(id);
    writeTranscript(file, [
      userLine({ agentId: id, timestamp: iso(T0 - 59 * MINUTE) }),
      assistantLine({ agentId: id, timestamp: iso(T0 - 59 * MINUTE + 3000), read: 40000 }),
      { ...userLine({ agentId: id, timestamp: iso(T0 - 4000), isMeta: true, text: "wf keep-warm ping: reply ok only" }), origin: { kind: "coordinator" } },
      assistantLine({ agentId: id, timestamp: iso(T0 - 2000), read: 40100 })
    ]);
    const ledgerPath = path.join(config.stateDir, `${SESSION}.json`);
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    ledger.agents[id] = { type: "wf:coder-t2", transcript: file };
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
    const [worker] = idleTargets({ targets: [id], ledger, sessionId: SESSION, now: T0 });
    assert.equal(worker.idleMs, 4000, "idle since the ping, not since the request 59 minutes ago");
    const clock = fakeClock(T0);
    const result = await watch({ config, argv: ["--agents", id], clock });
    assert.deepEqual(result.lines, ["wf keep-warm: ping main (idle 58 min)"], "main comes due first, the worker 58 minutes after its ping");
  });

  test("uses --session over CLAUDE_CODE_SESSION_ID and refuses to run without either", async () => {
    const { config } = sandbox({ mainAt: T0 });
    const withFlag = await watch({ config, argv: ["--session", SESSION], env: { CLAUDE_CODE_SESSION_ID: "other-session" }, clock: fakeClock(T0 + 60 * MINUTE) });
    assert.deepEqual(withFlag.lines, ["wf keep-warm: ping main (idle 60 min)"]);
    const errors = [];
    const code = await keepWarm({ argv: [], env: {}, config, now: () => T0, sleep: async () => {}, out: () => {}, err: (line) => errors.push(line) });
    assert.equal(code, 2);
    assert.match(errors[0], /no session/);
  });

  test("bad arguments exit 2 with the usage", async () => {
    const { config } = sandbox();
    const result = await watch({ config, argv: ["--task", "relative"], clock: fakeClock(T0) });
    assert.equal(result.code, 2);
    assert.match(result.errors[0], /usage: wf-keepwarm/);
  });
});

function pingLine(agentId, at) {
  return { ...userLine({ agentId, timestamp: iso(at), isMeta: true, text: "wf keep-warm ping: reply ok only" }), origin: { kind: "coordinator" } };
}

describe("keep-warm per agent cache", () => {
  test("limitFor gives main, 1 hour coder and unknown types 58 minutes and a 5 minute role 4 minutes", () => {
    const config = { ...DEFAULTS, cacheTtl: { coder: "1h", tester: "5m" } };
    assert.equal(limitFor({ type: "main", config, env: {} }), 58);
    assert.equal(limitFor({ type: "wf:coder-t2", config, env: {} }), 58);
    assert.equal(limitFor({ type: "wf:tester-t2", config, env: {} }), 4);
    assert.equal(limitFor({ type: "wf:unknown-t1", config, env: {} }), 58);
  });

  test("WF_KEEPWARM_MINUTES changes the 1 hour limit only, not the 5 minute one", () => {
    const config = { ...DEFAULTS, cacheTtl: { coder: "1h", tester: "5m" } };
    assert.equal(limitFor({ type: "wf:coder-t2", config, env: { WF_KEEPWARM_MINUTES: "10" } }), 10);
    assert.equal(limitFor({ type: "wf:tester-t2", config, env: { WF_KEEPWARM_MINUTES: "10" } }), 4);
  });

  test("pings a 5 minute worker at 4 minutes idle without sleeping first", async () => {
    const { config } = sandbox({ mainAt: T0 + 30 * MINUTE, agents: { t1: T0 }, types: { t1: "wf:tester-t2" } });
    const clock = fakeClock(T0 + 4 * MINUTE);
    const result = await watch({ config, argv: ["--agents", "t1"], clock });
    assert.deepEqual(result.lines, ["wf keep-warm: ping t1 (idle 4 min)"]);
    assert.deepEqual(clock.sleeps, []);
  });

  test("does not ping a 5 minute worker at 3 minutes idle and sleeps until it reaches 4 minutes", async () => {
    const { config } = sandbox({ mainAt: T0 + 30 * MINUTE, agents: { t1: T0 }, types: { t1: "wf:tester-t2" }, overrides: { keepwarmPollSeconds: 600 } });
    const clock = fakeClock(T0 + 3 * MINUTE);
    const result = await watch({ config, argv: ["--agents", "t1"], clock });
    assert.deepEqual(clock.sleeps, [MINUTE]);
    assert.deepEqual(result.lines, ["wf keep-warm: ping t1 (idle 4 min)"]);
  });

  test("does not ping a 1 hour worker at 4 minutes idle and pings it at 58", async () => {
    const { config } = sandbox({ mainAt: T0 + 30 * MINUTE, agents: { c1: T0 }, types: { c1: "wf:coder-t2" } });
    const early = await firstPoll({ config, argv: ["--agents", "c1"], start: T0 + 4 * MINUTE });
    assert.deepEqual(early.lines, []);
    const result = await watch({ config, argv: ["--agents", "c1"], clock: fakeClock(T0 + 58 * MINUTE) });
    assert.deepEqual(result.lines, ["wf keep-warm: ping c1 (idle 58 min)"]);
  });

  test("pings a 5 minute worker whose last work is exactly 30 minutes old", async () => {
    const { config } = sandbox({ mainAt: T0 + 30 * MINUTE, agents: { t1: T0 }, types: { t1: "wf:tester-t2" } });
    const result = await watch({ config, argv: ["--agents", "t1"], clock: fakeClock(T0 + 30 * MINUTE) });
    assert.deepEqual(result.lines, ["wf keep-warm: ping t1 (idle 30 min)"]);
  });

  test("stops pinging a 5 minute worker whose last real work is 31 minutes old, without holding main's ping", async () => {
    const { layout, config } = sandbox({ mainAt: T0 + 20 * MINUTE });
    const file = layout.agentTranscript("t1");
    writeTranscript(file, [
      userLine({ agentId: "t1", timestamp: iso(T0 + 9 * MINUTE) }),
      assistantLine({ agentId: "t1", timestamp: iso(T0 + 9 * MINUTE + 3000), read: 40000 }),
      pingLine("t1", T0 + 36 * MINUTE),
      assistantLine({ agentId: "t1", timestamp: iso(T0 + 36 * MINUTE + 2000), read: 40100 })
    ]);
    registerAgent(config, "t1", "wf:tester-t2", file);
    const result = await watch({ config, argv: ["--agents", "t1"], clock: fakeClock(T0 + 40 * MINUTE) });
    assert.deepEqual(result.lines, ["wf keep-warm: ping main (idle 58 min)"]);
  });

  test("a keep-warm ping does not count as work: the quiet time keeps growing while the idle time restarts", () => {
    const { layout, config } = sandbox();
    const file = layout.agentTranscript("t1");
    writeTranscript(file, [
      userLine({ agentId: "t1", timestamp: iso(T0) }),
      assistantLine({ agentId: "t1", timestamp: iso(T0 + 3000), read: 40000 }),
      pingLine("t1", T0 + 4 * MINUTE),
      assistantLine({ agentId: "t1", timestamp: iso(T0 + 4 * MINUTE + 2000), read: 40100 })
    ]);
    registerAgent(config, "t1", "wf:tester-t2", file);
    const [early] = idleTargets({ targets: ["t1"], ledger: ledgerObject(config), sessionId: SESSION, now: T0 + 10 * MINUTE });
    assert.equal(early.idleMs, 6 * MINUTE);
    assert.equal(early.quietMs, 10 * MINUTE);
    const [late] = idleTargets({ targets: ["t1"], ledger: ledgerObject(config), sessionId: SESSION, now: T0 + 20 * MINUTE });
    assert.equal(late.quietMs, 20 * MINUTE);
  });

  test("an agent type the ledger does not map keeps the 58 minute limit", async () => {
    const { config } = sandbox({ mainAt: T0 + 30 * MINUTE, agents: { u1: T0 }, types: { u1: "wf:unknown-t1" } });
    const result = await watch({ config, argv: ["--agents", "u1"], clock: fakeClock(T0 + 57 * MINUTE) });
    assert.deepEqual(result.lines, ["wf keep-warm: ping u1 (idle 58 min)"]);
  });
});

describe("keep-warm discovers every subagent of the session", () => {
  const gitCache = { coder: "1h", tester: "5m", git: "5m" };

  test("pings a ledger 5 minute agent at 4 idle minutes without --agents", async () => {
    const { config } = sandbox({ mainAt: T0 + 30 * MINUTE, agents: { t1: T0 }, types: { t1: "wf:tester-t2" } });
    const clock = fakeClock(T0 + 4 * MINUTE);
    const result = await watch({ config, clock });
    assert.deepEqual(result.lines, ["wf keep-warm: ping t1 (idle 4 min)"]);
    assert.deepEqual(clock.sleeps, []);
  });

  test("sleeps until a ledger 5 minute agent reaches 4 idle minutes when it is at 3", async () => {
    const { config } = sandbox({ mainAt: T0 + 30 * MINUTE, agents: { t1: T0 }, types: { t1: "wf:tester-t2" }, overrides: { keepwarmPollSeconds: 600 } });
    const clock = fakeClock(T0 + 3 * MINUTE);
    const result = await watch({ config, clock });
    assert.deepEqual(clock.sleeps, [MINUTE]);
    assert.deepEqual(result.lines, ["wf keep-warm: ping t1 (idle 4 min)"]);
  });

  test("pings a finished wf:git agent at 4 idle minutes without --agents", async () => {
    const { config } = sandbox({ mainAt: T0 + 30 * MINUTE, agents: { g1: T0 }, types: { g1: "wf:git" }, overrides: { cacheTtl: gitCache } });
    const result = await watch({ config, clock: fakeClock(T0 + 4 * MINUTE) });
    assert.deepEqual(result.lines, ["wf keep-warm: ping g1 (idle 4 min)"]);
  });

  test("does not ping a finished wf:git agent whose last real work is 31 minutes old, even when a ping left it 4 minutes idle", async () => {
    const { layout, config } = sandbox({ mainAt: T0 + 31 * MINUTE, overrides: { cacheTtl: gitCache } });
    const file = layout.agentTranscript("g1");
    writeTranscript(file, [
      userLine({ agentId: "g1", timestamp: iso(T0) }),
      assistantLine({ agentId: "g1", timestamp: iso(T0 + 3000), read: 40000 }),
      pingLine("g1", T0 + 27 * MINUTE),
      assistantLine({ agentId: "g1", timestamp: iso(T0 + 27 * MINUTE + 2000), read: 40100 })
    ]);
    registerAgent(config, "g1", "wf:git", file);
    const { lines } = await firstPoll({ config, start: T0 + 31 * MINUTE });
    assert.deepEqual(lines, []);
  });

  test("pings a ledger coder at 58 idle minutes and not at 4, without --agents", async () => {
    const { config } = sandbox({ mainAt: T0 + 30 * MINUTE, agents: { c1: T0 }, types: { c1: "wf:coder-t2" } });
    const early = await firstPoll({ config, start: T0 + 4 * MINUTE });
    assert.deepEqual(early.lines, []);
    const result = await watch({ config, clock: fakeClock(T0 + 58 * MINUTE) });
    assert.deepEqual(result.lines, ["wf keep-warm: ping c1 (idle 58 min)"]);
  });

  test("prints main and a ledger coder due at the same poll as two lines", async () => {
    const { config } = sandbox({ mainAt: T0, agents: { c1: T0 }, types: { c1: "wf:coder-t2" } });
    const result = await watch({ config, clock: fakeClock(T0 + 58 * MINUTE) });
    assert.deepEqual(result.lines, ["wf keep-warm: ping main (idle 58 min)", "wf keep-warm: ping c1 (idle 58 min)"]);
  });

  test("picks up an agent written to the ledger after the watcher started, on the next poll", async () => {
    const { layout, config } = sandbox({ mainAt: T0 + 30 * MINUTE });
    const clock = fakeClock(T0 + 40 * MINUTE);
    const lines = [];
    let registered = false;
    const sleep = async (ms) => {
      if (!registered) {
        registered = true;
        registerAgent(config, "t2", "wf:tester-t2", transcriptIdleSince(layout.agentTranscript("t2"), T0 + 36 * MINUTE, "t2"));
      }
      await clock.sleep(ms);
    };
    const code = await keepWarm({ argv: [], env: { CLAUDE_CODE_SESSION_ID: SESSION }, config, now: clock.now, sleep, out: (line) => lines.push(line), err: () => {} });
    assert.equal(code, 0);
    assert.deepEqual(lines, ["wf keep-warm: ping t2 (idle 4 min)"]);
    assert.equal(clock.now(), T0 + 40 * MINUTE + 20000);
  });

  test("skips a ledger agent whose transcript is missing, without a cannot-find error or exit 1", async () => {
    const { root, config } = sandbox({ mainAt: T0 });
    registerAgent(config, "ghost1", "wf:coder-t2", path.join(root, "gone", "agent-ghost1.jsonl"));
    const result = await watch({ config, clock: fakeClock(T0 + 50 * MINUTE) });
    assert.equal(result.code, 0);
    assert.deepEqual(result.lines, ["wf keep-warm: ping main (idle 58 min)"]);
    assert.deepEqual(result.errors, []);
  });

  test("exits 1 for an explicit agent id without transcript, and ignores a ledger agent without one", async () => {
    const { root, config } = sandbox({ mainAt: T0 });
    registerAgent(config, "ghost1", "wf:coder-t2", path.join(root, "gone", "agent-ghost1.jsonl"));
    const result = await watch({ config, argv: ["--agents", "nope1"], clock: fakeClock(T0 + 10 * MINUTE) });
    assert.equal(result.code, 1);
    assert.deepEqual(result.lines, ["wf keep-warm: cannot find agent nope1"]);
  });

  test("prints one line for an agent given in --agents that the ledger also holds", async () => {
    const { config } = sandbox({ mainAt: T0 + 30 * MINUTE, agents: { c1: T0 }, types: { c1: "wf:coder-t2" } });
    const result = await watch({ config, argv: ["--agents", "c1"], clock: fakeClock(T0 + 58 * MINUTE) });
    assert.deepEqual(result.lines, ["wf keep-warm: ping c1 (idle 58 min)"]);
  });

  test("keeps the 58 minute limit for a ledger agent of unknown type", async () => {
    const { config } = sandbox({ mainAt: T0 + 30 * MINUTE, agents: { u1: T0 }, types: { u1: "wf:unknown-t1" } });
    const early = await firstPoll({ config, start: T0 + 57 * MINUTE });
    assert.deepEqual(early.lines, []);
    const result = await watch({ config, clock: fakeClock(T0 + 57 * MINUTE) });
    assert.deepEqual(result.lines, ["wf keep-warm: ping u1 (idle 58 min)"]);
  });
});

describe("keep-warm process", () => {
  test("exits 0 with the ping line for an idle main thread", () => {
    counter += 1;
    const root = path.join(tmp, `proc-${counter}`);
    const layout = sessionLayout(root);
    transcriptIdleSince(layout.mainTranscript, Date.parse("2026-01-01T00:00:00.000Z"));
    const stateDir = path.join(root, "ai-agents-setup", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, `${SESSION}.json`), JSON.stringify({ sessionId: SESSION, agents: { main: { transcript: layout.mainTranscript } } }));
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", timeout: 10000, env: { ...process.env, CLAUDE_CONFIG_DIR: root, CLAUDE_CODE_SESSION_ID: SESSION, WF_KEEPWARM_MINUTES: "1" } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^wf keep-warm: ping main \(idle [0-9]+ min\)\n$/);
  });

  test("exits 0 when the task folder is gone", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--task", path.join(tmp, "gone", ".work", "t")], { encoding: "utf8", timeout: 10000, env: { ...process.env, CLAUDE_CONFIG_DIR: tmp, CLAUDE_CODE_SESSION_ID: SESSION } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "wf keep-warm: task folder gone, stopped\n");
  });
});
