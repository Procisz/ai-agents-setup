import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, ledgerFile, readLedger } from "../hooks/context.mjs";
import {
  TITLE_CHILD_ENV,
  TITLE_MODEL_TIMEOUT_MS,
  CLEAR_TERMINAL_SEQUENCE,
  TITLE_SYSTEM,
  fallbackName,
  generateName,
  handleClear,
  handlePrompt,
  handleWrite,
  nameWords,
  slugWords,
  summaryTier,
  titleChildEnv,
  titleFor,
  titlePrefix
} from "../hooks/title.mjs";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(REPO, "hooks", "title.mjs");
const SID = "sess-1";

let tmp;
let counter = 0;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-title-"));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sandbox() {
  counter += 1;
  const root = path.join(tmp, `case-${counter}`);
  const config = { ...DEFAULTS, stateDir: path.join(root, "state") };
  fs.mkdirSync(config.stateDir, { recursive: true });
  return { root, config, file: ledgerFile(config.stateDir, SID) };
}

function summaryWrite(slug, extra = {}, content = undefined) {
  return {
    hook_event_name: "PostToolUse",
    session_id: SID,
    tool_name: "Write",
    tool_input: { file_path: `/work/proj/.work/20261029-1715-${slug}/summary.md`, ...(content === undefined ? {} : { content }) },
    ...extra
  };
}

function tierContent(tier) {
  return `🎯 **What you want**\n- something\n\n📊 **Tier**: ${tier}: several modules\n`;
}

function prompt(text, sessionTitle) {
  return { hook_event_name: "UserPromptSubmit", session_id: SID, prompt: text, ...(sessionTitle === undefined ? {} : { session_title: sessionTitle }) };
}

function fakeGenerate(name = "fix login timeout") {
  const calls = [];
  const generate = (text) => {
    calls.push(text);
    return name;
  };
  return { generate, calls };
}

function run(input, config, generate, env = {}) {
  return handlePrompt(input, { config, generate, env });
}

describe("nameWords", () => {
  test("turns a model reply into space separated words", () => {
    assert.equal(nameWords("fix-login-timeout"), "fix login timeout");
  });

  test("keeps the first five words only", () => {
    assert.equal(nameWords("one two three four five six seven"), "one two three four five");
  });

  test("returns null for a single word", () => {
    assert.equal(nameWords("login"), null);
  });

  test("returns null for empty and whitespace input", () => {
    assert.equal(nameWords(""), null);
    assert.equal(nameWords("  \n \n"), null);
    assert.equal(nameWords(undefined), null);
  });

  test("uses the first non-empty line only", () => {
    assert.equal(nameWords("\n\nfix login bug\nextra words here"), "fix login bug");
  });

  test("strips accents, lowercases and folds punctuation to spaces", () => {
    assert.equal(nameWords("Árvíztűrő Tükörfúrógép!"), "arvizturo tukorfurogep");
    assert.equal(nameWords("Fix: Login/Timeout (v2)"), "fix login timeout v2");
  });

  test("strips a leading wf prefix", () => {
    assert.equal(nameWords("[WF] Fix login"), "fix login");
    assert.equal(nameWords("WF-fix-login-timeout"), "fix login timeout");
  });

  test("returns null when only one word is left after the prefix is stripped", () => {
    assert.equal(nameWords("wf-login"), null);
  });

  test("strips a leading wf(T<n>)- prefix with its tier word", () => {
    assert.equal(nameWords("wf(T3)-Fix login"), "fix login");
    assert.equal(nameWords("wf(T5)-Login timeout fix"), "login timeout fix");
    assert.equal(nameWords("wf(T0)-Fix login"), "fix login");
  });

  test("keeps a tier like word that does not follow a leading wf", () => {
    assert.equal(nameWords("t3 fix login"), "t3 fix login");
    assert.equal(nameWords("wf-t9-fix"), "t9 fix");
  });

  test("cuts at 40 characters on a word boundary", () => {
    const name = nameWords("internationalization-configuration-management-service-layer");
    assert.equal(name, "internationalization configuration");
    assert.ok(name.length <= 40);
  });

  test("keeps a name of exactly 40 characters whole", () => {
    const text = `${"a".repeat(19)} ${"b".repeat(20)}`;
    assert.equal(text.length, 40);
    assert.equal(nameWords(text), text);
  });

  test("cuts a name just over 40 characters at the last space before the limit", () => {
    const text = `${"a".repeat(19)} ${"b".repeat(21)}`;
    assert.equal(nameWords(text), "a".repeat(19));
  });
});

describe("fallbackName", () => {
  test("drops stop words and keeps the first four words", () => {
    assert.equal(fallbackName("Please fix the login timeout in auth.js"), "fix login timeout auth");
  });

  test("returns session when only stop words are left", () => {
    assert.equal(fallbackName("please can you"), "session");
    assert.equal(fallbackName(""), "session");
    assert.equal(fallbackName("???"), "session");
  });

  test("folds accents and case", () => {
    assert.equal(fallbackName("Javítsd ki a Árvíztűrő hibát"), "javitsd ki arvizturo hibat");
  });

  test("limits the name to 40 characters on a word boundary", () => {
    const name = fallbackName("internationalization configuration management service");
    assert.equal(name, "internationalization configuration");
  });

  test("works on a single meaningful word", () => {
    assert.equal(fallbackName("refactor"), "refactor");
  });
});

describe("generateName", () => {
  test("spawns claude with the haiku flags, the prompt on stdin and a marked child env", () => {
    const seen = [];
    const spawn = (command, args, options) => {
      seen.push({ command, args, options });
      return { status: 0, stdout: "fix-login-timeout\n" };
    };
    const name = generateName("x".repeat(3000), { env: { PATH: "/bin", CLAUDECODE: "1", KEEP: "yes" }, platform: "linux", spawn });
    assert.equal(name, "fix login timeout");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].command, "claude");
    assert.deepEqual(seen[0].args, [
      "-p",
      "--model",
      "haiku",
      "--no-session-persistence",
      "--tools",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--system-prompt",
      TITLE_SYSTEM
    ]);
    assert.equal(seen[0].options.input, "x".repeat(2000));
    assert.equal(seen[0].options.timeout, TITLE_MODEL_TIMEOUT_MS);
    assert.equal(TITLE_MODEL_TIMEOUT_MS, 12000);
    assert.equal(seen[0].options.cwd, os.tmpdir());
    assert.equal(seen[0].options.shell, undefined);
    assert.deepEqual(seen[0].options.env, { PATH: "/bin", KEEP: "yes", [TITLE_CHILD_ENV]: "1" });
  });

  test("uses a shell with every argument double-quoted on win32", () => {
    const seen = [];
    const spawn = (command, args, options) => {
      seen.push({ command, args, options });
      return { status: 0, stdout: "fix-login-timeout" };
    };
    generateName("hello world", { env: {}, platform: "win32", spawn });
    assert.equal(seen[0].command, '"claude"');
    assert.equal(seen[0].options.shell, true);
    assert.ok(seen[0].args.every((arg) => arg.startsWith('"') && arg.endsWith('"')));
    assert.equal(seen[0].args[5], '""');
  });

  test("returns null on a non-zero status", () => {
    assert.equal(generateName("p", { env: {}, spawn: () => ({ status: 1, stdout: "fix-login-timeout" }) }), null);
  });

  test("returns null when the spawn reports an error such as a timeout", () => {
    assert.equal(generateName("p", { env: {}, spawn: () => ({ error: new Error("ETIMEDOUT"), status: null, stdout: "" }) }), null);
  });

  test("returns null when the reply is a single word", () => {
    assert.equal(generateName("p", { env: {}, spawn: () => ({ status: 0, stdout: "hello" }) }), null);
  });

  test("returns null when stdout is not a string", () => {
    assert.equal(generateName("p", { env: {}, spawn: () => ({ status: 0, stdout: null }) }), null);
  });
});

describe("titleChildEnv", () => {
  test("removes the Claude Code session variables and marks the child", () => {
    const env = titleChildEnv({
      PATH: "/bin",
      HOME: "/home/x",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDE_CODE_SESSION_ACCESS_TOKEN: "t",
      CLAUDE_CODE_SSE_PORT: "1",
      CLAUDE_CODE_EXECPATH: "/x",
      CLAUDE_AGENT_SDK_VERSION: "1",
      CLAUDE_PROJECT_DIR: "/p",
      CLAUDE_CONFIG_DIR: "/cfg"
    });
    assert.deepEqual(env, { PATH: "/bin", HOME: "/home/x", CLAUDE_CONFIG_DIR: "/cfg", [TITLE_CHILD_ENV]: "1" });
  });
});

describe("first prompt", () => {
  test("names the session with the plain generated name, no prefix, and stores stage named", () => {
    const { config, file } = sandbox();
    const { generate, calls } = fakeGenerate("fix login timeout");
    assert.equal(run(prompt("Please fix the login timeout"), config, generate), "Fix login timeout");
    assert.deepEqual(calls, ["Please fix the login timeout"]);
    const ledger = readLedger(file);
    assert.deepEqual(ledger.title, { name: "Fix login timeout", stage: "named", task: null, tier: null });
    assert.equal(ledger.sessionId, SID);
    assert.deepEqual(ledger.agents, {});
  });

  test("falls back to the stop-word-free prompt words when the model gives nothing", () => {
    const { config } = sandbox();
    assert.equal(run(prompt("Please fix the login timeout in auth.js"), config, () => null), "Fix login timeout auth");
  });

  test("skips a slash command without calling the model or writing a ledger", () => {
    const { config, file } = sandbox();
    const { generate, calls } = fakeGenerate();
    assert.equal(run(prompt("/wf fix things"), config, generate), null);
    assert.equal(run(prompt("   /clear"), config, generate), null);
    assert.deepEqual(calls, []);
    assert.equal(fs.existsSync(file), false);
  });

  test("skips an empty or missing prompt", () => {
    const { config, file } = sandbox();
    const { generate, calls } = fakeGenerate();
    assert.equal(run(prompt("   \n"), config, generate), null);
    assert.equal(run({ hook_event_name: "UserPromptSubmit", session_id: SID }, config, generate), null);
    assert.deepEqual(calls, []);
    assert.equal(fs.existsSync(file), false);
  });

  test("does nothing inside a title child session", () => {
    const { config, file } = sandbox();
    const { generate, calls } = fakeGenerate();
    assert.equal(run(prompt("fix the login timeout"), config, generate, { [TITLE_CHILD_ENV]: "1" }), null);
    assert.deepEqual(calls, []);
    assert.equal(fs.existsSync(file), false);
  });

  test("refuses an unsafe session id", () => {
    const { config } = sandbox();
    const { generate, calls } = fakeGenerate();
    assert.equal(run({ ...prompt("fix the login timeout"), session_id: "../evil" }, config, generate), null);
    assert.equal(run({ ...prompt("fix the login timeout"), session_id: undefined }, config, generate), null);
    assert.deepEqual(calls, []);
  });

  test("does not call the model again on the second prompt before an approval", () => {
    const { config } = sandbox();
    const { generate, calls } = fakeGenerate();
    assert.equal(run(prompt("first task here"), config, generate), "Fix login timeout");
    assert.equal(run(prompt("second thing", "Fix login timeout"), config, generate), null);
    assert.equal(calls.length, 1);
  });

  test("keeps the agents of an existing ledger and its other keys", () => {
    const { config, file } = sandbox();
    fs.writeFileSync(file, JSON.stringify({ sessionId: SID, updatedAt: "2026-10-29T10:00:00.000Z", agents: { a1: { peak: 5 } }, other: 7 }));
    run(prompt("fix the login timeout"), config, fakeGenerate().generate);
    const ledger = readLedger(file);
    assert.deepEqual(ledger.agents, { a1: { peak: 5 } });
    assert.equal(ledger.other, 7);
    assert.equal(ledger.updatedAt, "2026-10-29T10:00:00.000Z");
    assert.equal(ledger.title.name, "Fix login timeout");
  });

  test("keeps the first name when the session title already equals it", () => {
    const { config } = sandbox();
    run(prompt("fix the login timeout"), config, fakeGenerate("a b").generate);
    const { generate, calls } = fakeGenerate("c d");
    assert.equal(run(prompt("more", "A b"), config, generate), null);
    assert.deepEqual(calls, []);
  });
});

describe("approval write", () => {
  test("records the task slug of a summary.md write in the ledger", () => {
    const { config, file } = sandbox();
    assert.equal(handleWrite(summaryWrite("session-names-width"), { config }), true);
    assert.deepEqual(readLedger(file).title, { name: null, stage: null, task: "session-names-width", tier: null });
  });

  test("keeps the session name and stage while recording the slug", () => {
    const { config, file } = sandbox();
    run(prompt("fix the login timeout"), config, fakeGenerate().generate);
    handleWrite(summaryWrite("add-widget"), { config });
    assert.deepEqual(readLedger(file).title, { name: "Fix login timeout", stage: "named", task: "add-widget", tier: null });
  });

  test("records only the first approval of the session", () => {
    const { config, file } = sandbox();
    assert.equal(handleWrite(summaryWrite("first-task"), { config }), true);
    assert.equal(handleWrite(summaryWrite("second-task"), { config }), false);
    assert.equal(readLedger(file).title.task, "first-task");
  });

  test("records the tier of the Tier line of the summary content together with the slug", () => {
    const { config, file } = sandbox();
    assert.equal(handleWrite(summaryWrite("tiered-task", {}, tierContent("T4")), { config }), true);
    assert.deepEqual(readLedger(file).title, { name: null, stage: null, task: "tiered-task", tier: "T4" });
  });

  test("records tier null when the summary content has no usable Tier line", () => {
    for (const content of ["no tier here", tierContent("T0"), tierContent("T6"), ""]) {
      const { config, file } = sandbox();
      assert.equal(handleWrite(summaryWrite("tiered-task", {}, content), { config }), true);
      assert.equal(readLedger(file).title.tier, null, content);
    }
  });

  test("only the first approval's tier counts", () => {
    const { config, file } = sandbox();
    handleWrite(summaryWrite("first-task", {}, tierContent("T2")), { config });
    assert.equal(handleWrite(summaryWrite("second-task", {}, tierContent("T5")), { config }), false);
    assert.equal(readLedger(file).title.tier, "T2");
  });

  test("works on Windows style paths", () => {
    const { config, file } = sandbox();
    const input = summaryWrite("x", { tool_input: { file_path: "C:\\proj\\.work\\20261029-1715-win-task\\summary.md" } });
    assert.equal(handleWrite(input, { config }), true);
    assert.equal(readLedger(file).title.task, "win-task");
  });

  test("ignores a subagent write", () => {
    const { config, file } = sandbox();
    assert.equal(handleWrite(summaryWrite("task-one", { agent_id: "a1" }), { config }), false);
    assert.equal(fs.existsSync(file), false);
  });

  test("ignores other tools", () => {
    const { config, file } = sandbox();
    assert.equal(handleWrite(summaryWrite("task-one", { tool_name: "Edit" }), { config }), false);
    assert.equal(fs.existsSync(file), false);
  });

  test("ignores other paths in the work folder and elsewhere", () => {
    const { config, file } = sandbox();
    for (const file_path of [
      "/p/.work/20261029-1715-task-one/plan.md",
      "/p/.work/20261029-1715-task-one/notes/summary.md",
      "/p/.work/task-one/summary.md",
      "/p/work/20261029-1715-task-one/summary.md",
      "/p/.work/20261029-1715-Task/summary.md",
      "/p/summary.md"
    ]) {
      assert.equal(handleWrite(summaryWrite("x", { tool_input: { file_path } }), { config }), false, file_path);
    }
    assert.equal(fs.existsSync(file), false);
  });

  test("ignores a write without a file path", () => {
    const { config } = sandbox();
    assert.equal(handleWrite(summaryWrite("x", { tool_input: {} }), { config }), false);
    assert.equal(handleWrite(summaryWrite("x", { tool_input: undefined }), { config }), false);
  });

  test("refuses an unsafe session id", () => {
    const { config } = sandbox();
    assert.equal(handleWrite(summaryWrite("task-one", { session_id: "../evil" }), { config }), false);
  });

  test("keeps the agents of an existing ledger", () => {
    const { config, file } = sandbox();
    fs.writeFileSync(file, JSON.stringify({ sessionId: SID, updatedAt: "2026-10-29T10:00:00.000Z", agents: { a1: { peak: 5 } } }));
    handleWrite(summaryWrite("task-one"), { config });
    const ledger = readLedger(file);
    assert.deepEqual(ledger.agents, { a1: { peak: 5 } });
    assert.equal(ledger.title.task, "task-one");
  });
});

describe("rename after the first approval", () => {
  test("the next prompt renames to wf(T<n>)- plus the task slug words", () => {
    const { config, file } = sandbox();
    const { generate } = fakeGenerate("fix login timeout");
    assert.equal(run(prompt("fix the login timeout"), config, generate), "Fix login timeout");
    handleWrite(summaryWrite("login-timeout-fix", {}, tierContent("T4")), { config });
    assert.equal(run(prompt("yes, go on", "Fix login timeout"), config, generate), "wf(T4)-Login timeout fix");
    assert.deepEqual(readLedger(file).title, { name: "wf(T4)-Login timeout fix", stage: "renamed", task: "login-timeout-fix", tier: "T4" });
  });

  test("the rename is plain when the summary write had no content", () => {
    const { config, file } = sandbox();
    const { generate } = fakeGenerate("fix login timeout");
    run(prompt("fix the login timeout"), config, generate);
    handleWrite(summaryWrite("login-timeout-fix"), { config });
    assert.equal(run(prompt("yes, go on", "Fix login timeout"), config, generate), "Login timeout fix");
    assert.deepEqual(readLedger(file).title, { name: "Login timeout fix", stage: "renamed", task: "login-timeout-fix", tier: null });
  });

  test("the rename is plain for a ledger written before the tier key existed", () => {
    const { config, file } = sandbox();
    fs.writeFileSync(file, JSON.stringify({ sessionId: SID, updatedAt: "2026-01-01T00:00:00.000Z", agents: {}, title: { name: "[WF] Fix login timeout", stage: "named", task: "login-fix" } }));
    assert.equal(run(prompt("go", "[WF] Fix login timeout"), config, fakeGenerate().generate), "Login fix");
    assert.deepEqual(readLedger(file).title, { name: "Login fix", stage: "renamed", task: "login-fix", tier: null });
  });

  test("the slug in the ledger is used as the first name when the approval came before any name", () => {
    const { config, file } = sandbox();
    const { generate, calls } = fakeGenerate();
    handleWrite(summaryWrite("early-task", {}, tierContent("T2")), { config });
    assert.equal(run(prompt("start the work"), config, generate), "wf(T2)-Early task");
    assert.deepEqual(calls, []);
    assert.equal(readLedger(file).title.stage, "renamed");
  });

  test("never renames again after the rename", () => {
    const { config, file } = sandbox();
    const { generate } = fakeGenerate();
    run(prompt("fix the login timeout"), config, generate);
    handleWrite(summaryWrite("first-task", {}, tierContent("T3")), { config });
    assert.equal(run(prompt("go", "Fix login timeout"), config, generate), "wf(T3)-First task");
    assert.equal(handleWrite(summaryWrite("second-task", {}, tierContent("T5")), { config }), false);
    assert.equal(run(prompt("next", "wf(T3)-First task"), config, generate), null);
    assert.equal(readLedger(file).title.name, "wf(T3)-First task");
    assert.equal(readLedger(file).title.task, "first-task");
  });

  test("a later approval before the rename does not replace the first slug", () => {
    const { config } = sandbox();
    const { generate } = fakeGenerate();
    run(prompt("fix the login timeout"), config, generate);
    handleWrite(summaryWrite("first-task", {}, tierContent("T1")), { config });
    handleWrite(summaryWrite("second-task", {}, tierContent("T5")), { config });
    assert.equal(run(prompt("go", "Fix login timeout"), config, generate), "wf(T1)-First task");
  });

  test("the prompts between the name and the approval change nothing", () => {
    const { config, file } = sandbox();
    const { generate, calls } = fakeGenerate();
    run(prompt("fix the login timeout"), config, generate);
    assert.equal(run(prompt("more detail", "Fix login timeout"), config, generate), null);
    assert.equal(run(prompt("even more", "Fix login timeout"), config, generate), null);
    assert.equal(calls.length, 1);
    assert.deepEqual(readLedger(file).title, { name: "Fix login timeout", stage: "named", task: null, tier: null });
  });
});

describe("a title the user set", () => {
  test("a different session title at the second prompt stops all naming", () => {
    const { config, file } = sandbox();
    const { generate, calls } = fakeGenerate();
    run(prompt("fix the login timeout"), config, generate);
    assert.equal(run(prompt("more", "My own title"), config, generate), null);
    assert.equal(readLedger(file).title.stage, "user");
    handleWrite(summaryWrite("late-task"), { config });
    assert.equal(run(prompt("go", "My own title"), config, generate), null);
    assert.equal(run(prompt("go again", "My own title"), config, generate), null);
    assert.equal(readLedger(file).title.name, "Fix login timeout");
    assert.equal(calls.length, 1);
  });

  test("a user title set before the rename keeps the rename from happening", () => {
    const { config, file } = sandbox();
    const { generate } = fakeGenerate();
    run(prompt("fix the login timeout"), config, generate);
    handleWrite(summaryWrite("approved-task"), { config });
    assert.equal(run(prompt("go", "Renamed by me"), config, generate), null);
    assert.equal(readLedger(file).title.stage, "user");
    assert.equal(readLedger(file).title.task, "approved-task");
  });

  test("a session title already present at the very first prompt is treated as the user's and kept", () => {
    const { config, file } = sandbox();
    const { generate, calls } = fakeGenerate();
    assert.equal(run(prompt("fix the login timeout", "Existing user title"), config, generate), null);
    assert.deepEqual(calls, []);
    assert.equal(readLedger(file).title.stage, "user");
    handleWrite(summaryWrite("task-one"), { config });
    assert.equal(run(prompt("go", "Existing user title"), config, generate), null);
    assert.equal(readLedger(file).title.name, null);
  });

  test("a user title after the rename is left alone", () => {
    const { config, file } = sandbox();
    const { generate } = fakeGenerate();
    run(prompt("fix the login timeout"), config, generate);
    handleWrite(summaryWrite("task-one", {}, tierContent("T2")), { config });
    run(prompt("go", "Fix login timeout"), config, generate);
    assert.equal(run(prompt("later", "Something I typed"), config, generate), null);
    assert.equal(readLedger(file).title.name, "wf(T2)-Task one");
    assert.equal(readLedger(file).title.stage, "renamed");
  });

  test("an empty session title counts as no title", () => {
    const { config, file } = sandbox();
    const { generate } = fakeGenerate();
    run(prompt("fix the login timeout"), config, generate);
    handleWrite(summaryWrite("task-one", {}, tierContent("T2")), { config });
    assert.equal(run(prompt("go", "  "), config, generate), "wf(T2)-Task one");
    assert.equal(readLedger(file).title.stage, "renamed");
  });
});

describe("titlePrefix", () => {
  test("gives wf(T<n>)- for a known tier", () => {
    assert.equal(titlePrefix("T4"), "wf(T4)-");
    assert.equal(titlePrefix("T1"), "wf(T1)-");
    assert.equal(titlePrefix("T5"), "wf(T5)-");
  });

  test("gives an empty prefix for null, undefined and an unknown tier", () => {
    assert.equal(titlePrefix(null), "");
    assert.equal(titlePrefix(undefined), "");
    assert.equal(titlePrefix("T0"), "");
    assert.equal(titlePrefix("T6"), "");
    assert.equal(titlePrefix("t3"), "");
  });
});

describe("summaryTier", () => {
  test("reads the tier of an icon Tier line", () => {
    assert.equal(summaryTier("📊 **Tier**: T4: several modules, stored agent config"), "T4");
  });

  test("reads the tier of a plain Tier line", () => {
    assert.equal(summaryTier("**Tier**: T2: one module"), "T2");
    assert.equal(summaryTier("Tier: T1: tiny"), "T1");
  });

  test("takes the tier right after the colon, not a later mention", () => {
    assert.equal(summaryTier("**Tier**: T3: a T4-sized change with extra care"), "T3");
  });

  test("finds the Tier line among other lines", () => {
    assert.equal(summaryTier("**What you want**\n- a\n\n📊 **Tier**: T5: risky\n⏰ **Estimate**: about 120 to 180 minutes\n"), "T5");
  });

  test("returns null for T0 and T6", () => {
    assert.equal(summaryTier("**Tier**: T0: question"), null);
    assert.equal(summaryTier("**Tier**: T6: too big"), null);
  });

  test("returns null without a Tier line", () => {
    assert.equal(summaryTier("**What you want**\n- a tier T3 change"), null);
    assert.equal(summaryTier(""), null);
  });

  test("returns null for a Tier mention in the middle of a line", () => {
    assert.equal(summaryTier("see the **Tier**: T3: later"), null);
  });

  test("returns null for a non-string", () => {
    assert.equal(summaryTier(undefined), null);
    assert.equal(summaryTier(null), null);
    assert.equal(summaryTier(42), null);
    assert.equal(summaryTier({ tier: "T3" }), null);
  });
});

describe("title hook process", () => {
  const isPosix = process.platform !== "win32";

  function hookRun(input, { root, bin }) {
    return spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: root,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        [TITLE_CHILD_ENV]: ""
      }
    });
  }

  function fakeClaude(root, reply) {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const script = path.join(bin, "claude");
    fs.writeFileSync(script, `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '${reply}'\n`, { mode: 0o755 });
    return bin;
  }

  test("a first prompt prints exactly one sessionTitle JSON line and stores the ledger under the config dir", { skip: !isPosix }, () => {
    const { root } = sandbox();
    const bin = fakeClaude(root, "Fix-Login-Timeout");
    const result = hookRun(prompt("Please fix the login timeout"), { root, bin });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: "Fix login timeout" } })}\n`);
    const ledger = readLedger(path.join(root, "ai-agents-setup", "state", `${SID}.json`));
    assert.deepEqual(ledger.title, { name: "Fix login timeout", stage: "named", task: null, tier: null });
  });

  test("a summary.md write prints nothing and the next prompt prints the renamed title", { skip: !isPosix }, () => {
    const { root } = sandbox();
    const bin = fakeClaude(root, "fix-login-timeout");
    assert.equal(hookRun(prompt("fix the login timeout"), { root, bin }).status, 0);
    const written = hookRun(summaryWrite("login-fix", {}, tierContent("T5")), { root, bin });
    assert.equal(written.status, 0, written.stderr);
    assert.equal(written.stdout, "");
    const next = hookRun(prompt("go", "Fix login timeout"), { root, bin });
    assert.equal(next.status, 0, next.stderr);
    assert.equal(next.stdout, `${JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: "wf(T5)-Login fix" } })}\n`);
  });

  test("uses the fallback name when claude fails", { skip: !isPosix }, () => {
    const { root } = sandbox();
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const result = hookRun(prompt("Please fix the login timeout in auth.js"), { root, bin });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.sessionTitle, "Fix login timeout auth");
  });

  test("exits 0 and prints nothing for broken input", { skip: !isPosix }, () => {
    const { root } = sandbox();
    const bin = fakeClaude(root, "fix-login-timeout");
    const result = spawnSync(process.execPath, [HOOK], {
      input: "{not json",
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: root, PATH: `${bin}${path.delimiter}${process.env.PATH}`, [TITLE_CHILD_ENV]: "" }
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(fs.readFileSync(path.join(root, "ai-agents-setup", "state", "hook-errors.log"), "utf8"), /title/);
  });
});

describe("titleFor and slugWords", () => {
  test("titleFor without a tier gives sentence case words and no prefix", () => {
    assert.equal(titleFor("fix login timeout"), "Fix login timeout");
    assert.equal(titleFor("width section first", null), "Width section first");
  });

  test("titleFor with a tier adds the wf(T<n>)- prefix and upper-cases only the first letter", () => {
    assert.equal(titleFor("login fix", "T3"), "wf(T3)-Login fix");
    assert.equal(titleFor("fix api timeout", "T4"), "wf(T4)-Fix api timeout");
  });

  test("slugWords turns hyphens into spaces without a word cap", () => {
    assert.equal(slugWords("fix-v2-login"), "fix v2 login");
    assert.equal(slugWords("a-b-c-d-e-f-g"), "a b c d e f g");
  });

  test("a task slug becomes a sentence case title", () => {
    assert.equal(titleFor(slugWords("fix-v2-login")), "Fix v2 login");
    assert.equal(titleFor(slugWords("fix-login-timeout"), "T2"), "wf(T2)-Fix login timeout");
  });

  test("the one word fallback gives Session", () => {
    assert.equal(titleFor(fallbackName("the a an")), "Session");
  });
});

describe("title style end to end", () => {
  test("the first prompt title has no dash and no capital after the first letter", () => {
    const { config } = sandbox();
    const title = run(prompt("make the width section first"), config, () => nameWords("Width-Section-First"));
    assert.equal(title, "Width section first");
    assert.doesNotMatch(title, /-/);
    assert.doesNotMatch(title.slice(1), /[A-Z]/);
  });

  test("the rename after approval uses the same style with all slug words", () => {
    const { config } = sandbox();
    const { generate } = fakeGenerate("width section first");
    run(prompt("make the width section first"), config, generate);
    handleWrite(summaryWrite("one-two-three-four-five-six-seven-eight", {}, tierContent("T3")), { config });
    const title = run(prompt("go", "Width section first"), config, generate);
    assert.equal(title, "wf(T3)-One two three four five six seven eight");
    assert.doesNotMatch(title.slice("wf(T3)-O".length), /[A-Z-]/);
  });
});

describe("user title detection with the new style", () => {
  function legacyLedger(file, extra = {}) {
    fs.writeFileSync(file, JSON.stringify({ sessionId: SID, updatedAt: "2026-01-01T00:00:00.000Z", agents: {}, title: { name: "wf-fix-login", stage: "named", task: null, ...extra } }));
  }

  test("a legacy wf- name matching the session title is not a user title and is renamed at the task rename", () => {
    const { config, file } = sandbox();
    const { generate, calls } = fakeGenerate();
    legacyLedger(file, { task: "login-fix" });
    assert.equal(run(prompt("go", "wf-fix-login"), config, generate), "Login fix");
    assert.deepEqual(readLedger(file).title, { name: "Login fix", stage: "renamed", task: "login-fix", tier: null });
    assert.deepEqual(calls, []);
  });

  test("a legacy name without a task stays unchanged and not user", () => {
    const { config, file } = sandbox();
    const { generate } = fakeGenerate();
    legacyLedger(file);
    assert.equal(run(prompt("more", "wf-fix-login"), config, generate), null);
    assert.equal(readLedger(file).title.stage, "named");
  });

  test("a /rename to wf-mine sets stage user and prints nothing", () => {
    const { config, file } = sandbox();
    const { generate } = fakeGenerate();
    legacyLedger(file, { task: "login-fix" });
    assert.equal(run(prompt("go", "wf-mine"), config, generate), null);
    assert.equal(readLedger(file).title.stage, "user");
  });

  test("a /rename to [WF] mine differing from the stored name sets stage user and prints nothing", () => {
    const { config, file } = sandbox();
    const { generate } = fakeGenerate();
    run(prompt("fix the login timeout"), config, generate);
    handleWrite(summaryWrite("login-fix"), { config });
    assert.equal(run(prompt("go", "[WF] mine"), config, generate), null);
    assert.equal(readLedger(file).title.stage, "user");
    assert.equal(readLedger(file).title.name, "Fix login timeout");
  });

  test("extra whitespace around the stored name is not a user title", () => {
    const { config, file } = sandbox();
    const { generate } = fakeGenerate();
    run(prompt("fix the login timeout"), config, generate);
    handleWrite(summaryWrite("login-fix", {}, tierContent("T3")), { config });
    assert.equal(run(prompt("go", "  Fix  login   timeout \n"), config, generate), "wf(T3)-Login fix");
    assert.equal(readLedger(file).title.stage, "renamed");
  });
});

describe("handleClear", () => {
  function seed(file, extra = {}) {
    const ledger = { sessionId: SID, updatedAt: "2026-01-01T00:00:00.000Z", agents: { a1: { x: 1 } }, other: "kept", title: { name: "[WF] Fix login", stage: "named", task: null }, ...extra };
    fs.writeFileSync(file, JSON.stringify(ledger));
    return ledger;
  }

  test("source clear removes the title and keeps every other key", () => {
    const { config, file } = sandbox();
    const ledger = seed(file);
    const { title: _title, ...rest } = ledger;
    assert.equal(handleClear({ source: "clear", session_id: SID }, { config, env: {} }), true);
    assert.deepEqual(readLedger(file), rest);
  });

  test("other sources change nothing", () => {
    for (const source of ["startup", "resume", "compact", undefined]) {
      const { config, file } = sandbox();
      const ledger = seed(file);
      assert.equal(handleClear({ source, session_id: SID }, { config, env: {} }), false);
      assert.deepEqual(readLedger(file), ledger);
    }
  });

  test("no ledger means no file is created", () => {
    const { config, file } = sandbox();
    assert.equal(handleClear({ source: "clear", session_id: SID }, { config, env: {} }), true);
    assert.equal(fs.existsSync(file), false);
  });

  test("a ledger without a title is left byte for byte", () => {
    const { config, file } = sandbox();
    const text = JSON.stringify({ sessionId: SID, agents: {} });
    fs.writeFileSync(file, text);
    handleClear({ source: "clear", session_id: SID }, { config, env: {} });
    assert.equal(fs.readFileSync(file, "utf8"), text);
  });

  test("returns false when the title child env is set", () => {
    const { config, file } = sandbox();
    const ledger = seed(file);
    assert.equal(handleClear({ source: "clear", session_id: SID }, { config, env: { [TITLE_CHILD_ENV]: "1" } }), false);
    assert.deepEqual(readLedger(file), ledger);
  });

  test("an unsafe session id does not throw and touches no file", () => {
    const { config } = sandbox();
    assert.doesNotThrow(() => handleClear({ source: "clear", session_id: "../evil" }, { config, env: {} }));
    assert.doesNotThrow(() => handleClear({ source: "clear", session_id: 5 }, { config, env: {} }));
    assert.deepEqual(fs.readdirSync(config.stateDir), []);
  });

  test("the terminal sequence is an OSC 0 with an empty title", () => {
    assert.equal(CLEAR_TERMINAL_SEQUENCE, "\u001b]0;\u0007");
  });
});

describe("title hook process on /clear", () => {
  const isPosix = process.platform !== "win32";

  function hookRun(input, root, bin) {
    return spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: root, PATH: `${bin}${path.delimiter}${process.env.PATH}`, [TITLE_CHILD_ENV]: "" }
    });
  }

  test("clear prints the terminal sequence and resets the ledger title, startup prints nothing, a new session is named", { skip: !isPosix }, () => {
    const { root } = sandbox();
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' 'width section first'\n", { mode: 0o755 });
    const first = hookRun(prompt("make the width section first"), root, bin);
    assert.equal(first.status, 0, first.stderr);
    const ledgerPath = path.join(root, "ai-agents-setup", "state", `${SID}.json`);
    assert.equal(readLedger(ledgerPath).title.name, "Width section first");

    const startup = hookRun({ hook_event_name: "SessionStart", session_id: SID, source: "startup" }, root, bin);
    assert.equal(startup.status, 0, startup.stderr);
    assert.equal(startup.stdout, "");
    assert.equal(readLedger(ledgerPath).title.name, "Width section first");

    const cleared = hookRun({ hook_event_name: "SessionStart", session_id: SID, source: "clear" }, root, bin);
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.equal(cleared.stdout, '{"terminalSequence":"\\u001b]0;\\u0007"}\n');
    assert.equal(Object.hasOwn(readLedger(ledgerPath), "title"), false);

    const fresh = { ...prompt("make the width section first"), session_id: "sess-2" };
    const named = hookRun(fresh, root, bin);
    assert.equal(named.status, 0, named.stderr);
    assert.equal(JSON.parse(named.stdout).hookSpecificOutput.sessionTitle, "Width section first");
  });
});
