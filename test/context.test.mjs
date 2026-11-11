import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_FULL_NAME } from "../hooks/compact.mjs";
import {
  COMPACT_TOOL,
  DEFAULTS,
  bandOf,
  cacheTtlOf,
  contextLimits,
  findSubagentTranscript,
  formatTokens,
  lastRequest,
  lastUsage,
  lastWorkRequestTime,
  loadConfig,
  precompactText,
  pruneLedgers,
  readLedger,
  readTailLines,
  recordToolCall,
  roleOf,
  taskOwnership,
  transcriptLastRequest,
  withLedgerLock
} from "../hooks/context.mjs";
import { agentsReport } from "../scripts/wf-agents.mjs";
import { SESSION, assistantLine, sessionLayout, systemLine, userLine, writeTranscript } from "./data/hooks/transcript.mjs";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(REPO, "hooks", "context.mjs");
const FIXTURES = path.join(REPO, "test", "data", "hooks");
const T0 = Date.parse("2026-10-28T10:00:00.000Z");

let tmp;
let counter = 0;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-context-"));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function at(seconds) {
  return new Date(T0 + seconds * 1000).toISOString();
}

function sandbox() {
  counter += 1;
  const root = path.join(tmp, `case-${counter}`);
  const layout = sessionLayout(root);
  const config = { ...DEFAULTS, stateDir: path.join(root, "state") };
  return { root, layout, config };
}

function usageAt(tokens, seconds = 0, agentId) {
  return assistantLine({ agentId, timestamp: at(seconds), input: 2, creation: 1000, read: tokens - 1002 });
}

function setTokens(file, tokens, agentId) {
  writeTranscript(file, [userLine({ agentId, timestamp: at(0) }), usageAt(tokens, 1, agentId)]);
}

function mainInput(layout, extra = {}) {
  return { session_id: SESSION, transcript_path: layout.mainTranscript, cwd: "/work/demo-project", hook_event_name: "PostToolUse", tool_name: "Read", agent_type: "wf:orchestrator", ...extra };
}

function agentInput(layout, agentId, agentType = "wf:coder-t2") {
  return mainInput(layout, { agent_id: agentId, agent_type: agentType });
}

describe("config and limits", () => {
  test("loadConfig falls back to the defaults with stateDir under CLAUDE_CONFIG_DIR", () => {
    const config = loadConfig({ file: path.join(tmp, "missing.json"), env: { CLAUDE_CONFIG_DIR: "/cfg" } });
    assert.deepEqual(config, { ...DEFAULTS, stateDir: path.join("/cfg", "ai-agents-setup", "state"), cacheTtl: {} });
  });

  test("loadConfig uses ~/.claude when CLAUDE_CONFIG_DIR is unset", () => {
    assert.equal(loadConfig({ file: path.join(tmp, "missing.json"), env: {}, homedir: "/home/u" }).stateDir, path.join("/home/u", ".claude", "ai-agents-setup", "state"));
  });

  test("loadConfig reads config.json and ignores invalid values", () => {
    const file = path.join(tmp, "config.json");
    fs.writeFileSync(file, JSON.stringify({ window: 1000000, warnTokens: 400000, handoffTokens: "x", keepwarmMinutes: -1, stateDir: "/abs/state", extra: 1 }));
    const config = loadConfig({ file, env: {} });
    assert.equal(config.warnTokens, 400000);
    assert.equal(config.handoffTokens, 800000);
    assert.equal(config.keepwarmMinutes, 58);
    assert.equal(config.stateDir, "/abs/state");
    fs.writeFileSync(file, JSON.stringify({ stateDir: "relative/state" }));
    assert.notEqual(loadConfig({ file, env: {} }).stateDir, "relative/state");
  });

  test("loadConfig defaults the short keep-warm to 4 and 30 minutes and reads positive overrides", () => {
    const missing = loadConfig({ file: path.join(tmp, "missing.json"), env: {} });
    assert.equal(missing.keepwarmShortMinutes, 4);
    assert.equal(missing.keepwarmShortMaxMinutes, 30);
    const file = path.join(tmp, "short.json");
    fs.writeFileSync(file, JSON.stringify({ keepwarmShortMinutes: 0, keepwarmShortMaxMinutes: 45 }));
    const config = loadConfig({ file, env: {} });
    assert.equal(config.keepwarmShortMinutes, 4);
    assert.equal(config.keepwarmShortMaxMinutes, 45);
  });

  test("loadConfig keeps only the cacheTtl entries that are 5m or 1h for a plain role name", () => {
    const file = path.join(tmp, "cache-ttl.json");
    fs.writeFileSync(file, JSON.stringify({ cacheTtl: { coder: "1h", tester: "5m", docs: "10m", git: 5, Reviewer: "5m", planner: null, "bad role": "1h" } }));
    assert.deepEqual(loadConfig({ file, env: {} }).cacheTtl, { coder: "1h", tester: "5m" });
    fs.writeFileSync(file, JSON.stringify({ cacheTtl: ["5m"] }));
    assert.deepEqual(loadConfig({ file, env: {} }).cacheTtl, {});
    fs.writeFileSync(file, JSON.stringify({ window: 1000000 }));
    assert.deepEqual(loadConfig({ file, env: {} }).cacheTtl, {});
  });

  test("cacheTtlOf gives a 5 minute cache only to a role the config maps to 5m", () => {
    const config = { ...DEFAULTS, cacheTtl: { coder: "1h", tester: "5m" } };
    assert.deepEqual(["wf:coder-t2", "wf:tester-t1", "main", "unknown", "wf:docs-t1"].map((type) => cacheTtlOf(config, type)), ["1h", "5m", "1h", "1h", "1h"]);
    assert.equal(cacheTtlOf({ ...DEFAULTS }, "wf:tester-t1"), "1h", "a config without a cacheTtl map keeps the 1 hour cache");
  });

  test("the zones are absolute 500K and 800K of a 1M window, with compaction at 850K", () => {
    assert.deepEqual(contextLimits(DEFAULTS, {}), { window: 1000000, warn: 500000, handoff: 800000, compact: 850000, step: 50000, overEvery: 5 });
  });

  test("WF_CONTEXT_WINDOW scales warn and handoff to 50 and 80 percent of the new window", () => {
    assert.deepEqual(contextLimits(DEFAULTS, { WF_CONTEXT_WINDOW: "60000" }), { window: 60000, warn: 30000, handoff: 48000, compact: 51000, step: 3000, overEvery: 5 });
  });

  test("an invalid WF_CONTEXT_WINDOW is ignored", () => {
    for (const value of ["", "abc", "0", "-5"]) assert.equal(contextLimits(DEFAULTS, { WF_CONTEXT_WINDOW: value }).window, 1000000, value);
  });

  test("formatTokens writes K and M", () => {
    assert.deepEqual([1000000, 1250000, 850000, 500000, 34505, 999, 0].map(formatTokens), ["1M", "1.25M", "850K", "500K", "35K", "999", "0"]);
  });

  test("bandOf switches at exactly 500K and 800K", () => {
    const limits = contextLimits(DEFAULTS, {});
    assert.deepEqual([0, 499999, 500000, 799999, 800000, 990000].map((tokens) => bandOf(tokens, limits)), ["ok", "ok", "buffer", "buffer", "over", "over"]);
  });

  test("roleOf reads the role from a wf agent type", () => {
    assert.deepEqual(["wf:coder-t2", "wf:planner-t3", "wf:orchestrator", "wf:git", "Explore", undefined].map(roleOf), ["coder", "planner", "orchestrator", "git", "<role>", "<role>"]);
  });
});

describe("transcript reading", () => {
  test("the fixture transcripts give the tokens of their last assistant usage", () => {
    assert.equal(lastUsage(readTailLines(path.join(FIXTURES, "transcript-main.jsonl"))).tokens, 5 + 2500 + 32000);
    assert.equal(lastUsage(readTailLines(path.join(FIXTURES, "transcript-agent.jsonl"))).tokens, 2 + 4000 + 30000);
  });

  test("lastUsage skips synthetic, zero and malformed lines", () => {
    const lines = [usageAt(300000), assistantLine({ timestamp: at(2), input: 0, creation: 0, read: 0 }), assistantLine({ timestamp: at(3), model: "<synthetic>", input: 9, read: 900000 }), "{broken", "[1,2]"].map((line) => (typeof line === "string" ? line : JSON.stringify(line)));
    assert.equal(lastUsage(lines).tokens, 300000);
    assert.equal(lastUsage([]), null);
  });

  test("readTailLines reads only the tail and drops the cut first line", () => {
    const file = writeTranscript(path.join(tmp, "big.jsonl"), [userLine({ timestamp: at(0), text: "x".repeat(700 * 1024) }), usageAt(123456, 5)]);
    const lines = readTailLines(file);
    assert.equal(lines.length, 1);
    assert.equal(lastUsage(lines).tokens, 123456);
    assert.deepEqual(readTailLines(file, 10), []);
  });

  test("lastRequest takes the last user line and skips meta lines", () => {
    const lines = [userLine({ timestamp: at(0) }), assistantLine({ timestamp: at(5) }), userLine({ timestamp: at(6), toolResult: true }), assistantLine({ timestamp: at(9) }), userLine({ timestamp: at(20), isMeta: true }), systemLine({ timestamp: at(21) })].map((line) => JSON.stringify(line));
    assert.deepEqual(lastRequest(lines), { time: T0 + 6000, source: "user" });
  });

  function rawUser(seconds, content, extra = {}) {
    return { ...userLine({ timestamp: at(seconds) }), message: { role: "user", content }, ...extra };
  }

  test("a local /context command after the last request is not a request", () => {
    const lines = [
      userLine({ timestamp: at(0) }),
      usageAt(300000, 60),
      rawUser(2400, "<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>", { isMeta: true }),
      rawUser(2400, "<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>"),
      systemLine({ timestamp: at(2401) })
    ].map((line) => JSON.stringify(line));
    assert.deepEqual(lastRequest(lines), { time: T0, source: "user" });
  });

  test("local command output and bash mode lines are not requests", () => {
    for (const content of ["<local-command-stdout>Set effort to high</local-command-stdout>", "<bash-input>ls</bash-input>", "<bash-stdout>a b</bash-stdout><bash-stderr></bash-stderr>", [{ type: "text", text: "<command-name>/effort</command-name>" }], "[Request interrupted by user]"]) {
      const lines = [userLine({ timestamp: at(0) }), usageAt(300000, 60), rawUser(2400, content)].map((line) => JSON.stringify(line));
      assert.deepEqual(lastRequest(lines), { time: T0, source: "user" }, JSON.stringify(content));
    }
  });

  test("a SendMessage delivery is a request although Claude Code marks it meta", () => {
    const lines = [
      userLine({ timestamp: at(0) }),
      usageAt(300000, 60),
      rawUser(3540, "wf keep-warm ping: reply ok only", { isMeta: true, origin: { kind: "coordinator" } }),
      usageAt(300100, 3542)
    ].map((line) => JSON.stringify(line));
    assert.deepEqual(lastRequest(lines), { time: T0 + 3540000, source: "user" });
  });

  test("a prompt command expansion, meta but answered by the model, counts through the reply", () => {
    const lines = [
      userLine({ timestamp: at(0) }),
      usageAt(300000, 60),
      rawUser(1800, "<command-name>/review</command-name>"),
      rawUser(1801, "Review the current diff.", { isMeta: true }),
      usageAt(310000, 1830),
      usageAt(311000, 1900)
    ].map((line) => JSON.stringify(line));
    assert.deepEqual(lastRequest(lines), { time: T0 + 1801000, source: "request" });
  });

  test("lastRequest falls back to the last line with a timestamp", () => {
    assert.deepEqual(lastRequest([JSON.stringify(assistantLine({ timestamp: at(3) })), JSON.stringify({ type: "custom-title" })]), { time: T0 + 3000, source: "last" });
    assert.equal(lastRequest([]), null);
  });

  test("transcriptLastRequest falls back to the file time", () => {
    const file = writeTranscript(path.join(tmp, "notime.jsonl"), [{ type: "custom-title" }]);
    const when = new Date(T0);
    fs.utimesSync(file, when, when);
    assert.deepEqual(transcriptLastRequest(file), { time: T0, source: "mtime" });
  });

  function pingEntry(seconds) {
    return { ...userLine({ timestamp: at(seconds), isMeta: true, text: "wf keep-warm ping: reply ok only" }), origin: { kind: "coordinator" } };
  }

  test("lastWorkRequestTime skips keep-warm ping lines, so a ping does not count as work", () => {
    const file = writeTranscript(path.join(tmp, "ping.jsonl"), [userLine({ timestamp: at(0) }), assistantLine({ timestamp: at(3) }), pingEntry(240), assistantLine({ timestamp: at(242) })]);
    assert.deepEqual(transcriptLastRequest(file), { time: T0 + 240000, source: "user" });
    assert.equal(lastWorkRequestTime(file), T0);
  });

  test("lastWorkRequestTime falls back to the last request when the transcript holds only pings", () => {
    const file = writeTranscript(path.join(tmp, "only-ping.jsonl"), [pingEntry(240), assistantLine({ timestamp: at(242) })]);
    assert.equal(lastWorkRequestTime(file), T0 + 240000);
  });

  test("findSubagentTranscript searches the session subagents folder recursively", () => {
    const { layout } = sandbox();
    setTokens(layout.mainTranscript, 1000);
    const flat = setTokensReturn(layout.agentTranscript("a1"), "a1");
    const nested = setTokensReturn(layout.agentTranscript("b2", "workflows", "wf_123"), "b2");
    assert.equal(findSubagentTranscript(layout.mainTranscript, SESSION, "a1"), flat);
    assert.equal(findSubagentTranscript(layout.mainTranscript, SESSION, "b2"), nested);
    assert.equal(findSubagentTranscript(layout.mainTranscript, SESSION, "c3"), null);
    assert.equal(findSubagentTranscript(nested, SESSION, "b2"), nested);
  });

  test("findSubagentTranscript refuses ids that could leave the folder", () => {
    const { layout } = sandbox();
    assert.equal(findSubagentTranscript(layout.mainTranscript, SESSION, "../x"), null);
    assert.equal(findSubagentTranscript(layout.mainTranscript, "../s", "a1"), null);
    assert.equal(findSubagentTranscript(undefined, SESSION, "a1"), null);
  });
});

function setTokensReturn(file, agentId) {
  setTokens(file, 1000, agentId);
  return file;
}

describe("recordToolCall", () => {
  test("records the main thread in a ledger of the documented shape and stays quiet below 50 percent", () => {
    const { layout, config } = sandbox();
    setTokens(layout.mainTranscript, 120000);
    const result = recordToolCall(mainInput(layout), { config, env: {}, now: T0 });
    assert.equal(result.notice, null);
    const ledger = readLedger(path.join(config.stateDir, `${SESSION}.json`));
    assert.deepEqual(ledger, {
      sessionId: SESSION,
      updatedAt: at(0),
      agents: {
        main: { type: "wf:orchestrator", transcript: layout.mainTranscript, tokens: 120000, percent: 12, band: "ok", calls: 1, lastNotifiedTokens: 0, lastNotifiedCall: 0, updatedAt: at(0) }
      }
    });
  });

  test("a worker is nudged on entering the buffer, every further 50K, on reaching 80 percent and then every 5 calls", () => {
    const { layout, config } = sandbox();
    setTokens(layout.mainTranscript, 1000);
    const file = layout.agentTranscript("a1");
    const steps = [
      [400000, null],
      [500000, "buffer"],
      [520000, null],
      [549999, null],
      [550000, "buffer"],
      [560000, null],
      [600000, "buffer"],
      [800000, "over"],
      [805000, null],
      [810000, null],
      [815000, null],
      [820000, null],
      [825000, "over"],
      [830000, null],
      [100000, null],
      [500000, "buffer"]
    ];
    steps.forEach(([tokens, expected], index) => {
      setTokens(file, tokens, "a1");
      const { notice, entry } = recordToolCall(agentInput(layout, "a1"), { config, env: {}, now: T0 + index * 1000 });
      if (expected === null) assert.equal(notice, null, `call ${index + 1} at ${tokens} should be quiet`);
      else if (expected === "buffer") assert.match(notice ?? "", /Estimate the tokens you still need/, `call ${index + 1} at ${tokens} should get the buffer nudge`);
      else assert.match(notice ?? "", /Stop now/, `call ${index + 1} at ${tokens} should get the over nudge`);
      assert.equal(entry.calls, index + 1);
    });
  });

  test("the worker buffer text holds the tokens used, the 800K rule and the handoff note path", () => {
    const { layout, config } = sandbox();
    setTokens(layout.mainTranscript, 1000);
    setTokens(layout.agentTranscript("a1"), 612000, "a1");
    const { notice } = recordToolCall(agentInput(layout, "a1", "wf:coder-t2"), { config, env: {}, now: T0 });
    assert.equal(
      notice,
      "wf context: you have used 612K of your 1M token context (61.2%). Estimate the tokens you still need. If used plus still needed exceeds 800K, finish the current step, write your handoff note .work/<task>/handoff-coder-<n>.md (sections Done, Remaining, Key facts, Files touched, Checks state) and end with Status: handoff. Otherwise continue and do not re-read files."
    );
  });

  test("the worker over text says stop now and write the handoff note", () => {
    const { layout, config } = sandbox();
    setTokens(layout.mainTranscript, 1000);
    setTokens(layout.agentTranscript("t7"), 812000, "t7");
    const { notice } = recordToolCall(agentInput(layout, "t7", "wf:tester-t1"), { config, env: {}, now: T0 });
    assert.equal(
      notice,
      "wf context: you have used 812K of your 1M token context (81.2%), past the 800K handoff line. Stop now: write your handoff note .work/<task>/handoff-tester-<n>.md (sections Done, Remaining, Key facts, Files touched, Checks state) and end with Status: handoff."
    );
  });

  test("the reviewer, which has no Write tool, is told to put the handoff sections in its result", () => {
    const { layout, config } = sandbox();
    setTokens(layout.mainTranscript, 1000);
    setTokens(layout.agentTranscript("r1"), 812000, "r1");
    const { notice } = recordToolCall(agentInput(layout, "r1", "wf:reviewer-t3"), { config, env: {}, now: T0 });
    assert.equal(
      notice,
      "wf context: you have used 812K of your 1M token context (81.2%), past the 800K handoff line. Stop now: put the handoff sections Done, Remaining, Key facts, Files touched, Checks state at the end of Open issues (you write no file; the orchestrator saves the note) and end with Status: handoff."
    );
  });

  test("the debugger in the buffer is told to end blocked with its analysis, never to hand off", () => {
    const { layout, config } = sandbox();
    setTokens(layout.mainTranscript, 1000);
    setTokens(layout.agentTranscript("d1"), 612000, "d1");
    const { notice } = recordToolCall(agentInput(layout, "d1", "wf:debugger-t2"), { config, env: {}, now: T0 });
    assert.equal(
      notice,
      "wf context: you have used 612K of your 1M token context (61.2%). Estimate the tokens you still need. If used plus still needed exceeds 800K, finish the current step, put your analysis so far (root cause or best hypothesis, evidence, what is left) under Open issues and end with Status: blocked; you write no handoff note and no other debugger takes over. Otherwise continue and do not re-read files."
    );
    assert.doesNotMatch(notice, /handoff-debugger|Status: handoff/, "the debugger never hands off");
  });

  test("the debugger past 800K is told to stop now and end blocked, never to hand off", () => {
    const { layout, config } = sandbox();
    setTokens(layout.mainTranscript, 1000);
    setTokens(layout.agentTranscript("d2"), 812000, "d2");
    const { notice } = recordToolCall(agentInput(layout, "d2", "wf:debugger-t3"), { config, env: {}, now: T0 });
    assert.equal(
      notice,
      "wf context: you have used 812K of your 1M token context (81.2%), past the 800K handoff line. Stop now: put your analysis so far (root cause or best hypothesis, evidence, what is left) under Open issues and end with Status: blocked; you write no handoff note and no other debugger takes over."
    );
    assert.doesNotMatch(notice, /handoff-debugger|Status: handoff/, "the debugger never hands off");
  });

  test("the single wf:git agent past 800K writes its own handoff note", () => {
    const { layout, config } = sandbox();
    setTokens(layout.mainTranscript, 1000);
    setTokens(layout.agentTranscript("g1"), 812000, "g1");
    const { notice } = recordToolCall(agentInput(layout, "g1", "wf:git"), { config, env: {}, now: T0 });
    assert.equal(
      notice,
      "wf context: you have used 812K of your 1M token context (81.2%), past the 800K handoff line. Stop now: write your handoff note .work/<task>/handoff-git-<n>.md (sections Done, Remaining, Key facts, Files touched, Checks state) and end with Status: handoff."
    );
  });

  test("the orchestrator gets its own buffer and over texts: compact at a quiet point in the buffer, at once past 800K (D123)", () => {
    const { layout, config } = sandbox();
    setTokens(layout.mainTranscript, 500000);
    const buffer = recordToolCall(mainInput(layout), { config, env: {}, now: T0 }).notice;
    assert.equal(buffer, "wf context: the orchestrator has used 500K of its 1M token context (50%). Estimate what the rest of the task still brings into your context. When used plus needed stays under 800K, go on without compacting: delegate reading, do not re-read files, keep progress.md current. Otherwise compact at the next point where no worker runs: start no new worker; once none runs, update progress.md, call mcp__wf__compact with next and end your turn (skill context-cache).");
    setTokens(layout.mainTranscript, 801000);
    const over = recordToolCall(mainInput(layout), { config, env: {}, now: T0 + 1000 }).notice;
    assert.equal(over, "wf context: the orchestrator has used 801K of its 1M token context (80.1%), past 800K: compaction is due now, whatever runs. Finish a report or a T0 answer first. Right after an approval, write the task folder, summary.md and progress.md first; with a task folder, update progress.md in one edit (phase, workers with states and changed files, check results, assumptions, open issues). Then call mcp__wf__compact with next and end your turn at once, in the discussion too; the wf plugin compacts when the turn ends. The engine compacts on its own at 850K.");
  });

  test("the notices name the tool the compact module serves", () => {
    assert.equal(COMPACT_TOOL, TOOL_FULL_NAME);
  });

  test("a subagent transcript found once is remembered in the ledger", () => {
    const { layout, config } = sandbox();
    setTokens(layout.mainTranscript, 1000);
    const nested = layout.agentTranscript("n1", "workflows", "wf_9");
    setTokens(nested, 200000, "n1");
    const first = recordToolCall(agentInput(layout, "n1"), { config, env: {}, now: T0 });
    assert.equal(first.entry.transcript, nested);
    assert.equal(first.entry.tokens, 200000);
    const second = recordToolCall({ ...agentInput(layout, "n1"), transcript_path: path.join(tmp, "elsewhere.jsonl") }, { config, env: {}, now: T0 + 1000 });
    assert.equal(second.entry.transcript, nested);
  });

  test("a subagent that is not a wf agent is recorded but never nudged", () => {
    const { layout, config } = sandbox();
    setTokens(layout.mainTranscript, 1000);
    setTokens(layout.agentTranscript("e1"), 900000, "e1");
    const result = recordToolCall(agentInput(layout, "e1", "Explore"), { config, env: {}, now: T0 });
    assert.equal(result.notice, null);
    assert.equal(result.entry.band, "over");
    assert.equal(result.entry.type, "Explore");
  });

  test("WF_CONTEXT_WINDOW makes a small window for live checks", () => {
    const { layout, config } = sandbox();
    setTokens(layout.mainTranscript, 1000);
    setTokens(layout.agentTranscript("w1"), 31000, "w1");
    const { notice, entry } = recordToolCall(agentInput(layout, "w1", "wf:coder-t1"), { config, env: { WF_CONTEXT_WINDOW: "60000" }, now: T0 });
    assert.equal(entry.band, "buffer");
    assert.equal(entry.percent, 51.7);
    assert.match(notice, /used 31K of your 60K token context \(51\.7%\).*exceeds 48K/);
  });

  test("a transcript without usage keeps the previous tokens", () => {
    const { layout, config } = sandbox();
    setTokens(layout.mainTranscript, 300000);
    recordToolCall(mainInput(layout), { config, env: {}, now: T0 });
    writeTranscript(layout.mainTranscript, [userLine({ timestamp: at(9) })]);
    assert.equal(recordToolCall(mainInput(layout), { config, env: {}, now: T0 + 1000 }).entry.tokens, 300000);
  });

  test("agents share one ledger and the write leaves no temporary file", () => {
    const { layout, config } = sandbox();
    setTokens(layout.mainTranscript, 10000);
    setTokens(layout.agentTranscript("a1"), 20000, "a1");
    setTokens(layout.agentTranscript("b2"), 30000, "b2");
    recordToolCall(mainInput(layout), { config, env: {}, now: T0 });
    recordToolCall(agentInput(layout, "a1"), { config, env: {}, now: T0 + 1 });
    recordToolCall(agentInput(layout, "b2", "wf:tester-t2"), { config, env: {}, now: T0 + 2 });
    const ledger = readLedger(path.join(config.stateDir, `${SESSION}.json`));
    assert.deepEqual(Object.keys(ledger.agents), ["main", "a1", "b2"]);
    assert.deepEqual(Object.values(ledger.agents).map((agent) => agent.tokens), [10000, 20000, 30000]);
    assert.deepEqual(fs.readdirSync(config.stateDir), [`${SESSION}.json`]);
  });

  test("a new ledger prunes ledgers older than 7 days and nothing else", () => {
    const { layout, config } = sandbox();
    fs.mkdirSync(config.stateDir, { recursive: true });
    const old = path.join(config.stateDir, "old-session.json");
    const fresh = path.join(config.stateDir, "fresh-session.json");
    const log = path.join(config.stateDir, "hook-errors.log");
    for (const file of [old, fresh, log]) fs.writeFileSync(file, "{}\n");
    const eightDays = new Date(T0 - 8 * 24 * 3600 * 1000);
    fs.utimesSync(old, eightDays, eightDays);
    fs.utimesSync(log, eightDays, eightDays);
    setTokens(layout.mainTranscript, 1000);
    recordToolCall(mainInput(layout), { config, env: {}, now: T0 });
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(log), true);
    fs.writeFileSync(old, "{}\n");
    fs.utimesSync(old, eightDays, eightDays);
    recordToolCall(mainInput(layout), { config, env: {}, now: T0 + 1000 });
    assert.equal(fs.existsSync(old), true, "an existing ledger does not prune again");
  });

  test("pruneLedgers keeps the named file", () => {
    const { config } = sandbox();
    fs.mkdirSync(config.stateDir, { recursive: true });
    const keep = path.join(config.stateDir, "keep.json");
    fs.writeFileSync(keep, "{}");
    const old = new Date(T0 - 30 * 24 * 3600 * 1000);
    fs.utimesSync(keep, old, old);
    assert.deepEqual(pruneLedgers(config.stateDir, T0, keep), []);
  });

  test("an invalid session id is an error, never a path", () => {
    const { layout, config } = sandbox();
    assert.throws(() => recordToolCall(mainInput(layout, { session_id: "../../etc" }), { config, env: {}, now: T0 }), /invalid session_id/);
  });
});

describe("ledger lock", () => {
  function hookInputs(layout, ids, tokens) {
    setTokens(layout.mainTranscript, 1000);
    for (const id of new Set(ids)) setTokens(layout.agentTranscript(id), tokens, id);
    return ids.map((id) => agentInput(layout, id));
  }

  function runAll(root, inputs) {
    return Promise.all(
      inputs.map(
        (input) =>
          new Promise((resolve) => {
            const child = spawn(process.execPath, [HOOK], { env: { ...process.env, WF_CONTEXT_WINDOW: "", CLAUDE_CONFIG_DIR: root } });
            let stdout = "";
            child.stdout.on("data", (chunk) => {
              stdout += chunk;
            });
            child.on("close", (code) => resolve({ code, stdout }));
            child.stdin.end(JSON.stringify(input));
          })
      )
    );
  }

  test("hooks of 12 agents that start at once all land in the ledger", async () => {
    const { root, layout } = sandbox();
    const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const results = await runAll(root, hookInputs(layout, ids, 20000));
    assert.ok(results.every((result) => result.code === 0));
    const ledger = readLedger(path.join(root, "ai-agents-setup", "state", `${SESSION}.json`));
    assert.deepEqual(Object.keys(ledger.agents).sort(), [...ids].sort());
    for (const id of ids) assert.equal(ledger.agents[id].calls, 1, id);
    assert.deepEqual(fs.readdirSync(path.join(root, "ai-agents-setup", "state")).filter((name) => name.endsWith(".lock")), [], "no lock is left behind");
  });

  test("parallel tool calls of one agent count every call and send the buffer notice once", async () => {
    const { root, layout } = sandbox();
    const results = await runAll(root, hookInputs(layout, Array(6).fill("same"), 600000));
    const notices = results.filter((result) => result.stdout.includes("additionalContext"));
    assert.equal(notices.length, 1, "one notice for entering the buffer");
    const ledger = readLedger(path.join(root, "ai-agents-setup", "state", `${SESSION}.json`));
    assert.equal(ledger.agents.same.calls, 6);
  });

  test("a stale lock is broken and a held lock is waited for only briefly", () => {
    const dir = path.join(tmp, "locks");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "s.json");
    fs.writeFileSync(`${file}.lock`, "");
    const old = new Date(Date.now() - 10000);
    fs.utimesSync(`${file}.lock`, old, old);
    assert.equal(withLedgerLock(file, () => fs.existsSync(`${file}.lock`)), true, "the stale lock was replaced by ours");
    assert.equal(fs.existsSync(`${file}.lock`), false, "and ours is removed afterwards");
    fs.writeFileSync(`${file}.lock`, "");
    const started = Date.now();
    assert.equal(withLedgerLock(file, () => "ran", { waitMs: 50 }), "ran", "a held lock never blocks the hook");
    assert.ok(Date.now() - started < 1000);
    assert.equal(fs.existsSync(`${file}.lock`), true, "someone else's lock is left alone");
  });
});

describe("task ownership", () => {
  test("a task folder is mine, live, stale or unowned by its Session line and that session's ledger", () => {
    const stateDir = path.join(tmp, "own-state");
    const work = path.join(tmp, "own-project", ".work");
    const folder = (name, session) => {
      const dir = path.join(work, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "progress.md"), session ? `# ${name}\nSession: ${session}\nTier: T1.\n` : `# ${name}\n`);
      return dir;
    };
    fs.mkdirSync(stateDir, { recursive: true });
    const now = T0 + 200 * 60000;
    fs.writeFileSync(path.join(stateDir, "live-session.json"), JSON.stringify({ sessionId: "live-session", updatedAt: new Date(now - 30 * 60000).toISOString(), agents: {} }));
    fs.writeFileSync(path.join(stateDir, "old-session.json"), JSON.stringify({ sessionId: "old-session", updatedAt: new Date(now - 90 * 60000).toISOString(), agents: {} }));
    const options = { stateDir, sessionId: "me", now };
    assert.equal(taskOwnership(folder("a", "me"), options).state, "mine");
    assert.equal(taskOwnership(folder("b", "live-session"), options).state, "live");
    assert.equal(taskOwnership(folder("c", "old-session"), options).state, "stale");
    assert.equal(taskOwnership(folder("d", "gone-session"), options).state, "stale");
    assert.equal(taskOwnership(folder("e", null), options).state, "unowned");
  });
});

describe("precompact", () => {
  test("the orchestrator keep-list names the task folder and every item of the plan", () => {
    const project = path.join(tmp, "pc-project");
    const task = path.join(project, ".work", "20261028-1000-slugify");
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    fs.mkdirSync(task, { recursive: true });
    fs.mkdirSync(path.join(project, ".work", "stray"), { recursive: true });
    fs.writeFileSync(path.join(task, "progress.md"), "x");
    const text = precompactText({ cwd: project, trigger: "auto" });
    assert.match(text, new RegExp(`task folder path: ${task.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
    for (const item of ["approved summary", "phase", "worker", "keep-warm", "assumptions", "open issues"]) assert.match(text, new RegExp(item));
    assert.match(text, /marked NOT APPROVED/, "before the approval the summary is kept as not approved");
    assert.match(text, /its changed files and its handoff note/, "the report and the git phase need every worker's changed files (D123)");
    assert.match(text, /the last result of each check, and whether it ran after the last code change/, "the report needs the last check results (D123)");
    assert.match(text, /once a task folder holds summary\.md/, "a typed or advance approval counts as approved once summary.md exists");
    assert.match(text, /with none, nothing is approved yet/, "no task folder means nothing is approved");
    assert.doesNotMatch(text, /stray/);
  });

  test("the keep-list names only the task folders of this session and those without an owner", () => {
    const project = path.join(tmp, "pc-sessions");
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    const mine = path.join(project, ".work", "20261028-1000-mine");
    const other = path.join(project, ".work", "20261028-1100-other");
    const unowned = path.join(project, ".work", "20261028-1200-unowned");
    for (const [dir, text] of [[mine, `# mine\nSession: ${SESSION}\n`], [other, "# other\nSession: another-session\n"], [unowned, "# unowned\n"]]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "progress.md"), text);
    }
    const text = precompactText({ cwd: project, session_id: SESSION });
    assert.ok(text.includes(mine), "its own folder");
    assert.ok(text.includes(unowned), "a folder without a Session line");
    assert.ok(!text.includes(other), "not the folder of another session");
  });

  test("a worker keep-list keeps its steps, facts, files and checks", () => {
    const text = precompactText({ cwd: path.join(tmp, "none"), agent_id: "a1" });
    for (const item of ["delegation header", "steps remaining", "key facts", "file touched", "checks"]) assert.match(text, new RegExp(item));
    assert.match(text, /the \.work\/<task> folder named in progress\.md or in your delegation message/);
  });

  test("a worker keep-list keeps the notes its delegation names, so a debugger re-reads its debug note", () => {
    const text = precompactText({ cwd: path.join(tmp, "none"), agent_id: "a1" });
    assert.match(text, /every note it names in Read first or the free text \(handoff, fix or debug note\)/);
    assert.match(text, /re-read summary\.md and plan\.md in the task folder and every note your delegation names \(for example notes\/debug-<n>\.md or a fix file\)/);
  });
});

function runHook(args, input, { raw, env = {} } = {}) {
  return spawnSync(process.execPath, [HOOK, ...args], {
    input: raw ?? JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, WF_CONTEXT_WINDOW: "", ...env },
    timeout: 10000
  });
}

describe("context hook process", () => {
  test("PostToolUse in the buffer prints additionalContext and exits 0", () => {
    const { root, layout } = sandbox();
    setTokens(layout.mainTranscript, 1000);
    setTokens(layout.agentTranscript("a1"), 650000, "a1");
    const result = runHook([], agentInput(layout, "a1"), { env: { CLAUDE_CONFIG_DIR: root } });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(output.hookSpecificOutput.additionalContext, /^wf context: you have used 650K/);
    assert.ok(fs.existsSync(path.join(root, "ai-agents-setup", "state", `${SESSION}.json`)));
  });

  test("PostToolUse below the buffer prints nothing", () => {
    const { root, layout } = sandbox();
    setTokens(layout.mainTranscript, 40000);
    const result = runHook([], mainInput(layout), { env: { CLAUDE_CONFIG_DIR: root } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });

  test("precompact prints the keep-list on stdout", () => {
    const { root } = sandbox();
    const result = runHook(["precompact"], { session_id: SESSION, hook_event_name: "PreCompact", trigger: "auto", cwd: root }, { env: { CLAUDE_CONFIG_DIR: root } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^wf compaction: the summary must keep/);
  });

  test("broken input exits 0 silently and logs one line", () => {
    const { root } = sandbox();
    const result = runHook([], null, { raw: "{oops", env: { CLAUDE_CONFIG_DIR: root } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    const log = fs.readFileSync(path.join(root, "ai-agents-setup", "state", "hook-errors.log"), "utf8").trim().split("\n");
    assert.equal(log.length, 1);
    assert.match(log[0], /context: SyntaxError/);
  });

  test("precompact with broken input still prints the generic keep-list", () => {
    const { root } = sandbox();
    const result = runHook(["precompact"], null, { raw: "nope", env: { CLAUDE_CONFIG_DIR: root } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /the approved summary/);
  });
});

describe("wf-agents --tasks", () => {
  test("lists each task folder of the project with its owner and what to do with it", () => {
    const { root, config } = sandbox();
    const project = path.join(root, "project");
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    const make = (name, session) => {
      const dir = path.join(project, ".work", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "progress.md"), session ? `# ${name}\nSession: ${session}\n` : `# ${name}\n`);
      return dir;
    };
    const now = T0 + 300 * 60000;
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.writeFileSync(path.join(config.stateDir, "busy.json"), JSON.stringify({ sessionId: "busy", updatedAt: new Date(now - 20 * 60000).toISOString(), agents: {} }));
    const mine = make("20261028-1000-mine", SESSION);
    const busy = make("20261028-1100-busy", "busy");
    const old = make("20261028-1200-old", "gone");
    const bare = make("20261028-1300-bare", null);
    const report = agentsReport({ argv: ["--tasks", "--project", path.join(project, "src")], env: { CLAUDE_CODE_SESSION_ID: SESSION }, now, config });
    assert.equal(report.code, 0);
    const lines = report.text.split("\n");
    assert.equal(lines[0], `wf tasks: ${path.join(project, ".work")} (this session ${SESSION})`);
    assert.match(lines.find((line) => line.startsWith(mine)), /  mine  session .+: this session$/);
    assert.match(lines.find((line) => line.startsWith(busy)), /  live  session busy, last activity 20 min ago: another session that is still active: leave it alone$/);
    assert.match(lines.find((line) => line.startsWith(old)), /  stale  session gone, no activity recorded: interrupted: ask Resume, Discard or Leave it$/);
    assert.match(lines.find((line) => line.startsWith(bare)), /  unowned  session none, no activity recorded: no Session line/);
    const json = JSON.parse(agentsReport({ argv: ["--tasks", "--json", "--project", project], env: { CLAUDE_CODE_SESSION_ID: SESSION }, now, config }).text);
    assert.deepEqual(json.tasks.map((task) => task.state), ["mine", "live", "stale", "unowned"]);
  });
});

describe("wf-agents", () => {
  function ledgerSandbox() {
    const { layout, config } = sandbox();
    writeTranscript(layout.mainTranscript, [userLine({ timestamp: at(0) }), usageAt(412000, 30)]);
    writeTranscript(layout.agentTranscript("a1"), [userLine({ agentId: "a1", timestamp: at(60) }), usageAt(612000, 90, "a1")]);
    recordToolCall(mainInput(layout), { config, env: {}, now: T0 + 120000 });
    recordToolCall(agentInput(layout, "a1"), { config, env: {}, now: T0 + 180000 });
    return { layout, config };
  }

  test("prints the session ledger as a table with the last request of each agent", () => {
    const { config } = ledgerSandbox();
    const result = agentsReport({ argv: [], env: { CLAUDE_CODE_SESSION_ID: SESSION }, now: T0 + 10 * 60000, config });
    assert.equal(result.code, 0);
    const lines = result.text.split("\n");
    assert.equal(lines[0], `wf agents: session ${SESSION}, ledger updated ${at(180)}`);
    assert.match(lines[1], /^agent\s+type\s+tokens\s+percent\s+band\s+updated\s+last request$/);
    assert.match(lines[2], /^main\s+wf:orchestrator\s+412K\s+41\.2%\s+ok\s+8 min ago\s+10 min ago$/);
    assert.match(lines[3], /^a1\s+wf:coder-t2\s+612K\s+61\.2%\s+buffer\s+7 min ago\s+9 min ago$/);
    assert.equal(lines[4], "zones: buffer from 500K, handoff from 800K, compaction at 850K of 1M");
  });

  test("--json gives the agents with ISO times", () => {
    const { config } = ledgerSandbox();
    const result = agentsReport({ argv: ["--json", "--session", SESSION], env: {}, now: T0, config });
    const data = JSON.parse(result.text);
    assert.equal(data.sessionId, SESSION);
    assert.deepEqual(data.agents.map((agent) => [agent.agent, agent.tokens, agent.band, agent.lastRequestAt]), [
      ["main", 412000, "ok", at(0)],
      ["a1", 612000, "buffer", at(60)]
    ]);
  });

  test("without a session id it shows the newest ledger", () => {
    const { config } = ledgerSandbox();
    const result = agentsReport({ argv: [], env: {}, now: T0, config });
    assert.equal(result.code, 0);
    assert.match(result.text, new RegExp(`session ${SESSION}`));
  });

  test("a missing ledger and bad arguments are reported", () => {
    const { config } = sandbox();
    assert.equal(agentsReport({ argv: [], env: { CLAUDE_CODE_SESSION_ID: SESSION }, config }).code, 1);
    assert.equal(agentsReport({ argv: [], env: {}, config }).code, 1);
    assert.equal(agentsReport({ argv: ["--bogus"], env: {}, config }).code, 2);
    assert.equal(agentsReport({ argv: ["--session", "../x"], env: {}, config }).code, 2);
  });
});
